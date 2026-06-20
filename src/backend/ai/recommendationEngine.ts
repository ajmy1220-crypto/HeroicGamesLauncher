/**
 * recommendationEngine.ts
 * ------------------------------------------------------------------
 * Helmsman 決策層（藍圖 §6.2）——純函式、無副作用、不呼叫 AI、不碰引擎。
 *
 * 職責：
 *   拿 logAnalyzer 產出的 LogAnalysis + 上層注入的 GameContext，結合後端能力表
 *   （backendCapabilities），產出一份「建議動作清單 + verdict」或「不可行 + 原因」。
 *   規則抓不到結論（verdict 'unknown' 或有訊號卻零動作）時，標 needsAi=true 交下游
 *   aiAdvisor。
 *
 * 它「不」做的事（鐵律）：
 *   - 不呼叫任何 LLM / AI provider。
 *   - 不安裝、不改設定、不啟動任何行程（那是 actionExecutor 的事）。
 *   - 不改傳入的 analysis / context（純函式，相同輸入永遠回傳深度相等結果）。
 *
 * 決策三軸 = context.arch × context.directxVersion × 反作弊。
 * is32bit 僅作摩擦警示（降信心 / 標註），不作決策主軸（§5）。
 *
 * 能力表標 [VERIFIED]/[SEED] 的真機校準事項見 backendCapabilities.ts。
 */

import { candidatesFor, pickBackend, supports } from './backendCapabilities'
import type {
  DirectXVersion,
  GameContext,
  LogAnalysis,
  Recommendation,
  RecommendedAction
} from './types'
import { mergeVerdict } from './verdict'

// ── 內部常數 ──────────────────────────────────────────────────────

/**
 * [SEED] log 無訊號、純由能力表主動換後端時的保守信心。
 * 待 Bryan 真機校準；目前不參與「是否觸發 AI」的門檻（門檻列為 openQuestion）。
 */
const CAPABILITY_ONLY_CONFIDENCE = 0.7

/** blocking 短路時，topSignal 缺信心的保底值。 */
const BLOCKING_FALLBACK_CONFIDENCE = 0.9

/** 動作排序權重：switch_backend（最根本）→ install_winetricks → none（提示/占位）。 */
const KIND_ORDER: Record<RecommendedAction['kind'], number> = {
  switch_backend: 0,
  reinstall_wine_variant: 1,
  install_dxvk: 1,
  install_winetricks: 2,
  change_setting: 3,
  install_steam: 4,
  none: 5
}

// ── 主函式 ────────────────────────────────────────────────────────

/**
 * 拿分析結果與遊戲脈絡，產出建議。純函式：相同 (analysis, context) 必得深度相等結果。
 */
export function recommend(
  analysis: LogAnalysis,
  context: GameContext
): Recommendation {
  const summary = analysis.summary

  // 步驟 0｜建殼。result 為可變累積器；不直接覆寫已定論的硬結論，只「加動作 / 取較嚴重 verdict」。
  const result: Recommendation = {
    verdict: summary.verdict,
    actions: [],
    needsAi: false,
    blocking: summary.blocking
  }

  // ── 步驟 1｜反作弊／blocking 硬牆（最高優先，短路 return）─────────
  // blocking 後只解釋，丟棄所有 winetricks / switch_backend 候選。
  if (summary.blocking === true) {
    result.verdict = 'incompatible'
    result.blocking = true
    result.needsAi = false
    result.actions = [
      {
        kind: 'none',
        params: {},
        reason:
          summary.topSignal?.message ??
          '偵測到硬不相容（如反作弊），同組設定不必重試',
        autoApplyable: false,
        confidence:
          summary.topSignal?.confidence ?? BLOCKING_FALLBACK_CONFIDENCE
      }
    ]
    return result
  }

  // ── 步驟 2｜預算 Steam 鎖閘門（供步驟 5 共用）───────────────────────
  // Steam-locked 時不產生可自動套用的 switch_backend，改產「另裝對應後端 Steam」提示（§11）。
  const isSteamLocked =
    context.runner === 'sideload' && context.isWindowsSteamClient === true

  const dx = context.directxVersion

  // ── 步驟 3+4｜決定要換到的後端（target）─────────────────────────────
  //
  // 換後端的前提（不論 target 來源是 log 或能力表）：現用後端「不適用」。
  // 現用後端已適用時，即使 log 點名了另一個後端——哪怕那個後端在此 dx+arch
  // 合法、只是偏好序較差（如 dxvk 上一行雜散 'DirectX 12' 誤觸而點名 gptk）——
  // 也一律不換：不對能跑的設定折騰、更不把它降級成較差後端。
  //   - isCurrentAdequate 對 dx 未知回 false，故 dx 未知時仍信任 log 點名的方向。
  //   - rollup 已防呆 summary.suggestedBackend ≠ currentBackend。
  let target: GameContext['currentBackend'] | undefined
  let targetConfidence = 0

  if (!isCurrentAdequate(context, dx)) {
    if (summary.suggestedBackend) {
      // 步驟 3｜log 明說後端方向（且現用確實不適用）。
      target = summary.suggestedBackend
      targetConfidence =
        summary.topSignal?.confidence ?? CAPABILITY_ONLY_CONFIDENCE
    } else if (dx !== undefined) {
      // 步驟 4｜主動換後端（log 沒明說，§6.2 步驟2 的關鍵增值）。從免費後端挑
      // 偏好序最高者；crossover（商業）、wined3d（無翻譯保底）皆排除，永不作為
      // 主動 switch_backend 目標（對齊能力表「wined3d 預設不選為主動建議」）。
      const picked = pickBackend(context.arch, dx, [
        context.currentBackend,
        'crossover',
        'wined3d'
      ])
      if (picked) {
        target = picked
        // 較保守：topSignal 信心與能力表確定性取較小；無 signal 時用 [SEED] 0.7。
        targetConfidence = activeSwitchConfidence(summary.topSignal?.confidence)
      }
    }
  }
  // 現用後端已適用，或（dx 未知且 log 沒點名）→ 不換後端，留步驟 7 評估 needsAi。

  // ── 步驟 5｜log 來源 target 不合此 arch 的覆寫 ───────────────────────
  // 能到這一步代表現用後端已不適用（適用的話步驟 3 根本不會採納 log target）。
  // 若 log 點名的後端在此 dx+arch 不合法（如 Intel 上被誤點 dxmt），回退能力表
  // 挑合法的「免費翻譯」後端（排除 crossover/wined3d），挑不到才放棄。
  if (target && dx !== undefined && !supports(target, dx, context.arch)) {
    const fallback = pickBackend(context.arch, dx, [
      context.currentBackend,
      'crossover',
      'wined3d'
    ])
    target = fallback
    if (fallback)
      targetConfidence = activeSwitchConfidence(summary.topSignal?.confidence)
  }

  // ── 步驟 5b｜產生 switch_backend / Steam 提示（gate + Steam 分流）─────
  // gate：target 存在、target ≠ 現用後端、且在此 dx+arch 合法（dx 未知時放行）。
  if (target) {
    // dx 未知但 log 點名後端時，以 log 方向為準（無 dx 不過 supports 閘，故下方放行）。
    const gatePassed =
      target !== context.currentBackend &&
      (dx === undefined ? true : supports(target, dx, context.arch))

    if (gatePassed) {
      // 32-bit DX11 on Apple Silicon（§5 最糟組合）：降信心 + 標 WoW64 摩擦，不判死。
      const worstCombo =
        context.is32bit === true && dx === 11 && context.arch === 'arm64'
      const finalConfidence = worstCombo
        ? Math.max(0, targetConfidence - 0.2)
        : targetConfidence

      if (isSteamLocked) {
        // §11：Windows Steam 客戶端鎖後端 → 不自動換，改提示另裝第二套 Steam。
        result.actions.push({
          kind: 'none',
          params: { suggestedBackend: target },
          reason: `此遊戲在 Windows Steam 客戶端內，Steam 後端已鎖定（改後端會弄壞 Steam）；請另以 ${target} 後端安裝第二套 Steam`,
          autoApplyable: false,
          confidence: finalConfidence
        })
      } else {
        result.actions.push({
          kind: 'switch_backend',
          // 【鍵名鎖定】params.backend = 目標後端（對齊 AiAssistantPanel.tsx 第293行）。
          params: {
            backend: target,
            from: context.currentBackend,
            directxVersion: dx,
            arch: context.arch
          },
          reason: switchReason(context, dx, target, worstCombo),
          autoApplyable: false,
          confidence: finalConfidence
        })
      }
      result.verdict = mergeVerdict(result.verdict, 'needs_backend_change')
      // 最糟組合：附 needsAi 讓 AI 補充評估是否改 dxvk。
      if (worstCombo) result.needsAi = true
    }
  } else if (
    dx !== undefined &&
    context.arch === 'x86_64' &&
    !supports(context.currentBackend, dx, context.arch)
  ) {
    // Intel Mac + 無免費後端（典型 DX12）：pickBackend 排除 crossover 後回 undefined。
    // 仍提示「可考慮商業 crossover」（kind:'none'，autoApplyable 恆 false）。
    // 這是免費後端的死局，交 AI 補充評估（needsAi=true，§7 步驟7「可為 true」）。
    if (supports('crossover', dx, context.arch)) {
      result.actions.push({
        kind: 'none',
        params: { suggestedBackend: 'crossover' },
        reason: `Intel Mac 上 DirectX ${dx} 沒有免費翻譯後端可用；可考慮商業方案 CrossOver`,
        autoApplyable: false,
        confidence: CAPABILITY_ONLY_CONFIDENCE
      })
      // 現用後端在此 dx+arch 不合法 → verdict 至少為 needs_backend_change，
      // 不可停在種子 launched_ok（否則「乾淨啟動」卻同時叫你換商業後端，矛盾）。
      result.verdict = mergeVerdict(result.verdict, 'needs_backend_change')
      result.needsAi = true
    }
  }

  // ── 步驟 6｜消費 winetricks 與 os_mismatch（可與換後端並存）──────────
  // (6a) winetricks（analyzer 已對應好且去重，引擎不重算）。唯一預設 autoApplyable=true。
  for (const verb of summary.suggestedWinetricks) {
    result.actions.push({
      kind: 'install_winetricks',
      params: { verb },
      reason: winetricksReason(analysis, verb),
      autoApplyable: true,
      confidence: winetricksConfidence(analysis)
    })
    result.verdict = mergeVerdict(result.verdict, 'recoverable')
  }

  // (6b) os_mismatch + Sonoma(14.x) 或更舊 → 升級提示（kind:'none'，純提示不可代行）。
  // 此提示是 DXMT 專屬（Metal 3.2 shader intrinsic 問題），僅當現用後端為 dxmt
  // 才相關：Intel Mac 跑不了 dxmt、現用 dxvk 的使用者升級 OS 也與此無關，故加
  // currentBackend==='dxmt' 守衛，避免對非 DXMT 使用者顯示無意義的升級建議。
  const osSig = analysis.signals.find((s) => s.category === 'os_mismatch')
  if (
    osSig &&
    context.currentBackend === 'dxmt' &&
    isSonomaOrOlder(context.osVersion)
  ) {
    result.actions.push({
      kind: 'none',
      params: {},
      reason:
        'DXMT 在 macOS Sonoma 的 Metal 3.2 shader intrinsic 相容問題，建議升級至 Sequoia(15+) 以上',
      autoApplyable: false,
      confidence: osSig.confidence
    })
    result.verdict = mergeVerdict(result.verdict, 'recoverable')
  }

  // ── 步驟 7｜收斂 needsAi + verdict 一致性（§6.2 步驟5）──────────────
  // (a) verdict 仍為 unknown → 交 AI。
  if (result.verdict === 'unknown') result.needsAi = true

  // (b) needs_backend_change 必須有「後端動作」支撐（switch_backend，或帶
  //     suggestedBackend 的 none 提示＝Steam 鎖 / crossover）。否則該「要換後端」
  //     的判斷懸空（例：device_init_failure 不帶 suggestedBackend、現用後端又
  //     已適用，產不出 switch）——此時若另有可套用修正（winetricks/dxvk）則降為
  //     recoverable，否則降為 unknown，並一律交 AI 評估那個懸空的後端問題。
  //     這補上「零動作守衛」漏接的『動作存在但種類不對應 verdict』矛盾。
  const hasBackendAction = result.actions.some(
    (a) =>
      a.kind === 'switch_backend' ||
      (a.kind === 'none' && a.params.suggestedBackend !== undefined)
  )
  if (result.verdict === 'needs_backend_change' && !hasBackendAction) {
    const hasFix = result.actions.some(
      (a) => a.kind === 'install_winetricks' || a.kind === 'install_dxvk'
    )
    result.verdict = hasFix ? 'recoverable' : 'unknown'
    result.needsAi = true
  }

  // (c) 有訊號卻走完 1~6 零具體動作：代表沒有確定性修正。verdict 不該停在
  //     recoverable / needs_backend_change（型別語義要求「有可套用修正」），
  //     降為 unknown 並交 AI，於步驟 8 補占位，使 verdict / needsAi / 動作三者一致。
  //     launched_ok（含純效能提示）與 incompatible（反作弊，前者步驟1已 return）
  //     不在此降級——它們零動作是合理終態。
  if (
    analysis.signals.length > 0 &&
    result.actions.length === 0 &&
    result.verdict !== 'launched_ok' &&
    result.verdict !== 'incompatible'
  ) {
    result.verdict = 'unknown'
    result.needsAi = true
  }

  // ── 步驟 8｜收尾保證 + 排序去重 ────────────────────────────────────
  // unknown 且零動作（needsAi 情境）→ 補占位，確保 UI 永遠有可顯示內容。
  // launched_ok（乾淨啟動，含純效能提示）不補占位，actions 維持 []。
  if (result.actions.length === 0 && result.verdict === 'unknown') {
    result.actions.push({
      kind: 'none',
      params: {},
      reason: '尚無確定性修正，交由 AI 進一步看 evidence',
      autoApplyable: false,
      confidence: 0
    })
  }

  result.actions = dedupe(result.actions).sort(byKindOrder)

  return result
}

// ── 小工具（皆純函式）────────────────────────────────────────────

/**
 * 此 dx+arch 下偏好序最高的「免費」後端（排除商業 crossover）。
 * 用來判斷現用後端是否已是最佳免費解；無免費解時回 undefined。
 * 與 pickBackend(arch, dx, [..., 'crossover']) 的 exclude 一致，確保
 * 「adequate 判定」與「實際挑選的 target」基於同一張免費後端偏好序。
 */
function bestFreeBackend(
  dx: DirectXVersion,
  arch: GameContext['arch']
): GameContext['currentBackend'] | undefined {
  for (const backend of candidatesFor(dx, arch)) {
    if (backend !== 'crossover') return backend
  }
  return undefined
}

/**
 * 現用後端在此 dx 下是否「已經夠好、不需主動換」。
 *
 *   - dx 未知 → 無從斷定適用，回 false（不臆測現用後端 OK）。
 *   - 不支援此 dx+arch → false（必換）。
 *   - 現用為 wined3d（無翻譯保底）且同 dx+arch 下有更佳免費翻譯後端 → false
 *     （該升級掉；對齊能力表「wined3d 只在所有翻譯後端皆排除時的最後手段」）。
 *   - 其餘（翻譯後端且支援）→ true：刻意不在翻譯後端之間互推（dxvk↔dxmt），
 *     避免對能跑的設定無謂折騰。
 */
function isCurrentAdequate(
  context: GameContext,
  dx: DirectXVersion | undefined
): boolean {
  if (dx === undefined) return false
  if (!supports(context.currentBackend, dx, context.arch)) return false
  if (context.currentBackend === 'wined3d') {
    const best = bestFreeBackend(dx, context.arch)
    if (best !== undefined && best !== 'wined3d') return false
  }
  return true
}

/**
 * 主動換後端（能力表來源）的信心：topSignal 信心與能力表確定性取較小；
 * 無 signal 時用 [SEED] 0.7。集中於此免兩處步驟各寫一遍而漂移。
 */
function activeSwitchConfidence(signalConfidence: number | undefined): number {
  return signalConfidence !== undefined
    ? Math.min(signalConfidence, CAPABILITY_ONLY_CONFIDENCE)
    : CAPABILITY_ONLY_CONFIDENCE
}

/** switch_backend 的人話理由。 */
function switchReason(
  context: GameContext,
  dx: DirectXVersion | undefined,
  target: string,
  worstCombo: boolean
): string {
  const cur = context.currentBackend
  const dxLabel = dx !== undefined ? `DirectX ${dx}` : '此遊戲的圖形需求'

  // context 自相矛盾（如 x86_64 卻在用 dxmt）：明說偵測到不合理組合。
  if (dx !== undefined && !supports(cur, dx, context.arch)) {
    const archMismatch = isArchMismatch(cur, context)
    if (archMismatch) {
      return `偵測到不合理的後端/晶片組合（${context.arch} 上用 ${cur}）；${dxLabel}建議改用 ${target}`
    }
  }

  const base = `${dxLabel}：現用 ${cur} 不適用，建議改用 ${target}`
  if (worstCombo) {
    return `${base}（注意：32-bit DX11 在 Apple Silicon 上 WoW64 摩擦較大，可能需 AI 進一步評估是否改用 dxvk）`
  }
  return base
}

/** 現用後端是否與 context.arch 不相容（資料異常偵測，純啟發式不查表也安全）。 */
function isArchMismatch(
  backend: GameContext['currentBackend'],
  context: GameContext
): boolean {
  if (context.arch === 'x86_64' && (backend === 'dxmt' || backend === 'gptk'))
    return true
  return false
}

/** 找出對應該 winetricks verb 的 missing_dependency 訊號 message。 */
function winetricksReason(analysis: LogAnalysis, verb: string): string {
  const sig = analysis.signals.find((s) => s.category === 'missing_dependency')
  return sig?.message ?? `安裝相依套件 ${verb}`
}

/** winetricks 動作信心取對應 missing_dependency 訊號的信心。 */
function winetricksConfidence(analysis: LogAnalysis): number {
  const sig = analysis.signals.find((s) => s.category === 'missing_dependency')
  return sig?.confidence ?? 0.5
}

/** 粗略判斷是否為 Sonoma(14.x) 或更舊。沿用 logAnalyzer 同邏輯（major ≤ 14）。 */
function isSonomaOrOlder(osVersion: string): boolean {
  const major = parseInt(osVersion.split('.')[0] ?? '', 10)
  return Number.isFinite(major) && major <= 14
}

/** 以 (kind + 主要 param：backend/verb) 去重。先出現者保留。 */
function dedupe(actions: RecommendedAction[]): RecommendedAction[] {
  const seen = new Set<string>()
  const out: RecommendedAction[] = []
  for (const act of actions) {
    const key = dedupeKey(act)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(act)
  }
  return out
}

function dedupeKey(act: RecommendedAction): string {
  if (act.kind === 'switch_backend')
    return `switch_backend:${String(act.params.backend)}`
  if (act.kind === 'install_winetricks')
    return `install_winetricks:${String(act.params.verb)}`
  // none 的提示型：以 suggestedBackend（若有）區隔 Steam/crossover 提示 vs 占位。
  if (act.kind === 'none')
    return `none:${String(act.params.suggestedBackend ?? '')}:${act.reason}`
  return `${act.kind}:${String(act.params.key ?? '')}`
}

/** 排序：switch_backend 在前 → install_winetricks → none（提示/占位）恆最後。穩定排序。 */
function byKindOrder(a: RecommendedAction, b: RecommendedAction): number {
  return KIND_ORDER[a.kind] - KIND_ORDER[b.kind]
}
