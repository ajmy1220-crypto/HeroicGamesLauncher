/**
 * deriveBackend.test.ts
 * ------------------------------------------------------------------
 * deriveBackend 是 selectWineForBackend 的逆，純函式、只 import type → jest 零 mock。
 * 釘樁：每個 mapping 一條；DXMT 名稱判斷優先於 DXVK 旗標（拿掉 endsWith('-DXMT') 即變紅）。
 */

import { deriveBackend } from '../deriveBackend'

import type { WineInstallation } from 'common/types'

/** 只填 deriveBackend 會看的 type/name，其餘湊型別。 */
const wv = (
  type: WineInstallation['type'],
  name: string
): WineInstallation => ({
  bin: '/fake/bin/wine',
  name,
  type
})

describe('deriveBackend（selectWineForBackend 的逆）', () => {
  test('toolkit → gptk', () => {
    expect(
      deriveBackend(wv('toolkit', 'Game Porting Toolkit 2.1'), false)
    ).toBe('gptk')
  })

  test('crossover → crossover', () => {
    expect(deriveBackend(wv('crossover', 'CrossOver - 24.0'), false)).toBe(
      'crossover'
    )
  })

  test("wine + '-DXMT' → dxmt（名稱判斷優先於 DXVK 旗標）", () => {
    expect(
      deriveBackend(wv('wine', 'Wine-Staging-macOS-9.0-DXMT'), false)
    ).toBe('dxmt')
    // 釘樁：autoInstallDxvk:true 仍是 dxmt（name 判斷在旗標之前）。拿掉 endsWith('-DXMT')
    // 會讓這兩條翻成 dxvk/wined3d → 變紅。
    expect(deriveBackend(wv('wine', 'Wine-Staging-macOS-9.0-DXMT'), true)).toBe(
      'dxmt'
    )
  })

  test('純 wine + autoInstallDxvk → dxvk', () => {
    expect(deriveBackend(wv('wine', 'Wine-Staging-macOS-9.0'), true)).toBe(
      'dxvk'
    )
  })

  test('純 wine + !autoInstallDxvk → wined3d', () => {
    expect(deriveBackend(wv('wine', 'Wine-Staging-macOS-9.0'), false)).toBe(
      'wined3d'
    )
  })

  test('proton（macOS 不該出現）→ wined3d 防禦', () => {
    expect(deriveBackend(wv('proton', 'Proton 9'), true)).toBe('wined3d')
  })
})
