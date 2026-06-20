/**
 * compatibilityStore.ts
 * ------------------------------------------------------------------
 * Helmsman — 知識層「遊戲 → 已知可用設定」(藍圖 §6.5 / §7)。
 *
 * 職責:記錄某遊戲在這台機器上成功跑起來的設定(後端、wine 版本、winetricks、
 * env),讓下次的自己(或下個跑同款的人)啟動失敗時,先查 store 有沒有現成配方,
 * 與 log 分析併行(§6.5「用法」)。
 *
 * 分層風格對齊 heroicBridge.ts:持久層抽成【契約介面】注入,核心查詢/合併是
 * 【純函式】。本輪只給記憶體實作。
 *
 * 依賴方向(單向):
 *   types.ts ← compatibilityStore.ts ←(ipc / panel / 啟動流程)
 *
 * 鐵律:
 *   - selectBestRecipe / upsertRecord 為純函式:無副作用、不碰 IO、不呼叫 AI、
 *     【不呼叫 Date.now() / new Date()】(時間戳由呼叫端提供,CompatRecord 已含
 *     updatedAt)、不修改傳入參數(一律回新陣列 / 既有參照)。
 *   - 持久層只給記憶體實作;實際檔案(Electron userData)後端與後期共享社群 DB
 *     都屬 Phase 6b(⚠,各自實作同一 CompatStorage 介面)。
 */

import type { Arch, CompatRecord } from './types';

// ── 持久層契約 ────────────────────────────────────────────────────

/**
 * 持久層契約:知識層只透過此介面讀寫整份配方清單,不關心背後是記憶體、檔案
 * 還是社群 DB。
 *
 * ⚠ Phase 6b:實際檔案(Electron userData JSON)後端與後期共享社群 DB 都實作
 * 此介面,各自處理序列化 / 同步 / 衝突,核心純函式不變。
 */
export interface CompatStorage {
  /**
   * 讀出全部配方。實作須回【新陣列】(改動回傳陣列的結構不污染內部);但其中的
   * CompatRecord 元素一律【視為唯讀】——呼叫端不得就地改 record 欄位。本層的純
   * 函式皆遵守此約定;Phase 6b 各後端亦須維持此語意以免跨後端行為漂移。
   */
  load(): Promise<CompatRecord[]>;
  /** 以傳入清單整批取代既有內容。 */
  save(records: CompatRecord[]): Promise<void>;
}

/**
 * 記憶體實作(測試 / 預設)。內部持一份陣列。
 *
 * - load() 回【複本】(淺拷陣列),避免外部改動回傳值污染內部狀態。
 * - save() 以傳入清單的【複本】取代內部,避免呼叫端後續改動傳入陣列影響內部。
 *
 * 註:此處只淺拷陣列(複製外層容器,元素參照共享)。CompatRecord 在本層皆當
 * 唯讀資料流動,純函式從不就地改 record 欄位,故淺拷已足以隔離「陣列結構」層
 * 級的污染;不做深拷以免無謂成本。
 */
export function inMemoryStorage(seed: CompatRecord[] = []): CompatStorage {
  // 起始即吃 seed 的複本,避免外部後續改動 seed 影響內部。
  let store: CompatRecord[] = [...seed];
  return {
    load(): Promise<CompatRecord[]> {
      return Promise.resolve([...store]);
    },
    save(records: CompatRecord[]): Promise<void> {
      store = [...records];
      return Promise.resolve();
    },
  };
}

// ── 查詢輸入 ──────────────────────────────────────────────────────

/**
 * 查配方的最小輸入。
 *
 * osVersion 目前【不】作硬過濾(見 selectBestRecipe 註解):僅資訊性欄位,保留供
 * Phase 6b 若要做「同 OS 加分」排序時使用,預設不影響選擇結果。
 */
export interface RecipeQuery {
  appName: string;
  arch: Arch;
  osVersion?: string;
}

// ── 純函式:選最佳配方 ────────────────────────────────────────────

/** result 偏好序:works 最優,works_with_issues 次之。broken / 未知值不在此。 */
const RESULT_RANK: Record<'works' | 'works_with_issues', number> = {
  works: 0,
  works_with_issues: 1,
};

/** 是否為「可作為配方回傳」的 result(正面白名單:排除 broken 與任何未來新增的未知值)。 */
function isUsableResult(result: CompatRecord['result']): result is 'works' | 'works_with_issues' {
  return result in RESULT_RANK;
}

/** result 的排序值;未知值給明確的最低優先後備(沉底),避免將來新增列舉值時靜默錯排。 */
function resultRank(result: CompatRecord['result']): number {
  return result in RESULT_RANK ? RESULT_RANK[result as 'works' | 'works_with_issues'] : 2;
}

/**
 * 把 updatedAt 轉成可比較的數值時間（用 Date.parse，非裸字串字典序）。
 *
 * 裸字串比較對混時區（'…Z' vs '…+08:00'）、混精度（'…00Z' vs '…000Z'）或髒值
 * 會選錯——這正是 Phase 6b 跨機器 / 跨序列化器的共享社群 DB 最容易混入的格式。
 * Date.parse 是純函式（字串→數值，不依賴現在時間），不違反「不呼叫 Date.now()/
 * new Date()」的鐵律。無法解析者（NaN）視為最舊（-Infinity，沉底），使壞資料不會
 * 冒頂壓過合法配方。
 */
function updatedAtRank(updatedAt: string): number {
  const t = Date.parse(updatedAt);
  return Number.isNaN(t) ? -Infinity : t;
}

/**
 * 純函式:從 records 中挑出最適合 query 的單一配方,無候選回 null。
 *
 * 候選條件:appName 相符、arch 相符、且 result 為可用值(isUsableResult，正面
 *   白名單,排除 broken「已知壞掉」與任何未來新增的未知 result 值)。
 *
 * 排序挑最佳:
 *   1. result:'works' 優先於 'works_with_issues'(resultRank 較小者勝)。
 *   2. 同 result:取 updatedAt 較新者(以 Date.parse 數值比較,見 updatedAtRank)。
 *
 * osVersion 不作硬過濾:即使查詢者的 OS 與某配方不同,該配方仍可能可用(資訊性
 * 欄位)。若 Phase 6b 想用 osVersion 做「同 OS 加分」,須在此說明理由再加入排序
 * 鍵;預設不用,以免把跨 OS 仍可用的好配方誤排到後面。
 *
 * 不修改傳入 records(只讀比較,不排序原陣列)。
 */
export function selectBestRecipe(
  records: CompatRecord[],
  query: RecipeQuery,
): CompatRecord | null {
  let best: CompatRecord | null = null;
  for (const rec of records) {
    if (rec.appName !== query.appName) continue;
    if (rec.arch !== query.arch) continue;
    if (!isUsableResult(rec.result)) continue;
    if (best === null || isBetterRecipe(rec, best)) {
      best = rec;
    }
  }
  return best;
}

/** 候選 a 是否比現任 best 更佳(result 序優先,同序比 updatedAt 較新)。 */
function isBetterRecipe(a: CompatRecord, best: CompatRecord): boolean {
  const ra = resultRank(a.result);
  const rb = resultRank(best.result);
  if (ra !== rb) return ra < rb;
  // 同 result:updatedAt 數值較大(較新)者勝;平手保留現任 best(穩定)。
  return updatedAtRank(a.updatedAt) > updatedAtRank(best.updatedAt);
}

// ── 純函式:去重 upsert ───────────────────────────────────────────

/** 去重 key:同遊戲 + 同後端 + 同晶片視為同一「槽」。 */
function slotKey(rec: CompatRecord): string {
  return `${rec.appName}|${rec.backend}|${rec.arch}`;
}

/**
 * 純函式:把 incoming 併入 records,回【新陣列】(不修改傳入 records)。
 *
 * 去重 key = `${appName}|${backend}|${arch}`(同槽)。
 *   - 同槽已存在:incoming 的 updatedAt >= 既有(以 Date.parse 數值比較)→ 用
 *     incoming 取代(較新或同時間,後寫者勝);否則保留既有(忽略較舊的 incoming)。
 *   - 不存在同槽:附加到尾端。
 *
 * 保持原有元素順序;同槽取代為「就地換成 incoming」(維持該槽原本位置)。
 */
export function upsertRecord(
  records: CompatRecord[],
  incoming: CompatRecord,
): CompatRecord[] {
  const key = slotKey(incoming);
  let replaced = false;
  const next = records.map((rec) => {
    if (slotKey(rec) !== key) return rec;
    replaced = true;
    // incoming 較新或同時間 → 後寫者勝;較舊 → 保留既有。
    return updatedAtRank(incoming.updatedAt) >= updatedAtRank(rec.updatedAt) ? incoming : rec;
  });
  if (!replaced) next.push(incoming);
  return next;
}

// ── 組裝:注入持久層的知識層門面 ──────────────────────────────────

/**
 * 用注入的 storage 組出知識層門面。
 *
 * - findRecipe:load → selectBestRecipe(啟動失敗時先查現成配方)。
 * - saveRecord:load → upsertRecord → save(成功跑起來後寫回,同槽更新不重複)。
 * - listForApp:load → filter appName,回複本(不外漏 storage 內部參照)。
 */
export function createCompatStore(storage: CompatStorage): {
  findRecipe(query: RecipeQuery): Promise<CompatRecord | null>;
  saveRecord(record: CompatRecord): Promise<void>;
  listForApp(appName: string): Promise<CompatRecord[]>;
} {
  return {
    async findRecipe(query: RecipeQuery): Promise<CompatRecord | null> {
      const records = await storage.load();
      return selectBestRecipe(records, query);
    },
    async saveRecord(record: CompatRecord): Promise<void> {
      const records = await storage.load();
      await storage.save(upsertRecord(records, record));
    },
    async listForApp(appName: string): Promise<CompatRecord[]> {
      const records = await storage.load();
      // load() 已回複本,filter 又產新陣列,故回傳不外漏內部參照。
      return records.filter((rec) => rec.appName === appName);
    },
  };
}
