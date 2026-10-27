/**
 * 恢复与自愈。
 *
 * 三条职责（见 company-runtime 规格）：
 * 1. 打开后恢复上次进程遗留的未完成任务；恢复前不执行任何处理器。
 * 2. 巡检因反复崩溃被暂停的任务，报告给宿主。
 * 3. 因存储故障关闭后自动重开，并依靠语义化请求标识去重重复投递。
 */
import { BACKGROUND_CONTEXT, type Context } from "@earendil-works/chord/context";
import type { HarnessInspection } from "@earendil-works/pi-durable";
import type { CompanyRuntime, RuntimeReport } from "./open.ts";

/** 一个被暂停（受阻）的任务。 */
export type ParkedTask = {
	readonly taskId: string;
	readonly taskKind: string;
	readonly conversationId: number;
	/** 受阻原因，目前只有「反复崩溃达到上限」。 */
	readonly reason: "restart-limit";
};

// ── 存活判定 ────────────────────────────────────────────────────────────────

/**
 * 任务「僵住」的原因。
 *
 * 这不是「跑得慢」，而是**永远不会自己往前走**——必须有人动手收尾，
 * 否则 `inspect()` 会永远把它算作「在忙」，后续派活全部排队。
 */
export type StuckReason =
	/** `waiting` 的任务，`on` 指向的子任务已经全部结束（或根本不在活任务里）。 */
	| "waiting-on-dead"
	/** `waiting` 的任务，子任务还在但全部受阻（缺定义 / 反复崩溃被暂停），等下去没有意义。 */
	| "waiting-on-blocked"
	/** 运行时间超过阈值（generation / tool 各有一套）。 */
	| "overdue"
	/** 自身受阻，需要人工或看门狗重试。 */
	| "blocked";

/** 一个任务的存活判定。 */
export type TaskLiveness = {
	readonly taskId: string;
	readonly taskKind: string;
	readonly conversationId: number;
	readonly status: "running" | "ready" | "waiting" | "sleeping" | "blocked" | "completing";
	/** 是否算「这个会话正在忙」。僵住的 waiting 不算。 */
	readonly busy: boolean;
	/** 是否僵住（永远不会自己往前走）。 */
	readonly stuck: boolean;
	readonly reason?: StuckReason;
	/** 从「本次观察起点」或 `startedAt` 起算的时长；两者都未知时为 0。 */
	readonly ageMs: number;
	/** waiting 时它等的任务。 */
	readonly waitingOn?: readonly string[];
	/** blocked 时的底层原因。 */
	readonly blockedReason?: string;
};

/** 存活判定选项。 */
export type LivenessOptions = {
	/** 一轮生成超过多久算超期。默认 600_000（10 分钟）。 */
	readonly generationOverdueMs?: number;
	/** 一次工具调用超过多久算超期。默认 300_000（5 分钟）。 */
	readonly toolOverdueMs?: number;
	/**
	 * 本次进程的启动时刻（毫秒）。默认 `-Infinity`（表示不区分进程）。
	 *
	 * 为什么需要它：`startedAt` 会跨重启保留（见底层 `TaskRecordBase.startedAt`），
	 * 崩溃恢复后的任务带着**上一次进程**的时间戳。如果直接拿 `now - startedAt` 判超期，
	 * 刚重启就会把「正在恢复」的任务全部误判成僵住并中断——那会打断真正的恢复。
	 *
	 * 规则：`startedAt` 早于本进程启动时刻 → 是上一个进程的遗留，超期从
	 * 「本进程看到它的时刻」（{@link observedAt}）起算；否则按真实 `startedAt` 算。
	 * 这样既不会误杀恢复中的任务，又能在稳态运行中如实判超期。
	 */
	readonly processStartedAt?: number;
	/**
	 * 每个任务「第一次被本次进程看到」的时刻（毫秒）。
	 *
	 * 只在 `startedAt` 早于 {@link processStartedAt}（上个进程的遗留）时作为起点。
	 */
	readonly observedAt?: ReadonlyMap<string, number>;
	/** 判定用的当前时刻，默认 `Date.now()`。测试可注入。 */
	readonly now?: number;
};

/** 一次巡检的存活视图。 */
export type Liveness = {
	readonly tasks: readonly TaskLiveness[];
	/** 真正在忙的会话（running / ready / 没僵住的 waiting）。 */
	readonly busyConversations: readonly number[];
	/** 僵住的任务。 */
	readonly stuckTasks: readonly TaskLiveness[];
	/** 原始巡检结果，调用方需要看提交队列时用。 */
	readonly inspection: HarnessInspection;
};

/**
 * 本进程的启动时刻（毫秒），模块加载时取一次。
 *
 * 用它把「本次进程创建的任务」和「上一次进程遗留的任务」分开：
 * 前者可以按真实 `startedAt` 判超期，后者必须从「本进程看到它」起算，
 * 否则崩溃恢复永远会把正在恢复的任务当成僵死并中断。
 */
export const PROCESS_STARTED_AT = Date.now();

/** 默认阈值：一轮生成 10 分钟。 */
export const GENERATION_OVERDUE_MS = 600_000;
/** 默认阈值：一次工具调用 5 分钟。 */
export const TOOL_OVERDUE_MS = 300_000;

/**
 * 判定哪些任务真的在跑、哪些已经僵住。
 *
 * 这是「界面永远正在忙」的正面修法。原先是三处各自手写
 * `state.kind === "running" || "ready" || "waiting"` 就算忙——于是
 * `waiting` 但等的东西早就结束了的任务会永远把会话钉在「在忙」。
 * 现在统一在这里判定，界面、派活、状态灯共用一套口径。
 */
export function inspectLivenessFrom(inspection: HarnessInspection, options: LivenessOptions = {}): Liveness {
	const now = options.now ?? Date.now();
	const generationOverdue = options.generationOverdueMs ?? GENERATION_OVERDUE_MS;
	const toolOverdue = options.toolOverdueMs ?? TOOL_OVERDUE_MS;

	const live = new Map<string, (typeof inspection.tasks)[number]>();
	for (const task of inspection.tasks) live.set(String(task.record.id), task);

	const tasks: TaskLiveness[] = [];
	const busyConversations = new Set<number>();
	const stuckTasks: TaskLiveness[] = [];

	for (const task of inspection.tasks) {
		const taskId = String(task.record.id);
		const conversationId = Number(task.record.conversationId);
		const state = task.state;
		// 超期起点：优先信本进程观察到的 startedAt；上个进程遗留的，从「看到它」起算。
		const processStart = options.processStartedAt ?? PROCESS_STARTED_AT;
		const startedAt = task.record.startedAt;
		const observed = options.observedAt?.get(taskId);
		let since: number;
		if (startedAt !== undefined && startedAt >= processStart) since = startedAt;
		else if (observed !== undefined) since = observed;
		else since = processStart;
		const ageMs = Math.max(0, now - since);

		const base = { taskId, taskKind: task.record.kind, conversationId, ageMs };
		let status: TaskLiveness["status"] = state.kind;
		let busy = false;
		let reason: StuckReason | undefined;
		let waitingOn: readonly string[] | undefined;
		let blockedReason: string | undefined;

		switch (state.kind) {
			case "running":
			case "ready":
				busy = true;
				break;
			case "waiting": {
				const children = state.on.map(String);
				waitingOn = children;
				const liveChildren = children.flatMap((id) => {
					const child = live.get(id);
					return child === undefined ? [] : [child];
				});
				if (children.length > 0 && liveChildren.length === 0) {
					// 等的子任务已经全部结束（或不在活任务里）→ 等不到任何东西了
					reason = "waiting-on-dead";
				} else if (liveChildren.length > 0 && liveChildren.every((child) => child.state.kind === "blocked")) {
					reason = "waiting-on-blocked";
				}
				// 僵住的 waiting 不算忙：它是「卡死」而不是「在跑」
				busy = reason === undefined;
				break;
			}
			case "sleeping":
				// 休眠等老板拍板可以跨天，本来就不占执行名额，也不算忙
				busy = false;
				break;
			case "blocked":
				reason = "blocked";
				blockedReason = state.reason;
				busy = false;
				break;
			case "completing":
				// 结果已定，等自己的活收尾；不再跑代码
				busy = false;
				break;
		}

		if (reason === undefined && (state.kind === "running" || state.kind === "waiting")) {
			const limit = task.record.kind === "pi.tool" ? toolOverdue : generationOverdue;
			if (ageMs >= limit) reason = "overdue";
		}

		const entry: TaskLiveness = {
			...base,
			status,
			busy,
			stuck: reason !== undefined,
			...(reason === undefined ? {} : { reason }),
			...(waitingOn === undefined ? {} : { waitingOn }),
			...(blockedReason === undefined ? {} : { blockedReason }),
		};
		tasks.push(entry);
		if (busy) busyConversations.add(conversationId);
		if (entry.stuck) stuckTasks.push(entry);
	}

	return {
		tasks,
		busyConversations: [...busyConversations].sort((a, b) => a - b),
		stuckTasks,
		inspection,
	};
}

/** 读一次巡检并做存活判定。 */
export async function inspectLiveness(
	runtime: CompanyRuntime,
	options: LivenessOptions = {},
	context: Context = BACKGROUND_CONTEXT,
): Promise<Liveness> {
	const inspection = await runtime.harness.inspect(context);
	return inspectLivenessFrom(inspection, options);
}

/** 某个会话是否真的在忙（僵住的 waiting 不算）。 */
export function isConversationBusy(liveness: Liveness, conversationId: number): boolean {
	return liveness.busyConversations.includes(conversationId);
}

/** 恢复结果。 */
export type RecoveryResult = {
	/** 打开时发现、已重新调度或仍待运行的任务数。 */
	readonly pendingTasks: number;
	/** 被暂停、需要人工干预的任务。 */
	readonly parkedTasks: readonly ParkedTask[];
	/** 打开时判定为僵住的任务（已经自动收尾或已重试）。 */
	readonly stuckTasks: readonly TaskLiveness[];
	/** 本次启动已经自动收尾（中断 / 重试）的任务标识。 */
	readonly recoveredTasks: readonly string[];
};

/** 恢复选项。 */
export type RecoveryOptions = {
	/** 是否对僵住任务自动调度恢复（默认 true；关掉只报告不动作）。 */
	readonly autoRecover?: boolean;
};

/**
 * 恢复运行时：先巡检（不执行任何处理器），再开启调度，然后收尾僵住的任务。
 *
 * 顺序很重要：`inspect()` 只读不跑代码，`resume()` 才开始调度。
 * 规格要求「恢复前不执行任何处理器」，所以必须先 inspect 后 resume。
 *
 * 为什么要自动收尾而不是只报告：真实事故里重启之后界面照样显示「正在忙」，
 * 因为僵住的 `waiting` 任务被原样恢复了；「报一个受阻任务列表等人点」等于
 * 把收尾责任推给老板。这里对**结构上已经不可能前进**的任务直接动手：
 * - 等的子任务全没了（`waiting-on-dead`）→ 中断它，让它写下中断结果；
 * - 子任务全受阻（`waiting-on-blocked`）→ 先重试受阻的那个；
 * - 自身因反复崩溃被暂停（`restart_limit`）→ 重试一次。
 *
 * 注意：启动时**不**按时间阈值判超期（见 {@link LivenessOptions.observedAt}）——
 * 崩溃恢复中的任务带着旧时间戳，按时间判会打断正常恢复。
 */
export async function recover(
	runtime: CompanyRuntime,
	context: Context = BACKGROUND_CONTEXT,
	options: RecoveryOptions = {},
): Promise<RecoveryResult> {
	const inspection = await runtime.harness.inspect(context);
	// 启动瞬间把「观察起点」定成现在：超期一律从这一刻起算，不继承旧 startedAt。
	const observedAt = new Map<string, number>();
	const bootAt = Date.now();
	for (const task of inspection.tasks) observedAt.set(String(task.record.id), bootAt);

	const liveness = inspectLivenessFrom(inspection, { observedAt, now: bootAt });

	const parkedTasks: ParkedTask[] = [];
	let pendingTasks = 0;

	for (const task of inspection.tasks) {
		const state = task.state;
		if (state.kind === "blocked" && state.reason === "restart_limit") {
			parkedTasks.push({
				taskId: String(task.record.id),
				taskKind: task.record.kind,
				conversationId: Number(task.record.conversationId),
				reason: "restart-limit",
			});
		} else if (state.kind === "ready" || state.kind === "running" || state.kind === "waiting") {
			pendingTasks += 1;
		}
	}

	// 巡检完成后再开调度。
	runtime.harness.resume();

	const recoveredTasks: string[] = [];
	// 启动时的超期判定只从 bootAt 起算，等于「刚看到」，所以这里只会命中结构性僵住。
	const structural = liveness.stuckTasks.filter((task) => task.reason !== "overdue");

	if (options.autoRecover !== false) {
		for (const task of structural) {
			try {
				if (task.reason === "waiting-on-blocked") {
					// 先救子任务：重试受阻的那个，父任务自然继续
					const child = await firstBlockedChild(runtime, task, context);
					if (child !== undefined) {
						await runtime.harness.retryTask(child as never, context);
						recoveredTasks.push(String(child));
						continue;
					}
				}
				// 自身受阻（restart_limit）→ 重试；其余僵住 → 中断，让它写下中断结果
				if (task.reason === "blocked") {
					await runtime.harness.retryTask(task.taskId as never, context);
				} else {
					await runtime.harness.abortTask(task.taskId as never, context);
				}
				recoveredTasks.push(task.taskId);
			} catch {
				// 收尾失败不影响启动：任务仍在，下一轮看门狗会再试
			}
		}
	}

	return { pendingTasks, parkedTasks, stuckTasks: liveness.stuckTasks, recoveredTasks };
}

/** 找 waiting 任务里第一个受阻的子任务（用于先救子任务）。 */
async function firstBlockedChild(
	runtime: CompanyRuntime,
	task: TaskLiveness,
	context: Context,
): Promise<string | undefined> {
	const inspection = await runtime.harness.inspect(context);
	const blocked = new Set(
		inspection.tasks.filter((entry) => entry.state.kind === "blocked").map((entry) => String(entry.record.id)),
	);
	for (const id of task.waitingOn ?? []) {
		if (blocked.has(id)) return id;
	}
	return undefined;
}

/** 重试一个被暂停的任务。 */
export async function retryParked(
	runtime: CompanyRuntime,
	taskId: string,
	context: Context = BACKGROUND_CONTEXT,
): Promise<void> {
	await runtime.harness.retryTask(Number(taskId) as never, context);
}

/** 自愈配置。 */
export type SelfHealingOptions = {
	/** 重开失败后是否继续重试。 */
	readonly keepRetrying?: boolean;
	/** 两次重开之间的等待毫秒数。 */
	readonly retryDelayMs?: number;
	/** 每次重开后执行的恢复动作。 */
	readonly onReopen?: (runtime: CompanyRuntime) => Promise<void> | void;
	/** 报告。 */
	readonly onReport?: (report: RuntimeReport) => void;
};

/**
 * 监听运行时关闭，因故障关闭时自动重开。
 *
 * 存储错误是致命的：一次失败整个运行时自我关闭，不重试（底层设计如此）。
 * 宿主必须自己重开，并依靠语义化请求标识让重复投递被去重。
 *
 * @returns 停止监听的函数
 */
export function watchForFailure(
	runtime: CompanyRuntime,
	reopen: () => Promise<CompanyRuntime>,
	options: SelfHealingOptions = {},
): () => void {
	let stopped = false;
	const delay = options.retryDelayMs ?? 500;

	const run = async (): Promise<void> => {
		const end = await runtime.harness.closed;
		if (stopped) return;
		if (end.reason !== "failed") return;

		options.onReport?.({ kind: "runtime-failed", error: end.error });

		while (!stopped) {
			try {
				const next = await reopen();
				await options.onReopen?.(next);
				return;
			} catch (error) {
				options.onReport?.({ kind: "other", error });
				if (options.keepRetrying === false) return;
				await new Promise((resolve) => setTimeout(resolve, delay));
			}
		}
	};

	void run();

	return () => {
		stopped = true;
	};
}

/** 等待运行时彻底空闲（所有普通归属范围的任务结束）。 */
export async function waitForIdle(runtime: CompanyRuntime, context: Context = BACKGROUND_CONTEXT): Promise<void> {
	await runtime.harness.waitForIdle(context);
}

/** 底层 harness 的只读诊断视图：活跃任务与未结算提交。 */
export async function inspect(runtime: CompanyRuntime, context: Context = BACKGROUND_CONTEXT) {
	return runtime.harness.inspect(context);
}

/** 判断运行时是否已因故障失效。 */
export function hasFailed(runtime: CompanyRuntime): boolean {
	return runtime.failure() !== undefined;
}

