/**
 * heroicConfirm.ts
 * ------------------------------------------------------------------
 * Helmsman — apply 的【主程序權威確認】adapter（§12.9）。
 *
 * 用 Electron 原生 `dialog.showMessageBox`（主程序、可 await、回傳使用者真實按鍵）取得確認——
 * 這是 §12.9「絕不靜默套用」唯一可信的錨：renderer 無法偽造（不像 Heroic 的 styled
 * showDialogModal，那的按鈕 callback 在 renderer 跑）。由 ipc_handler 注入 runApply →
 * executeAction 的確認閘呼叫。
 *
 * 此檔【只能住在 Heroic（fork）tree 內】——import electron / main_window / i18next。
 * orchestrator / actionExecutor 永不 import 它（DI 鐵律，維持純函式零 mock 可測）。
 */

import { dialog } from 'electron'
import { t } from 'i18next'

import { getMainWindow } from 'backend/main_window'

import type { PlannedCall } from './actionExecutor'

/**
 * 彈原生確認框，回 true 才執行。型別相容 ExecuteOptions.confirm（context 用不到故省略，
 * 少參數的函式仍可賦值給多參數的 callback 型別）。
 *   - cancelId/defaultId=1：Esc / 關窗 / 預設聚焦都落在「否」→ fail-closed。
 *   - getMainWindow 可能回 undefined（main_window.ts）→ 無窗時用單參 overload fallback。
 *   - message 用 plan.description（已是人話）；風險警語依 plan.reversible 分流。
 */
export async function helmsmanConfirm(plan: PlannedCall): Promise<boolean> {
  const win = getMainWindow()
  const opts: Electron.MessageBoxOptions = {
    type: 'warning',
    title: t('helmsman.confirm.title', 'Apply this fix?'),
    message: plan.description,
    detail: plan.reversible
      ? t('helmsman.confirm.reversible', 'This changes game settings.')
      : t(
          'helmsman.confirm.irreversible',
          'This modifies the game and cannot be undone.'
        ),
    buttons: [t('box.yes', 'Yes'), t('box.no', 'No')],
    cancelId: 1,
    defaultId: 1
  }
  const { response } = win
    ? await dialog.showMessageBox(win, opts)
    : await dialog.showMessageBox(opts)
  return response === 0
}
