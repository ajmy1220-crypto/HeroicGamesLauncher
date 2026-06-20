/**
 * heroicBridge.ts
 * ------------------------------------------------------------------
 * Helmsman — 「我們需要 Heroic 提供的操作」契約介面（藍圖 §6.4 / §8）。
 *
 * 這是【我方契約】，不是 Heroic 真實函式簽章：actionExecutor 只透過此介面
 * 與 Heroic 對話，永遠不直接呼叫、不猜測 Heroic 內部函式（鐵律 §12.7「呼叫
 * Heroic 既有函式，絕不重寫安裝邏輯」）。真正把這些方法接到 Heroic live repo
 * 既有函式，屬 Phase 3b（需讀實際 repo 核對簽章，見 §8 整合點表）。
 *
 * ✅ Phase 3b 調查已完成：各方法對應的【真實 Heroic 函式 / 檔案 / 簽章 / 呼叫方式 /
 *   陷阱】已對照 Heroic v2.22.0 原始碼核出，詳見 docs/phase3b-heroic-integration.md。
 *   下方各方法註解標出對應的真實函式（v2.22.0 行號）。動工前請以 Bryan 實際安裝的
 *   版本重新核對（Heroic 是移動標的）；adapter 實作須在 Heroic（fork）tree 內進行
 *   （它 import Heroic 內部模組，無法在本 repo 獨立編譯）。
 *
 * 依賴方向：
 *   types.ts ← heroicBridge.ts ← actionExecutor.ts ←（ipc / panel）
 *
 * 本檔只引入 type（Backend / GameContext），不帶任何 Heroic runtime 依賴：
 * Phase 3 之前在無 live repo 環境下仍可完整編譯與測試。
 */

import type { Backend, GameContext } from './types'

// ── 遊戲辨識 ──────────────────────────────────────────────────────

/**
 * 辨識一款遊戲所需的最小資訊（appName + runner）。
 * 從 GameContext 取子集，避免把整包執行脈絡（含後端/OS 等）漏進 bridge 簽章。
 */
export type GameRef = Pick<GameContext, 'appName' | 'runner'>

// ── 契約介面 ──────────────────────────────────────────────────────

/**
 * Helmsman 要求 Heroic 提供的全部操作。皆 async；多數無回傳值（副作用型），
 * 由 actionExecutor 包成 ExecutionResult 回報結果。
 *
 * ⚠ 以下每個方法的「真實實作」都待對照藍圖 §8 整合點表 + live repo 核對簽章。
 */
export interface HeroicBridge {
  /**
   * → Heroic v2.22.0：`Winetricks.install(runner, appName, component)`（tools/index.ts ~L760）。
   *   adapter 直接 import 呼叫（backend 內部，不走 renderer）。verb→component、game→(runner,appName)。
   *   ⚠ 前置：該遊戲須有有效 wineVersion + 已初始化的 prefix，否則 runWithArgs 靜默早退。
   */
  installWinetricks(args: { verb: string; game: GameRef }): Promise<void>

  /**
   * → Heroic v2.22.0：macOS 上【無單一 backend 欄位】。後端 = `wineVersion`(WineInstallation 物件) +
   *   `autoInstallDxvk` + DXVK 實體裝/移除的組合。adapter 須 `GlobalConfig.getAlternativeWine()`
   *   挑真實 WineInstallation → `GameConfig.setSetting('wineVersion',…)`；dxvk↔wined3d 還要
   *   `DXVK.installRemove`(toggleDXVK backup/restore)。完整對照表見 docs/phase3b-heroic-integration.md §0/§1。
   *   ⚠ 後端不可用(使用者沒裝該 runtime)應 throw。§11：actionExecutor 已先擋 Steam 客戶端 prefix。
   */
  switchBackend(args: { backend: Backend; game: GameRef }): Promise<void>

  /**
   * → Heroic v2.22.0：`DXVK.installRemove(gameSettings, 'dxvk', 'backup')`（tools/index.ts:205；
   *   'backup'=裝/啟用）。adapter 先 `GameConfig.get(appName).getSettings()` 取 gs。macOS 自動
   *   remap 'dxvk'→'dxvk-macOS'。⚠ toolkit/`-DXMT` prefix 上自動 no-op。
   */
  installDxvk(args: { game: GameRef }): Promise<void>

  /**
   * → Heroic v2.22.0：【無 reinstall API】。adapter 自組：從 `wine-releases` store 把 variant
   *   resolve 成 WineVersionInfo → `removeWineVersion(release)` 再 `installWineVersion(release,onProgress)`
   *   （wine/manager/utils.ts:262/353）。⚠ wine 變體是全域安裝，`game` 在此用不到。
   */
  reinstallWineVariant(args: { variant: string; game: GameRef }): Promise<void>

  /**
   * → Heroic v2.22.0：【無 installSteam】。= 通用 sideload 流程，照 SideloadDialog/index.tsx(handleRunExe)：
   *   `addNewApp({runner:'sideload',title:'Steam',install:{executable:SteamSetup.exe,platform:'Windows'}})`
   *   (storeManagers/sideload/library.ts:10) → 覆寫 winePrefix/wineVersion → `runWineCommand({commandParts,
   *   wait:true, protonVerb:'runinprefix'})`(launcher.ts:1495)。⚠ addNewApp 回 void;介面宜回傳新建 appName。
   */
  installSteam(args: { backend: Backend }): Promise<void>

  /**
   * → Heroic v2.22.0：`GameConfig.get(appName).setSetting(key, value)`（game_config.ts:46/321，
   *   同步、內部 flush()）。⚠ runner 不參與定址（只用 appName）。別誤用 GlobalConfig.setSetting(改全域)
   *   或 writeConfig(整份取代)。切後端的 wineVersion 是物件非字串(屬 switchBackend)。
   */
  changeSetting(args: {
    key: string
    value: unknown
    game: GameRef
  }): Promise<void>
}

// ── live 模式預設：未接線即大聲失敗 ───────────────────────────────

/**
 * 尚未接上 Heroic 時的預設 bridge：每個方法都 throw。
 *
 * 作為 live（非 dry-run）模式的安全預設——若上層忘了注入真實 bridge，會立刻
 * 大聲失敗，而不是靜默假裝成功。dry-run 流程不碰 bridge，故不受此影響。
 */
export const notWiredBridge: HeroicBridge = {
  installWinetricks() {
    return Promise.reject(notWiredError())
  },
  switchBackend() {
    return Promise.reject(notWiredError())
  },
  installDxvk() {
    return Promise.reject(notWiredError())
  },
  reinstallWineVariant() {
    return Promise.reject(notWiredError())
  },
  installSteam() {
    return Promise.reject(notWiredError())
  },
  changeSetting() {
    return Promise.reject(notWiredError())
  }
}

/** ⚠ Phase 3b 接上實際函式後即移除此佔位錯誤。 */
function notWiredError(): Error {
  return new Error(
    '尚未接上 Heroic（Phase 3b 待對照藍圖 §8 / live repo 接上實際函式）'
  )
}
