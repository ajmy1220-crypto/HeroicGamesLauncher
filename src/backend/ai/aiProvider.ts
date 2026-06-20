/**
 * aiProvider.ts
 * ------------------------------------------------------------------
 * Helmsman — provider 無關的 LLM 契約介面（藍圖 §6.3）。
 *
 * aiAdvisor 只依賴此介面；每個廠商一個 adapter，要換廠商就換注入的 adapter，
 * 核心邏輯一行都不用動（與 heroicBridge / compatibilityStore 同樣的依賴注入分層）。
 *
 * 鐵律（§6.3 / §12）：
 *   - provider 無關、【不寫死】任一廠商。Bryan 是 Claude 重度使用者，預設走 Anthropic，
 *     但介面層不綁定。
 *   - 金鑰與邏輯留 Electron main process（後端側），不進 renderer。
 *   - LLM 產出一律視為「建議」，經使用者確認才套用，絕不靜默執行——此鐵律由 aiAdvisor
 *     強制（把 suggestedActions 的 autoApplyable 設 false），actionExecutor 確認閘再擋一層。
 *
 * 真實廠商 adapter 屬 Phase 5b（放後端、需金鑰），本輪只給介面 + 安全預設 notWiredProvider。
 */

import type { RecommendedAction } from './types';

// ── 契約型別 ──────────────────────────────────────────────────────

/** 一次 LLM 請求（provider 無關，由 aiAdvisor 組好）。 */
export interface AiRequest {
  /** system prompt：角色、規則、輸出格式說明。 */
  system: string;
  /** 使用者訊息：已組好的 evidence + 提問。 */
  user: string;
  /**
   * 可選：要求結構化輸出時的 JSON schema（描述 explanation + actions）。
   * adapter 各自把它對映到該廠商的結構化輸出機制（見下方指引）。
   */
  responseSchema?: Record<string, unknown>;
  /** 輸出 token 上限；未給時由 adapter 用預設。 */
  maxTokens?: number;
}

/** 一次 LLM 回應。 */
export interface AiResponse {
  /** 人話解釋（必有）。 */
  text: string;
  /**
   * 可選：結構化動作建議（原始，未經確認）。
   * aiAdvisor 會強制把每條的 autoApplyable 設 false（§12.9 絕不靜默套用）。
   */
  suggestedActions?: RecommendedAction[];
}

/** 廠商無關的 LLM provider 契約。 */
export interface AiProvider {
  /** 廠商名，如 'anthropic' | 'gemini' | 'ollama'。 */
  readonly name: string;
  /** 送一次請求，回人話 +（可選）結構化建議。 */
  complete(req: AiRequest): Promise<AiResponse>;
}

// ── 安全預設：未設定 provider 即大聲失敗 ──────────────────────────

/**
 * 尚未注入真實 provider 時的預設：每次呼叫都 reject（像 heroicBridge 的 notWiredBridge）。
 * 確保上層忘了設定 provider 時立刻失敗，而非靜默假裝有 AI。
 */
export const notWiredProvider: AiProvider = {
  name: 'not-wired',
  complete() {
    return Promise.reject(
      new Error('尚未設定 AI provider（Phase 5b 待接 Anthropic / Gemini / 本地 adapter）'),
    );
  },
};

// ── 各廠商 adapter 實作指引（Phase 5b）────────────────────────────
//
// ⚠ 以下 adapter 皆屬 Phase 5b：放 Electron main process（金鑰留後端），各自實作
//   AiProvider.complete（把 AiRequest 轉成該廠商 API、回 AiResponse）。差異全藏這層，
//   aiAdvisor 不變。
//
// 【Anthropic（預設，藍圖建議）】——以下對照當前 Claude API 事實（非從記憶猜）：
//   - SDK：官方 `@anthropic-ai/sdk`（TS 專案用這個，勿用 OpenAI-compatible shim）。
//   - model：預設 'claude-opus-4-8'（最新 Opus；model id 為【裸字串】，不加日期後綴）。
//   - 基本呼叫：client.messages.create({ model, max_tokens, system: req.system,
//       messages: [{ role: 'user', content: req.user }] })。system 是 top-level 參數。
//   - 結構化輸出：req.responseSchema 存在時帶
//       output_config: { format: { type: 'json_schema', schema: req.responseSchema } }
//       （這是當前正規參數；舊的 output_format 已棄用）。回應第一個 text block 即合法 JSON。
//   - thinking：Opus 4.8 用 adaptive（thinking: { type: 'adaptive' }）；【不要】用
//       budget_tokens（已移除，會 400）；temperature/top_p/top_k 同樣已移除。
//   - 安全：先檢查 response.stop_reason === 'refusal' 再讀 content（refused 時 content 可能為空）。
//   - max_tokens：非串流預設 ~16000；大輸出改用 client.messages.stream(...)（避免 SDK HTTP timeout）。
//   - 金鑰：client 預設讀環境變數 ANTHROPIC_API_KEY，【不要寫死】。
//
// 【Gemini】google-genai：generateContent + responseSchema（structured output）。
// 【本地（Ollama 等）】HTTP /api/chat + format:'json'；離線可跑、無金鑰。
