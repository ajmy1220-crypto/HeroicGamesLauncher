/**
 * deriveBackend.ts
 * ------------------------------------------------------------------
 * Helmsman — 從「現在設定的」wineVersion 物件 + autoInstallDxvk 推回 Backend。
 *
 * 這是 realHeroicBridge.selectWineForBackend 的【逆】（同一 macOS 後端模型，§0）：
 *   toolkit → gptk；crossover → crossover
 *   wine 且 name 以 '-DXMT' 結尾 → dxmt（名稱判斷優先於 DXVK 旗標）
 *   純 wine → autoInstallDxvk ? dxvk : wined3d（dxvk↔wined3d 唯一區別就是 DXVK 旗標）
 *
 * 抽成獨立純函式（只 `import type`）→ 與 Heroic runtime 完全脫鉤，jest 零 mock 可測；
 * heroicContextProvider 引用它組 currentBackend。
 *
 * R5：依賴 '-DXMT' 名稱約定（繼承自 selectWineForBackend）；使用者手裝的變體若不照此
 * 後綴會誤判。currentBackend 是決策三軸之一，誤判會連帶錯判建議。
 */

import type { WineInstallation } from 'common/types'

import type { Backend } from './types'

export function deriveBackend(
  wineVersion: WineInstallation,
  autoInstallDxvk: boolean
): Backend {
  switch (wineVersion.type) {
    case 'toolkit':
      return 'gptk'
    case 'crossover':
      return 'crossover'
    case 'wine':
      if (wineVersion.name.endsWith('-DXMT')) return 'dxmt'
      return autoInstallDxvk ? 'dxvk' : 'wined3d'
    case 'proton':
    default:
      // [SEED] macOS 後端模型無 proton（getMacOsWineSet 只產 toolkit/crossover/wine）。
      // 防禦性：未知 type 退化成 wined3d（無翻譯保底），不讓 currentBackend 漏成 undefined。
      return 'wined3d'
  }
}
