/**
 * claudeCliProvider.test.ts
 * ------------------------------------------------------------------
 * 只測純函式 buildCliArgs / parseCliResult（不 spawn 真 claude）。
 * spawn 膠合層 runClaude 屬整合測試 / 真機責任。
 */

import { buildCliArgs, parseCliResult } from '../claudeCliProvider'

import type { AiRequest } from '../aiProvider'

const req = (over: Partial<AiRequest> = {}): AiRequest => ({
  system: 'SYS',
  user: 'USR',
  responseSchema: { type: 'object' },
  maxTokens: 100,
  ...over
})

describe('buildCliArgs', () => {
  test('帶 -p / user / --append-system-prompt / system / --output-format json', () => {
    const a = buildCliArgs(req({ responseSchema: undefined }))
    expect(a).toContain('-p')
    expect(a).toContain('USR')
    expect(a[a.indexOf('--append-system-prompt') + 1]).toBe('SYS')
    expect(a[a.indexOf('--output-format') + 1]).toBe('json')
  })

  test('有 responseSchema → 帶 --json-schema（序列化後的 schema）', () => {
    const schema = { type: 'object', properties: { x: { type: 'string' } } }
    const a = buildCliArgs(req({ responseSchema: schema }))
    expect(a).toContain('--json-schema')
    expect(a[a.indexOf('--json-schema') + 1]).toBe(JSON.stringify(schema))
  })

  test('無 responseSchema → 不帶 --json-schema', () => {
    expect(buildCliArgs(req({ responseSchema: undefined }))).not.toContain(
      '--json-schema'
    )
  })

  test('有 model → 帶 --model', () => {
    const a = buildCliArgs(req(), 'claude-sonnet-4-6')
    expect(a[a.indexOf('--model') + 1]).toBe('claude-sonnet-4-6')
  })
})

describe('parseCliResult', () => {
  test('structured：structured_output → text=explanation、actions 轉成 RecommendedAction', () => {
    const stdout = JSON.stringify({
      type: 'result',
      is_error: false,
      result: '原始文字',
      structured_output: {
        explanation: '看起來是 shader 問題',
        actions: [
          {
            kind: 'switch_backend',
            params: { backend: 'gptk' },
            reason: 'DXMT 不支援',
            confidence: 0.7,
            autoApplyable: true // 來源亂給 true
          }
        ]
      }
    })
    const r = parseCliResult(stdout, true)
    expect(r.text).toBe('看起來是 shader 問題')
    expect(r.suggestedActions).toHaveLength(1)
    expect(r.suggestedActions![0].kind).toBe('switch_backend')
    // 來源 autoApplyable:true 一律被中和成 false（§12.9）。
    expect(r.suggestedActions![0].autoApplyable).toBe(false)
  })

  test('structured：非法 kind 過濾、confidence 夾擠、params 陣列中和', () => {
    const stdout = JSON.stringify({
      is_error: false,
      result: 'x',
      structured_output: {
        explanation: 'x',
        actions: [
          { kind: 'rm_rf_root', reason: '惡意', confidence: 1 }, // 非法 kind
          { kind: 'none', params: [1, 2], reason: 'ok', confidence: 9999 }
        ]
      }
    })
    const r = parseCliResult(stdout, true)
    expect(r.suggestedActions).toHaveLength(1)
    expect(r.suggestedActions![0].kind).toBe('none')
    expect(r.suggestedActions![0].params).toEqual({}) // 陣列被中和
    expect(r.suggestedActions![0].confidence).toBe(1) // 9999 夾擠成 1
  })

  test('is_error:true → 拋錯', () => {
    expect(() =>
      parseCliResult(JSON.stringify({ is_error: true, result: 'boom' }), true)
    ).toThrow(/claude CLI 回報錯誤/)
  })

  test('stdout 非 JSON → 拋錯', () => {
    expect(() => parseCliResult('not json at all', true)).toThrow(/非 JSON/)
  })

  test('structured 但無 structured_output → 退回 result 當解釋、無動作', () => {
    const r = parseCliResult(
      JSON.stringify({ is_error: false, result: '純文字回應' }),
      true
    )
    expect(r.text).toBe('純文字回應')
    expect(r.suggestedActions).toEqual([])
  })

  test('非 structured → text=result、無 suggestedActions', () => {
    const r = parseCliResult(
      JSON.stringify({ is_error: false, result: '純解釋' }),
      false
    )
    expect(r.text).toBe('純解釋')
    expect(r.suggestedActions).toBeUndefined()
  })
})
