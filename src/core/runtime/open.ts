/**
 * 打开「一个库 + 一个 harness」的唯一入口。
 *
 * 这里只做四件事：打开存储、建 harness、自愈脏数据、返回关闭句柄。
 */
import type { Models } from "@earendil-works/pi-ai";
import {
	Harness as DurableHarness,
	LiveDoc,
	type Harness,
	type HarnessSettings,
	type Report,
} from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { BACKGROUND_CONTEXT, type Context } from "@earendil-works/chord/context";
import type { JsonValue } from "@earendil-works/chord";
import type { DatabaseSync } from "node:sqlite";
import type { Cursor, Registry, SubmissionId, TaskRecord } from "@earendil-works/pi-durable";
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
	/**
	 * 底座的「运行报告」出口（`HarnessOptions.onReport`）。
	 *
	 * 底座遇到**不会让调用失败**的错误（任务抛异常、重启超限被挂起、storage 让整个
	 * Session 关掉、扩展/宿主回调抛错）时走这里。以前我们没接，于是这些事在界面上
	 * 一个字都看不到 —— 表现只是「这个人不说话了」。
	 */
	readonly onReport?: (report: RuntimeReport) => void;
};

/**
 * 一条运行报告，**已经摊平成可落盘的普通数据**。
 *
 * 为什么不直接把底座的 `Report` 递出去：它是 pi-durable 的类型，而按边界规则
 * 只有 `runtime/` 能碰那个包。这里做一次翻译，上层（`app/diag.ts` 落盘 + 界面）
 * 就只认这个自己的形状。
 */
export type RuntimeReport = {
	/** 报告种类，与底座 `Report.kind` 同名。 */
	readonly type: string;
	/** 落盘时间（ISO）。底座不提供时间戳，由这里补。 */
	readonly at: string;
	/** 错误正文（有些报告没有错误对象，比如 `task_interrupted`）。 */
	readonly message?: string;
	/** 错误堆栈前三行：定位用，不要整段。 */
	readonly stack?: string;
	/** 涉及的任务。 */
	readonly task?: { readonly id: string; readonly kind: string; readonly conversationId: number };
	/** 哪个扩展的代码出的问题。 */
	readonly extension?: string;
	/** 子原因（`threw` / `restart_limit` / `interrupted` / `missing_task` / `task_too_old` / …）。 */
	readonly reason?: string;
	/** 哪个宿主回调抛的（`now` / `settings` / `models` / …）。 */
	readonly callback?: string;
	/** 不在任务里时，涉及哪个会话。 */
	readonly conversationId?: number;
	/** 任务连续被重启打断的次数（`task_interrupted` 带）。 */
	readonly restarts?: number;
};

/** 堆栈只留三行：够看出在哪一层炸的，又不会把日志写爆。 */
const STACK_LINES = 3;

/** 把底座的一条 `Report` 翻成可落盘的形状。纯函数。 */
export function toRuntimeReport(report: Report): RuntimeReport {
	const error = report.error;
	const task = "task" in report && report.task !== undefined ? report.task : undefined;
	const message = error instanceof Error ? error.message : typeof error === "string" ? error : undefined;
	const stack =
		error instanceof Error && error.stack !== undefined
			? error.stack.split("\n").slice(0, STACK_LINES).join("\n")
			: undefined;
	return {
		type: report.kind,
		at: new Date().toISOString(),
		...(message === undefined || message === "" ? {} : { message }),
		...(stack === undefined ? {} : { stack }),
		...(task === undefined
			? {}
			: { task: { id: String(task.id), kind: task.kind, conversationId: task.conversationId as unknown as number } }),
		...("extension" in report && report.extension !== undefined ? { extension: String(report.extension) } : {}),
		...("reason" in report && report.reason !== undefined ? { reason: String(report.reason) } : {}),
		...("callback" in report && report.callback !== undefined ? { callback: String(report.callback) } : {}),
		...("conversationId" in report && report.conversationId !== undefined
			? { conversationId: report.conversationId as unknown as number }
			: {}),
		...("restarts" in report && report.restarts !== undefined ? { restarts: report.restarts } : {}),
	};
}

export type CoreRuntime = {
	readonly harness: Harness;
	readonly registry: Registry;
	readonly close: (context?: Context) => Promise<void>;
	/**
	 * 重启时正跑到一半、被结算成 `orphaned` 的会话。装配层拿它把人叫回来接着做
	 * （ADR-044）—— 这一层不认识频道，只报「谁的这一轮断了」。
	 */
	readonly interrupted: readonly number[];
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
/**
 * 把一个 `scan*` 接口的所有页读全（库一次只给一页；只读第一页会让后面的僵尸永远清不掉）。
 */
async function scanAllPages<T>(
	scan: (limit: number, cursor?: Cursor) => Promise<{ items: readonly T[]; next?: Cursor }>,
): Promise<T[]> {
	const items: T[] = [];
	let page = await scan(256);
	items.push(...page.items);
	while (page.next !== undefined) {
		page = await scan(256, page.next);
		items.push(...page.items);
	}
	return items;
}

async function reconcileZombieTasks(harness: Harness, context: Context): Promise<readonly number[]> {
	// 调度器 open 时按这些列扫描「活着」的任务。
	const LIVE = ["pending", "running", "waiting", "sleeping", "completing"] as const;
	let terminated = 0;
	let settled = 0;
	// 被解开「假忙」的会话：它们的积压输入还卡在 inbox 里，等一个人开第一轮。
	const unblocked = new Set<number>();
	// 重启时正跑到一半的会话（有 `run`）：它们的这一轮已经没了，装配层要把人叫回来接着做。
	const interrupted = new Set<number>();
	try {
		// 先读一遍未结的输入 submission（任务结算后它们就再也无人处理了）。
		const pendingSubmissions = (await harness.inspect(context)).submissions.filter(
			(submission) => submission.status === "queued" || submission.status === "placed",
		);

		// 一次 commit 里把整棵残留任务树全部结算成 terminal。分开做会被级联改回 pending。
		terminated = await harness.commit(async (tx) => {
			// **先把所有表扫完，再开始写。**
			//
			// 旧版本在这里踩过一个一直没人发现的坑：先 `setTask` 写任务，再 `scanConversations`
			// 扫会话 —— pi-durable 明确禁止「写表之后再读表」，于是整个 commit 抛错、
			// 被外层 catch 吞成一行警告，结果是**这套自愈从上线起一次都没真正跑过**
			// （实测每次启动都打 `Tx.scanConversations() cannot read tables after the first table write`），
			// 僵尸任务与残留输入一直挂在库里（`submissions` 里 2 条 unanswered 从 10-29 挂到现在）。
			// 必须翻页：`scan*` 一次只给一页。早先只读第一页（256 条），某个状态超过 256 条时
			// 后面的僵尸永远清不掉，每次启动都重建一次崩溃。
			const live = [];
			for (const status of LIVE) {
				live.push(...(await scanAllPages((limit, cursor) => tx.scanTasks({ status }, limit, cursor))));
			}

			// 会话 + 每个会话的 `pi.live`（也是读）：判断那一条 `run` 是不是已经没人收尾了。
			const stale: { conversationId: number; runInputs: readonly SubmissionId[]; stale: boolean }[] = [];
			for (const conversation of await scanAllPages((limit, cursor) => tx.scanConversations({}, limit, cursor))) {
				const doc = await tx.doc(LiveDoc, conversation.id);
				const run = doc.run;
				// **只要有 `run` 就算陈旧**：这次 commit 会把所有活着状态的任务统统结算成
				// terminal（上面 `live`），所以它的 owner 也一样会死。旧判断只看
				// 「owner 不存在或已 terminal」，owner 还是 `running` 时判成「不陈旧」，
				// 于是它服务的排队输入被 `abortSubmission` 撤掉、也没人补占位 ——
				// 我崩溃前说的话就这样被静默吞了（实测：私聊里几十条全没）。
				stale.push({
					conversationId: conversation.id,
					runInputs: run?.inputs ?? [],
					stale: run !== undefined,
				});
			}
			for (const id of stale.filter((item) => item.stale).flatMap((item) => item.runInputs)) {
				tx.settleSubmission(id, { status: "unanswered", reason: "restart" });
				settled += 1;
			}

			// ── 以上全是读，从这里开始写 ──
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
			for (const item of stale) {
				if (item.stale) {
					unblocked.add(item.conversationId);
					interrupted.add(item.conversationId);
				}
				const doc = await tx.doc(LiveDoc, item.conversationId as never);
				if (doc.run !== undefined) delete doc.run;
				delete doc.generation;
				delete doc.tools;
				delete doc.nestedTools;
			}
			return count;
		}, context);

		// **排队中的输入一条都不撤**。`queued` = 还躺在 inbox 里、从未被这一轮取走，
		// 它的内容完好，撤掉就是把我崩溃前说的话静默吞掉（实测：私聊里几十条全没）。
		// 之前只对「被解开假忙」的会话放行，可那个集合只包含有 `run` 标记的会话；
		// 没有标记的会话里排队的东西同样能续上——下面统一补一句占位输入把它们踢起来。
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
		const backlog = pendingSubmissions.filter((submission) => submission.status === "queued");
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
		return [];
	}
	if (terminated > 0) console.error(`[reconcile] 已清掉 ${terminated} 条残留任务（强杀留下、无法恢复的）`);
	if (settled > 0) console.error(`[reconcile] 已结算 ${settled} 条残留输入`);
	return [...interrupted];
}

/** 已完成（terminal）的任务记录保留多久：超过就回收。 */
const TASK_RETENTION_MS = 3 * 24 * 60 * 60_000;

/**
 * 直接开一条 SQLite 连接跑一句 SQL（回收用），完了关掉。表不在 / 没开 JSON1 一律返回
 * `fallback`，不挡启动。
 */
async function withSqlite<T>(databasePath: string, run: (db: DatabaseSync) => T, fallback: T): Promise<T> {
	if (databasePath === ":memory:") return fallback;
	const { DatabaseSync } = await import("node:sqlite");
	let db: DatabaseSync | undefined;
	try {
		db = new DatabaseSync(databasePath);
		return run(db);
	} catch {
		return fallback;
	} finally {
		db?.close();
	}
}

/**
 * 回收「已完成且超过 3 天」的任务记录（A3）。
 *
 * 为什么用直接 SQL 而不是库的 API：pi-durable 只提供 `setTask`（整条替换），**没有删任务
 * 的口子**，而 `tasks` 是每轮一条、只增不减（实测 2079 条 terminal / 652KB，`conversations`
 * 只有 4 个）。这里在 harness 打开**之前**删，此时没有任何内存缓存引用这些记录。
 *
 * 只删 `status = 'terminal'` 且 `endedAt` 早于 3 天前的：正在跑的和最近的都不动。
 */
export async function pruneTerminalTasks(databasePath: string, retentionMs = TASK_RETENTION_MS): Promise<number> {
	const sql = "DELETE FROM tasks WHERE status = 'terminal' AND json_extract(record, '$.endedAt') < ?";
	return withSqlite(databasePath, (db) => Number(db.prepare(sql).run(Date.now() - retentionMs).changes ?? 0), 0);
}

/** 每个会话保留多少条「已结算」的 submission 记录。 */
const SUBMISSION_KEEP_PER_CONVERSATION = 500;

/** 只删终态（`queued` / `placed` 是真在排队的活，一律不碰），每个会话留最近 N 条。 */
const SUBMISSION_PRUNE_SQL = `DELETE FROM submissions WHERE status IN ('done', 'unanswered') AND id NOT IN (
	SELECT id FROM submissions AS inner_table
	WHERE inner_table.conversation_id = submissions.conversation_id
	  AND inner_table.status IN ('done', 'unanswered')
	ORDER BY id DESC LIMIT ?
)`;

/**
 * 回收「已结算的输入记录」，每个会话只留最近 N 条。
 *
 * 为什么要管这个：`submissions` 是**每轮一条**的记账（实测 177 done + 2 unanswered，
 * `conversations` 只有 4 个），只增不减。它不是待办 —— `status` 是 `done`/`unanswered`
 * 的都已经结算过，不会再被谁处理，留着只是历史。
 *
 * 为什么按「条数」而不是「时间」：这张表的记录里**没有时间戳**（只有 conversationId /
 * requestId / status / entry），没法按天筛；按每会话保留最近 N 条既能给表一个确定上界，
 * 又不会误删刚发生的记录（合并唤醒会让最近这些记录变化很快，必须保守）。
 *
 * 只删终态：`queued` / `placed` 一律不碰（那是真在排队的活）。
 */
export async function pruneTerminalSubmissions(
	databasePath: string,
	keepPerConversation = SUBMISSION_KEEP_PER_CONVERSATION,
): Promise<number> {
	return withSqlite(
		databasePath,
		(db) => Number(db.prepare(SUBMISSION_PRUNE_SQL).run(keepPerConversation).changes ?? 0),
		0,
	);
}

/** 报告出口自己不许抛：它会连累底座把「一次任务失败」升级成别的后果。 */
function safeReport(sink: ((value: RuntimeReport) => void) | undefined): (report: Report) => void {
	return (report) => {
		try {
			sink?.(toRuntimeReport(report));
		} catch (reportError) {
			console.error("[core] 运行报告没处理掉：", (reportError as Error)?.message);
		}
	};
}

export async function openCore(options: OpenCoreOptions, context: Context = BACKGROUND_CONTEXT): Promise<CoreRuntime> {
	const pruned = await pruneTerminalTasks(options.databasePath);
	if (pruned > 0) console.error(`[core] 回收 ${pruned} 条 3 天前的已完成任务记录`);
	const prunedSubmissions = await pruneTerminalSubmissions(options.databasePath);
	if (prunedSubmissions > 0) console.error(`[core] 回收 ${prunedSubmissions} 条已结算的输入记录`);
	const storage = await openNodeSqliteStorage(options.databasePath);
	const raw = await DurableHarness.open(
		storage,
		{
			models: options.models,
			registry: options.registry,
			...(options.settings === undefined ? {} : { settings: options.settings }),
			...(options.onReport === undefined ? {} : { onReport: safeReport(options.onReport) }),
		},
		context,
	);
	// 所有写都走这一个闸：同进程并发的 commit 会让底层读覆盖层失效，而**失败的那次
	// 其实已经写进去了** —— 模型以为没发出去于是重发，频道里出现两条一模一样的话。
	// 详见 `runtime/serialize.ts`。
	const harness = serializedHarness(raw);
	// 自愈必须在 open 之后、装配之前：此时 Harness 已持有连接，用它的 commit 把
	// 强杀留下的半截任务树一次结算掉，才能根治 `Task N invocation has ended` 崩溃。
	const interrupted = await reconcileZombieTasks(harness, context);
	return {
		harness,
		registry: options.registry,
		close: (ctx?: Context) => harness.close(ctx ?? context),
		interrupted,
	};
}
