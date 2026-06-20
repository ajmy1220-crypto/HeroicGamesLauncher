/**
 * verdict.ts
 * ------------------------------------------------------------------
 * Verdict 嚴重度序表的【單一真相源】。
 *
 * 為什麼獨立成檔：
 *   logAnalyzer.ts 的 rollup 與 recommendationEngine.ts 的合併步驟都需要
 *   「取較嚴重 verdict」。若各寫一份序表，兩處遲早漂移（incompatible 的優先序
 *   不一致將造成詭異 bug）。抽到此檔讓兩處 import 同一張表，杜絕漂移。
 *
 * 這是 types.ts 旁唯一允許帶 runtime 值的例外——types.ts 本體維持純 type
 * 可 erase；序表（runtime const + 純函式）放這裡。
 *
 * 嚴重度由小到大（數字小 = 較嚴重，mergeVerdict 取較小者）：
 *   incompatible(0) < needs_backend_change(1) < recoverable(2)
 *     < unknown(3) < launched_ok(4)
 *
 * 此序表與 logAnalyzer.ts 既有第 413-419 行的 VERDICT_ORDER 逐項一致；
 * 抽取以「行為零變更、12 測試全綠」為硬驗收。
 */

import type { Verdict } from './types'

/** verdict 嚴重度序：數字越小越嚴重。 */
export const VERDICT_ORDER: Record<Verdict, number> = {
  incompatible: 0,
  needs_backend_change: 1,
  recoverable: 2,
  unknown: 3,
  launched_ok: 4
}

/**
 * 取「比較嚴重」的 verdict（數字小者）。
 * b 未提供時回傳 a，行為與 logAnalyzer 既有 mergeVerdict 完全一致。
 */
export function mergeVerdict(a: Verdict, b?: Verdict): Verdict {
  if (!b) return a
  return VERDICT_ORDER[b] < VERDICT_ORDER[a] ? b : a
}
