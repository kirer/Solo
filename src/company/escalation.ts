/**
 * 升级链：直属管理层 → CEO → 老板。
 *
 * 架构（design.md 决策 4）：
 * - 升级是一个**持久化任务**，每个层级一个阶段。
 * - 每级跃迁提交检查点，记录当前层级 → 崩溃重开从当前级继续，不重复询问。
 * - 问询不是同步阻塞：任务把问题写进「待决问题」文档，然后休眠；
 *   角色通过工具答复（写答复），任务醒来读答复推进。
 * - 等待老板同样用休眠 → 不占执行名额、可跨天。
 * - 全程写审计与沟通留痕 → 可重建完整路径。
 *
 * 实现要点：任务阶段需要访问公司运行时（读待决文档、找角色会话），
 * 所以用**工厂函数**创建任务定义，把运行时闭包进去。这是唯一能让
 * 任务代码与业务数据解耦又不污染全局状态的方式。
 */
import {
	BACKGROUND_CONTEXT,
	type Context,
	defineDoc,
	defineTask,
	escalationId,
	type CompanyRuntime,
} from "../runtime/index.ts";
import type { Task } from "../runtime/index.ts";
import { AuditDoc, CompanyDoc, ROLE_LABELS, TrailDoc, type ManagementRole } from "./docs.ts";

/** 升级流程的输入。 */
export type EscalationInput = {
	readonly question: string;
	readonly from: string;
	readonly fromConversationId: number;
	/** 直属管理层岗位；不传则从 CEO 开始。 */
	readonly manager?: ManagementRole;
	readonly project?: string;
	/** 升级标识，用于关联审计与留痕。 */
	readonly escalationKey: string;
	/**
	 * 直接从「问老板」开始（跳过管理层与 CEO 两级）。
	 *
	 * 只允许 CEO 发起时置为 true：**只有 CEO 能把问题递到老板面前**，
	 * 其他任何人的上报都只会停在自己这条链的最高一层（CEO）。
	 */
	readonly startAtOwner?: boolean;
};

/** 阶段状态。 */
export type EscalationState =
	| { readonly phase: "ask-manager"; readonly level: string; readonly askedAt: number; readonly path: string[] }
	| { readonly phase: "ask-ceo"; readonly askedAt: number; readonly path: string[] }
	| { readonly phase: "ask-owner"; readonly askedAt: number; readonly path: string[] };

/** 升级结果。 */
export type EscalationResult = {
	readonly decidedBy: string;
	readonly decision: string;
	readonly path: string[];
};

/** 待决问题项。 */
export type PendingItem = {
	readonly key: string;
	readonly question: string;
	readonly level: string;
	readonly from: string;
	readonly fromConversationId: number;
	project?: string;
	readonly askedAt: number;
	/** 已给出的答复；未答复时不存在。 */
	answer?: string;
	/** 答复者。 */
	answeredBy?: string;
	/** 表示「我也拍不了，继续往上」。 */
	escalate?: boolean;
};

/** 待决问题文档（公司级）。任务与角色之间的唯一通道。 */
export type PendingState = {
	items: PendingItem[];
};

export const PendingDoc = defineDoc<PendingState>({
	kind: "app.pending",
	version: 1,
	scope: "session",
	initial: () => ({ items: [] }),
	checkpointWhen: () => false,
});

/**
 * 轮询间隔（毫秒）。
 *
 * 升级任务不是同步阻塞，而是「睡一会儿、醒来看看有没有答复」。
 * 200ms 是为了让**人在界面里拍板**之后几乎立刻有反应——老板的感知上限是「一眨眼」。
 */
export const POLL_MS = 200;

/**
 * 退避后的轮询间隔（毫秒）。
 *
 * 为什么需要退避：等老板拍板可能跨天（规格明确要求「不占执行名额、可跨天」）。
 * 如果一直 200ms 轮询，一天就是 43 万次唤醒，每次都要读文档、判断、再睡回去——
 * 白白占着 CPU，还让运行时永远「有活可干」，进程没法真正安静下来。
 *
 * 30 秒的理由：老板真回来了，最多等 30 秒就有反应，比 200ms 差得远但可以接受；
 * 而唤醒次数降到原来的 1/150。等 CEO 的层级同理——它是人（模型）在另一轮里回答，
 * 一分钟内给答复是常态，超过一分钟就是「不在当前这一轮里」，慢轮询足够。
 */
export const SLOW_POLL_MS = 30_000;

/**
 * 快轮询窗口（毫秒）：提问后的头一分钟用 {@link POLL_MS}，之后降到 {@link SLOW_POLL_MS}。
 *
 * 一分钟的理由：模型一轮生成通常在 10–60 秒内完成，同层级管理层的答复几乎总在这个窗口里。
 * 窗口内用快轮询能保证「答复一落盘，任务立刻继续」；窗口外用慢轮询省资源。
 */
export const FAST_POLL_WINDOW_MS = 60_000;

/**
 * 计算下一次轮询该睡多久。
 *
 * 纯函数，便于测试与解释：等得越久，问得越稀。
 */
export function pollDelay(askedAt: number, now: number): number {
	if (askedAt <= 0) return POLL_MS;
	return now - askedAt < FAST_POLL_WINDOW_MS ? POLL_MS : SLOW_POLL_MS;
}

/**
 * 创建升级任务定义。
 *
 * @param runtime 公司运行时，用于读文档、找角色会话、写审计。
 */
export function createEscalationTask(
	runtime: CompanyRuntime,
): Task<EscalationInput, EscalationState, EscalationResult, object> {
	return defineTask<EscalationInput, EscalationState, EscalationResult>({
		name: "app.escalation",
		version: 1,

		initial: (input) =>
			input.startAtOwner === true
				? { phase: "ask-owner", askedAt: 0, path: [input.from, "ceo"] }
				: {
						phase: "ask-manager",
						level: input.manager ?? "ceo",
						askedAt: 0,
						path: [input.from],
					},

		phases: {
			"ask-manager": async (task, taskRuntime, context) => {
				const state = task.state.checkpoint as Extract<EscalationState, { phase: "ask-manager" }>;
				const level = state.level;

				// 没有直属管理层（或直属就是 CEO）时直接进 CEO 阶段
				if (level === "ceo") {
					await taskRuntime.commit(
						() => ({
							status: "running",
							checkpoint: { phase: "ask-ceo", askedAt: 0, path: [...state.path, level] },
						}),
						context,
					);
					return;
				}

				const askedAt = state.askedAt === 0 ? taskRuntime.now() : state.askedAt;
				await ensurePending(runtime, task.input, level, askedAt, context);

				const outcome = await readOutcome(runtime, task.input.escalationKey, level, context);

				if (outcome === undefined) {
					const now = taskRuntime.now();
					await taskRuntime.sleepUntil(
						now + pollDelay(askedAt, now),
						{ phase: "ask-manager", level, askedAt, path: state.path },
						context,
					);
					return;
				}

				if (outcome.escalate) {
					await recordHop(runtime, task.input, level, "ceo", context);
					await taskRuntime.commit(
						() => ({
							status: "running",
							checkpoint: { phase: "ask-ceo", askedAt: 0, path: [...state.path, level] },
						}),
						context,
					);
					return;
				}

				await finish(
					 taskRuntime,
					 runtime,
					 context,
					 task.input,
					 outcome.answeredBy ?? level,
					 outcome.answer,
					 [...state.path, level],
				 );
			},

			"ask-ceo": async (task, taskRuntime, context) => {
				const state = task.state.checkpoint as Extract<EscalationState, { phase: "ask-ceo" }>;
				const askedAt = state.askedAt === 0 ? taskRuntime.now() : state.askedAt;
				await ensurePending(runtime, task.input, "ceo", askedAt, context);

				const outcome = await readOutcome(runtime, task.input.escalationKey, "ceo", context);

				if (outcome === undefined) {
					const now = taskRuntime.now();
					await taskRuntime.sleepUntil(
						now + pollDelay(askedAt, now),
						{ phase: "ask-ceo", askedAt, path: state.path },
						context,
					);
					return;
				}

				if (outcome.escalate) {
					await recordHop(runtime, task.input, "ceo", "owner", context);
					await taskRuntime.commit(
						() => ({
							status: "running",
							checkpoint: { phase: "ask-owner", askedAt: 0, path: [...state.path, "ceo"] },
						}),
						context,
					);
					return;
				}

				await finish(
					 taskRuntime,
					 runtime,
					 context,
					 task.input,
					 outcome.answeredBy ?? "ceo",
					 outcome.answer,
					 [...state.path, "ceo"],
				 );
			},

			"ask-owner": async (task, taskRuntime, context) => {
				const state = task.state.checkpoint as Extract<EscalationState, { phase: "ask-owner" }>;
				const askedAt = state.askedAt === 0 ? taskRuntime.now() : state.askedAt;
				await ensurePending(runtime, task.input, "owner", askedAt, context);

				const outcome = await readOutcome(runtime, task.input.escalationKey, "owner", context);

				if (outcome === undefined) {
					// 老板拍板可能跨天：休眠不占执行名额，进程重启后仍然有效。
					// 但轮询要退避，否则一天 43 万次唤醒（见 pollDelay 的说明）。
					const now = taskRuntime.now();
					await taskRuntime.sleepUntil(
						now + pollDelay(askedAt, now),
						{ phase: "ask-owner", askedAt, path: state.path },
						context,
					);
					return;
				}

				await finish(
					 taskRuntime,
					 runtime,
					 context,
					 task.input,
					 outcome.answeredBy ?? "owner",
					 outcome.answer,
					 [...state.path, "owner"],
				 );
			},
		},

		abort: async (_task, taskRuntime, context) => {
			await taskRuntime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context);
		},
	});
}

// ── 对外操作 ────────────────────────────────────────────────────────────────

/** 发起一次升级，返回任务标识。 */
export async function startEscalation(
	runtime: CompanyRuntime,
	task: Task<EscalationInput, EscalationState, EscalationResult, object>,
	input: EscalationInput,
	context: Context = BACKGROUND_CONTEXT,
): Promise<number> {
	const manager = input.manager ?? "ceo";
	const taskId = await runtime.harness.commit(
		(tx) =>
			tx.createTask(task, { ...input, manager }, {
				ownership: { kind: "conversation" },
				conversationId: input.fromConversationId as never,
			}),
		context,
	);

	await recordHop(runtime, input, input.from, manager, context);
	return Number(taskId);
}

/** 答复一条待决问题。 */
export async function answerPending(
	runtime: CompanyRuntime,
	input: {
		readonly key: string;
		readonly answer: string;
		readonly answeredBy: string;
		readonly escalate?: boolean;
	},
	context: Context = BACKGROUND_CONTEXT,
): Promise<boolean> {
	return runtime.harness.commit(async (tx) => {
		const pending = await tx.doc(PendingDoc);
		const index = pending.items.findIndex((item) => item.key === input.key && item.answer === undefined);
		if (index < 0) return false;

		const item = pending.items[index];
		if (item === undefined) return false;

		pending.items[index] = {
			...item,
			answer: input.answer,
			answeredBy: input.answeredBy,
			...(input.escalate === true ? { escalate: true } : {}),
		};

		const audit = await tx.doc(AuditDoc, item.fromConversationId as never);
		audit.events.push({
			at: Date.now(),
			type: input.escalate === true ? "escalate" : "decide",
			from: input.answeredBy,
			to: item.from,
			note: input.answer.slice(0, 200),
			ref: input.key,
		});
		return true;
	}, context);
}

/**
 * CEO 拍板：只允许回答「到自己这一级」的待决问题。
 *
 * 越权防线：CEO 无法替老板拍板（owner 级），也无法替下属拍板。
 * 每条会校验层级并返回 false，由工具层给出可读原因。
 */
export async function answerPendingAsCeo(
	runtime: CompanyRuntime,
	input: { readonly key: string; readonly answer: string; readonly escalate?: boolean },
	context: Context = BACKGROUND_CONTEXT,
): Promise<boolean> {
	const state = await runtime.harness.snapshot(PendingDoc, context);
	const item = state?.items.find((entry) => entry.key === input.key);
	if (item === undefined) return false;
	if (item.level !== "ceo") return false;
	if (item.answer !== undefined) return false;

	return answerPending(
		runtime,
		{
			key: input.key,
			answer: input.answer,
			answeredBy: "ceo",
			...(input.escalate === true ? { escalate: true } : {}),
		},
		context,
	);
}

/** 列出当前未答复的待决问题。 */
export async function listPending(
	runtime: CompanyRuntime,
	context: Context = BACKGROUND_CONTEXT,
): Promise<PendingItem[]> {
	const state = await runtime.harness.snapshot(PendingDoc, context);
	return state?.items.filter((item) => item.answer === undefined) ?? [];
}

/** 等待一次升级结束。 */
export async function waitEscalation(
	runtime: CompanyRuntime,
	taskId: number,
	context: Context = BACKGROUND_CONTEXT,
): Promise<EscalationResult | undefined> {
	const settled = await runtime.harness.waitForTask(taskId as never, context);
	if (settled.state.status !== "terminal") return undefined;
	const outcome = settled.state.outcome;
	if (outcome.status !== "completed") return undefined;
	return outcome.result as EscalationResult;
}

// ── 内部 ────────────────────────────────────────────────────────────────────

/** 确保问题出现在待决列表里（幂等）。 */
async function ensurePending(
	runtime: CompanyRuntime,
	input: EscalationInput,
	level: string,
	askedAt: number,
	context: Context = BACKGROUND_CONTEXT,
): Promise<void> {
	await runtime.harness.commit(async (tx) => {
		const pending = await tx.doc(PendingDoc);
		const existing = pending.items.find(
			(item) => item.key === input.escalationKey && item.level === level,
		);
		if (existing !== undefined) return;

		// 老板只看得到「CEO 报上来的问题」：owner 级待办一律记在 CEO 名下，
		// 哪怕最初是某个项目负责人发起的（中间已由 CEO 背书过一层）。
		let from = input.from;
		let fromConversationId = input.fromConversationId;
		if (level === "owner") {
			const company = await runtime.harness.snapshot(CompanyDoc, context);
			const ceoId = company?.roles.ceo;
			if (ceoId !== undefined) {
				from = "CEO";
				fromConversationId = ceoId;
			}
		}

		const item: PendingItem = {
			key: input.escalationKey,
			question: input.question,
			level,
			from,
			fromConversationId,
			askedAt,
		};
		if (input.project !== undefined) item.project = input.project;
		pending.items.push(item);
	}, context);
}

/**
 * 读某个升级在**指定层级**的答复；未答复返回 undefined。
 *
 * 必须按层级精确定位：同一升级在多个层级各有一条待决项，
 * 只按 key 读会读到下层的答复，导致上层被跳过。
 */
async function readOutcome(
	runtime: CompanyRuntime,
	escalationKey: string,
	level: string,
	context: Context = BACKGROUND_CONTEXT,
): Promise<{ answer: string; escalate: boolean; answeredBy?: string } | undefined> {
	const state = await runtime.harness.snapshot(PendingDoc, context);
	const item = state?.items.find(
		(entry) => entry.key === escalationKey && entry.level === level && entry.answer !== undefined,
	);
	if (item?.answer === undefined) return undefined;
	return {
		answer: item.answer,
		escalate: item.escalate === true,
		...(item.answeredBy === undefined ? {} : { answeredBy: item.answeredBy }),
	};
}

/** 结束升级，写终态。 */
async function finish(
	taskRuntime: {
		commit: (
			change: () => {
				status: "terminal";
				outcome: { status: "completed"; result: EscalationResult };
			},
			context: Context,
		) => Promise<void>;
	},
	runtime: CompanyRuntime,
	context: Context,
	input: EscalationInput,
	decidedBy: string,
	decision: string,
	path: readonly string[],
): Promise<void> {
	const result: EscalationResult = { decidedBy, decision, path: [...path] };

	// 先写审计与留痕，再提交终态。
	// 顺序很重要：调用方 waitEscalation() 在终态提交后立刻返回，
	// 若先提交终态，随后写的时间线可能还没落盘（竞态）。
	const companyAtDecision = await runtime.harness.snapshot(CompanyDoc, context);
	const deciderConversation =
		roleConversationOf(companyAtDecision, decidedBy) ?? input.fromConversationId;

	await runtime.harness.commit(async (tx) => {
		const audit = await tx.doc(AuditDoc, input.fromConversationId as never);
		audit.events.push({
			at: Date.now(),
			type: decidedBy === "owner" ? "owner-decision" : "decide",
			from: ROLE_LABELS[decidedBy as ManagementRole] ?? decidedBy,
			to: input.from,
			note: decision.slice(0, 200),
			ref: input.escalationKey,
		});

		const trail = await tx.doc(TrailDoc);
		const edge: (typeof trail.edges)[number] = {
			at: Date.now(),
			kind: "decide",
			fromConversation: deciderConversation,
			toConversation: input.fromConversationId,
			from: decidedBy,
			to: input.from,
			ref: input.escalationKey,
		};
		if (input.project !== undefined) edge.project = input.project;
		trail.edges.push(edge);
	}, context);

	await taskRuntime.commit(() => ({ status: "terminal", outcome: { status: "completed", result } }), context);
}

/** 记录一次层级跃迁。 */
async function recordHop(
	runtime: CompanyRuntime,
	input: EscalationInput,
	from: string,
	to: string,
	context: Context = BACKGROUND_CONTEXT,
): Promise<void> {
	const company = await runtime.harness.snapshot(CompanyDoc, context);
	const fromConversation = roleConversationOf(company, from) ?? input.fromConversationId;
	const toConversation = roleConversationOf(company, to) ?? input.fromConversationId;

	await runtime.harness.commit(async (tx) => {
		const trail = await tx.doc(TrailDoc);
		const edge: (typeof trail.edges)[number] = {
			at: Date.now(),
			kind: "escalate",
			fromConversation,
			toConversation,
			from,
			to,
			ref: input.escalationKey,
		};
		if (input.project !== undefined) edge.project = input.project;
		trail.edges.push(edge);

		const audit = await tx.doc(AuditDoc, input.fromConversationId as never);
		audit.events.push({
			at: Date.now(),
			type: "escalate",
			from,
			to,
			note: input.question.slice(0, 200),
			ref: input.escalationKey,
		});
	}, context);
}

/** 把岗位名（cto/ceo/owner）解析成会话标识；解析不到返回 undefined。 */
function roleConversationOf(
	state: { readonly roles: Record<string, number> } | undefined,
	label: string,
): number | undefined {
	if (state === undefined) return undefined;
	const direct = state.roles[label];
	if (direct !== undefined) return Number(direct);
	if (label === "owner") {
		const ceo = state.roles.ceo;
		if (ceo !== undefined) return Number(ceo);
	}
	return undefined;
}

export { escalationId };
