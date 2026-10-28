/**
 * 打开「一个库 + 一个 harness」的唯一入口。
 *
 * 这里只做四件事：打开存储、建 harness、自愈脏数据、返回关闭句柄。
 */
import type { Models } from "@earendil-works/pi-ai";
import { Harness as DurableHarness, type Harness, type HarnessSettings } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { BACKGROUND_CONTEXT, type Context } from "@earendil-works/chord/context";
import type { JsonValue } from "@earendil-works/chord";
import type { Registry, TaskRecord } from "@earendil-works/pi-durable";

/**
 * `Tx.setTask` 在运行时存在（调度器 open 恢复时正是用它），但没进公开的 `Tx` 类型。
 * 这里按结构声明出用到的那一个方法，避免去 import 库的私有模块。
 */
type TaskWriter = {
	setTask(value: TaskRecord<JsonValue, JsonValue, JsonValue>): void;
};

export type OpenCoreOptions = {
	/** SQLite 文件路径。 */
	readonly databasePath: string;
	/** 模型访问。 */
	readonly models: Models;
	/** 能力注册表（新核心只装一个「基础能力包」）。 */
	readonly registry: Registry;
	/** 底层运行设置。 */
	readonly settings?: HarnessSettings;
};

export type CoreRuntime = {
	readonly harness: Harness;
	readonly registry: Registry;
	readonly close: (context?: Context) => Promise<void>;
};

/**
 * 自愈：把被 `kill -9`（或任何没走 `harness.close` 的退出）留下的半截任务树清干净。
 *
 * 根因（实测确诊）：
 * `Harness.open` 会加载所有「非终态」任务并尝试恢复。一次强杀会把一棵任务树留在
 * 半截：父任务 `waiting` 在子任务上，子任务 `running`，还有一条 `placed` 的输入
 * submission。恢复时调度器重放这些任务，但它们背后的模型调用/工具调用早就随进程
 * 一起没了，于是抛 `Task N invocation has ended`；而且是**异步的未处理拒绝**，
 * 会把整个进程崩掉。库一直脏，下次启动照样崩。
 *
 * 为什么旧方案都无效（实测）：
 * - 直接 `UPDATE tasks SET status='terminal'`（另一条 SQLite 连接）：改动被 Harness
 *   自己的连接/页缓存覆盖，而且它只改 `record` 不改 `status` 列，列仍然是脏的。
 * - 基于 `harness.inspect()` 的 `conversation.reset()`：`inspect` 读的是调度器的
 *   **内存活映射**，open 之后还没 reconcile，里面是空的，永远看不到僵尸。
 *
 * 修法：open 之后、装配之前，用 Harness 自己的 **一次 commit** 把所有非终态任务
 * 就地结算成 `terminal`（`orphaned`/`restart`），并在同一次自愈里撤销所有未结的
 * 输入 submission。必须在同一个事务里一次做完：只终结父任务会级联把子任务改回
 * `pending`，它们仍然会重放、仍然会崩（实测）。走 Harness 自身连接与事务，无竞态。
 */
async function reconcileZombieTasks(harness: Harness, context: Context): Promise<void> {
	// 调度器 open 时按这些列扫描「活着」的任务。
	const LIVE = ["pending", "running", "waiting", "sleeping", "completing"] as const;
	let terminated = 0;
	let settled = 0;
	try {
		// 先读一遍未结的输入 submission（任务结算后它们就再也无人处理了）。
		const pendingSubmissions = (await harness.inspect(context)).submissions.filter(
			(submission) => submission.status === "queued" || submission.status === "placed",
		);

		// 一次 commit 里把整棵残留任务树全部结算成 terminal。分开做会被级联改回 pending。
		terminated = await harness.commit(async (tx) => {
			const live = [];
			for (const status of LIVE) {
				const page = await tx.scanTasks({ status }, 256, undefined);
				live.push(...page.items);
			}
			let count = 0;
			for (const task of live) {
				if (task.state?.status === "terminal") continue;
				// terminal 分支不许带 checkpoint / memos，库内 withState 也是这么剥的。
				const { checkpoint: _checkpoint, ...rest } = task.state as unknown as Record<string, unknown>;
				(tx as unknown as TaskWriter).setTask({
					...task,
					state: { ...rest, status: "terminal", outcome: { status: "orphaned", reason: "restart" } },
				} as TaskRecord<JsonValue, JsonValue, JsonValue>);
				count += 1;
			}
			return count;
		}, context);

		// 排队中的输入用 abort 撤掉（它会连 inbox 项一起清）；已经 placed 的只能就地结算——
		// 它的 entry 已经在会话里，但没有活着的任务会来回答它，留着会在下次启动时反复出现。
		for (const submission of pendingSubmissions) {
			if (submission.status === "queued") {
				const result = await harness.abortSubmission(submission.id, context, submission.conversationId);
				if (result === "aborted") settled += 1;
			}
		}
		const placed = pendingSubmissions.filter((submission) => submission.status === "placed");
		if (placed.length > 0) {
			await harness.commit(async (tx) => {
				for (const submission of placed) {
					tx.settleSubmission(submission.id, { status: "unanswered", reason: "restart" });
				}
			}, context);
			settled += placed.length;
		}
	} catch (error) {
		// 自愈失败也不要挡启动：进程能起来，人能进界面手动处理。
		console.error("[reconcile] 跳过（不影响启动）：", (error as Error)?.message);
	}
	if (terminated > 0) console.error(`[reconcile] 已清掉 ${terminated} 条残留任务（强杀留下、无法恢复的）`);
	if (settled > 0) console.error(`[reconcile] 已结算 ${settled} 条残留输入`);
}

export async function openCore(options: OpenCoreOptions, context: Context = BACKGROUND_CONTEXT): Promise<CoreRuntime> {
	const storage = await openNodeSqliteStorage(options.databasePath);
	const harness = await DurableHarness.open(
		storage,
		{
			models: options.models,
			registry: options.registry,
			...(options.settings === undefined ? {} : { settings: options.settings }),
		},
		context,
	);
	// 自愈必须在 open 之后、装配之前：此时 Harness 已持有连接，用它的 commit 把
	// 强杀留下的半截任务树一次结算掉，才能根治 `Task N invocation has ended` 崩溃。
	await reconcileZombieTasks(harness, context);
	return {
		harness,
		registry: options.registry,
		close: (ctx?: Context) => harness.close(ctx ?? context),
	};
}
