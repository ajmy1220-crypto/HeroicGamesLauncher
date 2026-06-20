/**
 * orchestrator.ts
 * ------------------------------------------------------------------
 * Helmsman — Phase 3b：orchestration 進入點（藍圖 §6 / §6.4）。
 *
 * 把 AI 核心的純函式串成可被主程序（IPC）觸發的服務，並在不可信的 IPC 邊界
 * 重建被 TypeScript 型別系統抹掉的安全前提（§11 / §12.9）。
 *
 * 分層鐵律：
 *   - 本檔【不】import realHeroicBridge / heroicContextProvider——bridge（寫 adapter）與
 *     context provider（讀 adapter）一律由呼叫端（ipc_handler）注入。故本檔與其全部相依
 *     （logAnalyzer / recommendationEngine / actionExecutor / heroicBridge / types）皆
 *     Heroic-free，可在 jest 下零 mock 測試（fake bridge + fake provider）。
 *   - diagnose 為純函式（analyze→recommend→planAll）；runDiagnose / runApply 驗不可信的
 *     { appName, runner, action }，再由注入的 provider 後端權威組 context + 讀 log。
 *
 * 信任邊界（§6.4 安全邊界的 IPC 版，對抗式審查的核心修正）：
 *   - §12.9：runApply 對 executeAction 一律傳 confirmed:false——「使用者已確認」這個
 *     事實【不】由 renderer 自證（renderer 可能是 AI 驅動 / 被攻陷）。本階段只有
 *     executeAction 白名單（autoApplyable 的 install_winetricks）會真執行，其餘一律
 *     回 blocked_needs_confirmation。可信確認回路待 Phase 4 前端。
 *   - §11：context 由注入的 provider 後端權威組（assembleGameContext，非 renderer 自報）
 *     ——renderer 無法偽造 isWindowsSteamClient 繞 Steam 鎖；executeAction 的 Steam 鎖判定
 *     （=== true）為最後防線。normalizeContext 保留為純驗證工具，降為防禦性備援、不在主路徑。
 *   - 不可信 log 不再讓 analyze 的 raw.split 同步 throw（coerceLog 先擋非字串 + 設上限）。
 */

import { executeAction, planAll } from './actionExecutor'
import { advise } from './aiAdvisor'
import { analyze } from './logAnalyzer'
import { recommend } from './recommendationEngine'

import type { ExecutionResult, PlannedCall } from './actionExecutor'
import type { AdvisorResult } from './aiAdvisor'
import type { AiProvider } from './aiProvider'
import type { HeroicBridge } from './heroicBridge'
import type {
  AnalyzerContext,
  Arch,
  Backend,
  DirectXVersion,
  GameContext,
  LogAnalysis,
  Recommendation,
  RecommendedAction,
  Runner
} from './types'

// ── 公開回傳型別 ──────────────────────────────────────────────────

/** 診斷結果：結構化分析 + 規則層建議 + dry-run 計畫（皆 plain object，可過 IPC structured-clone）。 */
export interface DiagnoseResult {
  analysis: LogAnalysis
  recommendation: Recommendation
  plans: PlannedCall[]
}

/** 結構化錯誤回傳（不把內部 error 訊息 / 堆疊原樣洩漏到 renderer）。 */
export interface HelmsmanError {
  error: string
}

/**
 * 後端「讀 adapter」契約：權威地組 GameContext + 讀遊戲 log（與 HeroicBridge 的「寫
 * adapter」對稱）。由 ipc_handler 注入真實 heroicContextProvider；測試注入 fake。
 * 本檔【不】import 真實 provider——保持 Heroic-free + jest 零 mock（同 bridge 注入鐵律）。
 */
export interface ContextProvider {
  assembleGameContext(appName: string, runner: Runner): Promise<GameContext>
  readGameLog(appName: string, runner: Runner): string
}

// ── 驗證白名單（runtime 重建被型別抹掉的 enum 約束）─────────────────

const RUNNERS: readonly Runner[] = ['legendary', 'gog', 'nile', 'sideload']
const BACKENDS: readonly Backend[] = [
  'wined3d',
  'dxvk',
  'dxmt',
  'gptk',
  'crossover'
]
const ARCHES: readonly Arch[] = ['arm64', 'x86_64']
const DIRECTX_VERSIONS: readonly DirectXVersion[] = [9, 10, 11, 12]
const ACTION_KINDS: readonly RecommendedAction['kind'][] = [
  'install_winetricks',
  'switch_backend',
  'install_dxvk',
  'reinstall_wine_variant',
  'install_steam',
  'change_setting',
  'none'
]

/**
 * log 字元上限。stderr log 即使很長也遠不及此；設上限是防不可信 renderer 送巨量字串
 * 讓 analyze 的同步 split + 逐行 regex 阻塞 main process（DoS 邊角）。超過則截前段
 * （stderr 重點通常在前/中段）。
 */
const MAX_LOG_CHARS = 1_048_576

// ── 純核心：診斷（藍圖 §6.2 / §6.4 規則層，不碰 bridge、不呼叫 LLM）────

/**
 * 串接 AI 核心三步純函式產出診斷：analyze → recommend → planAll。
 * 純函式：相同 (log, context, analyzerContext) 必得深度相等結果，無副作用。
 * 假設輸入已驗（呼叫端 runDiagnose 負責 fail-closed 驗證）。
 */
export function diagnose(
  log: string,
  context: GameContext,
  analyzerContext?: AnalyzerContext
): DiagnoseResult {
  const analysis = analyze(log, analyzerContext)
  const recommendation = recommend(analysis, context)
  const plans = planAll(recommendation, context)
  return { analysis, recommendation, plans }
}

// ── 不可信輸入的 fail-closed 驗證 / 正規化 ─────────────────────────

/** value 是否屬封閉字面量集合（同時當 type guard 用，收斂成 T）。 */
function isOneOf<T>(value: unknown, allowed: readonly T[]): value is T {
  return (allowed as readonly unknown[]).includes(value)
}

/**
 * 驗不可信 IPC 輸入的「定址欄位」{ appName, runner }，不合法回 null。
 * runner 以白名單收窄（Heroic 的 Runner 聯集較寬，含 comet/zoom 等；Helmsman 只認四種）。
 */
function readGameRef(
  o: Record<string, unknown>
): { appName: string; runner: Runner } | null {
  if (typeof o.appName !== 'string' || o.appName === '') return null
  if (!isOneOf(o.runner, RUNNERS)) return null
  return { appName: o.appName, runner: o.runner }
}

/** 非字串回 null（防 analyze 的 raw.split throw）；超過上限截斷。 */
export function coerceLog(
  raw: unknown,
  maxChars = MAX_LOG_CHARS
): string | null {
  if (typeof raw !== 'string') return null
  return raw.length > maxChars ? raw.slice(0, maxChars) : raw
}

/**
 * 把不可信的 context 正規化成可信任的 GameContext，不合法回 null。
 *
 * 【Phase 4 後角色變化】context 改由後端 provider 權威組（assembleGameContext），本函式
 * 不再在 runDiagnose / runApply 主路徑；保留為純驗證工具（防禦性備援 + 釘樁測試資產）。
 *
 *   - 必填字串（appName / wineVersion / osVersion）型別檢查。
 *   - enum 欄位（runner / currentBackend / arch）對白名單比對，不合法→null
 *     （否則垃圾值流進規則層會產生看似正常、實則錯誤的建議；§審查 risk #4）。
 *   - 可選 enum（directxVersion）合法才帶入，否則維持 undefined（規則層對未知 dx 有定義行為）。
 *   - §11：isWindowsSteamClient 強制 `=== true` 的嚴格 boolean，杜絕 'false' / 1 / null
 *     之類非 boolean 值在任何下游 truthy 判斷中被誤判（Boolean('false') === true 陷阱）。
 */
export function normalizeContext(raw: unknown): GameContext | null {
  if (typeof raw !== 'object' || raw === null) return null
  const o = raw as Record<string, unknown>

  if (typeof o.appName !== 'string' || o.appName === '') return null
  if (typeof o.wineVersion !== 'string') return null
  if (typeof o.osVersion !== 'string') return null

  if (!isOneOf(o.runner, RUNNERS)) return null
  if (!isOneOf(o.currentBackend, BACKENDS)) return null
  if (!isOneOf(o.arch, ARCHES)) return null

  const context: GameContext = {
    appName: o.appName,
    runner: o.runner,
    currentBackend: o.currentBackend,
    wineVersion: o.wineVersion,
    osVersion: o.osVersion,
    arch: o.arch,
    // §11：非 true 一律 false（含 undefined / 'true' / 1 / null）。
    isWindowsSteamClient: o.isWindowsSteamClient === true
  }

  if (isOneOf(o.directxVersion, DIRECTX_VERSIONS)) {
    context.directxVersion = o.directxVersion
  }
  if (typeof o.is32bit === 'boolean') {
    context.is32bit = o.is32bit
  }

  return context
}

/**
 * 把不可信的 action 正規化成 RecommendedAction，不合法回 null。
 *   - kind 必在白名單（未知 kind 拒絕）。
 *   - params 必為「非陣列物件」（executeAction 以 params[key] 取值）。
 *   - autoApplyable 強制 boolean：注意 executeAction 只在 kind==='install_winetricks'
 *     時尊重此旗標（其餘 kind 一律 requiresConfirmation=true），故惡意對 switch_backend
 *     等送 autoApplyable:true 不會繞過確認閘——本階段唯一被允許免確認的就是 winetricks 白名單。
 */
function normalizeAction(raw: unknown): RecommendedAction | null {
  if (typeof raw !== 'object' || raw === null) return null
  const o = raw as Record<string, unknown>

  if (!isOneOf(o.kind, ACTION_KINDS)) return null
  if (
    typeof o.params !== 'object' ||
    o.params === null ||
    Array.isArray(o.params)
  ) {
    return null
  }

  return {
    kind: o.kind,
    params: o.params as Record<string, unknown>,
    reason: typeof o.reason === 'string' ? o.reason : '',
    autoApplyable: o.autoApplyable === true,
    confidence: typeof o.confidence === 'number' ? o.confidence : 0
  }
}

/** 把 unknown 錯誤安全轉成人話訊息（catch 出來的可能不是 Error）。 */
function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

// ── IPC 邊界進入點（ipc_handler 直接呼叫；對不可信輸入收口）──────────

/**
 * helmsmanDiagnose 的核心：驗 { appName, runner } → provider 後端權威組 context + 讀 log
 * → diagnose。唯讀、不碰 bridge。analyzerContext 由 context 衍生（osVersion / currentBackend
 * 皆在 GameContext 內）；maxEvidence 用 analyze 預設。context 不再由 renderer 傳（後端權威）。
 */
export async function runDiagnose(
  raw: unknown,
  provider: ContextProvider
): Promise<DiagnoseResult | HelmsmanError> {
  try {
    if (typeof raw !== 'object' || raw === null) {
      return { error: 'helmsmanDiagnose：參數必須是物件' }
    }
    const ref = readGameRef(raw as Record<string, unknown>)
    if (ref === null) {
      return { error: 'helmsmanDiagnose：appName / runner 不合法' }
    }

    // 後端權威組 context + 讀 log（provider 是 Heroic 讀 adapter）。
    const context = await provider.assembleGameContext(ref.appName, ref.runner)
    const log = coerceLog(provider.readGameLog(ref.appName, ref.runner))
    if (log === null) {
      return { error: 'helmsmanDiagnose：log 讀取失敗（非字串）' }
    }

    const analyzerContext: AnalyzerContext = {
      osVersion: context.osVersion,
      currentBackend: context.currentBackend
    }

    return diagnose(log, context, analyzerContext)
  } catch (err) {
    return { error: `helmsmanDiagnose 失敗：${errorMessage(err)}` }
  }
}

/**
 * helmsmanApplyAction 的核心：驗 { appName, runner, action } → provider 組 context →
 * executeAction（注入 bridge + confirm）。
 *
 * §12.9：對 executeAction 傳 confirmed:false——「使用者已確認」不由 renderer 自證。
 * 須確認的動作改由注入的 confirm callback（主程序權威，live＝原生 dialog）在 executeAction
 * 的確認閘取得真實確認；install_winetricks 白名單仍免確認直接執行。confirm 未注入時
 * （如本檔測試不傳）須確認的動作一律 blocked_needs_confirmation。dryRun:false——本 channel
 * 是 live 套用；dry-run 預覽走 diagnose。
 *
 * §11：context 由 provider 後端權威組（非 renderer 傳）——renderer 無法偽造
 * isWindowsSteamClient 繞 Steam 鎖；Steam 鎖在 confirm 之前，Steam 客戶端不會先彈框再被擋。
 * action 仍從 renderer 來、仍過 normalizeAction。bridge / confirm 由參數注入；executeAction
 * 已把 bridge throw 收口成 status:'failed'，try/catch 只收驗證 / context 組裝的意外。
 */
export async function runApply(
  raw: unknown,
  bridge: HeroicBridge,
  provider: ContextProvider,
  confirm?: (plan: PlannedCall, context: GameContext) => Promise<boolean>
): Promise<ExecutionResult | HelmsmanError> {
  try {
    if (typeof raw !== 'object' || raw === null) {
      return { error: 'helmsmanApplyAction：參數必須是物件' }
    }
    const o = raw as Record<string, unknown>

    const ref = readGameRef(o)
    if (ref === null) {
      return { error: 'helmsmanApplyAction：appName / runner 不合法' }
    }

    const action = normalizeAction(o.action)
    if (action === null) {
      return {
        error:
          'helmsmanApplyAction：action 不合法（kind 不在白名單或 params 形狀錯誤）'
      }
    }

    const context = await provider.assembleGameContext(ref.appName, ref.runner)

    return await executeAction(action, context, bridge, {
      confirmed: false,
      dryRun: false,
      confirm
    })
  } catch (err) {
    return { error: `helmsmanApplyAction 失敗：${errorMessage(err)}` }
  }
}

/**
 * helmsmanAdvise 的核心：驗 { appName, runner, userQuestion? } → provider 後端權威組
 * context + 讀 log + analyze → 注入的 AiProvider 求 LLM 建議（aiAdvisor.advise）。
 *
 * 模糊→AI 層（藍圖核心）：規則層（diagnose）給確定性結論；本 channel 給 LLM 的人話解釋 +
 * 建議。aiProvider 由 ipc_handler 依金鑰注入；null（未設 ANTHROPIC_API_KEY）→ 回 error、
 * 不 crash。userQuestion 選用（有＝自然語言除錯；無＝對 evidence 模糊判斷）。
 *
 * §12.9：advise 內部已把每條 LLM 建議的 autoApplyable 強制為 false（執行期 invariant）——
 * AI 來源動作一律須經 helmsmanApplyAction 的確認閘，與規則層建議走同一條套用路徑。
 * 本 channel 不碰 bridge（只求建議，不執行）。
 */
export async function runAdvise(
  raw: unknown,
  provider: ContextProvider,
  aiProvider: AiProvider | null
): Promise<AdvisorResult | HelmsmanError> {
  try {
    if (typeof raw !== 'object' || raw === null) {
      return { error: 'helmsmanAdvise：參數必須是物件' }
    }
    const o = raw as Record<string, unknown>

    const ref = readGameRef(o)
    if (ref === null) {
      return { error: 'helmsmanAdvise：appName / runner 不合法' }
    }
    if (aiProvider === null) {
      return {
        error: 'LLM 未設定：請設定 ANTHROPIC_API_KEY 後重啟，才能用 AI 建議'
      }
    }

    // userQuestion 為不可信輸入：須是非空字串才採用，否則走模糊判斷模式。
    const userQuestion =
      typeof o.userQuestion === 'string' && o.userQuestion.trim() !== ''
        ? o.userQuestion
        : undefined

    const context = await provider.assembleGameContext(ref.appName, ref.runner)
    const log = coerceLog(provider.readGameLog(ref.appName, ref.runner))
    if (log === null) {
      return { error: 'helmsmanAdvise：log 讀取失敗（非字串）' }
    }
    const analyzerContext: AnalyzerContext = {
      osVersion: context.osVersion,
      currentBackend: context.currentBackend
    }
    const analysis = analyze(log, analyzerContext)

    return await advise({ analysis, context, userQuestion }, aiProvider)
  } catch (err) {
    return { error: `helmsmanAdvise 失敗：${errorMessage(err)}` }
  }
}
