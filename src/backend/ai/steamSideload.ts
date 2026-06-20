/**
 * steamSideload.ts
 * ------------------------------------------------------------------
 * Helmsman — 判斷一個 sideload GameInfo 是不是「Windows Steam 客戶端」（§11 Steam 鎖的
 * 單一充分條件）。
 *
 * 抽成獨立純函式（只 `import type`）→ 與 Heroic runtime 脫鉤，jest 零 mock 可測；
 * heroicContextProvider 引用它組 isWindowsSteamClient。
 *
 * 判據（fail-safe，寧錯鎖不漏鎖——漏鎖會弄壞 Steam[換後端]，錯鎖只是某 app 改不了後端）：
 *   - app_name 以 'steam-' 開頭：Helmsman installSteam 自產（'steam-'+backend），精確。
 *   - title==='steam'（trim/小寫）且 install.platform==='Windows'：兜底（使用者手動 sideload
 *     的官方 Steam）。
 * ⚠ getGameInfo 對不存在 app 回 {} 強轉 → app_name/title 實為 undefined → 必 optional chaining。
 * 勿放寬成 includes('steam')（會誤鎖 "Steamworks Demo" 之類）。
 */

import type { GameInfo } from 'common/types'

export function isSteamSideloadInfo(info: GameInfo | undefined): boolean {
  if (!info) return false
  if (info.app_name?.startsWith('steam-')) return true
  return (
    info.title?.trim().toLowerCase() === 'steam' &&
    info.install?.platform === 'Windows'
  )
}
