/**
 * claudeCliProvider.ts
 * ------------------------------------------------------------------
 * Helmsman — AiProvider 的【Claude Code CLI】adapter（fork-only，訂閱路線）。
 *
 * 不打 Anthropic API（不需 ANTHROPIC_API_KEY、不按 token 另外計費），而是 spawn 本機
 * `claude -p`（Claude Code CLI，走訂閱 OAuth）。給「有 Claude 訂閱但沒 API 金鑰」的人用。
 * ⚠ 每次呼叫會吃訂閱用量（算進 5h / 週上限）。
 *
 * 結構化輸出：用 CLI 原生 `--json-schema` + `--output-format json`；回的 wrapper 內
 * `structured_output` 即符合 schema 的物件——可靠度同 API 的 output_config.format。
 *
 * 分層：buildCliArgs / parseCliResult 為純函式（可測、不 spawn）；runClaude 是 spawn 膠合層。
 * 此檔【只能住在 Heroic（fork）tree 內】——用 node child_process，且依賴本機裝了 claude CLI。
 */

import { spawn } from 'child_process'
import { tmpdir } from 'os'

import type { AiProvider, AiRequest, AiResponse } from './aiProvider'
import type { RecommendedAction } from './types'

const DEFAULT_TIMEOUT_MS = 120_000

/** RecommendedAction 合法 kind（過濾 LLM 回的動作）。 */
const VALID_KINDS: ReadonlySet<RecommendedAction['kind']> = new Set([
  'install_winetricks',
  'switch_backend',
  'install_dxvk',
  'reinstall_wine_variant',
  'install_steam',
  'change_setting',
  'none'
])

export interface ClaudeCliOptions {
  /** claude 可執行檔路徑，預設 'claude'（靠 PATH）。 */
  bin?: string
  /** 覆寫 model；未給用 CLI/帳號預設。 */
  model?: string
  /** spawn 逾時（ms）。 */
  timeoutMs?: number
}

// ── 純函式：組參數 ────────────────────────────────────────────────

/**
 * 把 AiRequest 組成 `claude -p` 的參數（純函式）。
 * system 用 --append-system-prompt 帶；responseSchema 用 --json-schema 強制結構化輸出。
 */
export function buildCliArgs(req: AiRequest, model?: string): string[] {
  const args = [
    '-p',
    req.user,
    '--append-system-prompt',
    req.system,
    '--output-format',
    'json'
  ]
  if (req.responseSchema) {
    args.push('--json-schema', JSON.stringify(req.responseSchema))
  }
  if (model) args.push('--model', model)
  return args
}

// ── 純函式：解析 wrapper ──────────────────────────────────────────

/**
 * 解析 `claude --output-format json` 的 wrapper（純函式）。
 * structured（有送 --json-schema）→ 取 wrapper.structured_output；無則退回 wrapper.result。
 */
export function parseCliResult(
  stdout: string,
  structured: boolean
): AiResponse {
  let wrapper: Record<string, unknown>
  try {
    wrapper = JSON.parse(stdout) as Record<string, unknown>
  } catch {
    throw new Error('claude CLI 回應非 JSON（--output-format json 解析失敗）')
  }
  if (wrapper.is_error === true || wrapper.subtype === 'error') {
    const msg = typeof wrapper.result === 'string' ? wrapper.result : 'unknown'
    throw new Error(`claude CLI 回報錯誤：${msg}`)
  }

  const resultText = typeof wrapper.result === 'string' ? wrapper.result : ''
  if (!structured) return { text: resultText }

  const so = wrapper.structured_output
  if (so !== null && typeof so === 'object') {
    const obj = so as Record<string, unknown>
    const explanation =
      typeof obj.explanation === 'string' ? obj.explanation : resultText
    const suggestedActions = Array.isArray(obj.actions)
      ? obj.actions
          .map(toRecommendedAction)
          .filter((a): a is RecommendedAction => a !== null)
      : []
    return { text: explanation, suggestedActions }
  }
  // --json-schema 沒生效（無 structured_output）→ 保守退回 result 當解釋、無動作。
  return { text: resultText, suggestedActions: [] }
}

/** 把 LLM 回的單一動作物件保守轉成 RecommendedAction；不合法回 null（被過濾）。 */
function toRecommendedAction(raw: unknown): RecommendedAction | null {
  if (raw === null || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  if (
    typeof o.kind !== 'string' ||
    !VALID_KINDS.has(o.kind as RecommendedAction['kind'])
  ) {
    return null
  }
  return {
    kind: o.kind as RecommendedAction['kind'],
    params:
      o.params !== null &&
      typeof o.params === 'object' &&
      !Array.isArray(o.params)
        ? (o.params as Record<string, unknown>)
        : {},
    reason: typeof o.reason === 'string' ? o.reason : '',
    // LLM 來源：autoApplyable 一律 false（aiAdvisor 會再強制一次，§12.9）。
    autoApplyable: false,
    confidence:
      typeof o.confidence === 'number' && Number.isFinite(o.confidence)
        ? Math.min(1, Math.max(0, o.confidence))
        : 0
  }
}

// ── spawn 膠合層 ──────────────────────────────────────────────────

/** spawn `claude -p ...`，回 stdout（impure；逾時 kill、非零退出 reject）。 */
function runClaude(
  bin: string,
  args: string[],
  timeoutMs: number
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { cwd: tmpdir(), env: process.env })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error(`claude CLI 逾時（${timeoutMs}ms）`))
    }, timeoutMs)
    child.stdout?.on('data', (d) => {
      stdout += String(d)
    })
    child.stderr?.on('data', (d) => {
      stderr += String(d)
    })
    child.on('error', (e) => {
      clearTimeout(timer)
      reject(new Error(`claude CLI 啟動失敗：${e.message}`))
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code !== 0) {
        reject(
          new Error(`claude CLI 非零退出（${code}）：${stderr.slice(0, 500)}`)
        )
      } else {
        resolve(stdout)
      }
    })
  })
}

// ── 組裝 provider ─────────────────────────────────────────────────

/** 組出走本機 claude CLI 的 AiProvider（訂閱 OAuth，不需金鑰）。 */
export function createClaudeCliProvider(
  opts: ClaudeCliOptions = {}
): AiProvider {
  const bin = opts.bin ?? 'claude'
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  return {
    name: 'claude-cli',
    async complete(req: AiRequest): Promise<AiResponse> {
      const args = buildCliArgs(req, opts.model)
      const stdout = await runClaude(bin, args, timeoutMs)
      return parseCliResult(stdout, req.responseSchema !== undefined)
    }
  }
}
