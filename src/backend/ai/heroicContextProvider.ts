/**
 * heroicContextProvider.ts
 * ------------------------------------------------------------------
 * Helmsman — Phase 4：ContextProvider 契約的【真實讀 adapter】（與 realHeroicBridge
 * 的「寫 adapter」對稱）。
 *
 * 後端權威地組出 Helmsman 的 GameContext + 讀遊戲 log，讓前端只需送 { appName, runner }
 * 就能診斷——renderer 不再傳 context，故無法偽造 isWindowsSteamClient 繞 §11 Steam 鎖。
 *
 * 鐵律（§12.7）：只「呼叫 Heroic 既有函式」，絕不重寫設定 / log 邏輯。此檔【只能住在
 * Heroic（fork）tree 內】——它 import Heroic 內部模組（game_config / systeminfo /
 * logger…），無法在 Helmsman 主 repo 獨立編譯。orchestrator 永不 import 本檔（DI 注入）。
 *
 * 對照基準：Heroic fork `helmsman-ai-3b`（基於 tag v2.22.0）。各函式簽章已對照真實源碼：
 *   GameConfig.get(appName).getSettings():Promise<GameSettings>   game_config.ts:46/125
 *   getSystemInfo(cache?):Promise<SystemInformation>             utils/systeminfo/index.ts:74(export :157)
 *   isMac / isIntelMac                                           constants/environment.ts:23/24
 *   getLogFilePath(GetLogFileArgs):string                        logger/paths.ts:46(export :60)
 */

import { existsSync, readFileSync } from 'graceful-fs'

import { GameConfig } from 'backend/game_config'
import { getSystemInfo } from 'backend/utils/systeminfo'
import { isMac, isIntelMac } from 'backend/constants/environment'
import { getLogFilePath } from 'backend/logger/paths'
import { getGameInfo } from 'backend/storeManagers/sideload/games'

import { deriveBackend } from './deriveBackend'
import { isSteamSideloadInfo } from './steamSideload'

import type { ContextProvider } from './orchestrator'
import type { Arch, GameContext, Runner } from './types'

/**
 * arch：macOS 上用 isIntelMac 判，不用 process.arch。
 * R1：Apple Silicon 在 Rosetta 下跑 Heroic 進程時 process.arch 可能回 'x64'，會把 arm64
 * 機器誤判成 x86_64 → 規則層誤判「DXMT/GPTK 不可用」。晶片仍是 arm64、那些後端仍可用，
 * 故以 isIntelMac（看 CPU model 是否含 'Intel'）為 macOS 主判據。非 mac 退回 process.arch。
 */
function resolveArch(): Arch {
  if (isMac) return isIntelMac ? 'x86_64' : 'arm64'
  return process.arch === 'arm64' ? 'arm64' : 'x86_64'
}

/**
 * 權威地組出 GameContext（全部呼叫 Heroic 既有函式）。
 * isWindowsSteamClient 由 sideload GameInfo 權威判（§11）；directxVersion / is32bit 仍無
 * 權威來源 → [SEED] 不帶。
 */
export async function assembleGameContext(
  appName: string,
  runner: Runner
): Promise<GameContext> {
  const gs = await GameConfig.get(appName).getSettings()
  const systemInfo = await getSystemInfo()

  return {
    appName,
    runner,
    currentBackend: deriveBackend(gs.wineVersion, gs.autoInstallDxvk),
    // GameContext.wineVersion 是 string；Heroic 的是 WineInstallation 物件 → 取 .name。
    // （規則層不消費此欄，僅供顯示 / 知識層記錄。）
    wineVersion: gs.wineVersion.name,
    osVersion: systemInfo.OS.version,
    arch: resolveArch(),
    // §11：apply 上線後 Steam 鎖須權威——只有 sideload 可能是 Windows Steam 客戶端，讀其
    // GameInfo 以 isSteamSideloadInfo 判（fail-safe）；非 sideload runner 必非 Steam 客戶端。
    isWindowsSteamClient:
      runner === 'sideload' ? isSteamSideloadInfo(getGameInfo(appName)) : false
    // [SEED] directxVersion / is32bit 無權威來源 → 不帶（規則層對未知 dx 有定義行為）。
  }
}

/**
 * 讀該遊戲最近一次執行的 log（stdout+stderr 合併落地於 launch.log）。
 * 比照 logger/ipc_handler.ts:17-20，但後端直呼 getLogFilePath 不繞 IPC。
 * 檔不存在 / 沒跑過 → 回 ''（analyze 對空字串回 launched_ok / 無 signals，不 throw）。
 */
export function readGameLog(appName: string, runner: Runner): string {
  const path = getLogFilePath({ appName, runner })
  return existsSync(path) ? readFileSync(path, 'utf-8') : ''
}

/** 注入用單例（live 模式由 ipc_handler 注入 orchestrator）。 */
export const heroicContextProvider: ContextProvider = {
  assembleGameContext,
  readGameLog
}
