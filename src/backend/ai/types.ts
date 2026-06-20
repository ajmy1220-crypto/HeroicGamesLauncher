/**
 * types.ts
 * ------------------------------------------------------------------
 * Helmsman — 跨模組共用的型別單一真相源（藍圖 §7）。
 *
 * 依賴方向（單向、不可能成環）：
 *   types.ts ← logAnalyzer ← recommendationEngine ←（panel / ipc）
 *
 * 本檔【刻意維持純 type】：不 import 任何專案內模組、不帶任何 runtime 值，
 * 確保編譯後可被完整 erase（type-only）。需要 runtime 的共用序表（VERDICT_ORDER /
 * mergeVerdict）獨立放 verdict.ts，能力表型別放 backendCapabilities.ts，皆不污染此檔。
 *
 * 來源：
 *   - Severity / Layer / Backend / SignalCategory / Verdict /
 *     DetectedSignal / AnalysisSummary / LogAnalysis / AnalyzerContext
 *     原樣自 logAnalyzer.ts 搬入（Phase 1 型別下沉，形狀零變更）。
 *   - GameContext / RecommendedAction / Recommendation / CompatRecord
 *     對齊藍圖 §7 草案新增。
 */

// ── 可重用的字面聯集別名（消除散落的字面字串聯集）────────────────

/** 晶片架構。DXMT / GPTK 僅 arm64；Intel Mac 為 x86_64。 */
export type Arch = 'arm64' | 'x86_64'

/** Heroic 的 runner 種類（對齊 §7 與 AiAssistantPanel.tsx）。 */
export type Runner = 'legendary' | 'gog' | 'nile' | 'sideload'

/** DirectX 主版本（決策三軸之一）。 */
export type DirectXVersion = 9 | 10 | 11 | 12

// ── 列舉與基礎型別（自 logAnalyzer.ts 搬入，形狀零變更）──────────

export type Severity = 'fatal' | 'error' | 'warning' | 'info'

export type Layer = 'wine' | 'dxvk' | 'dxmt' | 'gptk' | 'game' | 'unknown'

export type Backend = 'wined3d' | 'dxvk' | 'dxmt' | 'gptk' | 'crossover'

export type SignalCategory =
  | 'missing_dependency' // 缺 DLL / 執行庫 → 裝 winetricks
  | 'device_init_failure' // 後端建立 D3D 裝置失敗 → 多半要換後端
  | 'unsupported_feature' // 後端做不到的功能（Stream-Output 等）
  | 'shader_failure' // airconv / shader 編譯或不支援
  | 'os_mismatch' // macOS 版本不符（DXMT 在 Sonoma 等）
  | 'anticheat' // 反作弊 → 通常無解
  | 'launcher_crash' // Epic Online Services 等啟動器崩潰
  | 'fatal_crash' // page fault / unhandled exception
  | 'performance' // 非失敗，但可調（PSO 快取、MetalFX、鎖幀）

export type Verdict =
  | 'launched_ok'
  | 'recoverable' // 有明確的可自動套用修正（裝 winetricks 等）
  | 'needs_backend_change' // 目前後端不行，建議換
  | 'incompatible' // 別再試了（反作弊、硬不支援）
  | 'unknown' // 規則沒抓到，丟給 AI 層去看 evidence

// ── 回傳給決策層的結構化物件（自 logAnalyzer.ts 搬入）─────────────

export interface DetectedSignal {
  /** 穩定 id，方便去重與測試，例如 'missing_dll'、'anticheat'。 */
  id: string
  category: SignalCategory
  severity: Severity
  layer: Layer
  /** 給人看的一句話描述。 */
  message: string
  /** 命中的原始 log 行（已截斷上限），供透明化與 AI prompt 使用。 */
  evidence: string[]
  /** 從 pattern 抓到的欄位，例如 { dll: 'd3dcompiler_47' }。 */
  detail?: Record<string, string>
  /** 0..1，pattern 命中的把握程度。 */
  confidence: number
}

export interface AnalysisSummary {
  verdict: Verdict
  /** 最值得決策層先處理的訊號。 */
  topSignal?: DetectedSignal
  /** 已預抽好的「桿」，決策層可直接拿去呼叫 Heroic 既有函式。 */
  suggestedWinetricks: string[]
  suggestedBackend?: Backend
  /** true 代表同一組設定不必重試（硬不相容）。 */
  blocking: boolean
}

export interface LogAnalysis {
  /** 解析了哪些來源（依命中的 layer 推得）。 */
  sources: Layer[]
  signals: DetectedSignal[]
  summary: AnalysisSummary
}

/** 呼叫端可帶入的環境脈絡，用來判斷 os_mismatch 等需要外部資訊的訊號。 */
export interface AnalyzerContext {
  /** macOS 版本字串，例如 '14.5'（Sonoma）、'15.1'（Sequoia）。 */
  osVersion?: string
  /** 目前使用的後端，用來推「DX12 跑在 DXMT 上」這類組合錯誤。 */
  currentBackend?: Backend
  /** 每個訊號最多保留幾行 evidence，避免之後塞爆 AI prompt。 */
  maxEvidencePerSignal?: number
}

// ── 決策層輸入：遊戲執行脈絡（藍圖 §7）────────────────────────────

export interface GameContext {
  appName: string
  runner: Runner
  currentBackend: Backend
  wineVersion: string
  /** macOS 版本，例 '15.1'。 */
  osVersion: string
  arch: Arch
  /** 可能未知（log 沒明說、上層也沒填）。 */
  directxVersion?: DirectXVersion
  is32bit?: boolean
  /**
   * [SEED][相對 §7 刻意新增] 此 sideload app 是否為「Windows Steam 客戶端」。
   *
   * 理由（§11 Steam 鎖後端）：§7 的 runner:'sideload' 無法區分
   * 「Windows Steam 客戶端 sideload」vs「一般 sideload」。要可靠地對 Steam
   * 客戶端鎖後端，必須有顯式布林，不可靠 appName 字串猜測。
   *
   * 真值來源：由上層（讀 Heroic sideload app 設定）注入，待對照 Heroic
   * live repo 的 sideload 結構核對。undefined / false 時退化為一般 sideload。
   */
  isWindowsSteamClient?: boolean
}

// ── 決策層產出（藍圖 §7）──────────────────────────────────────────

/**
 * 決策層產出的單一建議動作。
 *
 * 【params 鍵名鎖定 — 與 AiAssistantPanel.tsx actionTitle 對齊，不可改】：
 *   - switch_backend     → params.backend（目標後端，第293行讀 params.backend）
 *                          可選 params.from（現用後端，純供 UI 文案/log）
 *   - install_winetricks → params.verb（第296行）
 *   - change_setting     → params.key（第301行）
 * 改用 { from, to } 會讓既有 panel 顯示 undefined（panel 讀 params.backend）。
 */
export interface RecommendedAction {
  kind:
    | 'install_winetricks'
    | 'switch_backend'
    | 'install_dxvk'
    | 'reinstall_wine_variant'
    | 'install_steam'
    | 'change_setting'
    | 'none'
  params: Record<string, unknown>
  /** 人話，顯示在 UI。 */
  reason: string
  /** 是否可不問就套用（預設保守；僅 install_winetricks 預設 true）。 */
  autoApplyable: boolean
  /** 0..1。 */
  confidence: number
}

export interface Recommendation {
  verdict: Verdict
  actions: RecommendedAction[]
  /** true → 交 aiAdvisor 解釋 / 補判。 */
  needsAi: boolean
  /** true → 同組設定不必重試（硬不相容）。 */
  blocking: boolean
}

// ── 知識層紀錄（藍圖 §7；Phase 2 不用，集中以免 Phase 6 再動本檔）──

export interface CompatRecord {
  appName: string
  backend: Backend
  wineVersion: string
  winetricks: string[]
  env: Record<string, string>
  osVersion: string
  arch: Arch
  result: 'works' | 'works_with_issues' | 'broken'
  notes?: string
  /** ISO 時間字串。 */
  updatedAt: string
}
