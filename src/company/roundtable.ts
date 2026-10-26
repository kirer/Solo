/**
 * 圆桌讨论：把「多方意见」变成一次可恢复、有硬上限、失败不阻塞的会议。
 *
 * 架构（契约 §6，参照 `escalation.ts` 的多阶段任务模式）：
 *
 * ```
 * runRoundtable(topic, roles[], rounds, timeoutMs)
 *   └─ RoundtableDoc 记录（议题/参与者/每轮意见/结论/状态）—— 持久化，重启后可查
 *   └─ 第 1 轮：每个参与者一个**子任务**，并行向各自会话投递「议题 + 你的视角」
 *   └─ 第 2 轮（可选）：把第 1 轮汇总回投，要求「保留 / 修正 / 反对 + 理由」
 *   └─ 收口：写纪要 + 审计，任务终态带回结构化结果
 * ```
 *
 * 状态机（父任务）：
 *
 * ```
 * round-1 ──(并行子任务)──▶ collect-1 ──(rounds=2 且还有在场者)──▶ round-2 ──▶ collect-2
 *                                └──(否则)──▶ 收口 completed
 * ```
 *
 * 为什么用 durable task 而不是一个 `Promise.all`：
 * - 崩溃重开后从检查点继续，已经收到的意见不会丢（意见一收到就写进文档）；
 * - 中途 abort（老板点「立即处理」）会走到任务的 abort 阶段，能把纪要标成「已中断」；
 * - 子任务并行、父任务 `waiting` 收齐，等待期间不占执行名额。
 *
 * 容错硬要求（逐条对应契约 §6）：
 * - **每个参与者独立超时**（默认 120s）：超时/失败只标 `absent`，绝不阻塞整体；
 * - **全体缺席也产出纪要**，并在纪要里写明原因；
 * - **总时长硬上限** = `rounds * timeoutMs + 30s`：deadline 在发起时写进检查点与文档，
 *   每轮开始前检查，超了立刻收口返回已收到的部分；
 * - **abort 干净退出**：abort 阶段写终态并把纪要标成 `aborted`，保留已收到的意见；
 * - 参与者**不允许是调用方自己**（跳过），也不允许重复。
 *
 * 与 escalation 的差异：升级链需要 `CompanyRuntime` 闭包（要查会话、读待决文档），
 * 所以是工厂函数；圆桌的各阶段只碰文档与子任务（会话句柄由 TaskRuntime 提供），
 * 因此任务定义是模块级常量，天然与运行时无关，注册一次即可。
 */
import {
	BACKGROUND_CONTEXT,
	type Context,
	defineDoc,
	defineExtension,
	defineTask,
	messageRequestId,
	type CompanyRuntime,
	type Extension,
	type Task,
	type TaskRuntime,
} from "../runtime/index.ts";
import {
	AuditDoc,
	type AuditEvent,
	CompanyDoc,
	MANAGEMENT_ROLES,
	ROLE_LABELS,
	type ManagementRole,
} from "./docs.ts";
import { waitOrTimeout, type Waited } from "./wait.ts";

// ── 文档 ────────────────────────────────────────────────────────────────────

/** 一条意见的状态：到场作答，或缺席（超时/失败/被中断）。 */
export type RoundtableOpinionStatus = "present" | "absent";

/** 第 2 轮里参与者对第 1 轮意见的立场。 */
export type RoundtableStance = "keep" | "revise" | "oppose";

/** 一条意见。 */
export type RoundtableOpinion = {
	role: string;
	label: string;
	round: number;
	status: RoundtableOpinionStatus;
	/** 意见正文；`absent` 时是缺席原因。 */
	text: string;
	at: number;
	/** 仅第 2 轮可能出现。 */
	stance?: RoundtableStance;
};

/** 讨论状态。 */
export type RoundtableStatus = "running" | "completed" | "aborted" | "failed";

/** 一次圆桌讨论的完整记录。 */
export type RoundtableRecord = {
	/** 编号，形如 `rt:3:7`（发起会话 + 序号），同时用作审计的关联标识。 */
	id: string;
	topic: string;
	/** 要大家拍板的具体问题（可选）。 */
	question?: string;
	/** 发起人显示名。 */
	from?: string;
	/** 发起方会话（主持人），审计记在它名下。 */
	fromConversationId: number;
	/** 参与者岗位（已去重、已剔除发起方自己）。 */
	roles: string[];
	rounds: number;
	status: RoundtableStatus;
	createdAt: number;
	/** 总时长硬上限的时间点（毫秒时间戳）。 */
	deadline: number;
	endedAt?: number;
	opinions: RoundtableOpinion[];
	/** 全程缺席的岗位。 */
	absent: string[];
	/** 纪要正文（收口时写入，重启后可读）。 */
	summary?: string;
	/** 收口说明：为什么停在这里（超时收口 / 全体缺席 / 被中断）。 */
	note?: string;
};

export type RoundtableState = {
	records: RoundtableRecord[];
};

/**
 * 圆桌讨论文档（公司级）。
 *
 * 与 `CompanyDoc` 同为 session 级：重启后 `roundtable_minutes` 仍能查到历史纪要。
 */
export const RoundtableDoc = defineDoc<RoundtableState>({
	kind: "app.roundtable",
	version: 1,
	scope: "session",
	initial: () => ({ records: [] }),
	// 会议纪要只增：每 128 条压一次基线（单条纪要比审计事件大得多）。
	checkpointWhen: (value) => value.records.length >= 128,
});

// ── 常量与输入输出 ──────────────────────────────────────────────────────────

/** 默认参与者：技术、财务、产品、运营四个视角。 */
export const DEFAULT_ROUNDTABLE_ROLES: readonly string[] = ["cto", "cfo", "cpo", "coo"];

/** 每个参与者的默认超时（毫秒）。 */
export const DEFAULT_ROUNDTABLE_TIMEOUT_MS = 120_000;

/** 总时长在 `rounds * timeoutMs` 之外允许的额外开销（收口、写纪要）。 */
export const ROUNDTABLE_OVERHEAD_MS = 30_000;

/** 超时后撤销投递时最多等多久（撤销要等对方空闲，可能很久）。 */
const ABORT_BUDGET_MS = 2_000;

/** 发起一次圆桌讨论的输入。 */
export type RoundtableInput = {
	readonly topic: string;
	/** 参与者岗位；默认 {@link DEFAULT_ROUNDTABLE_ROLES}。 */
	readonly roles?: readonly string[];
	/** 轮数，1–2；默认 1。 */
	readonly rounds?: number;
	/** 要大家拍板的具体问题。 */
	readonly question?: string;
	/** 单个参与者的超时；默认 120s。 */
	readonly timeoutMs?: number;
	/** 发起方会话（主持人），也用于审计与「不能请自己参加」的判定。 */
	readonly fromConversationId: number;
	/** 发起人显示名。 */
	readonly from?: string;
};

/** 发起结果：任务已经落盘，可以去等它。 */
export type RoundtableStart = {
	readonly id: string;
	readonly taskId: number;
	readonly roles: readonly string[];
	readonly deadline: number;
};

/** 讨论结果（给工具层用）。 */
export type RoundtableOutcome = {
	readonly ok: boolean;
	readonly id: string;
	readonly status: RoundtableStatus;
	/** 完整纪要文本（模型可读）。 */
	readonly minutes: string;
	readonly present: readonly string[];
	readonly absent: readonly string[];
	/** `ok: false` 时的原因。 */
	readonly reason?: string;
};

// ── 任务定义 ────────────────────────────────────────────────────────────────

/** 父任务的输入：全部来自发起时的一次提交，重启后可重建。 */
export type RoundtableTaskInput = {
	roundtableId: string;
	topic: string;
	question?: string;
	roles: string[];
	rounds: number;
	timeoutMs: number;
	deadline: number;
	fromConversationId: number;
};

/** 父任务检查点：每个阶段只记录自己需要的最小状态。 */
export type RoundtableCheckpoint =
	| { readonly phase: "round-1"; readonly round: 1 }
	| { readonly phase: "collect-1"; readonly round: 1; readonly childIds: readonly number[] }
	| { readonly phase: "round-2"; readonly round: 2 }
	| { readonly phase: "collect-2"; readonly round: 2; readonly childIds: readonly number[] };

/** 父任务终态结果。 */
export type RoundtableTaskResult = {
	readonly id: string;
	readonly status: "completed" | "failed" | "aborted";
	readonly present: string[];
	readonly absent: string[];
	readonly rounds: number;
};

/** 子任务的输入：一个参与者的一轮发言。 */
export type OpinionTaskInput = {
	roundtableId: string;
	round: number;
	role: string;
	label: string;
	prompt: string;
	timeoutMs: number;
	deadline: number;
};

/** 子任务终态结果。 */
export type OpinionTaskResult = {
	readonly role: string;
	readonly label: string;
	readonly round: number;
	readonly status: RoundtableOpinionStatus;
	readonly text: string;
	readonly stance?: RoundtableStance;
};

type ParentRuntime = TaskRuntime<RoundtableTaskInput, RoundtableCheckpoint, RoundtableTaskResult, object>;
type OpinionRuntime = TaskRuntime<OpinionTaskInput, { phase: "ask" }, OpinionTaskResult, object>;

/**
 * 单个参与者的发言子任务。
 *
 * 一个阶段：投递 → 等到答复或超时 → 意见与终态同一次提交落盘。
 * 超时、投递失败、会话缺失都只影响它自己（标 `absent`），父任务照常收齐。
 */
const OPINION_TASK: Task<OpinionTaskInput, { phase: "ask" }, OpinionTaskResult, object> = defineTask<
	OpinionTaskInput,
	{ phase: "ask" },
	OpinionTaskResult
>({
	name: "app.roundtable.opinion",
	version: 1,
	initial: () => ({ phase: "ask" }),
	phases: {
		ask: async (task, runtime, context) => {
			const input = task.input;
			const result = await askParticipant(runtime, input, context);

			await runtime.commit(async (tx) => {
				const doc = await tx.doc(RoundtableDoc);
				upsertOpinion(findRecord(doc.records, input.roundtableId), {
					role: input.role,
					label: input.label,
					round: input.round,
					status: result.status,
					text: result.text,
					at: Date.now(),
					...(result.stance === undefined ? {} : { stance: result.stance }),
				});
				return { status: "terminal", outcome: { status: "completed", result } };
			}, context);
		},
	},
	abort: async (task, runtime, context) => {
		const input = task.input;
		await runtime.commit(async (tx) => {
			const doc = await tx.doc(RoundtableDoc);
			upsertOpinion(findRecord(doc.records, input.roundtableId), {
				role: input.role,
				label: input.label,
				round: input.round,
				status: "absent",
				text: "（讨论被中断，未收到意见）",
				at: Date.now(),
			});
			return { status: "terminal", outcome: { status: "aborted" } };
		}, context);
	},
});

/** 父任务：组织各轮发言并收口。 */
export const ROUNDTABLE_TASK: Task<RoundtableTaskInput, RoundtableCheckpoint, RoundtableTaskResult, object> =
	defineTask<RoundtableTaskInput, RoundtableCheckpoint, RoundtableTaskResult>({
		name: "app.roundtable",
		version: 1,

		initial: () => ({ phase: "round-1", round: 1 }),

		phases: {
			"round-1": async (task, runtime, context) => {
				const input = task.input;
				if (input.roles.length === 0) {
					await finalize(runtime, context, input, {
						status: "failed",
						note: "没有可用的参与者（全部被跳过或岗位无效），本次没有开会。",
					});
					return;
				}

				const ids = await createOpinionTasks(task.id, runtime, context, input, 1, (role) =>
					renderRound1Prompt(input, role),
				);

				await runtime.commit(
					() => ({
						status: "waiting",
						checkpoint: { phase: "collect-1", round: 1, childIds: ids },
						on: ids as never,
						policy: "allSettled",
					}),
					context,
				);
			},

			"collect-1": async (task, runtime, context) => {
				const input = task.input;
				await ensureRoundComplete(runtime, context, input.roundtableId, 1, input.roles);

				// 第 2 轮只在「有第 2 轮、没到总时长上限、且第 1 轮真有人答」时才开。
				const canSecond =
					input.rounds >= 2 &&
					Date.now() < input.deadline &&
					(await hasPresent(runtime, context, input.roundtableId));

				if (canSecond) {
					await runtime.commit(
						() => ({ status: "running", checkpoint: { phase: "round-2", round: 2 } }),
						context,
					);
					return;
				}

				await finalize(runtime, context, input, {
					status: "completed",
					...(input.rounds >= 2 && Date.now() >= input.deadline
						? { note: "总时长已到上限，第 2 轮未进行，以下是已收到的意见。" }
						: {}),
				});
			},

			"round-2": async (task, runtime, context) => {
				const input = task.input;
				const digest = await roundOneDigest(runtime, context, input.roundtableId);

				const ids = await createOpinionTasks(task.id, runtime, context, input, 2, (role) =>
					renderRound2Prompt(input, role, digest),
				);

				await runtime.commit(
					() => ({
						status: "waiting",
						checkpoint: { phase: "collect-2", round: 2, childIds: ids },
						on: ids as never,
						policy: "allSettled",
					}),
					context,
				);
			},

			"collect-2": async (task, runtime, context) => {
				const input = task.input;
				await ensureRoundComplete(runtime, context, input.roundtableId, 2, input.roles);
				await finalize(runtime, context, input, { status: "completed" });
			},
		},

		abort: async (task, runtime, context) => {
			const input = task.input;
			await runtime.commit(async (tx) => {
				const doc = await tx.doc(RoundtableDoc);
				const record = findRecord(doc.records, input.roundtableId);
				if (record !== undefined && record.status === "running") {
					record.status = "aborted";
					record.endedAt = Date.now();
					record.note = "讨论被中断（老板点了「立即处理」，或任务被取消）；以下是中断前已收到的意见。";
					record.absent = absentRoles(record);
					record.summary = renderMinutes(record);
				}
				await pushAudit(tx, input, "aborted", record);
				return { status: "terminal", outcome: { status: "aborted" } };
			}, context);
		},
	});

/** 圆桌讨论的能力包：父任务 + 参与者子任务，装进注册表才能被解析。 */
export function roundtableExtension(): Extension {
	return defineExtension({
		name: "roundtable",
		tasks: [ROUNDTABLE_TASK, OPINION_TASK],
	});
}

// ── 对外操作 ────────────────────────────────────────────────────────────────

/** 圆桌编号：发起会话 + 序号。序号由已提交的记录数推导，重启后稳定（ADR-006/012）。 */
export function roundtableId(fromConversationId: number, sequence: number): string {
	return `rt:${fromConversationId}:${sequence}`;
}

/**
 * 发起一次圆桌讨论（不等待结果）。
 *
 * 文档记录与任务在**同一次提交**里落盘：不会出现「有纪要没有任务」或「有任务没有纪要」。
 */
export async function startRoundtable(
	runtime: CompanyRuntime,
	input: RoundtableInput,
	context: Context = BACKGROUND_CONTEXT,
): Promise<RoundtableStart> {
	const state = await runtime.harness.snapshot(CompanyDoc, context);
	const callerRole = roleOfConversation(state, input.fromConversationId);
	const roles = resolveParticipants(input.roles, callerRole);
	const rounds = clampRounds(input.rounds);
	const timeoutMs = clampTimeout(input.timeoutMs);
	const deadline = Date.now() + rounds * timeoutMs + ROUNDTABLE_OVERHEAD_MS;
	const fromConversationId = input.fromConversationId;

	const created = await runtime.harness.commit(async (tx) => {
		const doc = await tx.doc(RoundtableDoc);
		const id = roundtableId(fromConversationId, doc.records.length);

		doc.records.push({
			id,
			topic: input.topic,
			...(input.question === undefined ? {} : { question: input.question }),
			...(input.from === undefined ? {} : { from: input.from }),
			fromConversationId,
			roles,
			rounds,
			status: "running",
			createdAt: Date.now(),
			deadline,
			opinions: [],
			absent: [],
		});

		const taskInput: RoundtableTaskInput = {
			roundtableId: id,
			topic: input.topic,
			...(input.question === undefined ? {} : { question: input.question }),
			roles,
			rounds,
			timeoutMs,
			deadline,
			fromConversationId,
		};
		const taskId = await tx.createTask(ROUNDTABLE_TASK, taskInput, {
			ownership: { kind: "conversation" },
			conversationId: fromConversationId as never,
		});

		return { id, taskId: Number(taskId) };
	}, context);

	return { id: created.id, taskId: created.taskId, roles, deadline };
}

/**
 * 开一次圆桌讨论并等它收口，返回纪要。
 *
 * 无论成功、部分缺席、全体缺席还是被中断，都会返回一份可读的纪要——
 * 圆桌本身不该成为新的卡住点。
 */
export async function runRoundtable(
	runtime: CompanyRuntime,
	input: RoundtableInput,
	context: Context = BACKGROUND_CONTEXT,
): Promise<RoundtableOutcome> {
	if (input.topic.trim() === "") {
		return {
			ok: false,
			id: "",
			status: "failed",
			minutes: "议题不能为空。",
			present: [],
			absent: [],
			reason: "empty-topic",
		};
	}

	const started = await startRoundtable(runtime, input, context);
	if (started.roles.length === 0) {
		await markFailed(runtime, started.id, "没有可用的参与者（全部被跳过或岗位无效）。", context);
		return {
			ok: false,
			id: started.id,
			status: "failed",
			minutes: "没有可用的参与者：调用方自己不能参加，且岗位名必须有效（ceo/cto/cfo/cpo/coo/cmo/chro）。",
			present: [],
			absent: [],
			reason: "no-participant",
		};
	}

	// 硬上限兜底：deadline 本身就是契约里的硬上限（rounds * timeoutMs + 30s）。
	// 即使任务因为意外（例如能力包未注册而受阻）迟迟不收口，调用方也一定在
	// deadline 到点后拿到一份「已收到的部分」，不会被一场会永久挂住。
	const waitBudget = Math.max(0, started.deadline - Date.now());
	const waited = await waitOrTimeout(
		runtime.harness.waitForTask(started.taskId as never, context).catch(() => undefined),
		waitBudget,
	);

	// 调用方被中断（老板点「立即处理」）：把会议也干净收口，别让它在后台继续跑。
	// 用后台 context 收尾——调用方那个 context 已经取消了，再拿它写库会一直失败。
	if (context.abortSignal?.aborted === true) {
		await waitOrTimeout(
			runtime.harness.abortTask(started.taskId as never, BACKGROUND_CONTEXT).catch(() => undefined),
			ABORT_BUDGET_MS,
		);
		const aborted = await readRoundtableRecord(runtime, started.id, BACKGROUND_CONTEXT);
		return {
			ok: false,
			id: started.id,
			status: aborted?.status ?? "aborted",
			minutes: aborted?.summary ?? "讨论被中断，还没有收到任何意见。",
			present: aborted === undefined ? [] : presentRoles(aborted),
			absent: aborted === undefined ? [] : absentRoles(aborted),
			reason: "aborted",
		};
	}

	const record = await readRoundtableRecord(runtime, started.id, context);
	if (record === undefined) {
		return {
			ok: false,
			id: started.id,
			status: "failed",
			minutes: `圆桌讨论 ${started.id} 已发起，但读不到纪要记录。`,
			present: [],
			absent: [],
			reason: "record-missing",
		};
	}

	const present = presentRoles(record);
	const absent = absentRoles(record);

	if (waited.timedOut && record.status === "running") {
		return {
			ok: false,
			id: record.id,
			status: "running",
			minutes: renderMinutes(record, "讨论仍未收口（已达总时长上限），以下是目前已收到的意见。"),
			present,
			absent,
			reason: "timeout",
		};
	}

	return {
		ok: record.status === "completed",
		id: record.id,
		status: record.status,
		minutes: record.summary ?? renderMinutes(record),
		present,
		absent,
		...(record.status === "completed" ? {} : { reason: record.status }),
	};
}

/** 读一次讨论的完整记录。 */
export async function readRoundtableRecord(
	runtime: CompanyRuntime,
	id: string,
	context: Context = BACKGROUND_CONTEXT,
): Promise<RoundtableRecord | undefined> {
	const state = await runtime.harness.snapshot(RoundtableDoc, context);
	return findRecord(state?.records ?? [], id);
}

/**
 * 读纪要文本。
 *
 * @param id 讨论编号；不传则取最近一次（重启后依然可查）。
 */
export async function readRoundtableMinutes(
	runtime: CompanyRuntime,
	id?: string,
	context: Context = BACKGROUND_CONTEXT,
): Promise<string> {
	const state = await runtime.harness.snapshot(RoundtableDoc, context);
	const records = state?.records ?? [];
	if (records.length === 0) return "还没有开过圆桌讨论。";
	const record = id === undefined ? records[records.length - 1] : findRecord(records, id);
	if (record === undefined) {
		return `没有编号为 ${id ?? ""} 的圆桌讨论。现有：${records.map((item) => item.id).join("、")}`;
	}
	return record.summary ?? renderMinutes(record);
}

/** 列出全部讨论（给界面与诊断用）。 */
export async function listRoundtables(
	runtime: CompanyRuntime,
	context: Context = BACKGROUND_CONTEXT,
): Promise<RoundtableRecord[]> {
	const state = await runtime.harness.snapshot(RoundtableDoc, context);
	return [...(state?.records ?? [])];
}

// ── 参与者发言 ──────────────────────────────────────────────────────────────

/**
 * 请一个参与者发言。
 *
 * 任何失败都收敛成 `absent`（带原因），绝不抛出——父任务必须能收齐所有子任务。
 * 唯一的例外是调用方自己被 abort：那个错误必须继续往上抛，否则 abort 永远等不到结束。
 */
async function askParticipant(
	runtime: OpinionRuntime,
	input: OpinionTaskInput,
	context: Context,
): Promise<OpinionTaskResult> {
	const absent = (reason: string): OpinionTaskResult => ({
		role: input.role,
		label: input.label,
		round: input.round,
		status: "absent",
		text: reason,
	});

	const state = await runtime.snapshot(CompanyDoc, context);
	const conversationId = state?.roles[input.role];
	if (conversationId === undefined) return absent("公司里没有这个岗位的会话");

	const conversation = await runtime.conversation(conversationId as never, context);
	if (conversation === undefined) return absent("岗位会话不存在");

	// 请求标识由「讨论 + 轮次 + 岗位」推导：重启后重复投递被底层去重，同一轮不会问两遍（ADR-006）。
	const requestId = messageRequestId(
		`roundtable:${input.roundtableId}:r${input.round}`,
		conversationId,
		0,
	);

	let submission: Awaited<ReturnType<typeof conversation.submit>>;
	try {
		submission = await conversation.submit(
			{
				type: "input",
				content: input.prompt,
				requestId,
				entry: {
					kind: "app.delegate",
					data: {
						from: "圆桌主持人",
						to: input.label,
						text: `【圆桌 · 第 ${input.round} 轮】${input.prompt.slice(0, 200)}`,
					},
				},
				// 对方正忙时排队等它，不打断它手上的活；排队再久也有超时兜底。
				whenBusy: "followUp",
			},
			context,
		);
	} catch (error) {
		if (context.abortSignal?.aborted === true) throw error;
		return absent(`投递失败：${errorText(error)}`);
	}

	// 每个参与者独立超时；同时受总 deadline 约束（跨重启也有效）。
	// 失败路径包成 `{ kind: "absent" }`，与正常答复区分开，避免把「缺席原因」当成答复正文。
	const budget = Math.min(input.timeoutMs, input.deadline - Date.now());
	const waited = await waitOrTimeout(
		submission.wait(context).then(
			(settled): Settled => ({ kind: "settled", settled }),
			(error: unknown): Settled => {
				if (context.abortSignal?.aborted === true) throw error;
				return { kind: "absent", result: absent(`等待答复时出错：${errorText(error)}`) };
			},
		),
		budget,
	);

	if (waited.timedOut) {
		// 撤掉还没被处理的投递，别让对方过一会儿再答一个已经结束的讨论。
		// abort 自己会等对方空闲，这里再兜一层上限：绝不允许「收尾」把整场会拖住。
		await waitOrTimeout(submission.abort(context).catch(() => undefined), ABORT_BUDGET_MS);
		return absent(
			budget <= 0 ? "总时长已到上限，本轮未发言" : `等待超时（${Math.round(budget / 1000)}s 内没有回复）`,
		);
	}

	const outcome = waited.value;
	if (outcome.kind === "absent") return outcome.result;

	const settled = outcome.settled;
	if (settled.status === "unanswered") return absent(`未能回答（${settled.reason}）`);

	const text = await readAnswerText(runtime, conversationId, settled.answer, context);
	if (text === "") return absent("回复为空");

	const result: OpinionTaskResult = {
		role: input.role,
		label: input.label,
		round: input.round,
		status: "present",
		text,
	};
	if (input.round >= 2) {
		const stance = detectStance(text);
		if (stance !== undefined) return { ...result, stance };
	}
	return result;
}

/** 任务运行时能拿到的会话句柄的提交类型（避免业务层直接依赖底层类型）。 */
type Submission = Awaited<ReturnType<NonNullable<Awaited<ReturnType<OpinionRuntime["conversation"]>>>["submit"]>>;
/** 一次提交结算后的记录。 */
type SettledSubmission = Awaited<ReturnType<Submission["wait"]>>;

/** 参与者这一轮的等待结果：拿到了答复，或者已经确定缺席。 */
type Settled =
	| { readonly kind: "settled"; readonly settled: SettledSubmission }
	| { readonly kind: "absent"; readonly result: OpinionTaskResult };

/**
 * 读出答复条目的正文。
 *
 * 注意不能只按 entryId 查：`runtime.entry()` 只看**任务所在会话**的可见条目，
 * 而答复在参与者自己的会话里。所以按会话取上下文视图再按 id 找。
 */
async function readAnswerText(
	runtime: OpinionRuntime,
	conversationId: number,
	entryId: unknown,
	context: Context,
): Promise<string> {
	if (entryId === undefined) return "";
	const view = await runtime.context(conversationId as never, context);
	const entry = view.entries.find((item) => Number(item.id) === Number(entryId));
	const message = entry?.model?.[0] as
		| { readonly content?: readonly { readonly type?: string; readonly text?: string }[] }
		| undefined;
	const text = (message?.content ?? [])
		.flatMap((part) => (part.type === "text" && part.text !== undefined ? [part.text] : []))
		.join("")
		.trim();
	return text.slice(0, 2000);
}

/** 识别第 2 轮的立场：反对 > 修正 > 保留。 */
export function detectStance(text: string): RoundtableStance | undefined {
	if (/反对|不同意|不赞成|坚决不行|无法接受/.test(text)) return "oppose";
	if (/修正|调整|修改|但需要|前提是|有条件/.test(text)) return "revise";
	if (/保留|维持|同意|支持|认可/.test(text)) return "keep";
	return undefined;
}

// ── 阶段辅助 ────────────────────────────────────────────────────────────────

/** 为本轮每个参与者创建一个子任务，返回子任务标识。 */
async function createOpinionTasks(
	parentTaskId: number,
	runtime: ParentRuntime,
	context: Context,
	input: RoundtableTaskInput,
	round: number,
	promptOf: (role: string) => string,
): Promise<number[]> {
	const ids: number[] = [];
	await runtime.commit(async (tx) => {
		for (const role of input.roles) {
			const created = await tx.createTask(
				OPINION_TASK,
				{
					roundtableId: input.roundtableId,
					round,
					role,
					label: labelOf(role),
					prompt: promptOf(role),
					timeoutMs: input.timeoutMs,
					deadline: input.deadline,
				},
				{ ownership: { kind: "task", taskId: parentTaskId as never } },
			);
			ids.push(Number(created));
		}
		return undefined;
	}, context);
	return ids;
}

/** 写终态：更新文档（状态 + 纪要）与审计，然后提交任务终态。 */
async function finalize(
	runtime: ParentRuntime,
	context: Context,
	input: RoundtableTaskInput,
	options: { readonly status: "completed" | "failed"; readonly note?: string },
): Promise<void> {
	await runtime.commit(async (tx) => {
		const doc = await tx.doc(RoundtableDoc);
		const record = findRecord(doc.records, input.roundtableId);
		if (record !== undefined) {
			record.status = options.status;
			record.endedAt = Date.now();
			record.absent = absentRoles(record);
			if (options.note !== undefined) record.note = options.note;
			if (record.note === undefined) {
				const fallback = defaultNote(record);
				if (fallback !== undefined) record.note = fallback;
			}
			record.summary = renderMinutes(record);
		}
		await pushAudit(tx, input, options.status, record);

		const present = record === undefined ? [] : presentRoles(record);
		const absent = record === undefined ? [] : absentRoles(record);
		const result: RoundtableTaskResult = {
			id: input.roundtableId,
			status: options.status === "completed" ? "completed" : "failed",
			present,
			absent,
			rounds: input.rounds,
		};

		if (options.status === "completed") {
			return { status: "terminal", outcome: { status: "completed", result } };
		}
		return {
			status: "terminal",
			outcome: {
				status: "failed",
				error: { message: options.note ?? "圆桌讨论失败" },
				result,
			},
		};
	}, context);
}

/** 追加一条审计：谁开的会、什么时候收口、收到了几条意见。 */
async function pushAudit(
	tx: { doc: (token: typeof AuditDoc, id: never) => Promise<{ events: AuditEvent[] }> },
	input: RoundtableTaskInput,
	status: RoundtableStatus,
	record: RoundtableRecord | undefined,
): Promise<void> {
	// 审计挂在发起方会话上，和升级/决定的记录放在一起，便于「谁在什么时候定了什么」可追溯。
	const audit = await tx.doc(AuditDoc, input.fromConversationId as never);
	const opinions = record?.opinions.length ?? 0;
	audit.events.push({
		at: Date.now(),
		type: "decide",
		from: "圆桌主持人",
		note: `圆桌讨论（${statusLabel(status)}）：${input.topic}`.slice(0, 200),
		ref: `${input.roundtableId}#${opinions}`,
	});
}

/** 本轮缺条目时补齐成缺席，保证纪要里每个参与者都有一行。 */
async function ensureRoundComplete(
	runtime: ParentRuntime,
	context: Context,
	id: string,
	round: number,
	roles: readonly string[],
): Promise<void> {
	await runtime.commit(async (tx) => {
		const doc = await tx.doc(RoundtableDoc);
		const record = findRecord(doc.records, id);
		if (record === undefined) return undefined;
		for (const role of roles) {
			const exists = record.opinions.some((item) => item.role === role && item.round === round);
			if (exists) continue;
			record.opinions.push({
				role,
				label: labelOf(role),
				round,
				status: "absent",
				text: "（本轮没有收到回复）",
				at: Date.now(),
			});
		}
		return undefined;
	}, context);
}

/** 第 1 轮是否至少有一条在场意见（全缺席时不必再开第 2 轮）。 */
async function hasPresent(runtime: ParentRuntime, context: Context, id: string): Promise<boolean> {
	const state = await runtime.snapshot(RoundtableDoc, context);
	const record = findRecord(state?.records ?? [], id);
	return record !== undefined && presentRoles(record).length > 0;
}

/** 第 1 轮的汇总文本，用于第 2 轮回投。 */
async function roundOneDigest(runtime: ParentRuntime, context: Context, id: string): Promise<string> {
	const state = await runtime.snapshot(RoundtableDoc, context);
	const record = findRecord(state?.records ?? [], id);
	const opinions = (record?.opinions ?? []).filter((item) => item.round === 1);
	if (opinions.length === 0) return "（第 1 轮没有收到任何意见）";
	return opinions
		.map((item) =>
			item.status === "present"
				? `- ${item.label}：${item.text.replace(/\s+/g, " ").slice(0, 400)}`
				: `- ${item.label}：（缺席，${item.text}）`,
		)
		.join("\n");
}

/** 任务因「没有参与者」直接失败时，把文档也标成失败。 */
async function markFailed(
	runtime: CompanyRuntime,
	id: string,
	reason: string,
	context: Context,
): Promise<void> {
	await runtime.harness.commit(async (tx) => {
		const doc = await tx.doc(RoundtableDoc);
		const record = findRecord(doc.records, id);
		if (record === undefined) return;
		record.status = "failed";
		record.endedAt = Date.now();
		record.note = reason;
		record.absent = absentRoles(record);
		record.summary = renderMinutes(record);
	}, context);
}

// ── 提示词 ──────────────────────────────────────────────────────────────────

/** 第 1 轮：独立作答，互不可见。 */
function renderRound1Prompt(input: RoundtableTaskInput, role: string): string {
	return [
		`【圆桌讨论 · 第 1 轮】议题：${input.topic}`,
		...(input.question === undefined ? [] : ["", `要大家拍板的问题：${input.question}`]),
		"",
		`你是本次圆桌的 ${labelOf(role)} 参与者（岗位 ${role}）。只从 ${labelOf(role)} 的职责视角作答：`,
		"1) 结论（一句话，明确「可行 / 需调整 / 不可行」或「支持 / 反对」）",
		"2) 关键理由（最多三条）",
		"3) 风险与前提",
		"",
		"本轮你看不到其他人的意见，不要猜测别人会怎么说。控制在 200 字以内，直接给判断，不要罗列所有可能性。",
	].join("\n");
}

/** 第 2 轮：把第 1 轮汇总回投，要求「保留 / 修正 / 反对 + 理由」。 */
function renderRound2Prompt(input: RoundtableTaskInput, role: string, digest: string): string {
	return [
		`【圆桌讨论 · 第 2 轮】议题：${input.topic}`,
		...(input.question === undefined ? [] : ["", `要大家拍板的问题：${input.question}`]),
		"",
		"第 1 轮各位的意见：",
		digest,
		"",
		`你是本次圆桌的 ${labelOf(role)} 参与者（岗位 ${role}）。请针对上面的意见给出你的立场：`,
		"「保留」= 我原来的判断不变；「修正」= 我调整我的判断（说明改成什么）；「反对」= 我不同意（说明为什么）。",
		"开头先写「保留 / 修正 / 反对」，再给理由。只回应与你的判断真正相关的部分，不要复述全文。",
	].join("\n");
}

// ── 纪要渲染 ────────────────────────────────────────────────────────────────

/** 渲染一份可读的纪要。 */
export function renderMinutes(record: RoundtableRecord, override?: string): string {
	const rounds = [...new Set(record.opinions.map((item) => item.round))].sort((a, b) => a - b);
	const present = presentRoles(record);
	const absent = absentRoles(record);

	const lines: string[] = [
		`【圆桌纪要 · ${record.id}】`,
		`议题：${record.topic}`,
		...(record.question === undefined ? [] : [`问题：${record.question}`]),
		`参与者：${record.roles.map(labelOf).join("、")}`,
		`状态：${statusLabel(record.status)}`,
		...(record.note === undefined ? [] : [`说明：${record.note}`]),
	];

	for (const round of rounds) {
		lines.push("", `第 ${round} 轮`);
		for (const item of record.opinions.filter((entry) => entry.round === round)) {
			if (item.status === "absent") {
				lines.push(`- ${item.label}：（缺席，${item.text}）`);
				continue;
			}
			const stance = item.stance === undefined ? "" : `（${stanceLabel(item.stance)}）`;
			lines.push(`- ${item.label}${stance}：${item.text.replace(/\s+/g, " ").trim()}`);
		}
	}

	lines.push("");
	if (present.length === 0) {
		lines.push("结论建议：本轮没有任何岗位给出意见，无法形成结论。建议缩小议题或换个时间再议。");
	} else {
		lines.push(
			`在场：${present.map(labelOf).join("、")}${absent.length === 0 ? "" : `；缺席：${absent.map(labelOf).join("、")}`}`,
		);
		const stances = record.opinions.filter((item) => item.stance !== undefined);
		if (stances.length > 0) {
			const names = (stance: RoundtableStance): string => {
				const matched = stances.filter((item) => item.stance === stance).map((item) => item.label);
				return matched.length === 0 ? "无" : matched.join("、");
			};
			lines.push(
				`立场分布：保留 ${names("keep")}；修正 ${names("revise")}；反对 ${names("oppose")}`,
			);
			const split = stances.some((item) => item.stance === "revise" || item.stance === "oppose");
			lines.push(
				split
					? "结论建议：存在分歧，主持人需要就分歧点给出裁定，而不是简单取多数。"
					: "结论建议：各岗位立场一致，主持人可以据此收口。",
			);
		} else {
			lines.push("结论建议：本纪要只记录各岗位原话与判断，共识与结论由主持人归纳（不要替缺席者发言）。");
		}
	}

	if (override !== undefined) lines.push("", override);
	return lines.join("\n");
}

function statusLabel(status: RoundtableStatus): string {
	switch (status) {
		case "running":
			return "进行中";
		case "completed":
			return "已完成";
		case "aborted":
			return "已中断";
		case "failed":
			return "失败";
	}
}

function stanceLabel(stance: RoundtableStance): string {
	switch (stance) {
		case "keep":
			return "保留";
		case "revise":
			return "修正";
		case "oppose":
			return "反对";
	}
}

function defaultNote(record: RoundtableRecord): string | undefined {
	if (presentRoles(record).length > 0) return undefined;
	return "所有参与者都没有给出意见（超时或不可用），本次没有形成任何结论。";
}

// ── 内部工具 ────────────────────────────────────────────────────────────────

function findRecord(records: readonly RoundtableRecord[], id: string): RoundtableRecord | undefined {
	return records.find((record) => record.id === id);
}

/** 写一条意见（同一岗位同一轮只保留一条：重启重跑不会写重复）。 */
function upsertOpinion(record: RoundtableRecord | undefined, opinion: RoundtableOpinion): void {
	if (record === undefined) return;
	const index = record.opinions.findIndex(
		(item) => item.role === opinion.role && item.round === opinion.round,
	);
	if (index >= 0) record.opinions[index] = opinion;
	else record.opinions.push(opinion);
}

/** 至少有一条在场意见的岗位。 */
function presentRoles(record: RoundtableRecord): string[] {
	const present = new Set(
		record.opinions.filter((item) => item.status === "present").map((item) => item.role),
	);
	return record.roles.filter((role) => present.has(role));
}

/** 全程没有给出任何意见的岗位。 */
function absentRoles(record: RoundtableRecord): string[] {
	const present = new Set(presentRoles(record));
	return record.roles.filter((role) => !present.has(role));
}

/** 岗位的中文显示名。 */
function labelOf(role: string): string {
	return ROLE_LABELS[role as ManagementRole] ?? role.toUpperCase();
}

/** 发起方自己是什么岗位（用于把它从参与者里剔除）。 */
function roleOfConversation(
	state: { readonly roles: Record<string, number> } | undefined,
	conversationId: number,
): string | undefined {
	if (state === undefined) return undefined;
	for (const [role, id] of Object.entries(state.roles)) {
		if (Number(id) === conversationId) return role;
	}
	return undefined;
}

/** 参与者名单：有效岗位、去重、剔除发起方自己。 */
function resolveParticipants(
	requested: readonly string[] | undefined,
	callerRole: string | undefined,
): string[] {
	const source = requested ?? DEFAULT_ROUNDTABLE_ROLES;
	const seen = new Set<string>();
	const roles: string[] = [];
	for (const raw of source) {
		const role = String(raw).trim().toLowerCase();
		if (!(MANAGEMENT_ROLES as readonly string[]).includes(role)) continue;
		if (role === callerRole) continue;
		if (seen.has(role)) continue;
		seen.add(role);
		roles.push(role);
	}
	return roles;
}

function clampRounds(value: number | undefined): number {
	if (value === undefined) return 1;
	const rounds = Math.floor(value);
	if (!Number.isFinite(rounds)) return 1;
	return Math.min(2, Math.max(1, rounds));
}

function clampTimeout(value: number | undefined): number {
	if (value === undefined) return DEFAULT_ROUNDTABLE_TIMEOUT_MS;
	if (!Number.isFinite(value)) return DEFAULT_ROUNDTABLE_TIMEOUT_MS;
	return Math.min(10 * 60_000, Math.max(50, Math.floor(value)));
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

