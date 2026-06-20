/**
 * orchestrator.test.ts
 * ------------------------------------------------------------------
 * Helmsman — Phase 3b orchestration 進入點的單元測試 + mutation 釘樁。
 *
 * 刻意【不】import realHeroicBridge：orchestrator 及其相依全 Heroic-free，
 * 故本檔零 mock（bridge 用結構相容的 fake）。釘樁原則：還原修正即變紅才算數。
 *
 * 誠實註記：runApply 對 bridge 是純 pass-through，故「realHeroicBridge 真的接對
 * Heroic 函式」在此測不出差異（等價突變）——那屬 realHeroicBridge 自身 + 整合測試
 * 責任。本檔釘的是 orchestrator 的串接、信任邊界硬化（§11 / §12.9）與輸入驗證。
 */

import {
  coerceLog,
  diagnose,
  normalizeContext,
  runApply,
  runDiagnose
} from '../orchestrator'

import type { ExecutionResult } from '../actionExecutor'
import type { HelmsmanError } from '../orchestrator'
import type { GameContext, RecommendedAction } from '../types'

// ── fixtures ──────────────────────────────────────────────────────

// [VERIFIED] 命中 logAnalyzer missing_dll pattern；extract→dll='d3dcompiler_47'。
const MISSING_DLL_LOG =
  '0024:err:module:import_dll Library d3dcompiler_47.dll not found'
// [VERIFIED] 命中 anticheat pattern（hint.blocking=true）。
const ANTICHEAT_LOG =
  'Game launch failed: EasyAntiCheat could not be initialized'

const baseContext: GameContext = {
  appName: 'TestGame',
  runner: 'sideload',
  currentBackend: 'dxvk',
  wineVersion: 'wine-staging-9.0',
  osVersion: '15.1',
  arch: 'arm64'
}

/** 不可信輸入用的原始 context（型別放鬆成可塞非法值）。 */
const rawContext = (
  overrides: Record<string, unknown> = {}
): Record<string, unknown> => ({
  appName: 'TestGame',
  runner: 'sideload',
  currentBackend: 'dxvk',
  wineVersion: 'wine-staging-9.0',
  osVersion: '15.1',
  arch: 'arm64',
  ...overrides
})

/** 結構相容的 fake bridge（每方法 jest.fn，可斷言呼叫）。 */
const makeFakeBridge = () => ({
  installWinetricks: jest.fn(() => Promise.resolve()),
  switchBackend: jest.fn(() => Promise.resolve()),
  installDxvk: jest.fn(() => Promise.resolve()),
  reinstallWineVariant: jest.fn(() => Promise.resolve()),
  installSteam: jest.fn(() => Promise.resolve()),
  changeSetting: jest.fn(() => Promise.resolve())
})

/** runApply / runDiagnose 回 ExecutionResult 或 HelmsmanError——收斂成前者（否則直接失敗）。 */
function asExecution(res: ExecutionResult | HelmsmanError): ExecutionResult {
  if ('error' in res) {
    throw new Error(`預期 ExecutionResult，卻得 error：${res.error}`)
  }
  return res
}

const switchAction: RecommendedAction = {
  kind: 'switch_backend',
  params: { backend: 'gptk' },
  reason: 'test',
  autoApplyable: false,
  confidence: 0.8
}

const winetricksAction: RecommendedAction = {
  kind: 'install_winetricks',
  params: { verb: 'd3dcompiler_47' },
  reason: 'test',
  autoApplyable: true,
  confidence: 0.9
}

// ── diagnose：純串接 analyze→recommend→planAll ────────────────────

describe('diagnose（純串接）', () => {
  test('missing-DLL log → 建議 install_winetricks 且 plans 含 installWinetricks', () => {
    const { recommendation, plans } = diagnose(MISSING_DLL_LOG, baseContext)

    expect(
      recommendation.actions.some(
        (a) =>
          a.kind === 'install_winetricks' && a.params.verb === 'd3dcompiler_47'
      )
    ).toBe(true)
    expect(plans.some((p) => p.operation === 'installWinetricks')).toBe(true)
  })

  test('anticheat log → blocking / incompatible，plans 為空（kind:none→null）', () => {
    const { recommendation, plans } = diagnose(ANTICHEAT_LOG, baseContext)

    expect(recommendation.blocking).toBe(true)
    expect(recommendation.verdict).toBe('incompatible')
    expect(plans).toHaveLength(0)
  })
})

// ── §12.9 釘樁：confirmed 不由 renderer 自證 ────────────────────────

describe('runApply — §12.9 確認閘硬化', () => {
  test('switch_backend → blocked_needs_confirmation，bridge 未被呼叫', async () => {
    const bridge = makeFakeBridge()
    const res = asExecution(
      await runApply({ action: switchAction, context: rawContext() }, bridge)
    )

    // 釘樁核心：把 runApply 的 confirmed:false 改成 true，此處會翻成 executed +
    // switchBackend 被呼叫 → 變紅。
    expect(res.status).toBe('blocked_needs_confirmation')
    expect(bridge.switchBackend).not.toHaveBeenCalled()
  })

  test('install_winetricks（autoApplyable）→ executed，bridge 被呼叫', async () => {
    const bridge = makeFakeBridge()
    const res = asExecution(
      await runApply(
        { action: winetricksAction, context: rawContext() },
        bridge
      )
    )

    expect(res.status).toBe('executed')
    expect(bridge.installWinetricks).toHaveBeenCalledWith(
      expect.objectContaining({ verb: 'd3dcompiler_47' })
    )
  })
})

// ── §11 釘樁：Steam 鎖 + isWindowsSteamClient 正規化 ────────────────

describe('Steam 鎖（§11）', () => {
  test('isWindowsSteamClient:true + switch_backend → blocked_steam_lock', async () => {
    const bridge = makeFakeBridge()
    const res = asExecution(
      await runApply(
        {
          action: switchAction,
          context: rawContext({ isWindowsSteamClient: true })
        },
        bridge
      )
    )

    expect(res.status).toBe('blocked_steam_lock')
    expect(bridge.switchBackend).not.toHaveBeenCalled()
  })

  test('normalizeContext 把 isWindowsSteamClient 強制成嚴格 boolean', () => {
    expect(
      normalizeContext(rawContext({ isWindowsSteamClient: true }))
        ?.isWindowsSteamClient
    ).toBe(true)
    // 釘樁：若停止 coercion 而原樣放行，'true' / 1 會 !== false → 變紅。
    expect(
      normalizeContext(rawContext({ isWindowsSteamClient: 'true' }))
        ?.isWindowsSteamClient
    ).toBe(false)
    expect(
      normalizeContext(rawContext({ isWindowsSteamClient: 1 }))
        ?.isWindowsSteamClient
    ).toBe(false)
    expect(
      normalizeContext(rawContext({ isWindowsSteamClient: undefined }))
        ?.isWindowsSteamClient
    ).toBe(false)
  })
})

// ── 不可信輸入的 fail-closed 驗證 ──────────────────────────────────

describe('輸入驗證', () => {
  test('coerceLog：非字串 → null；超上限 → 截斷', () => {
    expect(coerceLog('hello')).toBe('hello')
    expect(coerceLog(123)).toBeNull()
    expect(coerceLog(null)).toBeNull()
    expect(coerceLog('x'.repeat(2_000_000))?.length).toBe(1_048_576)
  })

  test('normalizeContext：enum 不合法 → null；合法 → 非 null', () => {
    expect(normalizeContext(rawContext({ arch: 'ARM' }))).toBeNull()
    expect(normalizeContext(rawContext({ runner: 'epic' }))).toBeNull()
    expect(
      normalizeContext(rawContext({ currentBackend: 'vulkan' }))
    ).toBeNull()
    expect(normalizeContext('nope')).toBeNull()
    expect(normalizeContext(rawContext())).not.toBeNull()
  })

  test('runDiagnose：非字串 log / 壞 context → 結構化 error；正常 → 結果', () => {
    expect('error' in runDiagnose({ log: 123, context: rawContext() })).toBe(
      true
    )
    expect(
      'error' in runDiagnose({ log: 'ok', context: rawContext({ arch: 'x' }) })
    ).toBe(true)
    expect(
      'error' in runDiagnose({ log: MISSING_DLL_LOG, context: rawContext() })
    ).toBe(false)
  })

  test('runApply：未知 kind / 壞 context → 結構化 error，bridge 未被呼叫', async () => {
    const bridge = makeFakeBridge()
    const badKind = await runApply(
      { action: { kind: 'evil', params: {} }, context: rawContext() },
      bridge
    )
    const badCtx = await runApply(
      { action: switchAction, context: rawContext({ arch: 'x' }) },
      bridge
    )

    expect('error' in badKind).toBe(true)
    expect('error' in badCtx).toBe(true)
    expect(bridge.switchBackend).not.toHaveBeenCalled()
  })
})
