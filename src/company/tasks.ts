/**
 * 任务的 IO 层：读写 `TaskDoc`、状态迁移、**系统保证的上报**。
 *
 * 纯逻辑全在 `src/domain/tasks.ts`。这里只做三件事：
 *
 * 1. 读 / 写 `TaskDoc`
 * 2. `transitionTask()` —— **唯一的状态迁移入口**
 * 3. 状态变化后写频道消息 + 投递下达人
 *
 * ── 为什么上报必须在这里 ──
 *
 * 老板的原话（2026-10-26）：「任务做完经常不上报给 CEO」。
 * 根因是上报是 `delegate()` 内部顺带写的，只在「同步等待成功返回」这条路径上发生；
 * 超时 / abort / 换路径 → 上报根本不会写。
 *
 * 现在：只要状态落到 `done` / `blocked` / `review`，**本文件**就写一条 report 到频道
 * 并投递 `assignedBy`。三个触发点（模型调 `task_update`、看门狗、项目终止）
 * 都只能走 `transitionTask()`，所以「忘了上报」在结构上不可能。
 */
import { BACKGROUND_CONTEXT, type CompanyRuntime, type Context, defineDoc } from "../runtime/index.ts";
import {
	boardOf,
	createTask as createTaskPure,
	emptyTaskState,
	isTerminal,
	needsReport,
	openTasks,
	staleTasks,
	tasksOfAssignee,
	tasksOfAssigner,
	tasksOfProject,
	transitionTask as transitionTaskPure,
	validateCreate,
	type BoardCard,
	type BoardColumnId,
	type CreateInput,
	type TaskEntry,
	type TaskState,
	type TaskStatus,
	type TaskUsage,
	type TransitionPatch,
} from "../domain/tasks.ts";
import { projectChannelId, OWNER_ID } from "../domain/channels.ts";
import { labelOf, personOf } from "../domain/membership.ts";
import { buildOrg } from "./org-model.ts";
import { CompanyDoc } from "./docs.ts";
import { postToChannel } from "./channels.ts";
import { conversationUsage } from "./cost.ts";
import { notify } from "./deliver.ts";
import { memoryReminderFor } from "./memory.ts";

/** 任务文档。 */
export const TaskDoc = defineDoc<TaskState>({
	kind: "app.tasks",
	version: 1,
	scope: "session",
	initial: () => emptyTaskState(),
	checkpointWhen: (_value, _ops, { deltasSinceBase }) => deltasSinceBase >= 64,
});

/** 系统会话标识（看门狗、迁移等非人类操作者）。 */
export const SYSTEM_ID = -1;

// ── 读 ──────────────────────────────────────────────────────────────────────

/** 读整个任务文档。 */
export async function readTasks(
	runtime: CompanyRuntime,
	context: Context = BACKGROUND_CONTEXT,
): Promise<TaskState> {
	return (await runtime.harness.snapshot(TaskDoc, context)) ?? emptyTaskState();
}

/** 读一个任务。 */
export async function readTask(
	runtime: CompanyRuntime,
	id: string,
	context: Context = BACKGROUND_CONTEXT,
): Promise<TaskEntry | undefined> {
	return (await readTasks(runtime, context)).tasks[id];
}

/** 某项目的任务（看板用）。 */
export async function listProjectTasks(
	runtime: CompanyRuntime,
	project: string,
	context: Context = BACKGROUND_CONTEXT,
): Promise<readonly TaskEntry[]> {
	return tasksOfProject(await readTasks(runtime, context), project);
}

/** 某人的任务。 */
export async function listMyTasks(
	runtime: CompanyRuntime,
	conversationId: number,
	context: Context = BACKGROUND_CONTEXT,
): Promise<readonly TaskEntry[]> {
	return tasksOfAssignee(await readTasks(runtime, context), conversationId);
}

/** 某人下达的任务。 */
export async function listAssignedTasks(
	runtime: CompanyRuntime,
	conversationId: number,
	context: Context = BACKGROUND_CONTEXT,
): Promise<readonly TaskEntry[]> {
	return tasksOfAssigner(await readTasks(runtime, context), conversationId);
}

/** 全部未完成任务。 */
export async function listOpenTasks(
	runtime: CompanyRuntime,
	context: Context = BACKGROUND_CONTEXT,
): Promise<readonly TaskEntry[]> {
	return openTasks(await readTasks(runtime, context));
}

/** 项目看板。 */
export async function projectBoard(
	runtime: CompanyRuntime,
	project: string,
	context: Context = BACKGROUND_CONTEXT,
): Promise<{
	readonly columns: Readonly<Record<BoardColumnId, readonly BoardCard[]>>;
	readonly blocked: readonly BoardCard[];
}> {
	return boardOf(await readTasks(runtime, context), { project });
}

// ── 创建 ────────────────────────────────────────────────────────────────────

/** 创建结果。 */
export type CreateTaskResult =
	| { readonly ok: true; readonly task: TaskEntry }
	| { readonly ok: false; readonly code: string; readonly message: string };

/**
 * 创建任务。
 *
 * 校验失败**返回可读原因**而不是抛错：模型需要看到「请改用 say」这类提示
 * 才能改行为。校验规则见 `domain/tasks.ts` 的 `validateCreate`。
 *
 * 创建成功后会：
 * 1. 写一条 `task` 消息到项目群（@ 负责人）
 * 2. 投递负责人（不等待）
 */
export async function createTask(
	runtime: CompanyRuntime,
	input: CreateInput,
	context: Context = BACKGROUND_CONTEXT,
): Promise<CreateTaskResult> {
	const company = await runtime.harness.snapshot(CompanyDoc, context);
	const org = buildOrg(company);
	const assignee = personOf(org, input.assignee);
	if (assignee === undefined) {
		return { ok: false, code: "unknown-assignee", message: `找不到负责人（会话 ${input.assignee}）。先用 whoami 或 org_tree 确认。` };
	}

	// **读必须在 commit 内**（`tx.doc` 拿到的是同一条 mutation line 上的可写 overlay）。
	//
	// 以前是 `readTasks()` 在 commit 之外先快照、commit 内整表覆盖。pi-durable 的
	// commit 是串行化的，但串行化只保护 commit 内部——两个并发 createTask 各自读到
	// 旧的 nextId，都算出 `T-7`，后写的把先写的覆盖掉，**两条任务变成一条**。
	// transitionTask 同理，并发迁移会丢掉其中一次的变更。
	const outcome = await runtime.harness.commit(async (tx) => {
		const doc = await tx.doc(TaskDoc);
		const state = doc as TaskState;
		const check = validateCreate(input, state.tasks);
		if (!check.ok) return { ok: false as const, code: check.code, message: check.message };

		const { state: next, task } = createTaskPure(state, input);
		// 按路径写：只写新增的那一条 + nextId。整表赋值会让每条 delta 都带全部任务。
		state.nextId = next.nextId;
		state.tasks[task.id] = task;
		return { ok: true as const, task };
	}, context);
	if (!outcome.ok) return outcome;
	const task = outcome.task;

	const channelId = input.channelId === "" ? projectChannelId(input.project) : input.channelId;
	await postToChannel(
		runtime,
		channelId,
		{
			from: input.assignedBy,
			fromLabel: labelOf(org, input.assignedBy),
			kind: "task",
			text: [
				`【新任务 ${task.id}】${task.title}`,
				task.brief === "" ? "" : task.brief,
				`验收标准：${task.acceptance}`,
				`负责人：${labelOf(org, task.assignee)}`,
			]
				.filter((line) => line !== "")
				.join("\n"),
			mentions: [task.assignee],
			refs: { taskId: task.id, projectSlug: task.project },
		},
		{ context },
	);

	return { ok: true, task };
}

// ── 状态迁移（唯一入口） ────────────────────────────────────────────────────

/** 迁移结果。 */
export type UpdateTaskResult =
	| { readonly ok: true; readonly task: TaskEntry; readonly reported: boolean }
	| { readonly ok: false; readonly code: string; readonly message: string };

/**
 * 状态迁移 + **系统保证的上报**。
 *
 * 这是整个「不上报」问题的修法核心：调用方（模型工具、看门狗、项目终止）
 * 只调这一个函数，上报由它内部完成，不依赖调用方记得。
 */
export async function transitionTask(
	runtime: CompanyRuntime,
	id: string,
	to: TaskStatus,
	patch: TransitionPatch & { readonly by?: number } = {},
	context: Context = BACKGROUND_CONTEXT,
): Promise<UpdateTaskResult> {
	// #11：进入 doing 时记一次用量基线，进入 done 时结算差额。
	// 必须在 commit **之前**读：用量文档和任务文档不在同一条 mutation line 上，
	// 在 tx 里读会跨文档。读失败不阻断状态迁移（成本是附加信息，不是业务前提）。
	const previous = await readTask(runtime, id, context);
	const usagePatch = await usagePatchFor(runtime, previous, to, patch, context);

	// 同 createTask：读改写全部落在同一条 mutation line 上，避免丢失更新。
	const outcome = await runtime.harness.commit(async (tx) => {
		const doc = await tx.doc(TaskDoc);
		const state = doc as TaskState;
		const result = transitionTaskPure(state, id, to, { ...patch, ...usagePatch });
		if (!result.ok) return { ok: false as const, code: result.code, message: result.message };
		// 按路径写：只写被改的那一条任务。
		state.nextId = result.state.nextId;
		state.tasks[id] = result.task;
		return { ok: true as const, task: result.task };
	}, context);
	if (!outcome.ok) return outcome;

	const task = outcome.task;
	const company = await runtime.harness.snapshot(CompanyDoc, context);
	const org = buildOrg(company);

	// ① 状态变化写进项目群（所有成员可见）
	const by = patch.by ?? SYSTEM_ID;
	const verb =
		to === "done" ? "完成" : to === "blocked" ? "阻塞" : to === "review" ? "提交验收" : to === "doing" ? "开始" : to === "cancelled" ? "取消" : "更新";
	const detail =
		to === "done"
			? task.evidence === undefined
				? "（没有提供证据）"
				: `证据：${task.evidence}`
			: to === "blocked"
				? `原因：${task.blockedReason ?? "（未说明）"}`
				: (patch.note ?? "");

	await postToChannel(
		runtime,
		task.channelId,
		{
			from: by === SYSTEM_ID ? task.assignee : by,
			fromLabel: by === SYSTEM_ID ? "系统" : labelOf(org, by),
			kind: "report",
			text: [`【${task.id} ${verb}】${task.title}`, detail].filter((line) => line !== "").join("\n"),
			// 完成/阻塞/验收：@ 下达人（它必须知道）
			mentions: needsReport(to) ? [task.assignedBy] : [],
			refs: { taskId: task.id, projectSlug: task.project },
		},
		{ context },
	);

	// ② 需要上报时，额外给下达人一条直达通知（不依赖它去看频道）
	let reported = false;
	if (needsReport(to)) {
		reported = await notify(
			runtime,
			task.assignedBy,
			{
				kind: "app.task-report",
				data: {
					taskId: task.id,
					title: task.title,
					status: to,
					assignee: task.assignee,
					assigneeLabel: labelOf(org, task.assignee),
					evidence: task.evidence ?? null,
					blockedReason: task.blockedReason ?? null,
					channelId: task.channelId,
				},
				text: [
					`【任务${verb}】${task.id} ${task.title}`,
					`负责人：${labelOf(org, task.assignee)}`,
					detail,
					// #12：完成时才提一句记忆。不强制写——强制的「记忆」只会是流水账。
					...(to === "done" ? [memoryReminderFor(task.id)] : []),
					`（讨论在频道 ${task.channelId}，用 read_channel 看上下文）`,
				]
					.filter((line) => line !== "")
					.join("\n"),
			},
			context,
		);
		// ③ 完成时把「写一条经验」的提醒送进负责人自己的会话流。
		//    必须 `wake: true`：`wake: false` 走 `submit({type:"write"})`，底层
		//    `isDisplayOnly` 判定 `entry.model === undefined`，而 `contribute()` 取的是
		//    `entry.model ?? []`——那条提示只进会话流，**永远不进模型上下文**。
		//    实测生产库 `app.memory-hint` 0 条、`memory_write` 0 次，就是这么来的。
		if (to === "done") {
			await notify(
				runtime,
				task.assignee,
				{
					kind: "app.memory-hint",
					data: { taskId: task.id, title: task.title },
					text: memoryReminderFor(task.id),
					wake: true,
				},
				context,
			);
		}
	}

	return { ok: true, task, reported };
}

/**
 * 算出这次迁移要顺带写入的用量字段（#11）。
 *
 * 只在两个时刻做：
 * - 进 `doing`（或首次进 review/done 但还没有基线）→ 记 `usageAtStart`
 * - 进 `done` → 用「当前累计 − 基线」结算 `usage`
 *
 * 读用量失败时返回空补丁：任务状态照常推进，只是没有成本数字。
 * 宁可少一个数字，也不能因为统计问题让任务卡住。
 */
async function usagePatchFor(
	runtime: CompanyRuntime,
	previous: TaskEntry | undefined,
	to: TaskStatus,
	patch: TransitionPatch,
	context: Context,
): Promise<{ readonly usageAtStart?: TaskUsage; readonly usage?: TaskUsage }> {
	if (previous === undefined) return {};
	const needsBaseline = to !== "todo" && previous.usageAtStart === undefined;
	const needsSettle = to === "done";
	if (!needsBaseline && !needsSettle) return {};
	if (patch.usageAtStart !== undefined || patch.usage !== undefined) return {};

	try {
		const usage = await conversationUsage(runtime, previous.assignee, context);
		const current: TaskUsage = { tokens: usage.totalTokens, costUsd: usage.costUsd };
		const baseline = previous.usageAtStart ?? current;
		if (needsSettle) {
			return {
				...(needsBaseline ? { usageAtStart: baseline } : {}),
				usage: {
					tokens: Math.max(0, current.tokens - baseline.tokens),
					costUsd: Math.max(0, Number((current.costUsd - baseline.costUsd).toFixed(6))),
				},
			};
		}
		return { usageAtStart: baseline };
	} catch {
		return {};
	}
}

/** 派活：等价于「建任务」——保留旧名字让调用方平滑迁移。 */
export const assignTask = createTask;

// ── 看门狗用 ────────────────────────────────────────────────────────────────

/**
 * 需要提醒的任务。
 *
 * 由看门狗每轮调用，返回后由它决定怎么提醒（写告警 / 投递负责人）。
 */
export async function tasksNeedingAttention(
	runtime: CompanyRuntime,
	now: number = Date.now(),
	options: { readonly blockedMs?: number; readonly staleMs?: number } = {},
	context: Context = BACKGROUND_CONTEXT,
): Promise<readonly { readonly task: TaskEntry; readonly reason: "blocked-too-long" | "no-progress" }[]> {
	return staleTasks(await readTasks(runtime, context), now, options);
}

/** 任务终态判定（转发）。 */
export { isTerminal };

/** 老板是 0，系统是 -1：两者都不是「真实的会话」。 */
export function isHumanActor(conversationId: number): boolean {
	return conversationId !== SYSTEM_ID && conversationId !== OWNER_ID;
}
