/**
 * logAnalyzer.ts
 * ------------------------------------------------------------------
 * Heroic AI 編排層 — 第一個原型模組。
 *
 * 職責（且僅此職責）：
 *   吃遊戲執行時的 stderr 純文字（Wine + DXVK + DXMT 交錯輸出），
 *   用確定性的 pattern 比對，回傳一個結構化的 LogAnalysis 物件。
 *
 * 它「不」做的事：
 *   - 不呼叫任何 LLM / AI provider
 *   - 不安裝任何東西、不改任何設定、不啟動任何行程
 *   這些都交給下游的決策層與 Heroic 既有的工具函式。
 *
 * 設計原則（hook 哲學）：
 *   確定性的訊號抽取 = 規則層（這個檔案）。
 *   需要詮釋的決策     = AI 層（消費這個檔案的回傳值）。
 *
 * ⚠ 校準須知：
 *   下方規則表中標 [VERIFIED] 的是格式公開、穩定的（Wine debug channel、
 *   DXVK 訊息）。標 [SEED] 的是依據 DXMT 已知行為種下的猜測 pattern，
 *   尚未對逐字 log 校準。正式使用前，請拿真實的 app_d3d11.log /
 *   app_dxgi.log 比對並修正這些 RegExp。不要把 [SEED] 當成已驗證字串。
 */

// ── 型別：單一真相源已下沉到 ./types（Phase 1）────────────────────
//
// 既有型別（Severity / Layer / Backend / SignalCategory / Verdict /
// DetectedSignal / AnalysisSummary / LogAnalysis / AnalyzerContext）已原樣
// 搬入 ./types，形狀零變更。此處：
//   1. import type 供本檔內部使用；
//   2. 於檔尾 re-export 同名型別，維持既有 import 路徑相容
//      （tests 的 `from '../src/backend/ai/logAnalyzer'`、其他模組沿用不變）。

// 註：Backend 在本檔內部已無直接引用（suggestedBackend 屬 AnalysisSummary），
// 故不在此 import，僅於下方 re-export 區段對外轉出，避免 noUnusedLocals 報未使用。
// Verdict 則在 rollup 的 verdict 合併（merged 累積器）內部使用，需 import。
import type {
  AnalysisSummary,
  AnalyzerContext,
  DetectedSignal,
  Layer,
  LogAnalysis,
  Severity,
  SignalCategory,
  Verdict
} from './types'

import { mergeVerdict } from './verdict'

// 向後相容：保留既有 `from '.../logAnalyzer'` 取型別的呼叫端不需改動。
export type {
  AnalysisSummary,
  AnalyzerContext,
  Backend,
  DetectedSignal,
  Layer,
  LogAnalysis,
  Severity,
  SignalCategory,
  Verdict
} from './types'

// ── 規則表（資料驅動，方便日後校準）──────────────────────────────

interface SignalRule {
  id: string
  category: SignalCategory
  severity: Severity
  layer: Layer
  /** 任一 pattern 命中即觸發。 */
  patterns: RegExp[]
  /** 把第一個命中的 match 轉成 detail 欄位。 */
  extract?: (m: RegExpMatchArray) => Record<string, string>
  confidence: number
  /** 這個訊號對決策層的隱含建議（會被彙整進 summary）。 */
  hint?: Partial<Omit<AnalysisSummary, 'topSignal'>>
  /** 描述產生器（可用 detail 補字）。 */
  describe: (detail?: Record<string, string>) => string
}

const RULES: SignalRule[] = [
  // ── 反作弊：最該先攔，攔到就別浪費 retry ──────────────────────
  {
    id: 'anticheat',
    category: 'anticheat',
    severity: 'fatal',
    layer: 'game',
    // [VERIFIED] 這些是業界通用的字串，跨平台都會出現
    patterns: [
      /BattlEye/i,
      /EasyAntiCheat|\bEAC\b/i,
      /Denuvo/i,
      /nProtect|GameGuard/i
    ],
    confidence: 0.9,
    hint: { verdict: 'incompatible', blocking: true },
    describe: () =>
      '偵測到反作弊元件（BattlEye / EAC / Denuvo 等），Wine 環境下通常無法執行'
  },

  // ── 缺 DLL / 執行庫：Wine debug channel ──────────────────────
  {
    id: 'missing_dll',
    category: 'missing_dependency',
    severity: 'error',
    layer: 'wine',
    // [VERIFIED] Wine 格式穩定：<tid>:err:module:import_dll ... L"xxx.dll"
    patterns: [
      /err:module:.*?(?:import_dll|load_dll|find_dll).*?["L]?([\w.+-]+\.dll)/i,
      /wine:\s*cannot find\s+["L]?([^"'\s]+)/i
    ],
    extract: (m) => ({ dll: (m[1] || '').toLowerCase().replace(/\.dll$/, '') }),
    confidence: 0.8,
    hint: { verdict: 'recoverable' },
    describe: (d) =>
      `缺少程式庫：${d?.dll ?? '(未知)'}，多半可用 winetricks 補上`
  },

  // ── .NET / VCRedist 這類最常見的執行庫缺漏 ──────────────────
  {
    id: 'missing_runtime',
    category: 'missing_dependency',
    severity: 'error',
    layer: 'wine',
    // [VERIFIED] 元件名稱固定；對應 winetricks verb 也固定
    patterns: [
      /mscoree|mscorwks|\.NET Framework/i,
      /vcruntime\d*|msvcp\d+|VCRUNTIME/i,
      /d3dcompiler_\d+/i
    ],
    confidence: 0.7,
    hint: { verdict: 'recoverable' },
    describe: () =>
      '缺少常見執行庫（.NET / VCRedist / d3dcompiler），通常可一鍵補裝'
  },

  // ── DXVK：建立 D3D 裝置失敗（最常見的「跑不起來」）─────────
  {
    id: 'dxvk_device_required',
    category: 'device_init_failure',
    severity: 'error',
    layer: 'dxvk',
    // [VERIFIED] 這句是遊戲引擎在 D3D11 裝置建立失敗時的標準訊息
    patterns: [
      /D3D11-?Compatible GPU.*required/i,
      /Failed to create.*D3D(11|12).*device/i,
      /feature level 11.*required|shader model 5\.0.*required/i
    ],
    confidence: 0.75,
    hint: { verdict: 'needs_backend_change' },
    describe: () =>
      'D3D 裝置建立失敗（多半是後端或 feature level 不符），建議改用其他圖形後端'
  },

  // ── 把 DX12 跑在只支援 DX10/11 的後端上（DXMT/DXVK-macOS）──
  {
    id: 'dx12_on_dx11_backend',
    category: 'unsupported_feature',
    severity: 'error',
    layer: 'dxmt',
    // [SEED] 需依實際 log 校準；DXMT/DXVK-macOS 只支援到 DX11
    patterns: [/d3d12|D3D12CreateDevice|DirectX 12/i],
    confidence: 0.55,
    // 注意：是否真要換 GPTK，交給下游結合 currentBackend 判斷
    hint: { verdict: 'needs_backend_change', suggestedBackend: 'gptk' },
    describe: () =>
      '偵測到 DirectX 12 需求；DXMT / DXVK-macOS 只支援到 DX11，需改用 GPTK'
  },

  // ── 把 D3D9 跑在 DXMT 上（DXMT 只做 D3D11/D3D10）─────────────
  {
    id: 'd3d9_on_dxmt',
    category: 'unsupported_feature',
    severity: 'error',
    layer: 'dxmt',
    // [VERIFIED] D3D9 的 API/元件名稱固定（Direct3DCreate9 等）；
    //            DXMT 不支援 D3D9 為官方確認。確切 log 行仍建議校準。
    patterns: [
      /d3d9(?:\.dll)?|Direct3DCreate9(?:Ex)?|IDirect3D(?:Device)?9|DirectX 9/i
    ],
    confidence: 0.6,
    // 注意：是否真要換 DXVK，交給下游結合 currentBackend 判斷
    // （若本來就在 DXVK-macOS 上，rollup 會擋掉這個多餘建議）
    hint: { verdict: 'needs_backend_change', suggestedBackend: 'dxvk' },
    describe: () =>
      '偵測到 DirectX 9 需求；DXMT 不支援 D3D9，建議改用 DXVK-macOS（支援到 DX9）'
  },

  // ── DXMT：不支援的功能（Stream-Output 等）────────────────────
  {
    id: 'dxmt_unsupported_feature',
    category: 'unsupported_feature',
    severity: 'error',
    layer: 'dxmt',
    // [SEED] 依 DXMT 公開討論中提到的限制種下，未對逐字 log 校準
    patterns: [
      /[Ss]tream.?[Oo]utput.*(?:not|unsupported)/,
      /[Tt]essellation.*(?:not|unsupported|partial)/,
      /\bunsupported\b.*(?:feature|capability)/i
    ],
    confidence: 0.5,
    hint: { verdict: 'needs_backend_change' },
    describe: () =>
      'DXMT 尚未支援此功能（如 Stream-Output / 部分 tessellation），可改試其他後端'
  },

  // ── DXMT / 通用：shader 不支援或 airconv 失敗 ────────────────
  {
    id: 'shader_unsupported',
    category: 'shader_failure',
    severity: 'error',
    layer: 'dxmt',
    // [SEED] 'airconv' 是 DXMT 的 shader 轉譯子專案，名稱可靠；
    //        確切錯誤字串待校準。後段是通用引擎訊息 [VERIFIED]。
    patterns: [
      /airconv.*(?:fail|error|unsupported)/i,
      /[Ss]hader.*(?:not supported|unsupported|compile.*fail)/
    ],
    confidence: 0.5,
    hint: { verdict: 'needs_backend_change' },
    describe: () =>
      'Shader 編譯失敗或不支援（DXMT airconv 轉譯問題），可能造成崩潰或算繪錯誤'
  },

  // ── DXMT：macOS 版本不符（Sonoma 的 Metal 3.2 intrinsic）────
  {
    id: 'dxmt_os_mismatch',
    category: 'os_mismatch',
    severity: 'warning',
    layer: 'dxmt',
    // [SEED] 依官方 changelog 描述種下；確切 log 字串待校準。
    //        實際判斷也會在 rollup 用 context.osVersion 補強。
    patterns: [/Metal 3\.2.*intrinsic/i, /Sonoma.*(?:no-?op|unsupported)/i],
    confidence: 0.4,
    hint: { verdict: 'recoverable' },
    describe: () =>
      'DXMT 在 macOS Sonoma 上有 Metal 3.2 shader intrinsic 的相容問題，建議升級到 Sequoia 以上'
  },

  // ── 啟動器崩潰：Epic Online Services ─────────────────────────
  {
    id: 'eos_crash',
    category: 'launcher_crash',
    severity: 'error',
    layer: 'game',
    // [SEED] 名稱可靠（EOSSDK），確切崩潰字串待校準
    patterns: [/Epic Online Services|EOSSDK|EOS_Initialize/i],
    confidence: 0.5,
    hint: { verdict: 'recoverable' },
    describe: () =>
      '偵測到 Epic Online Services；舊版 DXMT 曾導致從 Epic 啟動的遊戲崩潰，請確認後端為新版'
  },

  // ── 致命崩潰：page fault / unhandled exception ───────────────
  {
    id: 'fatal_crash',
    category: 'fatal_crash',
    severity: 'fatal',
    layer: 'wine',
    // [VERIFIED] Wine 的崩潰輸出格式固定
    patterns: [
      /wine:\s*Unhandled (?:exception|page fault)/i,
      /Unhandled exception:.*code [0-9a-fx]+/i,
      /:err:seh:/i
    ],
    confidence: 0.6,
    hint: { verdict: 'unknown' }, // 崩潰原因多端，交給 AI 層看完整 evidence
    describe: () =>
      '行程因未處理的例外或 page fault 崩潰，需結合上文 evidence 進一步判斷'
  },

  // ── 效能訊號（非失敗，可調）：PSO / shader 快取卡頓 ─────────
  {
    id: 'pso_stutter',
    category: 'performance',
    severity: 'info',
    layer: 'dxmt',
    // [SEED] 依 DXMT changelog 對 PSO 快取的描述種下
    patterns: [/PSO.*compil/i, /shader.*cache/i, /pipeline state.*compil/i],
    confidence: 0.35,
    hint: { verdict: 'launched_ok' }, // 能跑，只是體驗可優化
    describe: () =>
      '偵測到 PSO / shader 快取相關訊息：首次執行的卡頓多半會在後續啟動改善'
  }
]

// ── 主函式 ────────────────────────────────────────────────────────

const DEFAULT_MAX_EVIDENCE = 5

/**
 * 解析 stderr 純文字，回傳結構化的 LogAnalysis。
 * 純函式：相同輸入永遠回傳相同結果，無副作用。
 */
export function analyze(
  raw: string,
  context: AnalyzerContext = {}
): LogAnalysis {
  const maxEvidence = context.maxEvidencePerSignal ?? DEFAULT_MAX_EVIDENCE
  const lines = raw.split(/\r?\n/)

  // 用 Map 去重並累積 evidence。去重 key 通常為 rule.id，但對「會抽出可區分
  // 細項」的規則（目前只有 missing_dll 抽出 detail.dll），key 納入該細項，
  // 讓不同缺失 DLL（如 d3dcompiler_47 與 vcruntime140）各成獨立訊號——否則
  // 第二個 DLL 只會被併為第一個的 evidence，suggestedWinetricks 漏掉對應 verb。
  // 訊號的 id 欄位仍維持 rule.id（測試以 id 尋訊號的行為不變）。
  const found = new Map<string, DetectedSignal>()

  for (const line of lines) {
    if (!line.trim()) continue
    for (const rule of RULES) {
      let match: RegExpMatchArray | null = null
      for (const p of rule.patterns) {
        match = line.match(p)
        if (match) break
      }
      if (!match) continue

      const detail = rule.extract ? rule.extract(match) : undefined
      const key = detail?.dll ? `${rule.id}:${detail.dll}` : rule.id

      const existing = found.get(key)
      if (existing) {
        if (existing.evidence.length < maxEvidence)
          existing.evidence.push(line.trim())
        continue
      }

      found.set(key, {
        id: rule.id,
        category: rule.category,
        severity: rule.severity,
        layer: rule.layer,
        message: rule.describe(detail),
        evidence: [line.trim()],
        detail,
        confidence: rule.confidence
      })
    }
  }

  const signals = [...found.values()].sort(bySeverityThenConfidence)
  const sources = [...new Set(signals.map((s) => s.layer))]
  const summary = rollup(signals, context)

  return { sources, signals, summary }
}

// ── 彙整：把訊號滾成決策層要的 summary ───────────────────────────

function rollup(
  signals: DetectedSignal[],
  context: AnalyzerContext
): AnalysisSummary {
  const summary: AnalysisSummary = {
    verdict: 'launched_ok',
    suggestedWinetricks: [],
    blocking: false
  }
  if (signals.length === 0) return summary

  const top = signals[0]
  summary.topSignal = top

  // verdict 由各規則 hint 「取最嚴重者」推導，【不】用 'unknown' 當合併種子。
  // 若用 'unknown' 種子，純效能訊號（pso_stutter，hint=launched_ok，rank 4）
  // 會被 unknown(rank 3) 壓過而錯標 unknown；改成只 reduce 實際 hint verdict，
  // 讓「能跑、只是可優化」如實收斂為 launched_ok。所有規則皆帶 hint.verdict，
  // 故 merged 幾乎必有值；保險起見無任何 hint verdict 時才退回 'unknown'。
  let merged: Verdict | undefined
  for (const sig of signals) {
    const rule = RULES.find((r) => r.id === sig.id)
    const hint = rule?.hint
    if (!hint) continue
    if (hint.blocking) summary.blocking = true
    // 不要建議切換到「本來就在用」的後端
    // （例如 D3D9 跑在 DXVK-macOS 上時，別再叫你換 DXVK）。
    if (
      hint.suggestedBackend &&
      !summary.suggestedBackend &&
      hint.suggestedBackend !== context.currentBackend
    ) {
      summary.suggestedBackend = hint.suggestedBackend
    }
    if (hint.verdict) {
      merged =
        merged === undefined ? hint.verdict : mergeVerdict(merged, hint.verdict)
    }
  }
  summary.verdict = merged ?? 'unknown'

  // 把缺漏的程式庫對應成 winetricks verb（決策層可直接拿去裝）。
  for (const sig of signals) {
    if (sig.category !== 'missing_dependency') continue
    const verb = toWinetricksVerb(sig)
    if (verb && !summary.suggestedWinetricks.includes(verb)) {
      summary.suggestedWinetricks.push(verb)
    }
  }

  // os_mismatch 用實際 osVersion 補強信心：真的在 Sonoma 才升級到 warning。
  const osSig = signals.find((s) => s.category === 'os_mismatch')
  if (osSig && context.osVersion && isSonomaOrOlder(context.osVersion)) {
    osSig.confidence = Math.max(osSig.confidence, 0.8)
  }

  return summary
}

// ── 小工具 ────────────────────────────────────────────────────────

const SEVERITY_ORDER: Record<Severity, number> = {
  fatal: 0,
  error: 1,
  warning: 2,
  info: 3
}

function bySeverityThenConfidence(
  a: DetectedSignal,
  b: DetectedSignal
): number {
  const s = SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]
  return s !== 0 ? s : b.confidence - a.confidence
}

// 注意：VERDICT_ORDER 與 mergeVerdict 已抽到 ./verdict（單一真相源），
// 由 logAnalyzer 與 recommendationEngine 共用同一張序表，杜絕兩份漂移。

/** 把缺漏的程式庫粗略對應到 winetricks verb。對應表日後可外移成設定。 */
function toWinetricksVerb(sig: DetectedSignal): string | null {
  const dll = sig.detail?.dll ?? ''
  if (/d3dcompiler/.test(dll)) return 'd3dcompiler_47'
  if (/vcruntime|msvcp/.test(dll)) return 'vcrun2022'
  if (/mscoree|mscorwks/.test(dll)) return 'dotnet48'
  // missing_runtime 規則沒抓到 dll 名時，回傳 null，交給 AI 層判斷。
  return null
}

/** 粗略判斷是否為 Sonoma(14.x) 或更舊。Sequoia 是 15.x。 */
function isSonomaOrOlder(osVersion: string): boolean {
  const major = parseInt(osVersion.split('.')[0] ?? '', 10)
  return Number.isFinite(major) && major <= 14
}
