/**
 * actionExecutor.ts
 * ------------------------------------------------------------------
 * Helmsman 動作執行（橋接層，藍圖 §6.4）。
 *
 * 職責：把決策層產出的 RecommendedAction 對應成對 HeroicBridge 的一次呼叫，
 * 並負責執行前的全部安全閘門（參數驗證、Steam 鎖、確認閘、dry-run）。
 *
 * 它「不」做的事（鐵律）：
 *   - 絕不重寫安裝邏輯，絕不直接呼叫 / 猜測 Heroic 內部函式——一律透過注入的
 *     HeroicBridge 契約介面（§12.7）。
 *   - planAction / planAll 是純函式：無副作用、不呼叫 AI、不碰 IO，只把 action
 *     翻成「打算呼叫什麼」（PlannedCall），供 UI dry-run 預覽與審查（§6.4）。
 *   - 全程不修改傳入的 action / context（與決策層同樣的純度承諾）。
 *
 * 安全邊界（§6.4 / §11 / §12.9）：
 *   - 不可逆 / 改系統的動作須先經使用者確認，絕不靜默套用。
 *   - 不得對 Windows Steam 客戶端的 prefix 換後端（會弄壞 Steam）。
 *   - dry-run 只記錄打算呼叫什麼，完全不碰 bridge。
 *
 * 型別就近放此檔：只有橋接層消費，不污染 types.ts（types.ts 維持純型別真相源）。
 */

import type { HeroicBridge } from './heroicBridge'
import type {
  Backend,
  GameContext,
  Recommendation,
  RecommendedAction
} from './types'

// ── 橋接層專用型別（僅此層消費）──────────────────────────────────

/** 對應 HeroicBridge 的方法名集合（planAction 的輸出目標）。 */
export type BridgeOperation =
  | 'installWinetricks'
  | 'switchBackend'
  | 'installDxvk'
  | 'reinstallWineVariant'
  | 'installSteam'
  | 'changeSetting'

/**
 * 一次「打算對 bridge 做什麼」的純資料描述。planAction 的產物，dry-run 直接回給 UI。
 *   - args：要傳給 bridge[operation] 的實參（已從 action.params 轉好、鍵名鎖定）。
 *   - reversible：此操作是否可乾淨還原（換後端 / 改設定可逆；裝東西不可逆）。
 *     【資訊性欄位】回給呼叫端（UI / dry-run 預覽）顯示風險用，不參與確認閘判定
 *     （確認閘採白名單策略，見 planAction）；UI 可據此對不可逆動作加強警示。
 *   - requiresConfirmation：執行前是否須使用者確認。只有白名單動作
 *     （install_winetricks）可在 autoApplyable=true 時為 false；其餘恆 true。
 *   - description：人話「打算呼叫什麼」，供 dry-run 審查顯示。
 */
export interface PlannedCall {
  operation: BridgeOperation
  args: Record<string, unknown>
  reversible: boolean
  requiresConfirmation: boolean
  description: string
}

/** executeAction 的終態。每個值對應一個明確的「為何停在這裡」。 */
export type ExecutionStatus =
  | 'planned' // dry-run：只規劃、未執行
  | 'executed' // live：bridge 呼叫成功
  | 'skipped_not_executable' // kind:'none'（提示/占位），無可執行操作
  | 'blocked_needs_confirmation' // 須確認但未帶 confirmed
  | 'blocked_steam_lock' // §11：不得對 Steam 客戶端 prefix 換後端
  | 'invalid_params' // params 缺必要鍵（執行期防線）
  | 'failed' // bridge throw

/** executeAction 的回報物件。永遠帶回原 action 與（若有）plan，便於 UI 與 log。 */
export interface ExecutionResult {
  action: RecommendedAction
  plan: PlannedCall | null
  status: ExecutionStatus
  detail: string
}

export interface ExecuteOptions {
  /** true → 只規劃不執行，完全不碰 bridge。 */
  dryRun?: boolean
  /** true → 使用者已確認（通過確認閘）。預設 false：須確認的動作一律先擋。 */
  confirmed?: boolean
  /**
   * 須確認的動作在確認閘呼叫此 callback，取得【主程序權威】的使用者確認（§12.9）。
   * 由呼叫端注入（live 模式＝原生 dialog；測試＝fake）；回 true 才執行、false / 未注入則擋。
   * confirmed:true 仍直接放行（已預先確認路徑），不呼叫此 callback。
   */
  confirm?: (plan: PlannedCall, context: GameContext) => Promise<boolean>
}

// ── 純函式：規劃（planAction / planAll）──────────────────────────

/**
 * 把單一 RecommendedAction 翻成一次 PlannedCall（純函式、無副作用、不碰 bridge）。
 *
 * 依 §6.4 動作對應表把 kind → BridgeOperation + args。args 從 action.params 讀，
 * 鍵名與決策層【鎖定】一致（switch_backend→params.backend、install_winetricks→
 * params.verb、change_setting→params.key）。
 *
 * 注意：此處【不】驗證 params 內容是否齊全——缺鍵屬執行期防線，留給 executeAction
 * 回報 'invalid_params'。planAction 只負責「形狀對應」，故對 dry-run 預覽永遠能產出
 * 一份（可能 args 不全的）計畫供審查；唯 kind:'none' 回 null（提示/占位，不可執行）。
 */
export function planAction(
  action: RecommendedAction,
  context: GameContext
): PlannedCall | null {
  const game = gameRefOf(context)
  // 確認閘策略（§6.4 不可逆/改系統須確認、§12.9 絕不靜默套用）：
  // 只有白名單動作（install_winetricks，低風險）可在 autoApplyable=true 時免確認；
  // 其餘動作即使被上游（可能是 LLM / IPC，皆不可信）標成 autoApplyable=true，
  // executor 作為【最後安全閘門】仍一律要求確認——不把「可否靜默套用」的判斷外包
  // 給上游旗標。一個被誤標 / 幻覺標成 autoApplyable=true 的 install_steam 不該靜默執行。
  const requiresConfirmation =
    action.kind === 'install_winetricks' ? action.autoApplyable !== true : true

  switch (action.kind) {
    case 'install_winetricks':
      return {
        operation: 'installWinetricks',
        args: { verb: action.params.verb, game },
        reversible: false,
        requiresConfirmation,
        description: `安裝 winetricks「${String(action.params.verb)}」到 ${game.appName}`
      }

    case 'switch_backend':
      return {
        operation: 'switchBackend',
        args: { backend: action.params.backend, game },
        reversible: true,
        requiresConfirmation,
        description: `將 ${game.appName} 的後端切換為 ${String(action.params.backend)}`
      }

    case 'install_dxvk':
      return {
        operation: 'installDxvk',
        args: { game },
        reversible: false,
        requiresConfirmation,
        description: `安裝 DXVK 到 ${game.appName}`
      }

    case 'reinstall_wine_variant':
      return {
        operation: 'reinstallWineVariant',
        args: { variant: action.params.variant, game },
        reversible: false,
        requiresConfirmation,
        description: `重裝 wine 變體「${String(action.params.variant)}」到 ${game.appName}`
      }

    case 'install_steam':
      // installSteam 不綁單一遊戲（建立新 sideload Steam），args 只帶後端。
      return {
        operation: 'installSteam',
        args: { backend: action.params.backend },
        reversible: false,
        requiresConfirmation,
        description: `以 ${String(action.params.backend)} 後端安裝第二套 Steam`
      }

    case 'change_setting':
      return {
        operation: 'changeSetting',
        args: { key: action.params.key, value: action.params.value, game },
        reversible: true,
        requiresConfirmation,
        description: `將 ${game.appName} 的設定「${String(action.params.key)}」改為 ${String(action.params.value)}`
      }

    case 'none':
      // 提示 / 占位（如 Steam 鎖提示、crossover 提示、AI 占位）——無可執行操作。
      return null

    default:
      // 型別上 kind 已窮盡；保留防呆以免將來新增 kind 時悄悄漏接。
      return null
  }
}

/**
 * 把整份 Recommendation 的 actions 規劃成 PlannedCall[]（過濾掉 null，供 UI dry-run 預覽）。
 * 純函式：不改 rec / context，不碰 bridge。
 */
export function planAll(
  rec: Recommendation,
  context: GameContext
): PlannedCall[] {
  const plans: PlannedCall[] = []
  for (const action of rec.actions) {
    const plan = planAction(action, context)
    if (plan !== null) plans.push(plan)
  }
  return plans
}

// ── 執行（唯一帶副作用之處，且仍把副作用全部收進注入的 bridge）─────

/**
 * 執行單一動作：規劃 → 安全閘門 →（dry-run 規劃 / live 呼叫 bridge）。
 *
 * 閘門順序（任一不過即短路回報，後續不執行）：
 *   1. plan===null → 'skipped_not_executable'（kind:'none'）。
 *   2. 參數驗證：缺必要鍵 → 'invalid_params'（params:Record<string,unknown> 的執行期防線）。
 *   3. Steam 鎖（§11）：對 Windows Steam 客戶端，任何會動 prefix wine/後端的操作 → 'blocked_steam_lock'。
 *   4. 確認閘（§6.4 / §12.9）：須確認但未 confirmed → 'blocked_needs_confirmation'（絕不靜默套用）。
 *   5. dry-run：不碰 bridge → 'planned'。
 *   6. live：呼叫 bridge[operation](args)；成功 'executed'，bridge throw 則 catch → 'failed'（不外拋）。
 *
 * 全程不修改傳入的 action / context。
 */
export async function executeAction(
  action: RecommendedAction,
  context: GameContext,
  bridge: HeroicBridge,
  opts: ExecuteOptions = {}
): Promise<ExecutionResult> {
  const plan = planAction(action, context)

  // 1｜不可執行（提示 / 占位）。
  if (plan === null) {
    return {
      action,
      plan: null,
      status: 'skipped_not_executable',
      detail: '此動作為提示 / 占位（kind:none），無可執行的 Heroic 操作'
    }
  }

  // 2｜參數驗證（執行期防線：params 是 Record<string,unknown>，可能缺鍵）。
  const missing = missingArgKeys(plan)
  if (missing.length > 0) {
    return {
      action,
      plan,
      status: 'invalid_params',
      detail: `缺少必要參數：${missing.join('、')}`
    }
  }

  // 3｜Steam 鎖（§11 / §6.8）：Windows Steam 客戶端鎖在單一 Wine-Staging+DXMT
  //    prefix，「改 wine 版本【或】後端」都會弄壞它——不只換後端。故攔截【全部】會
  //    動到該 prefix wine/後端的操作（見 mutatesSteamPrefix），不只 switchBackend。
  //    判定以 isWindowsSteamClient===true 為單一充分條件：這個「危險事實」本身即足
  //    以鎖，不再 AND runner——runner 與此旗標是兩個獨立來源，AND 會在資料漂移
  //    （旗標填了、runner 沒同步）時讓安全鎖默默失效。
  if (context.isWindowsSteamClient === true && mutatesSteamPrefix(plan)) {
    return {
      action,
      plan,
      status: 'blocked_steam_lock',
      detail:
        '此 app 為 Windows Steam 客戶端，其 prefix 的 wine 版本 / 後端已鎖定（更動會弄壞 Steam，§11）；改為另裝對應後端的第二套 Steam'
    }
  }

  // 4｜確認閘（§6.4 / §12.9）：須確認且未預先確認 → 取【主程序權威】確認（opts.confirm）。
  //    confirm 回 false（或未注入）一律擋下，絕不靜默套用。Steam 鎖（步驟 3）已在此之前，
  //    故 Steam 客戶端永遠擋在 confirm 之前、不會先彈確認框再被擋。
  if (plan.requiresConfirmation && opts.confirmed !== true) {
    const confirmed = opts.confirm ? await opts.confirm(plan, context) : false
    if (!confirmed) {
      return {
        action,
        plan,
        status: 'blocked_needs_confirmation',
        detail:
          '此動作不可逆 / 會改系統，須使用者確認後才能套用（未確認或已取消）'
      }
    }
  }

  // 5｜dry-run：只規劃，完全不碰 bridge。
  if (opts.dryRun === true) {
    return {
      action,
      plan,
      status: 'planned',
      detail: `（dry-run）打算呼叫 ${plan.operation}：${plan.description}`
    }
  }

  // 6｜live：呼叫 bridge。bridge throw 不外拋，收成 'failed'。
  try {
    await callBridge(bridge, plan)
    return {
      action,
      plan,
      status: 'executed',
      detail: `已執行 ${plan.operation}：${plan.description}`
    }
  } catch (err) {
    return {
      action,
      plan,
      status: 'failed',
      detail: `執行 ${plan.operation} 失敗：${errorMessage(err)}`
    }
  }
}

// ── 小工具（皆純函式，無副作用）──────────────────────────────────

/** 從 GameContext 取出 bridge 辨識遊戲所需的最小子集。 */
function gameRefOf(context: GameContext): {
  appName: string
  runner: GameContext['runner']
} {
  return { appName: context.appName, runner: context.runner }
}

/**
 * 此操作是否會更動到（Steam 客戶端的）prefix 的 wine 版本 / 圖形後端。
 * §11 / §6.8：改 wine 版本「或」後端都會弄壞鎖定的 Steam 客戶端，故下列皆算：
 *   - switchBackend / reinstallWineVariant：直接換後端 / 重裝 wine 變體。
 *   - installDxvk：把 DXVK 圖形後端裝進 prefix，與 Steam 客戶端的 DXMT 衝突。
 *   - changeSetting：key 命中 wine 版本 / 後端 / 圖形轉譯層類設定時。
 * installWinetricks（加相依，不動 wine/後端）、installSteam（另建新 sideload）不算。
 */
function mutatesSteamPrefix(plan: PlannedCall): boolean {
  switch (plan.operation) {
    case 'switchBackend':
    case 'reinstallWineVariant':
    case 'installDxvk':
      return true
    case 'changeSetting': {
      const key = String(plan.args.key ?? '').toLowerCase()
      return /wine|backend|dxvk|dxmt|gptk|d3dmetal|crossover|prefix/.test(key)
    }
    default:
      return false
  }
}

/**
 * 各 operation 的「必要鍵」白名單（執行期防線用）。
 * 只列從 action.params 來、可能缺漏的鍵；game 由 context 必有、不列入檢查。
 */
const REQUIRED_ARGS: Record<BridgeOperation, readonly string[]> = {
  installWinetricks: ['verb'],
  switchBackend: ['backend'],
  installDxvk: [], // 只需 game，無 params 依賴。
  reinstallWineVariant: ['variant'],
  installSteam: ['backend'],
  changeSetting: ['key'] // value 允許 undefined / null（清空設定也是合法寫入）。
}

/**
 * 回傳 plan.args 中缺少的必要鍵清單；齊全則回空陣列。
 * 以 == null 判定，同時擋 undefined 與 null——params 來源是 Record<string,unknown>
 * （IPC / LLM 不可信），backend/verb/variant/key 為 null 無意義，應與缺鍵同等視為
 * invalid_params，避免 null 被 `as Backend`/`as string` 強轉後送進 bridge。
 * （change_setting 的 value 不在 REQUIRED_ARGS 內，故 value:null「清空設定」仍合法。）
 */
function missingArgKeys(plan: PlannedCall): string[] {
  return REQUIRED_ARGS[plan.operation].filter((key) => plan.args[key] == null)
}

/**
 * 依 operation 分派到對應 bridge 方法，逐一拆出強型別實參。
 * 集中此處的型別斷言（args 來源是 Record<string,unknown>），呼叫端已過參數驗證閘。
 */
function callBridge(bridge: HeroicBridge, plan: PlannedCall): Promise<void> {
  const a = plan.args
  const game = a.game as { appName: string; runner: GameContext['runner'] }

  switch (plan.operation) {
    case 'installWinetricks':
      return bridge.installWinetricks({ verb: a.verb as string, game })
    case 'switchBackend':
      return bridge.switchBackend({ backend: a.backend as Backend, game })
    case 'installDxvk':
      return bridge.installDxvk({ game })
    case 'reinstallWineVariant':
      return bridge.reinstallWineVariant({ variant: a.variant as string, game })
    case 'installSteam':
      return bridge.installSteam({ backend: a.backend as Backend })
    case 'changeSetting':
      return bridge.changeSetting({
        key: a.key as string,
        value: a.value,
        game
      })
    default:
      // 型別上 operation 已窮盡；理論上不可達。
      return Promise.reject(
        new Error(`未知的 bridge 操作：${String(plan.operation)}`)
      )
  }
}

/** 把 unknown 錯誤安全轉成人話訊息（catch 出來的可能不是 Error）。 */
function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message
  return String(err)
}
