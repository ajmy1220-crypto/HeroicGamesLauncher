/**
 * helmsmanAiProvider.ts
 * ------------------------------------------------------------------
 * Helmsman — LLM provider 的【解析閘】adapter（fork-only）。
 *
 * aiAdvisor 需要一個 AiProvider 才能呼叫 LLM。本檔依環境挑一個（優先序）：
 *   1. 有 ANTHROPIC_API_KEY → createAnthropicProvider()（打 Anthropic API，§5b）。
 *   2. 否則本機有 claude CLI → createClaudeCliProvider()（走 Claude 訂閱 OAuth，不需金鑰；
 *      ⚠ 吃訂閱用量）。給「有訂閱、沒 API 金鑰」的人。
 *   3. 兩者皆無 → null：runAdvise 對 null 回「LLM 未設定」error，優雅降級、不 crash。
 *
 * 環境判斷刻意留在此 fork-only 層——orchestrator 保持 Heroic-free（只收 AiProvider|null），
 * 可在 jest 下注入 fake provider / null 測試，零 env 依賴。
 */

import { execFileSync } from 'child_process'
import { existsSync } from 'fs'
import { homedir } from 'os'

import { createAnthropicProvider } from './anthropicProvider'
import { createClaudeCliProvider } from './claudeCliProvider'

import type { AiProvider } from './aiProvider'

/** 依環境挑 AiProvider：API 金鑰 → claude CLI → null（見檔頭優先序）。 */
export function resolveAiProvider(): AiProvider | null {
  const key = process.env.ANTHROPIC_API_KEY
  if (typeof key === 'string' && key.trim() !== '') {
    return createAnthropicProvider()
  }
  const bin = resolveClaudeBinary()
  if (bin) {
    return createClaudeCliProvider({ bin })
  }
  return null
}

/**
 * 找本機 claude 可執行檔：HELMSMAN_CLAUDE_BIN 覆寫 → PATH（which）→ 常見安裝點。
 * 找不到回 null。packaged .app 從 Finder 開時 PATH 可能不含 nvm，故有 fallback 路徑。
 */
function resolveClaudeBinary(): string | null {
  const override = process.env.HELMSMAN_CLAUDE_BIN
  if (override && existsSync(override)) return override

  try {
    const p = execFileSync('which', ['claude'], { encoding: 'utf8' }).trim()
    if (p && existsSync(p)) return p
  } catch {
    // 不在 PATH，往下試常見路徑
  }

  for (const candidate of [
    `${homedir()}/.claude/local/claude`,
    '/opt/homebrew/bin/claude',
    '/usr/local/bin/claude'
  ]) {
    if (existsSync(candidate)) return candidate
  }
  return null
}
