/**
 * realHeroicBridge.ts
 * ------------------------------------------------------------------
 * Helmsman — Phase 3b：HeroicBridge 契約的【真實 adapter】。
 *
 * 把 heroicBridge.ts 的六個 ⚠ 佔位接到 Heroic v2.22.0 既有函式。鐵律（§12.7）：
 * 只「呼叫 Heroic 既有函式」，絕不重寫安裝/設定邏輯。
 *
 * 此檔【只能住在 Heroic（fork）tree 內】——它 import Heroic 內部模組
 * （backend/tools、backend/game_config…），無法在 Helmsman 主 repo 獨立編譯。
 *
 * 對照基準：Heroic fork `helmsman-ai-3b`（基於 tag v2.22.0 / commit 0411046）。
 * 每個方法對應的真實函式/檔案/簽章已逐一對照真實源碼核出，詳見
 * Helmsman repo 的 docs/phase3b-heroic-integration.md（§0 後端模型、§1 逐方法）。
 *
 * 接線（待做）：Heroic 主程序把 `realHeroicBridge` 注入 actionExecutor，取代
 * heroicBridge.ts 的 notWiredBridge（live 模式）。dry-run 流程不碰 bridge。
 */

import { join } from 'path'

import { DXVK, Winetricks } from 'backend/tools'
import { GameConfig } from 'backend/game_config'
import { GlobalConfig } from 'backend/config'
import { runWineCommand } from 'backend/launcher'
import { addNewApp } from 'backend/storeManagers/sideload/library'
import { defaultWinePrefixDir } from 'backend/constants/paths'
import {
  updateWineVersionInfos,
  installWineVersion,
  removeWineVersion,
  wineDownloaderInfoStore
} from 'backend/wine/manager/utils'

import type {
  GameInfo,
  GameSettings,
  WineInstallation,
  WineVersionInfo,
  WineManagerStatus,
  Type as WineReleaseType
} from 'common/types'

import type { Backend } from './types'
import type { HeroicBridge, GameRef } from './heroicBridge'

// ── 共享 helper（config / wine）───────────────────────────────────
//
// 全部呼叫 Heroic 既有函式，未重寫任何安裝/設定邏輯。簽章皆對照 fork
// (v2.22.0 / 0411046) 真實源碼核出：
//   DXVK.installRemove(gs,'dxvk','backup'|'restore'):Promise<boolean>  backend/tools/index.ts:205
//   GameConfig.get(appName).setSetting(k,v):void(同步,內部 flush)       backend/game_config.ts:321
//   GameConfig.get(appName).getSettings():Promise<GameSettings>         backend/game_config.ts:203
//   GlobalConfig.get().getAlternativeWine():Promise<WineInstallation[]> backend/config.ts:191
//   updateWineVersionInfos/installWineVersion/removeWineVersion         backend/wine/manager/utils.ts:140/262/353(export 407)
//   wineDownloaderInfoStore.get('wine-releases',[]):WineVersionInfo[]   backend/wine/manager/utils.ts:28
//   addNewApp(GameInfo):void                                           backend/storeManagers/sideload/library.ts:10
//   runWineCommand(WineCommandArgs)                                    backend/launcher.ts:1495(export 2087-2100)

/** CrossOver bottle 全域 fallback（對齊 Heroic GlobalConfig 預設 'Heroic'，config.ts:355）。 */
const DEFAULT_CROSSOVER_BOTTLE = 'Heroic'

/**
 * 依 macOS 後端模型，從 getAlternativeWine() 的真實 WineInstallation 清單挑出
 * 符合 backend 的安裝。挑不到 → undefined（呼叫端 throw「後端不可用」，絕不捏造路徑）。
 *
 * predicate（§0 已複驗）：
 *   gptk      → type==='toolkit'
 *   crossover → type==='crossover'
 *   dxmt      → type==='wine' 且 name 以 '-DXMT' 結尾
 *   dxvk      → type==='wine' 且 name 不以 '-DXMT' 結尾（純 wine）
 *   wined3d   → 同 dxvk 的純 wine（差別只在 DXVK 裝/移除，不在挑哪個 wine）
 *
 * export：installSteam 重用同一 predicate。
 */
export function selectWineForBackend(
  backend: Backend,
  wines: WineInstallation[]
): WineInstallation | undefined {
  switch (backend) {
    case 'gptk':
      return wines.find((w) => w.type === 'toolkit')
    case 'crossover':
      return wines.find((w) => w.type === 'crossover')
    case 'dxmt':
      return wines.find((w) => w.type === 'wine' && w.name.endsWith('-DXMT'))
    case 'dxvk':
    case 'wined3d':
      return wines.find((w) => w.type === 'wine' && !w.name.endsWith('-DXMT'))
    default:
      return undefined
  }
}

/**
 * variant 字串 → wine-releases store 內的 WineVersionInfo.type（common/types.ts:753
 * 的 Type，macOS 三種）。別名先正規化（去空白/連字號、轉小寫）。挑不到 → undefined。
 */
function wineReleaseTypeForVariant(
  variant: string
): WineReleaseType | undefined {
  const key = variant.toLowerCase().replace(/[\s_-]/g, '')
  switch (key) {
    case 'winestaging':
    case 'winestagingmacos':
    case 'dxmt': // DXMT 變體底層即 Wine-Staging-macOS（裝後再加 DXMT dll 進 -DXMT 複本）
      return 'Wine-Staging-macOS'
    case 'crossover':
    case 'winecrossover':
      return 'Wine-Crossover'
    case 'gptk':
    case 'gameportingtoolkit':
      return 'Game-Porting-Toolkit'
    default:
      return undefined
  }
}

/** wine 變體安裝進度回呼的 no-op（adapter 不上報 UI 進度，由上層自管）。 */
const noopWineProgress: (status: WineManagerStatus) => void = () => {}

// ── 共享 helper（sideload）─────────────────────────────────────────

/**
 * 為 sideload 安裝產生「決定式」app_name（禁亂數/時間，否則每次都新增重複條目）。
 * 規則：'steam-' + backend（backend 是封閉字面量，URL-safe）。同後端重呼時，
 * addNewApp 以 app_name 比對既有 → 就地更新（library.ts:56-60），不會堆疊。
 * 決定式亦讓呼叫端能自行重建此 appName（介面回 void 但不需另回傳）。
 */
const sideloadAppName = (backend: Backend): string => `steam-${backend}`

/**
 * SEED §1.5：SteamSetup.exe 的本機路徑。
 * HeroicBridge.installSteam 介面只給 { backend }，未給安裝器路徑；Heroic 本身沒有
 * 「下載 Valve 安裝器」的 API（純 sideload 流程平常靠使用者手選 exe）。未注入前
 * installSteam 會直接 throw（見方法內守衛），不對空命令呼叫 runWineCommand。
 */
const STEAM_SETUP_EXE = '' // TODO(SEED §1.5)：實裝前注入真實 SteamSetup.exe 路徑

// ── adapter 本體 ──────────────────────────────────────────────────

class RealHeroicBridge implements HeroicBridge {
  /**
   * → Winetricks.install(runner, appName, component)（tools/index.ts:760）。
   * ⚠ 前置陷阱：該遊戲須有有效 wineVersion + 已初始化 prefix，否則 runWithArgs 靜默早退、
   *   本方法仍 resolve（看似成功實則 no-op）。上層（actionExecutor）應先確保 prefix 已建。
   */
  async installWinetricks(args: {
    verb: string
    game: GameRef
  }): Promise<void> {
    await Winetricks.install(args.game.runner, args.game.appName, args.verb)
  }

  /**
   * → macOS 無單一 backend 欄位（§0）：= wineVersion(物件) + autoInstallDxvk + DXVK 實體裝/移除。
   */
  async switchBackend(args: {
    backend: Backend
    game: GameRef
  }): Promise<void> {
    const { backend, game } = args
    const cfg = GameConfig.get(game.appName)

    // 1) 挑真實 WineInstallation（挑不到＝使用者沒裝該 runtime → 後端不可用）。
    const wines = await GlobalConfig.get().getAlternativeWine()
    const chosen = selectWineForBackend(backend, wines)
    if (!chosen) {
      throw new Error(
        `後端不可用：找不到對應 ${backend} 的 Wine 安裝（使用者尚未安裝該 runtime）`
      )
    }

    // 2) 指定 wineVersion（物件，非字串）。setSetting 同步、內部 flush。
    cfg.setSetting('wineVersion', chosen)

    // 3) 依後端補設定。
    switch (backend) {
      case 'gptk':
      case 'dxmt':
        // toolkit / DXMT prefix 上不裝 DXVK。
        cfg.setSetting('autoInstallDxvk', false)
        break

      case 'crossover': {
        cfg.setSetting('autoInstallDxvk', false)
        // CrossOver 需 bottle 名；不覆寫使用者既有值，只有未設時才填全域預設。
        const cs = await cfg.getSettings()
        if (!cs.wineCrossoverBottle) {
          cfg.setSetting('wineCrossoverBottle', DEFAULT_CROSSOVER_BOTTLE)
        }
        break
      }

      case 'dxvk': {
        // 先把 DXVK 實體裝進 prefix（macOS 自動 remap 'dxvk'→'dxvk-macOS'），成功才開旗標。
        // getSettings 取在 setSetting('wineVersion') 之後，gs.wineVersion 才是新挑的純 wine。
        const gs = await cfg.getSettings()
        const ok = await DXVK.installRemove(gs, 'dxvk', 'backup')
        if (!ok) {
          throw new Error(
            '切換到 dxvk 後端失敗：DXVK.installRemove(backup) 回報失敗'
          )
        }
        cfg.setSetting('autoInstallDxvk', true)
        break
      }

      case 'wined3d': {
        // 純 wine + 移除 DXVK：先 restore（移除 DXVK dll），再關 autoInstallDxvk。
        const gs = await cfg.getSettings()
        await DXVK.installRemove(gs, 'dxvk', 'restore')
        cfg.setSetting('autoInstallDxvk', false)
        break
      }
    }
  }

  /**
   * → DXVK.installRemove(gs,'dxvk','backup')（tools/index.ts:205；'backup'=裝/啟用）。
   * macOS 自動 remap 'dxvk'→'dxvk-macOS'；toolkit / '-DXMT' prefix 上自動 no-op。
   */
  async installDxvk(args: { game: GameRef }): Promise<void> {
    const gs = await GameConfig.get(args.game.appName).getSettings()
    await DXVK.installRemove(gs, 'dxvk', 'backup')
  }

  /**
   * → 無 reinstall API：自組「resolve release → remove → install」。
   * wine 變體是全域安裝，args.game 在此用不到（簽章保留以符合介面）。
   */
  async reinstallWineVariant(args: {
    variant: string
    game: GameRef
  }): Promise<void> {
    const wantType = wineReleaseTypeForVariant(args.variant)
    if (!wantType) {
      throw new Error(`不認得的 Wine 變體：'${args.variant}'`)
    }

    // 確保 wine-releases store 有資料；空則 fetch 一次。
    let releases: WineVersionInfo[] = wineDownloaderInfoStore.get(
      'wine-releases',
      []
    )
    if (releases.length === 0) {
      releases = await updateWineVersionInfos(true)
    }

    // 挑對應 type 的 release：優先已安裝者（reinstall 語意），否則取該 type 第一個。
    const candidates = releases.filter((r) => r.type === wantType)
    const release = candidates.find((r) => r.isInstalled) ?? candidates[0]
    if (!release) {
      throw new Error(
        `找不到可重裝的 Wine 變體 release（type=${wantType}，variant='${args.variant}'）`
      )
    }

    // installWineVersion 回【裸字串】 'success'|'error'|'abort'（已對源碼核實，非 {status}）。
    await removeWineVersion(release)
    const status = await installWineVersion(release, noopWineProgress)
    if (status !== 'success') {
      throw new Error(
        `重裝 Wine 變體 '${args.variant}' 失敗（installWineVersion 回 '${status}'）`
      )
    }
  }

  /**
   * → 無 installSteam API：= 通用 sideload 流程（§1.5，照 SideloadDialog/handleRunExe）。
   * 介面回 void；新建 appName 為決定式 sideloadAppName(backend)，呼叫端可自行重建。
   */
  async installSteam(args: { backend: Backend }): Promise<void> {
    const { backend } = args

    // SteamSetup.exe 路徑為 SEED：未注入前不可跑空命令，直接大聲失敗。
    if (!STEAM_SETUP_EXE) {
      throw new Error(
        'installSteam 尚未設定 SteamSetup.exe 路徑（SEED §1.5）：請先由上層注入安裝器路徑'
      )
    }

    const title = 'Steam'
    const appName = sideloadAppName(backend)

    // 先確認該後端有真實 WineInstallation（沒裝就別建空條目）。
    const wineVersion = selectWineForBackend(
      backend,
      await GlobalConfig.get().getAlternativeWine()
    )
    if (!wineVersion) {
      throw new Error(
        `後端不可用：找不到對應 ${backend} 的 Wine 安裝（使用者尚未安裝該 runtime）`
      )
    }

    // 每個後端各自獨立 prefix（用 appName 而非固定 title，避免不同後端互踩同一路徑）。
    const winePrefix = join(defaultWinePrefixDir, appName)

    // a. 註冊 sideload 條目（addNewApp 內部固定 runner:'sideload'）。
    const gameInfo: GameInfo = {
      runner: 'sideload',
      app_name: appName,
      title,
      art_cover: '',
      art_square: '',
      is_installed: true,
      canRunOffline: true,
      install: {
        executable: STEAM_SETUP_EXE,
        platform: 'Windows'
      }
    }
    addNewApp(gameInfo)

    // b. 覆寫 winePrefix + wineVersion。用 setSetting 逐鍵 merge，
    //    【不】用 writeConfig——writeConfig（utils.ts:1640）是整份取代（:1674 直接覆寫 .config），
    //    只帶部分鍵會清掉其餘設定（§1.6 陷阱）。setSetting 才安全。
    const cfg = GameConfig.get(appName)
    cfg.setSetting('winePrefix', winePrefix)
    cfg.setSetting('wineVersion', wineVersion)

    // c. 跑安裝器（protonVerb 必須 'runinprefix'；wait 等它跑完）。
    //    prefix 不存在時 runWineCommand 內部會自動 verifyWinePrefix 建立。
    const gs = await cfg.getSettings()
    await runWineCommand({
      gameSettings: gs,
      commandParts: [STEAM_SETUP_EXE],
      wait: true,
      protonVerb: 'runinprefix'
    })
  }

  /**
   * → GameConfig.get(appName).setSetting(key, value)（game_config.ts:321，同步、內部 flush）。
   * ⚠ runner 不參與定址（只用 appName）。切後端的 wineVersion 是物件、屬 switchBackend。
   */
  async changeSetting(args: {
    key: string
    value: unknown
    game: GameRef
  }): Promise<void> {
    GameConfig.get(args.game.appName).setSetting(
      args.key as keyof GameSettings,
      args.value
    )
  }
}

/** 注入用單例（live 模式取代 notWiredBridge）。 */
export const realHeroicBridge: HeroicBridge = new RealHeroicBridge()
