/**
 * 工单的**唯一写入口**：立、报、问、答、重试、停。
 *
 * 全是纯函数（拿 state 算新 state），落盘在工具里一次提交。这样做的理由和老频道
 * 那套一样：状态迁移的判据只能有一份，而纯函数能直接把边界情况钉在单测里
 * （重复报告、在已结束的工单上重试、问一个不存在的问题）。
 *
 * 「只有接受能立工单」在这里落实成：`openTicket` 只收一个 `Gate`，而且必须
 * `outcome === "accept"` —— 闸门不给票，这里就不发号。
 */
import { defineDoc } from "../runtime/index.ts";
import { MAX_DECISIONS, MAX_TICKETS, emptyWorkState, type Attention, type Decision, type Gate, type Report, type Ticket, type Trigger, type WorkState } from "./types.ts";

export const WorkDoc = defineDoc<WorkState>({
	kind: "core.work",
	version: 1,
	scope: "session",
	initial: emptyWorkState,
	// 和名册一样是只增的增量文档：要有回收上界（见 `roster.ts` 的说明）。
	checkpointWhen: (value, _ops, info) =>
		info.deltasSinceBase >= 64 || Object.keys(value.tickets).length > 200,
});

/** 一次迁移的结果。失败只给原因码，文案由调用方（工具）按 md 填。 */
export type Change =
	| { readonly ok: true; readonly state: WorkState; readonly ticket: Ticket }
	| { readonly ok: false; readonly reason: "unknown" | "ended" | "taken" | "not-accepted" };

export function ticketById(state: WorkState, id: string): Ticket | undefined {
	return state.tickets[id];
}

/** 这个频道里没结束的工单。 */
export function openTicketsIn(state: WorkState, channel: string): Ticket[] {
	return Object.values(state.tickets)
		.filter((ticket) => ticket.channel === channel && ticket.endedAt === undefined)
		.sort((left, right) => left.createdAt - right.createdAt);
}

/** 某个人的活（默认全部）。 */
export function ticketsOf(state: WorkState, assignee?: string): Ticket[] {
	return Object.values(state.tickets)
		.filter((ticket) => assignee === undefined || ticket.assignee === assignee)
		.sort((left, right) => left.createdAt - right.createdAt);
}

/** 把一条判断记进留痕。最多 200 条，丢最老的。 */
export function recordDecision(state: WorkState, decision: Decision): WorkState {
	const decisions = [...state.decisions, decision].slice(-MAX_DECISIONS);
	return { ...state, decisions };
}

export type OpenInput = {
	readonly trigger: Trigger;
	readonly gate: Gate;
	readonly title: string;
	readonly scope: string;
	readonly assignee: string;
	readonly at: number;
};

/**
 * 接受一条触发，立一张工单。
 *
 * 工单号是会话内自增的 `T1`、`T2`…：它会被抄进消息里（「这件事我记在 T3 了」），
 * 所以要短、要稳定、要人念得出来。
 */
export function openTicket(state: WorkState, input: OpenInput): Change {
	if (input.gate.outcome !== "accept" || input.gate.strength === undefined) {
		return { ok: false, reason: "not-accepted" };
	}
	const id = `T${state.nextTicket}`;
	const ticket: Ticket = {
		id,
		title: input.title,
		channel: input.trigger.channel,
		mandate: {
			policyVersion: input.gate.policyVersion,
			strength: input.gate.strength,
			scope: input.scope,
			rules: [...input.gate.rules],
			requester: input.trigger.from,
			trigger: input.trigger.id,
		},
		assignee: input.assignee,
		assignment: { state: "running", at: input.at, attempts: 1 },
		reports: [],
		createdAt: input.at,
	};
	return {
		ok: true,
		ticket,
		state: capped({
			...state,
			tickets: { ...state.tickets, [id]: ticket },
			nextTicket: state.nextTicket + 1,
		}),
	};
}

/**
 * 只增的文档要有回收上界：结束的工单太多就丢最老的。
 *
 * 没结束的一张都不丢 —— 那是「他手上还有活」的唯一凭据。每句话都会立一张单
 * （ADR-055），不收就有个每天涨几百条的文档。
 */
function capped(state: WorkState): WorkState {
	const ended = Object.values(state.tickets)
		.filter((ticket) => ticket.endedAt !== undefined)
		.sort((left, right) => (left.endedAt ?? 0) - (right.endedAt ?? 0));
	if (ended.length <= MAX_TICKETS) return state;
	const drop = new Set(ended.slice(0, ended.length - MAX_TICKETS).map((ticket) => ticket.id));
	const tickets = Object.fromEntries(Object.entries(state.tickets).filter(([id]) => !drop.has(id)));
	return { ...state, tickets };
}

/** 改一张工单。找不到 / 已结束都返回原因码，不抛。 */
function mutate(state: WorkState, id: string, change: (ticket: Ticket) => Ticket | { readonly reason: "unknown" | "ended" }): Change {
	const ticket = state.tickets[id];
	if (ticket === undefined) return { ok: false, reason: "unknown" };
	if (ticket.endedAt !== undefined) return { ok: false, reason: "ended" };
	const next = change(ticket);
	if ("reason" in next) return { ok: false, reason: next.reason };
	return { ok: true, ticket: next, state: { ...state, tickets: { ...state.tickets, [id]: next } } };
}

/**
 * 汇报一次。
 *
 * `ready` = 做完了，等人验收；`waiting` = 我这边没事了，等人；`blocked` / `failed` =
 * 停下，等人处理。**汇报不是发言**：它只改工单，要不要在频道里说话由模型自己再说一句。
 */
export function reportTicket(state: WorkState, id: string, report: Report): Change {
	return mutate(state, id, (ticket) => {
		const stopped = report.outcome === "ready" || report.outcome === "blocked" || report.outcome === "failed" || report.outcome === "dropped";
		const next: Ticket = {
			...ticket,
			reports: [...ticket.reports, report],
			// 「做完了 / 卡住了 / 砸了」都是这一轮**停了**，之后的活要重新开工（`retry` / 人答话）。
			assignment: { ...ticket.assignment, state: stopped ? "ended" : "running", at: report.at },
		};
		// 有实质进展就说明人答完了：问题收起来。
		if (report.outcome === "progress") delete next.attention;
		return next;
	});
}

/** 问一个问题：工单停在「等人回答」。 */
export function askTicket(state: WorkState, id: string, attention: Attention): Change {
	return mutate(state, id, (ticket) => ({
		...ticket,
		attention,
		reports: [...ticket.reports, { outcome: "waiting", text: attention.question, at: attention.at }],
		assignment: { ...ticket.assignment, state: "running" },
	}));
}

/** 人答了：问题收起来，接着干。 */
export function answerTicket(state: WorkState, id: string, at: number): Change {
	return mutate(state, id, (ticket) =>
		ticket.attention === undefined
			? ticket
			: (({ attention: _answered, ...rest }) => ({
					...rest,
					assignment: { state: "running", at, attempts: ticket.assignment.attempts + 1 },
				}))(ticket),
	);
}

/** 重试：重新排一次。次数加一，之前的汇报留着（历史是它干过什么的证据）。 */
export function retryTicket(state: WorkState, id: string, at: number): Change {
	return mutate(state, id, ({ attention: _dropped, ...rest }) => ({
		...rest,
		assignment: { state: "pending", at, attempts: rest.assignment.attempts + 1 },
	}));
}

/** 收工。`by` 是结束的原因：做完 / 不做了 / 做砸了 / 我喊停。 */
export function stopTicket(state: WorkState, id: string, by: NonNullable<Ticket["endedBy"]>, at: number): Change {
	return mutate(state, id, ({ attention: _closed, ...rest }) => ({
		...rest,
		assignment: { ...rest.assignment, state: "ended" },
		endedAt: at,
		endedBy: by,
	}));
}
