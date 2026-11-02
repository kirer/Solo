/**
 * 「一轮」这个概念的家：
 *
 * - `record.ts`：唤醒记录长什么样、怎么从名册读回来；
 * - `finish.ts`：结算后怎么收尾（取最终正文、挑频道、补进频道）。
 *
 * 投递、唤醒、沉淀、工具都只从这里拿「一轮」的类型与判断，不再各自拼一遍。
 */
export { parseWake, type WakeRecord, type WakeTarget } from "./record.ts";
export {
	createTurnFinisher,
	finalTextOf,
	saidLast,
	spokeAfterWake,
	turnTarget,
	type FinishTurn,
	type FinishTurnInfo,
} from "./finish.ts";
