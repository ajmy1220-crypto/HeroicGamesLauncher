/**
 * steamSideload.test.ts
 * ------------------------------------------------------------------
 * isSteamSideloadInfo 是 §11 Steam 鎖的判據，純函式、只 import type → jest 零 mock。
 * fail-safe：寧錯鎖不漏鎖，但不誤鎖一般遊戲；對 {} / undefined 不炸。
 */

import { isSteamSideloadInfo } from '../steamSideload'

import type { GameInfo } from 'common/types'

/** 只填 isSteamSideloadInfo 會看的欄位，其餘湊型別。 */
const gi = (over: Partial<GameInfo>): GameInfo => over as GameInfo

describe('isSteamSideloadInfo（§11 Windows Steam 客戶端偵測）', () => {
  test("app_name 'steam-' 前綴（Helmsman installSteam 自產）→ true", () => {
    expect(isSteamSideloadInfo(gi({ app_name: 'steam-dxmt' }))).toBe(true)
    expect(isSteamSideloadInfo(gi({ app_name: 'steam-wined3d' }))).toBe(true)
  })

  test("title 'Steam' + platform 'Windows' 兜底 → true（大小寫/空白無關）", () => {
    expect(
      isSteamSideloadInfo(
        gi({ title: 'Steam', install: { platform: 'Windows' } })
      )
    ).toBe(true)
    expect(
      isSteamSideloadInfo(
        gi({ title: '  steam ', install: { platform: 'Windows' } })
      )
    ).toBe(true)
  })

  test('不誤鎖：Steamworks Demo / 一般遊戲 / 非 Windows', () => {
    expect(
      isSteamSideloadInfo(
        gi({ title: 'Steamworks Demo', install: { platform: 'Windows' } })
      )
    ).toBe(false)
    expect(
      isSteamSideloadInfo(
        gi({
          app_name: 'mygame',
          title: 'My Game',
          install: { platform: 'Windows' }
        })
      )
    ).toBe(false)
    expect(
      isSteamSideloadInfo(gi({ title: 'Steam', install: { platform: 'Mac' } }))
    ).toBe(false)
  })

  test('不存在 app 回 {}（欄位 undefined）/ undefined → false（不炸）', () => {
    expect(isSteamSideloadInfo(gi({}))).toBe(false)
    expect(isSteamSideloadInfo(undefined)).toBe(false)
  })
})
