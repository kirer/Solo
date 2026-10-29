/**
 * 打开「一个库 + 一个 harness」的唯一入口。
 *
 * 这里只做四件事：打开存储、建 harness、自愈脏数据、返回关闭句柄。
 */
import type { Models } from "@earendil-works/pi-ai";
import { Harness as DurableHarness, LiveDoc, type Harness, type HarnessSettings } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { BACKGROUND_CONTEXT, type Context } from "@earendil-works/chord/context";
import type { JsonValue } from "@earendil-works/chord";
import type { Cursor, Registry, TaskRecord } from "@earendil-works/pi-durable";
import { serializedHarness } from "./serialize.ts";

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
 *
 * 还有一处必须一起清：会话的 `pi.live` 文档。它里面的 `run` 是「这个会话忙不忙」
 * 的唯一判据（入库检查就是 `busy = live.run !== undefined`）。强杀时 `run` 留在那里，
 * 而它指向的 generation 任务已经是 terminal —— 于是这个会话**永远被当成忙**，
 * 之后的每一条输入都被塞进 `queued` 再也无人取（实测：私聊几十条消息全哑）。
 */
async function reconcileZombieTasks(harness: Harness, context: Context): Promise<void> {
	// 调度器 open 时按这些列扫描「活着」的任务。
	const LIVE = ["pending", "running", "waiting", "sleeping", "completing"] as const;
	let terminated = 0;
	let settled = 0;
	// 被解开「假忙」的会话：它们的积压输入还卡在 inbox 里，等一个人开第一轮。
	const unblocked = new Set<number>();
	try {
		// 先读一遍未结的输入 submission（任务结算后它们就再也无人处理了）。
		const pendingSubmissions = (await harness.inspect(context)).submissions.filter(
			(submission) => submission.status === "queued" || submission.status === "placed",
		);

		// 一次 commit 里把整棵残留任务树全部结算成 terminal。分开做会被级联改回 pending。
		terminated = await harness.commit(async (tx) => {
			const live = [];
			for (const status of LIVE) {
				// 必须翻页：`scanTasks` 一次只给一页。早先只读第一页（256 条），
				// 某个状态超过 256 条时后面的僵尸永远清不掉，每次启动都重建一次崩溃。
				let cursor: Cursor | undefined;
				for (;;) {
					const page = await tx.scanTasks({ status }, 256, cursor);
					live.push(...page.items);
					if (page.next === undefined) break;
					cursor = page.next;
				}
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

			// 清掉所有会话的「忙」标记（见函数头注释：不清就等于让这个会话永远哑掉）。
			// 必须扫**全部会话**而不是只看上面那些残留任务所属的会话：一条活任务都没有、
			// 只有一条陈旧 `run` 的会话正是最坏的那种（它永远不会报错，只是再也不说话）。
			// 只清 `run` 指向的任务已经终态（或不存在）的——同一个库上可能还挂着另一个
			// 活进程，它的 `run` 指向的任务还活着，不能动。
			let conversationCursor: Cursor | undefined;
			for (;;) {
				const page = await tx.scanConversations({}, 256, conversationCursor);
				for (const conversation of page.items) {
					const doc = await tx.doc(LiveDoc, conversation.id);
					const run = doc.run;
					if (run !== undefined) {
						const owner = await tx.task(run.taskId);
						// 任务不存在也算陈旧（指向一个已经不存在的任务，没人会来收尾）。
						if (owner !== undefined && owner.state?.status !== "terminal") continue;
						// 与库内 `endRun` 同一套收尾：先结算这一轮挂着的输入，再摘掉整轮的表现。
						for (const id of run.inputs) {
							tx.settleSubmission(id, { status: "unanswered", reason: "restart" });
							settled += 1;
						}
						delete doc.run;
						unblocked.add(conversation.id);
					}
					delete doc.generation;
					delete doc.tools;
					delete doc.nestedTools;
				}
				if (page.next === undefined) break;
				conversationCursor = page.next;
			}
			return count;
		}, context);

		// 排队中的输入默认撤掉：它服务的那一轮已经死了，没人会再来取。
		// 例外是被解开假忙的会话——它现在是真空闲，这些输入**能被处理**，
		// 一律撤掉等于把老板刚说的话默默吞了（实测：私聊里几十条全被吞）。
		for (const submission of pendingSubmissions) {
			if (submission.status === "queued" && !unblocked.has(submission.conversationId)) {
				const result = await harness.abortSubmission(submission.id, context, submission.conversationId);
				if (result === "aborted") settled += 1;
			}
		}
		const placed = pendingSubmissions.filter(
			(submission) => submission.status === "placed" && !unblocked.has(submission.conversationId),
		);
		if (placed.length > 0) {
			await harness.commit(async (tx) => {
				for (const submission of placed) {
					tx.settleSubmission(submission.id, { status: "unanswered", reason: "restart" });
				}
			}, context);
			settled += placed.length;
		}

		// 解开假忙之后，那个会话里积压的输入仍然躺在 inbox 里：入库时 `busy` 为真，所以
		// 它们从未触发 `startRun`，而 inbox 只在「一轮结束」的边界上被取走。没有活着
		// 的一轮，就没人来取。这里补一句占位输入把它自己踢起来——不用猜那些积压的正文，
		// 一次 `admitSubmission` 会把 inbox 里所有排队项一起放进这一轮。
		const backlog = pendingSubmissions.filter(
			(submission) => submission.status === "queued" && unblocked.has(submission.conversationId),
		);
		for (const conversationId of new Set(backlog.map((submission) => submission.conversationId))) {
			const conversation = await harness.conversation(conversationId, context);
			if (conversation === undefined) continue;
			await conversation.submit(
				{
					type: "input",
					content: "（重启前积压的消息已恢复，请处理上面还没回的消息）",
					requestId: `reconcile:${conversationId}`,
				},
				context,
			);
			unblocked.delete(conversationId);
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
	const raw = await DurableHarness.open(
		storage,
		{
			models: options.models,
			registry: options.registry,
			...(options.settings === undefined ? {} : { settings: options.settings }),
		},
		context,
	);
	// 所有写都走这一个闸：同进程并发的 commit 会让底层读覆盖层失效，而**失败的那次
	// 其实已经写进去了** —— 模型以为没发出去于是重发，频道里出现两条一模一样的话。
	// 详见 `runtime/serialize.ts`。
	const harness = serializedHarness(raw);
	// 自愈必须在 open 之后、装配之前：此时 Harness 已持有连接，用它的 commit 把
	// 强杀留下的半截任务树一次结算掉，才能根治 `Task N invocation has ended` 崩溃。
	await reconcileZombieTasks(harness, context);
	return {
		harness,
		registry: options.registry,
		close: (ctx?: Context) => harness.close(ctx ?? context),
	};
}
