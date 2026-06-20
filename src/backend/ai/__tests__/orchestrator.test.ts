/**
 * orchestrator.test.ts
 * ------------------------------------------------------------------
 * Helmsman — orchestration 進入點的單元測試 + mutation 釘樁。
 *
 * 刻意【不】import realHeroicBridge / heroicContextProvider：orchestrator 及其相依全
 * Heroic-free，故本檔零 mock（bridge + provider 用結構相容的 fake）。
 * 釘樁原則：還原修正即變紅才算數。
 *
 * 誠實註記：runApply 對 bridge 純 pass-through、context 來自注入的 provider，故「真實
 * adapter 接對 Heroic 函式」在此測不出差異（等價突變，屬 realHeroicBridge /
 * heroicContextProvider 自身 + 整合測試責任）。本檔釘的是 orchestrator 的串接、
 * 信任邊界硬化（§11 / §12.9）與輸入驗證。
 */

import {
  coerceLog,
  diagnose,
  normalizeContext,
  runApply,
  runDiagnose
} from '../orchestrator'

import type { ContextProvider, HelmsmanError } from '../orchestrator'
import type { ExecutionResult } from '../actionExecutor'
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

/** 不可信輸入用的原始物件（型別放鬆成可塞非法值）。 */
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

/** 結構相容的 fake ContextProvider（後端權威組 context + 讀 log 的替身）。 */
const makeFakeProvider = (
  context: GameContext = baseContext,
  log = MISSING_DLL_LOG
): ContextProvider => ({
  assembleGameContext: jest.fn(async () => context),
  readGameLog: jest.fn(() => log)
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

const APP = { appName: 'TestGame', runner: 'sideload' }

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

// ── diagnose：純串接 analyze→recommend→planAll（簽章未變）──────────

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

// ── runDiagnose：provider 後端權威組 context + 讀 log → diagnose ─────

describe('runDiagnose（provider 注入）', () => {
  test('正常 → 串接 provider 的 log/context 得出建議', async () => {
    const res = await runDiagnose(APP, makeFakeProvider())
    expect('error' in res).toBe(false)
    if ('error' in res) throw new Error(res.error)

    expect(
      res.recommendation.actions.some((a) => a.kind === 'install_winetricks')
    ).toBe(true)
  })

  test('壞 runner → 結構化 error（不呼叫 provider）', async () => {
    const provider = makeFakeProvider()
    const res = await runDiagnose({ appName: 'X', runner: 'epic' }, provider)
    expect('error' in res).toBe(true)
    expect(provider.assembleGameContext).not.toHaveBeenCalled()
  })
})

// ── §12.9 釘樁：confirmed 不由 renderer 自證 ────────────────────────

describe('runApply — §12.9 確認閘硬化', () => {
  test('switch_backend → blocked_needs_confirmation，bridge 未被呼叫', async () => {
    const bridge = makeFakeBridge()
    const res = asExecution(
      await runApply(
        { ...APP, action: switchAction },
        bridge,
        makeFakeProvider()
      )
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
        { ...APP, action: winetricksAction },
        bridge,
        makeFakeProvider()
      )
    )

    expect(res.status).toBe('executed')
    expect(bridge.installWinetricks).toHaveBeenCalledWith(
      expect.objectContaining({ verb: 'd3dcompiler_47' })
    )
  })
})

// ── §11 釘樁：Steam 鎖（context 現由後端 provider 權威組）─────────────

describe('Steam 鎖（§11）', () => {
  test('provider 回 isWindowsSteamClient:true 的 ctx + switch_backend → blocked_steam_lock', async () => {
    const bridge = makeFakeBridge()
    const steamProvider = makeFakeProvider({
      ...baseContext,
      isWindowsSteamClient: true
    })
    const res = asExecution(
      await runApply({ ...APP, action: switchAction }, bridge, steamProvider)
    )

    // 安全屬性：context 後端權威 → renderer 無法偽造 isWindowsSteamClient:false 繞鎖。
    expect(res.status).toBe('blocked_steam_lock')
    expect(bridge.switchBackend).not.toHaveBeenCalled()
  })

  test('normalizeContext 把 isWindowsSteamClient 強制成嚴格 boolean（純工具，防禦性備援）', () => {
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

  test('runApply：未知 kind / 壞 runner → 結構化 error，bridge 未被呼叫', async () => {
    const bridge = makeFakeBridge()
    const badKind = await runApply(
      { ...APP, action: { kind: 'evil', params: {} } },
      bridge,
      makeFakeProvider()
    )
    const badRunner = await runApply(
      { appName: 'X', runner: 'epic', action: switchAction },
      bridge,
      makeFakeProvider()
    )

    expect('error' in badKind).toBe(true)
    expect('error' in badRunner).toBe(true)
    expect(bridge.switchBackend).not.toHaveBeenCalled()
  })
})
