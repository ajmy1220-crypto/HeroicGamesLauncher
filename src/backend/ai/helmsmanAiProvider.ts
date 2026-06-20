/**
 * helmsmanAiProvider.ts
 * ------------------------------------------------------------------
 * Helmsman — LLM provider 的【金鑰閘】adapter（fork-only）。
 *
 * aiAdvisor 需要一個 AiProvider 才能呼叫 LLM。本檔依環境決定要不要給：
 *   - 有 ANTHROPIC_API_KEY → createAnthropicProvider()（讀該金鑰，§5b 預設 adapter）。
 *   - 無 → 回 null：runAdvise 對 null 回「LLM 未設定」error，優雅降級、不 crash。
 *
 * 金鑰判斷刻意留在此 fork-only 層——orchestrator 保持 Heroic-free（只收 AiProvider|null），
 * 可在 jest 下注入 fake provider / null 測試，零 env 依賴。
 */

import { createAnthropicProvider } from './anthropicProvider'

import type { AiProvider } from './aiProvider'

/** 有非空 ANTHROPIC_API_KEY 才回 Anthropic provider；否則 null（LLM 未設定）。 */
export function resolveAiProvider(): AiProvider | null {
  const key = process.env.ANTHROPIC_API_KEY
  if (typeof key !== 'string' || key.trim() === '') return null
  return createAnthropicProvider()
}
