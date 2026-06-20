/**
 * aiAdvisor.ts
 * ------------------------------------------------------------------
 * Helmsman — 唯一呼叫 LLM 的模組（藍圖 §6.3），provider 無關。
 *
 * 職責（僅此兩項）：
 *   (1) 自然語言除錯：使用者打「開起來黑屏」→ 人話解釋 + 修正步驟。
 *   (2) 模糊判斷：recommendationEngine 標 needsAi 時，拿結構化 LogAnalysis + evidence 推理。
 *
 * 鐵律（§6.3 / §12.9）：
 *   - 透過注入的 AiProvider 對話，不綁定任一廠商（金鑰/邏輯留後端，由 adapter 處理）。
 *   - LLM 會幻覺：產出的結構化動作建議【一律視為建議】，本模組強制把每條的
 *     autoApplyable 設為 false，經使用者確認才可套用（actionExecutor 確認閘再擋一層）。
 *
 * 純度：
 *   - buildRequest 為純函式（只組 prompt），可獨立測試、不碰 IO/AI。
 *   - advise 唯一的外部互動是「呼叫注入的 provider」；不改傳入 input。
 */

import type { AiProvider, AiRequest } from './aiProvider';
import type { GameContext, LogAnalysis, RecommendedAction } from './types';

// ── 輸入 / 輸出 ────────────────────────────────────────────────────

export interface AdvisorInput {
  analysis: LogAnalysis;
  context: GameContext;
  /** 使用者自然語言提問（有 → 除錯模式；無 → 模糊判斷模式）。 */
  userQuestion?: string;
}

export interface AdvisorResult {
  /** 人話解釋（必有）。 */
  explanation: string;
  /** 結構化動作建議：每條 autoApplyable 已強制為 false（需使用者確認）。 */
  suggestedActions: RecommendedAction[];
  /** 實際回應的廠商名（供 UI/log）。 */
  provider: string;
}

// ── 常數 ──────────────────────────────────────────────────────────

/** 非串流輸出 token 上限預設（對齊當前 Claude API 建議的 ~16000）。 */
const DEFAULT_MAX_TOKENS = 16000;

/** system prompt：角色、誠實鐵則、輸出格式。provider 無關。 */
const ADVISOR_SYSTEM = [
  '你是 Helmsman 的除錯助手。Helmsman 在 Heroic Games Launcher 上協助 Mac 使用者跑 Windows 遊戲，',
  '訊號要穿過 Wine（Win32→macOS）、Rosetta 2（x86→ARM64）、圖形轉譯（DXMT→Metal / DXVK→Vulkan / GPTK→D3DMetal）三層。',
  '可用後端：wined3d（無翻譯、慢）、dxvk（DX9/10/11）、dxmt（DX10/11，僅 Apple Silicon）、gptk（DX11/12，僅 Apple Silicon）、crossover（商業）。',
  '',
  '依使用者提供的判定、訊號與環境，給出：',
  '1. 一段人話解釋：可能的原因與修正方向（必有）。',
  '2. 可選的結構化動作建議（依 schema）。',
  '',
  '鐵則：你的動作建議【一律是建議】，必須經使用者確認才會被套用；不要假裝已執行、不要保證結果。',
  '不確定就誠實說不確定，並說明還需要哪些資訊（如真機 log）。',
].join('\n');

/**
 * 結構化回應 schema（adapter 對映到各廠商的 structured output）。
 *
 * 【每個 object 節點都標 additionalProperties:false】——Anthropic 的 output_config.format
 * json_schema 要求所有 object 都封閉鍵，否則整份 schema 被拒。params 因此【不能】是裸的
 * { type:'object' }，須列出已知鍵（對齊 types.ts §6 的 params 鍵名鎖定）。
 *
 * [SEED] 仍有張力：RecommendedAction.params 本質是依 kind 而異的 Record<string,unknown>，
 * 真正嚴格的 per-kind 約束需把 actions 做成 oneOf-by-kind 的 discriminated union——這與
 * 「RecommendedAction 改 discriminated union」的延後項綁在一起（見 README 待辦）。在那之前，
 * 此處用「已知鍵的封閉 object（鍵皆選用）」當折衷；value 暫以 string 模型化（複雜值待校準）。
 * deepFreeze 之後此常數不可變（防 Phase 5b adapter 就地改寫污染全 process）。
 */
const ADVISOR_RESPONSE_SCHEMA: Record<string, unknown> = deepFreeze({
  type: 'object',
  additionalProperties: false,
  required: ['explanation', 'actions'],
  properties: {
    explanation: { type: 'string' },
    actions: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['kind', 'params', 'reason', 'confidence'],
        properties: {
          kind: {
            type: 'string',
            enum: [
              'install_winetricks',
              'switch_backend',
              'install_dxvk',
              'reinstall_wine_variant',
              'install_steam',
              'change_setting',
              'none',
            ],
          },
          // 封閉鍵，對齊 types.ts §6 的 params 鍵名鎖定；鍵皆選用（依 kind 而異）。
          params: {
            type: 'object',
            additionalProperties: false,
            properties: {
              backend: { type: 'string' },
              from: { type: 'string' },
              directxVersion: { type: 'number' },
              arch: { type: 'string' },
              verb: { type: 'string' },
              variant: { type: 'string' },
              key: { type: 'string' },
              value: { type: 'string' },
              suggestedBackend: { type: 'string' },
            },
          },
          reason: { type: 'string' },
          confidence: { type: 'number' },
        },
      },
    },
  },
});

// ── 純函式：組 prompt ─────────────────────────────────────────────

/**
 * 把 AdvisorInput 組成 provider 無關的 AiRequest（純函式，不碰 IO/AI、不改 input）。
 *   - 有 userQuestion → 除錯模式：附上使用者問題。
 *   - 無 userQuestion → 模糊判斷模式：請 LLM 依 evidence 推理。
 */
export function buildRequest(input: AdvisorInput): AiRequest {
  const { analysis, context, userQuestion } = input;

  const parts: string[] = [
    `遊戲：${context.appName}（runner: ${context.runner}）`,
    `環境：${formatContext(context)}`,
    `規則層判定：${analysis.summary.verdict}`,
    `偵測到的訊號：\n${formatSignals(analysis)}`,
  ];

  const q = userQuestion?.trim();
  if (q) {
    parts.push(`使用者的問題：${q}`);
  } else {
    parts.push('規則層無法下確定結論，請依上述 evidence 判斷可能原因與修正方向。');
  }

  return {
    system: ADVISOR_SYSTEM,
    user: parts.join('\n\n'),
    responseSchema: ADVISOR_RESPONSE_SCHEMA,
    maxTokens: DEFAULT_MAX_TOKENS,
  };
}

// ── 主流程：呼叫 provider + 強制「建議需確認」─────────────────────

/**
 * 對 LLM 求建議。組 request → 呼叫注入的 provider → 把所有結構化建議的
 * autoApplyable 強制為 false（§12.9 絕不靜默套用），回 AdvisorResult。
 * 不改傳入 input；唯一外部互動是 provider.complete。
 */
export async function advise(
  input: AdvisorInput,
  provider: AiProvider,
): Promise<AdvisorResult> {
  const req = buildRequest(input);
  const res = await provider.complete(req);

  // 誠實鐵則：LLM 來源的動作一律須使用者確認，autoApplyable 強制 false。
  const suggestedActions: RecommendedAction[] = (res.suggestedActions ?? []).map((a) => ({
    ...a,
    autoApplyable: false,
  }));

  // 執行期 invariant（§12.9）：把「絕不靜默套用」從測試層提升為【執行期保證】。
  // 上面的 map 已強制 false；此 guard 防的是未來重構誤改（如反轉 spread 順序讓 LLM 的
  // true 蓋過 false）——讓危險建議 fail-fast 大聲失敗，而非靜默以 autoApplyable=true 漏出。
  if (suggestedActions.some((a) => a.autoApplyable !== false)) {
    throw new Error(
      'aiAdvisor invariant 違反：LLM 來源動作的 autoApplyable 必須為 false（§12.9 絕不靜默套用）',
    );
  }

  return {
    explanation: res.text,
    suggestedActions,
    provider: provider.name,
  };
}

// ── 內部工具 ──────────────────────────────────────────────────────

/** 遞迴凍結（防共享常數被下游就地改寫）。module 載入時一次性。 */
function deepFreeze<T>(o: T): T {
  Object.freeze(o);
  for (const v of Object.values(o as Record<string, unknown>)) {
    if (v !== null && typeof v === 'object' && !Object.isFrozen(v)) deepFreeze(v);
  }
  return o;
}

// ── 小工具（純函式）──────────────────────────────────────────────

function formatContext(context: GameContext): string {
  const bits = [
    `現用後端 ${context.currentBackend}`,
    `DirectX ${context.directxVersion ?? '未知'}`,
    `晶片 ${context.arch}`,
    `macOS ${context.osVersion}`,
  ];
  if (context.is32bit === true) bits.push('32-bit');
  return bits.join('、');
}

function formatSignals(analysis: LogAnalysis): string {
  if (analysis.signals.length === 0) return '（log 無已知問題訊號）';
  return analysis.signals
    .map((s) => {
      const head = `- [${s.severity}] ${s.message}`;
      return s.evidence[0] ? `${head}\n  證據：${s.evidence[0]}` : head;
    })
    .join('\n');
}
