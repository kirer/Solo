/**
 * 「派活」这一块：策略（md）→ 闸门（纯函数）→ 工单（落盘）→ 阶段（纯函数）。
 *
 * 对外的入口只有：
 *
 * | 要什么 | 用哪个 |
 * |---|---|
 * | 现在按什么策略派活 | `readPolicy` / `renderPolicy`（`policy.ts`） |
 * | 这条消息算不算活 | `gateOf`（`gate.ts`） |
 * | 立 / 报 / 问 / 重试 / 停 | `openTicket` … （`ticket.ts`） |
 * | 它现在在哪个阶段 | `stageOf` / `describeStage`（`stage.ts`） |
 */
export type {
	AcceptMode,
	Attention,
	Decision,
	Gate,
	GateOutcome,
	Mandate,
	Policy,
	Report,
	ReportOutcome,
	Strength,
	Ticket,
	Trigger,
	WorkState,
} from "./types.ts";
export { MAX_DECISIONS, MAX_TICKETS, emptyWorkState, triggerOf } from "./types.ts";
export { DEFAULT_POLICY, allows, parsePolicy, policyVersion, readPolicy, renderPolicy } from "./policy.ts";
export { gateOf, mandateHolds, triggerSeq } from "./gate.ts";
export { WorkDoc, answerTicket, askTicket, openTicket, openTicketsIn, recordDecision, reportTicket, retryTicket, stopTicket, ticketById, ticketsOf } from "./ticket.ts";
export type { Change } from "./ticket.ts";
export { canRetry, describeStage, stageOf } from "./stage.ts";
export type { Stage, StageInput } from "./stage.ts";
