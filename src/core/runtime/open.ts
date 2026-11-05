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
import type { DatabaseSync } from "node:sqlite";
import type { Cursor, Registry, SubmissionId, TaskId } from "@earendil-works/pi-durable";

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
	 * 上一次进程停下时正在跑一轮的会话。装配层拿它留一句痕；这一轮由底座自己重放
	 * （ADR-044 / ADR-074）。
	 */
	readonly interrupted: readonly number[];
	/** 有排队输入、却没有活着的一轮来取它的会话。装配完由宿主发一条 `continue` 接上。 */
	readonly backlog: readonly number[];
};

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

/**
 * 启动检查：**不再替底座结算任务**。
 *
 * 1.4.x 时代这里会把所有非终态任务强杀成 `orphaned`，因为底座重放会抛
 * `Task N invocation has ended`。1.5.0 的调度器自己会在 open 时把 `running` 改回
 * `pending` 并计一次 restart，重放时按 checkpoint 继续；连续被切断超过 `restartLimit`
 * 才结束，并在 `pi.live.runFailure` 留下 `restart_limit` / `interrupted`（ADR-072 已能显示）。
 * 再抢着杀只会把本来能续上的一轮变成「没答上来」。
 *
 * 这里只剩两件底座不管的事：
 * - `run` 指向一条**根本不存在**的任务（旧数据 / 损坏）。任务还在的一律不动 ——
 *   答完但还在跑 `afterRun` 的 run 也指向一条 terminal generation，不能按「terminal」判死。
 * - 排队输入没有活着的一轮来取（崩溃恰好发生在上一轮结算之后、下一轮开始之前）。
 *   交给装配层发 `continue`，它会把 inbox 里的排队项一起带进这一轮。
 */
async function inspectStartup(
	harness: Harness,
	context: Context,
): Promise<{ interrupted: readonly number[]; backlog: readonly number[] }> {
	const inspection = await harness.inspect(context);
	const interrupted = new Set<number>();
	for (const task of inspection.tasks) {
		if (task.record.kind !== "pi.generation") continue;
		// open 把「上次退出时还在 running」的任务改成 pending 并 +1；改过状态的任务会清零。
		if ((task.record.restarts ?? 0) > 0) interrupted.add(task.record.conversationId);
	}

	// 扫一遍所有会话的 `pi.live.run`（只读的 commit）。
	const runs: { conversationId: number; taskId: TaskId; inputs: readonly SubmissionId[] }[] = [];
	await harness.commit(async (tx) => {
		for (const conversation of await scanAllPages((limit, cursor) => tx.scanConversations({}, limit, cursor))) {
			const doc = await tx.doc(LiveDoc, conversation.id);
			if (doc.run === undefined) continue;
			runs.push({ conversationId: conversation.id, taskId: doc.run.taskId, inputs: doc.run.inputs });
		}
	}, context);

	// 只有「run 指着的任务根本不存在」才清；任务在（哪怕 terminal）就交给底座。
	const gone: typeof runs = [];
	for (const run of runs) {
		if ((await harness.getTask(run.taskId, context)) !== undefined) continue;
		gone.push(run);
	}
	if (gone.length > 0) {
		await harness.commit(async (tx) => {
			for (const run of gone) {
				const doc = await tx.doc(LiveDoc, run.conversationId as never);
				if (doc.run === undefined) continue;
				for (const input of doc.run.inputs) {
					tx.settleSubmission(input, { status: "unanswered", reason: "restart" });
				}
				delete doc.run;
				delete doc.generation;
				delete doc.tools;
				delete doc.nestedTools;
			}
		}, context);
		console.error(`[reconcile] ${gone.length} 个会话的 run 指向不存在的任务，已结算为「没答上来」`);
	}

	const goneIds = new Set(gone.map((run) => run.conversationId));
	const runOf = new Set(runs.filter((run) => !goneIds.has(run.conversationId)).map((run) => run.conversationId));
	const liveGeneration = new Set(
		inspection.tasks
			.filter((task) => task.record.kind === "pi.generation" && task.state.kind !== "blocked")
			.map((task) => task.record.conversationId),
	);
	const backlog = new Set<number>();
	for (const submission of inspection.submissions) {
		if (submission.status !== "queued") continue;
		if (runOf.has(submission.conversationId) || liveGeneration.has(submission.conversationId)) continue;
		backlog.add(submission.conversationId);
	}

	return { interrupted: [...interrupted], backlog: [...backlog] };
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
	// 1.5.0 的 group commit 自己会把同一份文档的 commit 排队（不同文档并行），
	// Solo 不再包一层全局串行。见 `test/core/commit-concurrency.test.ts`。
	// 启动检查必须在 open 之后、装配之前：此时底座已经把上次 `running` 的任务改回
	// `pending`（并计了 restart），我们只读它留下的现场。
	const startup = await inspectStartup(raw, context);
	return {
		harness: raw,
		registry: options.registry,
		close: (ctx?: Context) => raw.close(ctx ?? context),
		interrupted: startup.interrupted,
		backlog: startup.backlog,
	};
}
