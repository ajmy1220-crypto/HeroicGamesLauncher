/**
 * anthropicProvider.ts
 * ------------------------------------------------------------------
 * Helmsman — AiProvider 的 Anthropic adapter（Phase 5b 預設 provider）。
 *
 * 實作 aiProvider.ts 的 AiProvider 契約：把 provider 無關的 AiRequest 轉成 Anthropic
 * Messages API 呼叫、回 AiResponse。所有「Anthropic 專屬」的差異藏在這一層；aiAdvisor 不變。
 *
 * 對照當前 Claude API（@anthropic-ai/sdk 0.105.0，依官方型別寫，非從記憶猜）：
 *   - model 預設 'claude-opus-4-8'（Model 型別聯集含此裸字串）。
 *   - 結構化輸出：output_config.format = { type:'json_schema', schema }（當前正規參數）。
 *   - thinking：Opus 4.8 用 adaptive（{ type:'adaptive' }）；budget_tokens 已移除。
 *   - 安全：stop_reason === 'refusal' 時拒絕（content 可能為空）→ 拋錯。
 *   - 金鑰：new Anthropic() 讀環境變數 ANTHROPIC_API_KEY，【不寫死】。
 *
 * 分層：buildCreateParams / parseResponse 為純函式（可用假物件測試，不碰網路/金鑰）；
 * createAnthropicProvider 是注入 client 的薄膠合層（測試注入假 client）。
 */

import Anthropic from '@anthropic-ai/sdk';

import type { AiProvider, AiRequest, AiResponse } from './aiProvider';
import type { RecommendedAction } from './types';

// ── 常數 ──────────────────────────────────────────────────────────

/** 預設 model（藍圖建議走 Anthropic；最新 Opus）。 */
export const DEFAULT_MODEL = 'claude-opus-4-8';

/** 非串流輸出 token 上限預設（對齊當前 Claude API 建議）。 */
const DEFAULT_MAX_TOKENS = 16000;

/** RecommendedAction 的合法 kind（用來過濾 LLM 回的動作）。 */
const VALID_KINDS: ReadonlySet<RecommendedAction['kind']> = new Set([
  'install_winetricks',
  'switch_backend',
  'install_dxvk',
  'reinstall_wine_variant',
  'install_steam',
  'change_setting',
  'none',
]);

// ── 注入點：此 adapter 需要的 client 最小子集 ─────────────────────

/** 便於測試注入假 client：只需 messages.create。 */
export interface AnthropicMessagesClient {
  messages: {
    create(params: Anthropic.MessageCreateParamsNonStreaming): Promise<Anthropic.Message>;
  };
}

export interface AnthropicProviderOptions {
  /** 注入的 client；預設 new Anthropic()（讀 ANTHROPIC_API_KEY）。測試注入假物件。 */
  client?: AnthropicMessagesClient;
  /** 覆寫 model，預設 DEFAULT_MODEL。 */
  model?: string;
  /** 覆寫 max_tokens 預設。 */
  maxTokens?: number;
}

// ── 純函式：組請求參數 ────────────────────────────────────────────

/**
 * 把 AiRequest 組成 Anthropic Messages API 的 create 參數（純函式）。
 * req.responseSchema 存在 → 帶 output_config.format（要求結構化 JSON 輸出）。
 */
export function buildCreateParams(
  req: AiRequest,
  model: string,
  maxTokens: number,
): Anthropic.MessageCreateParamsNonStreaming {
  const params: Anthropic.MessageCreateParamsNonStreaming = {
    model,
    max_tokens: req.maxTokens ?? maxTokens,
    system: req.system,
    messages: [{ role: 'user', content: req.user }],
    thinking: { type: 'adaptive' },
  };
  if (req.responseSchema) {
    params.output_config = { format: { type: 'json_schema', schema: req.responseSchema } };
  }
  return params;
}

// ── 純函式：解析回應 ──────────────────────────────────────────────

/** parseResponse 需要的 Message 最小子集（Anthropic.Message 結構上滿足之）。 */
interface MessageLike {
  stop_reason: string | null;
  content: ReadonlyArray<{ type: string; text?: string }>;
}

/**
 * 把 Anthropic 回應解析成 AiResponse（純函式）。
 *   - stop_reason 'refusal' → 拋錯（安全分類器拒絕；content 可能為空）。
 *   - 取第一個 text block。
 *   - structured（有送 responseSchema）→ text 為 JSON {explanation, actions}：
 *     取 explanation 當人話、actions map 成 RecommendedAction（autoApplyable 設 false）。
 *     解析不出預期形狀時，保守退回「把 text 當解釋、無動作」（不 crash）。
 *   - 非 structured → text 即解釋，無動作。
 */
export function parseResponse(message: MessageLike, structured: boolean): AiResponse {
  if (message.stop_reason === 'refusal') {
    throw new Error('Claude 安全分類器拒絕了此請求（stop_reason: refusal）');
  }

  // 先取 text block 本身：缺 block 才算「不含 text block」；block 存在但 .text 缺
  // （理論上不會，SDK TextBlock.text 必有）則視為空字串，不再誤報。
  const block = message.content.find((b) => b.type === 'text');
  if (!block) {
    throw new Error('Anthropic 回應不含 text block');
  }
  const text = block.text ?? '';

  if (!structured) return { text };

  const parsed = safeParseJson(text);
  if (parsed === null) {
    // output_config 理論上保證合法 JSON；保險：解析失敗就把原文當解釋、無動作。
    // structured 路徑一律回 suggestedActions 陣列（即使空），與成功路徑形狀一致。
    return { text, suggestedActions: [] };
  }

  const explanation = typeof parsed.explanation === 'string' ? parsed.explanation : text;
  const suggestedActions = Array.isArray(parsed.actions)
    ? parsed.actions.map(toRecommendedAction).filter((a): a is RecommendedAction => a !== null)
    : [];

  return { text: explanation, suggestedActions };
}

// ── 組裝：注入 client 的 provider ─────────────────────────────────

/**
 * 組出 Anthropic 的 AiProvider。預設 new Anthropic()（讀 ANTHROPIC_API_KEY）。
 * 真實呼叫在這裡發生（網路 + 金鑰）；純函式部分已可獨立測試。
 */
export function createAnthropicProvider(opts: AnthropicProviderOptions = {}): AiProvider {
  const model = opts.model ?? DEFAULT_MODEL;
  const maxTokens = opts.maxTokens ?? DEFAULT_MAX_TOKENS;
  const client: AnthropicMessagesClient = opts.client ?? new Anthropic();

  return {
    name: 'anthropic',
    async complete(req: AiRequest): Promise<AiResponse> {
      const params = buildCreateParams(req, model, maxTokens);
      const message = await client.messages.create(params);
      return parseResponse(message, req.responseSchema !== undefined);
    },
  };
}

// ── 小工具（純函式）──────────────────────────────────────────────

/** 安全 JSON.parse：失敗回 null，且只接受 object（非陣列/純值）。 */
function safeParseJson(text: string): Record<string, unknown> | null {
  try {
    const v: unknown = JSON.parse(text);
    return v !== null && typeof v === 'object' && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** 把 LLM 回的單一動作物件保守轉成 RecommendedAction；不合法回 null（被過濾掉）。 */
function toRecommendedAction(raw: unknown): RecommendedAction | null {
  if (raw === null || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.kind !== 'string' || !VALID_KINDS.has(o.kind as RecommendedAction['kind'])) {
    return null;
  }
  return {
    kind: o.kind as RecommendedAction['kind'],
    // 陣列也是 object：`typeof [] === 'object'`，須排除（params 應為純物件 map）。
    params: o.params !== null && typeof o.params === 'object' && !Array.isArray(o.params)
      ? (o.params as Record<string, unknown>)
      : {},
    reason: typeof o.reason === 'string' ? o.reason : '',
    // LLM 來源：autoApplyable 一律 false（aiAdvisor 會再強制一次，§12.9）。
    autoApplyable: false,
    confidence: clampConfidence(o.confidence),
  };
}

/** 把 LLM 回的 confidence 夾擠進 0..1；非數字或非有限值（NaN/Infinity）一律 0。 */
function clampConfidence(raw: unknown): number {
  return typeof raw === 'number' && Number.isFinite(raw)
    ? Math.min(1, Math.max(0, raw))
    : 0;
}
