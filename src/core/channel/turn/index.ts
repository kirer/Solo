/**
 * 「一轮」这个概念的家：
 *
 * - `record.ts`：唤醒记录长什么样、怎么从名册读回来；
 * - `finish.ts`：收尾的旧入口（薄壳，转调 `flow.settle`）。
 *
 * 判断与实现都在 `core/flow/`（`defaults/settle.ts` / `settle.ts`）。这里只做
 * 兼容再导出，让「一轮」的调用点不用认识 flow 的内部文件。
 */
export { parseWake, type WakeRecord, type WakeTarget } from "./record.ts";
export { createTurnFinisher } from "./finish.ts";
export type { FinishTurn, FinishTurnInfo } from "../../flow/types.ts";
export { finalTextOf, saidLast, spokeAfterWake, turnTarget } from "../../flow/defaults/settle.ts";
