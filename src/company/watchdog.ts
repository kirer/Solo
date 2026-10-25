/**
 * 看门狗：把「永远卡住」变成「看得见、有人收尾」。
 *
 * 为什么需要它（真实库 `workspace/company.sqlite` 复现）：
 *
 * 1. 负责人会话里 `staff_assign` 同步等员工，员工自己也在忙 → 请求进队列；
 * 2. 员工那轮里有工具报错，负责人这一轮变成 `tool error: interrupted and may have partially run`；
 * 3. 但 `pi.generation` 仍是 `waiting`（`on: [toolId]`），`inspect()` 一直把它算作「在忙」；
 * 4. 于是 `isEmployeeBusy` / `isBusy` 永远为真，后续派活全部排队，界面永远「正在忙」；
 * 5. 老板点「立即处理」也只是再排一条，**没有任何东西会去收尾**。
 *
 * 第 5 步是根因：系统里缺一个「定期看一眼，然后动手」的角色。这个文件就是它。
 *
 * 三条职责：
 * - **判定**：哪些任务真的在跑，哪些只是僵住的 `waiting`（判定逻辑在 `src/runtime/recover.ts`，
 *   这里只消费，不重复实现，避免界面/派活/看门狗三处口径不一致）。
 * - **收尾**：超期或结构性僵住的任务，中断或重试；同一条任务最多自动动手 2 次，
 *   之后如实标 error 并停手（不做无限重试，那只是把卡死变成抖动）。
 * - **排空**：会话空闲但队列里还压着老板的消息时，主动投一次，不等下一次老板说话。
 *
 * 每一次动手都写一条 `app.alert` 条目进会话流——老板必须**看得见**「系统自己做了什么」，
 * 否则「自动恢复」和「悄悄吞掉」在界面上没有区别。
 */
import {
	BACKGROUND_CONTEXT,
	type CompanyRuntime,
	type Context,
	InboxDoc,
	inspectLivenessFrom,
	isConversationBusy,
	type Liveness,
	type StuckReason,
	type TaskLiveness,
} from "../runtime/index.ts";
import { applyDueDispositionDefaults, applyDueResumeReminders } from "./disposition.ts";

/** 看门狗写进会话流的告警条目类型。 */
export const ALERT_ENTRY_KIND = "app.alert";

/** 看门狗对一条僵住任务做了什么。 */
export type WatchdogAction =
	/** 中断任务（超期 / 等不到东西了），让它写下中断结果。 */
	| "abort"
	/** 重试因反复崩溃被暂停的任务。 */
	| "retry"
	/** 把空闲会话里压着的排队消息投出去。 */
	| "drain"
	/** 自动动手次数用尽，只报告不再动手。 */
	| "report";

/** 一条看门狗事件。 */
export type WatchdogAlert = {
	readonly at: number;
	readonly conversationId: number;
	readonly taskId: string;
	readonly taskKind: string;
	readonly action: WatchdogAction;
	/** 触发原因；排空队列时是 `inbox-queued`。 */
	readonly reason: StuckReason | "inbox-queued";
	/** 给老板看的一句话。 */
	readonly message: string;
	/** 这是第几次自动动手（从 1 开始；`report` 时为上限 + 1）。 */
	readonly attempt: number;
	/** 已经放弃自动收尾，界面应当按故障显示。 */
	readonly giveUp: boolean;
};

/** 看门狗阈值与开关。 */
export type WatchdogOptions = {
	/** 巡检间隔（毫秒）。默认 30 秒。 */
	readonly intervalMs?: number;
	/** 一轮生成多久没有任何进展算超期。默认 600_000（10 分钟）。 */
	readonly generationOverdueMs?: number;
	/** 一次工具调用多久没有任何进展算超期。默认 300_000（5 分钟）。 */
	readonly toolOverdueMs?: number;
	/** 同一条任务最多自动动手几次。默认 2。 */
	readonly maxAttempts?: number;
	/** 两次自动动手之间的最小间隔（毫秒）。默认等于巡检间隔。 */
	readonly retryCooldownMs?: number;
	/** 是否在会话空闲时排空队列。默认 true。 */
	readonly drainInbox?: boolean;
	/** 启动时是否立刻巡检一次。默认 true。 */
	readonly immediate?: boolean;
	/** 事件回调（打日志、推 SSE 等）；留痕本身不依赖它。 */
	readonly onAlert?: (alert: WatchdogAlert) => void;
	readonly context?: Context;
};

/** 默认值集中在这里，便于测试与文档引用。 */
export const WATCHDOG_DEFAULTS = {
	intervalMs: 30_000,
	generationOverdueMs: 600_000,
	toolOverdueMs: 300_000,
	maxAttempts: 2,
	drainInbox: true,
	immediate: true,
} as const;

/** 一次巡检的结果。 */
export type WatchdogPassResult = {
	/** 本轮判定的存活视图。 */
	readonly liveness: Liveness;
	/** 本轮写出的告警。 */
	readonly alerts: readonly WatchdogAlert[];
};

/** 一条任务被看门狗动过几次。 */
type Attempt = { count: number; lastAt: number; gaveUp: boolean };

/** 每个运行时的看门狗状态（进程内；重启后重新建立，见下方 `startWatchdog`）。 */
type WatchdogState = {
	/** 任务标识 → 已自动动手次数。 */
	attempts: Map<string, Attempt>;
	/** 任务标识 → 本次进程第一次看到它的时刻。 */
	observedAt: Map<string, number>;
	/** 会话标识 → 最后一次看到新条目的时刻（心跳）。 */
	progressAt: Map<number, number>;
	/** 会话标识 → 最后看到的条目标识。 */
	lastEntry: Map<number, number>;
	/** 已写出的告警（最近的在前，供界面查询）。 */
	alerts: WatchdogAlert[];
};

const STATES = new WeakMap<CompanyRuntime, WatchdogState>();
const MAX_ALERTS = 200;

function stateOf(runtime: CompanyRuntime): WatchdogState {
	let state = STATES.get(runtime);
	if (state === undefined) {
		state = {
			attempts: new Map(),
			observedAt: new Map(),
			progressAt: new Map(),
			lastEntry: new Map(),
			alerts: [],
		};
		STATES.set(runtime, state);
	}
	return state;
}

/** 读出这个运行时最近的看门狗告警（最近的在前）。 */
export function readWatchdogAlerts(runtime: CompanyRuntime): readonly WatchdogAlert[] {
	return [...(STATES.get(runtime)?.alerts ?? [])];
}

/**
 * 跑一轮巡检。
 *
 * 设计要点：
 * - **只读判定，再动手**：先拿一次 `inspect()` 快照做判定，避免边判边改导致误判。
 * - **一次只动叶子**：`waiting` 任务等的子任务如果本轮也要动，就先动子任务，
 *   父任务留给下一轮（子任务结束后它自然变成 `waiting-on-dead`）。这样不会
 *   父子同时被中断，界面上不会出现「两个红条但只有一个真问题」。
 * - **心跳而非时间戳**：任务的 `startedAt` 会跨重启保留，且一轮生成跨多轮工具调用
 *   时总时长很长。所以「有没有进展」看的是**会话最新条目有没有变**，
 *   而不是「这个任务活了多久」。
 */
export async function runWatchdogPass(
	runtime: CompanyRuntime,
	options: WatchdogOptions = {},
): Promise<WatchdogPassResult> {
	const context = options.context ?? BACKGROUND_CONTEXT;
	const now = Date.now();
	const intervalMs = options.intervalMs ?? WATCHDOG_DEFAULTS.intervalMs;
	const maxAttempts = options.maxAttempts ?? WATCHDOG_DEFAULTS.maxAttempts;
	const cooldown = options.retryCooldownMs ?? intervalMs;
	const state = stateOf(runtime);

	// ① 心跳：会话最新条目变了 = 它在推进，把它的任务全部视为「刚刚有进展」。
	await refreshProgress(runtime, state, now, context);

	// ①' OPS-20261025-04（审计 R-02/R-03）：模型失败的终态任务落在 tasks 表里，
	// 底层不会为它调 onReport（详见 src/runtime/run-failure.ts）。每轮巡检扫一次，
	// 幂等（水位去重），重启后也不丢。扫表失败不影响巡检。
	await runtime.scanTaskFailures(context).catch(() => 0);

	const inspection = await runtime.harness.inspect(context);
	// 观察起点：任务的 startedAt 可能来自上一次进程，超期只从「我们真正开始看它」算。
	const observedAt = new Map<string, number>();
	for (const task of inspection.tasks) {
		const id = String(task.record.id);
		if (!state.observedAt.has(id)) state.observedAt.set(id, now);
		const heartbeat = state.progressAt.get(Number(task.record.conversationId)) ?? 0;
		const own = state.observedAt.get(id) ?? now;
		observedAt.set(id, Math.max(own, heartbeat));
	}
	// 清掉已经不在活任务里的记录，避免长期运行后 Map 无限增长
	const liveIds = new Set(inspection.tasks.map((task) => String(task.record.id)));
	for (const id of state.observedAt.keys()) if (!liveIds.has(id)) state.observedAt.delete(id);
	for (const id of state.attempts.keys()) if (!liveIds.has(id)) state.attempts.delete(id);

	const liveness = inspectLivenessFrom(inspection, {
		generationOverdueMs: options.generationOverdueMs ?? WATCHDOG_DEFAULTS.generationOverdueMs,
		toolOverdueMs: options.toolOverdueMs ?? WATCHDOG_DEFAULTS.toolOverdueMs,
		observedAt,
		now,
	});

	const alerts: WatchdogAlert[] = [];
	const push = async (alert: WatchdogAlert): Promise<void> => {
		alerts.push(alert);
		state.alerts.unshift(alert);
		if (state.alerts.length > MAX_ALERTS) state.alerts.length = MAX_ALERTS;
		await writeAlert(runtime, alert, context);
		try {
			options.onAlert?.(alert);
		} catch {
			// 回调失败不影响巡检
		}
	};

	// ② 收尾僵住的任务。
	const handled = new Set<string>();
	const stuck = [...liveness.stuckTasks].sort((left, right) => {
		// 先动工具（叶子），再动等它的生成任务
		const rank = (task: TaskLiveness) => (task.taskKind === "pi.tool" ? 0 : 1);
		return rank(left) - rank(right) || left.conversationId - right.conversationId;
	});

	for (const task of stuck) {
		if (handled.has(task.taskId)) continue;
		// 父任务：等的子任务本轮也要动 → 让子任务先走，父任务下一轮自然变成 waiting-on-dead
		const childStuck = (task.waitingOn ?? []).some((id: string) => stuck.some((entry) => entry.taskId === id));
		if (childStuck) continue;

		const attempt = state.attempts.get(task.taskId) ?? { count: 0, lastAt: 0, gaveUp: false };
		if (attempt.gaveUp) continue;

		// 冷却期内不重复动手（防止 30s 巡检把同一任务连打两次）
		if (attempt.count > 0 && now - attempt.lastAt < cooldown) continue;

		if (attempt.count >= maxAttempts) {
			// 动手次数用尽：如实标 error，停手，不再抖动
			attempt.gaveUp = true;
			state.attempts.set(task.taskId, attempt);
			await push({
				at: now,
				conversationId: task.conversationId,
				taskId: task.taskId,
				taskKind: task.taskKind,
				action: "report",
				reason: task.reason ?? "overdue",
				message: describeGiveUp(task, maxAttempts),
				attempt: attempt.count + 1,
				giveUp: true,
			});
			handled.add(task.taskId);
			continue;
		}

		const next = attempt.count + 1;
		const action: WatchdogAction = task.reason === "blocked" ? "retry" : "abort";
		let ok = false;
		try {
			if (action === "retry") {
				await runtime.harness.retryTask(task.taskId as never, context);
			} else {
				await runtime.harness.abortTask(task.taskId as never, context);
			}
			ok = true;
		} catch {
			// 任务可能刚好结束：下一轮就不在活任务里了，不必报错
		}
		state.attempts.set(task.taskId, { count: next, lastAt: now, gaveUp: false });
		handled.add(task.taskId);

		if (ok) {
			await push({
				at: now,
				conversationId: task.conversationId,
				taskId: task.taskId,
				taskKind: task.taskKind,
				action,
				reason: task.reason ?? "overdue",
				message: describeAction(task, action, next, maxAttempts),
				attempt: next,
				giveUp: false,
			});
		}
	}

	// ③ 队列排空：会话已经空闲，但队列里还压着消息。
	if (options.drainInbox ?? WATCHDOG_DEFAULTS.drainInbox) {
		for (const conversationId of await idleConversationsWithQueue(runtime, liveness, context)) {
			const drained = await drainOne(runtime, conversationId, context);
			if (drained === undefined) continue;
			await push({
				at: now,
				conversationId,
				taskId: drained,
				taskKind: "pi.inbox",
				action: "drain",
				reason: "inbox-queued",
				message: "会话已经空闲，但队列里还压着没处理的消息——已自动投递，开始处理。",
				attempt: 1,
				giveUp: false,
			});
		}
	}

	// ④ 处置待办到期兜底（ADR-026 决策 5）。
	// 「到期按暂搁执行，问题留在待办可事后改」——挂在这里而不是自己起定时器：
	// 定时器绑定进程实例，重启就丢；挂在已有巡检上，重启后自然恢复。
	// 失败不能拖垮巡检：它只是附加动作。
	try {
		await applyDueDispositionDefaults(runtime, now, context);
	} catch (error) {
		// 吞掉是对的（处置兜底不能拖垮巡检），但**必须留痕**：
		// 若每轮都抛而没人知道，兜底会安静地永远失败（审计 D-08，OPS-01 的教训）。
		// 写 stderr 而不塞进 `alerts`：后者会改变 runWatchdogPass 的返回语义与现有断言。
		// 注：由于 `listPending` 也会做读时兜底（D-01），这里失败不会再导致「到期永不生效」。
		process.stderr.write(`[处置兜底失败] ${error instanceof Error ? error.message : String(error)}\n`);
	}

	// ④' 恢复提醒（ADR-026 决策 4）：暂搁的「恢复条件」到点必须真的提醒下达人，
	// 否则那条条件只是一行字，暂搁的工作照样无声烂掉。
	// 与兜底同理挂在巡检上；失败留痕但不改变巡检返回语义。
	try {
		await applyDueResumeReminders(runtime, now, context);
	} catch (error) {
		process.stderr.write(`[恢复提醒失败] ${error instanceof Error ? error.message : String(error)}\n`);
	}

	return { liveness, alerts };
}

/**
 * 启动看门狗。
 *
 * @param source 运行时，或返回当前运行时的 getter。
 *   **一定要用 getter**：崩溃自愈（`watchForFailure`）会换掉运行时对象，
 *   传实例会让看门狗盯着一个已经关闭的运行时。
 * @returns 停止函数（幂等）
 */
export function startWatchdog(
	source: CompanyRuntime | (() => CompanyRuntime),
	options: WatchdogOptions = {},
): () => void {
	const current = typeof source === "function" ? source : () => source;
	const intervalMs = options.intervalMs ?? WATCHDOG_DEFAULTS.intervalMs;
	let stopped = false;
	let running = false;
	let timer: ReturnType<typeof setInterval> | undefined;

	const pass = async (): Promise<void> => {
		if (stopped || running) return;
		running = true;
		try {
			await runWatchdogPass(current(), options);
		} catch {
			// 巡检本身出错绝不能拖垮服务：下一轮继续
		} finally {
			running = false;
		}
	};

	if (options.immediate ?? WATCHDOG_DEFAULTS.immediate) void pass();

	timer = setInterval(() => void pass(), intervalMs);
	// 定时器不该阻止进程退出（Ctrl+C 时立刻能走）
	(timer as { unref?: () => void }).unref?.();

	return () => {
		if (stopped) return;
		stopped = true;
		if (timer !== undefined) clearInterval(timer);
		timer = undefined;
	};
}

// ── 内部 ────────────────────────────────────────────────────────────────────

/**
 * 刷新每个会话的心跳。
 *
 * 只对「有活任务」的会话读最新条目：一次 1 条的倒序扫描，代价可忽略。
 * 条目变了就说明这一轮在产出（生成的部分内容、工具结果都会落成条目），
 * 于是把该会话的心跳时间推到 now。
 */
async function refreshProgress(
	runtime: CompanyRuntime,
	state: WatchdogState,
	now: number,
	context: Context,
): Promise<void> {
	const inspection = await runtime.harness.inspect(context);
	const conversations = new Set(inspection.tasks.map((task) => Number(task.record.conversationId)));
	for (const conversationId of conversations) {
		try {
			const conversation = await runtime.harness.conversation(conversationId as never, context);
			if (conversation === undefined) continue;
			const page = await conversation.entries({ order: "descending" }, 1, undefined, context);
			const newest = page.items[0]?.id;
			if (newest === undefined) continue;
			const previous = state.lastEntry.get(conversationId);
			if (previous === undefined || newest !== previous) {
				state.lastEntry.set(conversationId, Number(newest));
				state.progressAt.set(conversationId, now);
			}
		} catch {
			// 会话刚被删除之类：忽略
		}
	}
}

/** 空闲但队列里还有输入消息的会话。 */
async function idleConversationsWithQueue(
	runtime: CompanyRuntime,
	liveness: Liveness,
	context: Context,
): Promise<readonly number[]> {
	const queued = new Set<number>();
	for (const submission of liveness.inspection.submissions) {
		if (submission.type !== "input") continue;
		if (submission.status !== "queued") continue;
		queued.add(Number(submission.conversationId));
	}

	const result: number[] = [];
	for (const conversationId of queued) {
		// 还在忙的会话不用管：它的边界会把队列排掉
		if (isConversationBusy(liveness, conversationId)) continue;
		// 还有活任务（哪怕是僵住的）也不投：先把任务收尾，否则投进去也是排队
		if (liveness.tasks.some((task) => task.conversationId === conversationId && !task.stuck)) continue;
		result.push(conversationId);
	}
	return result;
}

/**
 * 投递一条被压在队列里的消息。
 *
 * 为什么不是「再 submit 一次」：底层按请求标识去重，重复提交只会拿回原来那个
 * 仍然排队的提交，什么都不会发生。所以必须**先撤回再投**：
 * 撤回会把队列项拿掉，随后的 submit 因为队列已空，直接进对话并起一轮。
 *
 * 内容原样保留（包括 `app.delegate` 这类来源标记），不是伪造一条新消息。
 */
async function drainOne(
	runtime: CompanyRuntime,
	conversationId: number,
	context: Context,
): Promise<string | undefined> {
	const inbox = (await runtime.harness.snapshot(InboxDoc, conversationId as never, context)) as
		| { items?: readonly { id: number; mode: string; content: unknown; entry?: unknown }[] }
		| undefined;
	const item = (inbox?.items ?? []).find((entry) => entry.mode !== "write");
	if (item === undefined) return undefined;

	const conversation = await runtime.harness.conversation(conversationId as never, context);
	if (conversation === undefined) return undefined;

	const submission = await runtime.harness.submission(item.id as never, context);
	if (submission === undefined) return undefined;
	try {
		const result = await submission.abort(context);
		if (result !== "aborted") return undefined;
	} catch {
		return undefined;
	}

	try {
		await conversation.submit(
			{
				type: "input",
				content: item.content as never,
				whenBusy: "steer",
				...(item.entry === undefined ? {} : { entry: item.entry as never }),
			},
			context,
		);
	} catch {
		return undefined;
	}
	return String(item.id);
}

/** 把一条告警写成会话内条目（只显示，不进模型上下文）。 */
async function writeAlert(runtime: CompanyRuntime, alert: WatchdogAlert, context: Context): Promise<void> {
	try {
		await runtime.harness.commit(async (tx) => {
			await tx.appendEntry(alert.conversationId as never, {
				kind: ALERT_ENTRY_KIND,
				data: {
					text: alert.message,
					from: "看门狗",
					action: alert.action,
					reason: alert.reason,
					taskId: alert.taskId,
					taskKind: alert.taskKind,
					attempt: alert.attempt,
					giveUp: alert.giveUp,
					at: alert.at,
				},
			});
		}, context);
	} catch {
		// 留痕失败不影响收尾本身
	}
}

/** 给老板看的说明：做了什么。 */
function describeAction(task: TaskLiveness, action: WatchdogAction, attempt: number, maxAttempts: number): string {
	const target = task.taskKind === "pi.tool" ? "工具调用" : task.taskKind === "pi.generation" ? "模型生成" : task.taskKind;
	const why =
		task.reason === "waiting-on-dead"
			? "它在等的东西已经全部结束了，永远不会自己继续"
			: task.reason === "waiting-on-blocked"
				? "它等的任务被卡住了，等下去没有意义"
				: task.reason === "blocked"
					? "任务被反复中断，已暂停"
					: `它已经 ${Math.round(task.ageMs / 60_000)} 分钟没有任何进展`;
	const did = action === "retry" ? "已自动重试" : "已自动中断并收尾";
	return `看门狗：${target}（任务 ${task.taskId}）${why}。${did}（第 ${attempt}/${maxAttempts} 次）。`;
}

/** 给老板看的说明：放弃了。 */
function describeGiveUp(task: TaskLiveness, maxAttempts: number): string {
	return `看门狗：任务 ${task.taskId}（${task.taskKind}）已自动处理 ${maxAttempts} 次仍未结束，停止自动重试并标记为故障。你可以点「立即处理」强制中断，或等它自己结束。`;
}
