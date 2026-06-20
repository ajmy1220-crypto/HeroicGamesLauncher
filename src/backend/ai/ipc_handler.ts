/**
 * ai/ipc_handler.ts
 * ------------------------------------------------------------------
 * Helmsman — Phase 3b：把 orchestration 進入點接上 Heroic 主程序的 IPC。
 *
 * 刻意極薄（trivial wiring，不單元測試，靠 tsc + code review）：
 *   - 這是【唯一】import realHeroicBridge 之處——把真實 adapter 顯式注入 runApply
 *     （非預設參數）。顯式 + 全檔三行，讓「live bridge 接的是 realHeroicBridge」一眼可驗，
 *     消除「預設參數藏住誤傳 notWiredBridge」的盲區。
 *   - 全部不可信輸入驗證 / 信任邊界硬化（§11 / §12.9）都在 orchestrator 內收口。
 *
 * 透過 main.ts 的 side-effect import 載入（比照既有 13 個 *_handler）。
 */

import { addHandler } from '../ipc'

import { runApply, runDiagnose } from './orchestrator'
import { realHeroicBridge } from './realHeroicBridge'
import { heroicContextProvider } from './heroicContextProvider'

// 唯讀診斷：provider 後端權威組 context + 讀 log → analyze→recommend→plans。不碰 bridge。
addHandler('helmsmanDiagnose', (_e, args) =>
  runDiagnose(args, heroicContextProvider)
)

// live 套用：注入 realHeroicBridge（寫）+ heroicContextProvider（讀 context）。orchestrator
// 對 executeAction 一律 confirmed:false（§12.9），本階段僅 install_winetricks 白名單真執行。
addHandler('helmsmanApplyAction', (_e, args) =>
  runApply(args, realHeroicBridge, heroicContextProvider)
)
