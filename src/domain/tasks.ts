/**
 * 任务：工作的容器（纯数据 + 纯函数，无 IO）。
 *
 * 设计见 `docs/design/COMMS-REFACTOR.md` §2.2。核心约束：
 *
 * **只有「真任务」才进这里。** 判据是三条硬校验（`validateCreate`）：
 * 1. 有验收标准（`acceptance` 非空）—— 没有验收标准的指派是聊天，不是任务
 * 2. 有唯一负责人（`assignee` 是一个具体的人，不是「团队」）
 * 3. 属于某个项目（`project` 非空）
 *
 * 为什么这么严：看板一旦混进「谁在忙」这种运行时推导出来的卡片，它就变成了
 * 状态监视器，不再能回答「这件事做完了没有」。老板要的是后者。
 *
 * 状态机只接受显式边（见 `TRANSITIONS`），拒绝跳跃，防止「从 todo 直接 done」
 * 这种没有过程的完成。
 */

/** 任务状态。 */
export const TASK_STATUSES = ["todo", "doing", "blocked", "review", "done", "cancelled"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

/** 优先级。 */
export const TASK_PRIORITIES = ["low", "normal", "high"] as const;
export type TaskPriority = (typeof TASK_PRIORITIES)[number];

/** 一条进度记录。 */
export type TaskProgressNote = {
	at: number;
	text: string;
	/** 记这条的会话（0 = 老板，-1 = 系统）。 */
	by: number;
};

/** 一个任务。 */
/**
 * 一个任务。
 *
 * 字段不用 `readonly`：底层 `JsonObject` 要求可变结构（见 `domain/channels.ts`
 * 的同款说明）。不可变性由纯函数「每次返回新对象」保证。
 */
export type TaskEntry = {
	id: string;
	project: string;
	/** 讨论在哪个频道进行。 */
	channelId: string;
	title: string;
	brief: string;
	/** 验收标准。**必填**，空的不是任务。 */
	acceptance: string;
	/** 唯一负责人。 */
	assignee: number;
	/** 下达人（0 = 老板，-1 = 系统）。 */
	assignedBy: number;
	status: TaskStatus;
	priority: TaskPriority;
	createdAt: number;
	startedAt?: number;
	doneAt?: number;
	/** 完成证据：文件路径 / 测试输出 / 提交号。 */
	evidence?: string;
	blockedReason?: string;
	/** 依赖的任务标识（用于看板显示阻塞关系，不参与调度）。 */
	dependsOn: string[];
	progress: TaskProgressNote[];
};

/** 任务文档。 */
export type TaskState = {
	tasks: Record<string, TaskEntry>;
	/** 下一个任务号（单调递增，不复用）。 */
	nextId: number;
};

/** 空文档。 */
export function emptyTaskState(): TaskState {
	return { tasks: {}, nextId: 1 };
}

// ── 状态机 ──────────────────────────────────────────────────────────────────

/**
 * 允许的状态迁移。
 *
 * 刻意不做成「任意 → 任意」：
 * - `todo → done` 不允许：没有 doing/review 的完成是假的
 * - `done` / `cancelled` 是终态
 * - `blocked` 只能回到 `doing`（阻塞解除后继续，而不是跳去完成）
 */
export const TRANSITIONS: Readonly<Record<TaskStatus, readonly TaskStatus[]>> = {
	todo: ["doing", "cancelled"],
	doing: ["blocked", "review", "done", "cancelled"],
	blocked: ["doing", "cancelled"],
	review: ["doing", "done", "cancelled"],
	done: [],
	cancelled: [],
};

/** 这个迁移合不合法。 */
export function canTransition(from: TaskStatus, to: TaskStatus): boolean {
	if (from === to) return true; // 幂等
	return TRANSITIONS[from].includes(to);
}

/** 终态判定。 */
export function isTerminal(status: TaskStatus): boolean {
	return status === "done" || status === "cancelled";
}

/**
 * 这个状态变化是否需要**通知下达人**。
 *
 * 这是「做完不上报」的结构保证：只要状态落到这三态之一，调用方（tasks.ts 的 IO 层）
 * 就必须写一条 report 到频道并投递给 `assignedBy`。三个入口（模型调工具、看门狗、
 * 项目终止）都走同一个 `transitionTask`，所以不存在「忘了上报」的路径。
 */
export function needsReport(to: TaskStatus): boolean {
	return to === "done" || to === "blocked" || to === "review";
}

// ── 校验 ────────────────────────────────────────────────────────────────────

/** 建任务的输入。 */
export type CreateInput = {
	readonly project: string;
	readonly channelId: string;
	readonly title: string;
	readonly brief: string;
	readonly acceptance: string;
	readonly assignee: number;
	readonly assignedBy: number;
	readonly priority?: TaskPriority;
	readonly dependsOn?: readonly string[];
	readonly at?: number;
};

/** 校验结果。 */
export type Validation =
	| { readonly ok: true }
	| { readonly ok: false; readonly code: "no-acceptance" | "no-assignee" | "no-project" | "empty-title" | "unknown-dependency"; readonly message: string };

/**
 * 校验「这是不是一个真任务」。
 *
 * 三条硬性要求（老板 2026-10-26 拍板）：验收标准、唯一负责人、所属项目。
 * 不满足时的报错必须**告诉调用方该怎么做**——模型看到「请改用 say」才会改行为。
 */
export function validateCreate(input: CreateInput, known: Readonly<Record<string, TaskEntry>> = {}): Validation {
	if (input.title.trim() === "") {
		return { ok: false, code: "empty-title", message: "任务必须有标题。" };
	}
	if (input.project.trim() === "") {
		return {
			ok: false,
			code: "no-project",
			message: "任务必须属于某个项目（project 不能为空）。跨项目的协调请用 say 在领导层群讨论。",
		};
	}
	if (!Number.isFinite(input.assignee) || input.assignee <= 0) {
		return {
			ok: false,
			code: "no-assignee",
			message: "任务必须有唯一负责人（assignee 是一个具体的人）。指派给「团队」不是任务，请用 say。",
		};
	}
	if (input.acceptance.trim() === "") {
		return {
			ok: false,
			code: "no-acceptance",
			message: [
				"任务必须有验收标准（acceptance 不能为空）。",
				"没有验收标准的指派是聊天，不是任务——请在项目群里用 say 说清楚，或者补上验收标准再来。",
				"好的验收标准长这样：「登录接口在 token 过期时返回 401 且带 WWW-Authenticate 头，有单测覆盖」。",
			].join(""),
		};
	}
	for (const id of input.dependsOn ?? []) {
		if (known[id] === undefined) {
			return { ok: false, code: "unknown-dependency", message: `依赖的任务不存在：${id}` };
		}
	}
	return { ok: true };
}

// ── 创建与迁移 ──────────────────────────────────────────────────────────────

/** 任务标识前缀。 */
const TASK_PREFIX = "T-";

/** 建任务。校验失败会抛错（调用方应先调 `validateCreate` 给出可读提示）。 */
export function createTask(
	state: TaskState,
	input: CreateInput,
): { readonly state: TaskState; readonly task: TaskEntry } {
	const check = validateCreate(input, state.tasks);
	if (!check.ok) throw new Error(check.message);

	const id = `${TASK_PREFIX}${state.nextId}`;
	const task: TaskEntry = {
		id,
		project: input.project,
		channelId: input.channelId,
		title: input.title.trim(),
		brief: input.brief,
		acceptance: input.acceptance.trim(),
		assignee: input.assignee,
		assignedBy: input.assignedBy,
		status: "todo",
		priority: input.priority ?? "normal",
		createdAt: input.at ?? Date.now(),
		dependsOn: [...(input.dependsOn ?? [])],
		progress: [],
	};
	return {
		state: { nextId: state.nextId + 1, tasks: { ...state.tasks, [id]: task } },
		task,
	};
}

/** 状态迁移的补丁。 */
export type TransitionPatch = {
	readonly evidence?: string;
	readonly blockedReason?: string;
	readonly note?: string;
	/** 记这条的会话。 */
	readonly by?: number;
	readonly at?: number;
};

/** 迁移结果。 */
export type TransitionResult =
	| { readonly ok: true; readonly state: TaskState; readonly task: TaskEntry }
	| { readonly ok: false; readonly code: "not-found" | "illegal"; readonly message: string };

/**
 * 状态迁移。
 *
 * 只改状态、写 progress 与终态字段，**不做 IO**。写频道消息、投递通知
 * 是 IO 层（`company/tasks.ts`）的职责——但那一层只能调用本函数，
 * 所以「状态变了但没上报」在结构上不可能。
 */
export function transitionTask(
	state: TaskState,
	id: string,
	to: TaskStatus,
	patch: TransitionPatch = {},
): TransitionResult {
	const current = state.tasks[id];
	if (current === undefined) return { ok: false, code: "not-found", message: `任务不存在：${id}` };
	if (!canTransition(current.status, to)) {
		return {
			ok: false,
			code: "illegal",
			message: `任务 ${id} 不能从 ${current.status} 变成 ${to}。允许的下一步：${TRANSITIONS[current.status].join(" / ") || "（终态，不能再改）"}`,
		};
	}
	if (current.status === to && patch.note === undefined) {
		// 幂等：同状态且无新内容。
		//
		// 返回**浅拷贝**而不是 `current` 本身：调用方可能把 `state` 来自底层文档的
		// 可写 overlay（`tx.doc()` 的 Draft），而 overlay 在 commit 结束后会被 settle，
		// 之后任何属性访问都抛「Cannot use a settled overlay」。拷贝是纯函数该有的行为。
		return { ok: true, state, task: { ...current } };
	}

	const at = patch.at ?? Date.now();
	const note: TaskProgressNote | undefined =
		patch.note === undefined ? undefined : { at, text: patch.note, by: patch.by ?? -1 };

	const next: TaskEntry = {
		...current,
		status: to,
		...(current.startedAt === undefined && to !== "todo" ? { startedAt: at } : {}),
		...(to === "done" ? { doneAt: at } : {}),
		...(patch.evidence === undefined ? {} : { evidence: patch.evidence }),
		// 离开 blocked 时清掉原因；进入 blocked 时必须有原因（缺省给一句话）
		...(to === "blocked" ? { blockedReason: patch.blockedReason ?? "（未说明原因）" } : {}),
		...(to === "blocked" || current.blockedReason === undefined
			? {}
			: { blockedReason: undefined as never }),
		progress: note === undefined ? current.progress : [...current.progress, note],
	};
	// 清理 undefined 字段，保证 JSON 往返后结构稳定（底层文档要求严格 JSON）
	const cleaned = stripUndefined(next) as TaskEntry;

	return { ok: true, state: { ...state, tasks: { ...state.tasks, [id]: cleaned } }, task: cleaned };
}

/** 递归去掉 undefined（`JsonObject` 不接受 undefined，往返后会消失造成结构差异）。 */
function stripUndefined<T>(value: T): T {
	if (Array.isArray(value)) return value.map((item) => stripUndefined(item)) as never;
	if (value !== null && typeof value === "object") {
		const out: Record<string, unknown> = {};
		for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
			if (entry !== undefined) out[key] = stripUndefined(entry);
		}
		return out as T;
	}
	return value;
}

// ── 查询 ────────────────────────────────────────────────────────────────────

/** 按项目过滤（看板用）。 */
export function tasksOfProject(state: TaskState, project: string): readonly TaskEntry[] {
	return Object.values(state.tasks)
		.filter((task) => task.project === project)
		.sort(byPriorityThenAge);
}

/** 某人的任务。 */
export function tasksOfAssignee(state: TaskState, conversationId: number): readonly TaskEntry[] {
	return Object.values(state.tasks)
		.filter((task) => task.assignee === conversationId)
		.sort(byPriorityThenAge);
}

/** 某人下达的任务。 */
export function tasksOfAssigner(state: TaskState, conversationId: number): readonly TaskEntry[] {
	return Object.values(state.tasks)
		.filter((task) => task.assignedBy === conversationId)
		.sort(byPriorityThenAge);
}

/** 未完成的任务。 */
export function openTasks(state: TaskState): readonly TaskEntry[] {
	return Object.values(state.tasks).filter((task) => !isTerminal(task.status)).sort(byPriorityThenAge);
}

/** 排序：优先级高的在前，同优先级按创建时间早的在前。 */
function byPriorityThenAge(left: TaskEntry, right: TaskEntry): number {
	const rank = { high: 0, normal: 1, low: 2 } as const;
	return rank[left.priority] - rank[right.priority] || left.createdAt - right.createdAt;
}

/** 看板四列。 */
export const BOARD_COLUMNS = ["todo", "doing", "review", "done"] as const;
export type BoardColumnId = (typeof BOARD_COLUMNS)[number];

/** 一条看板卡片。 */
export type BoardCard = {
	readonly id: string;
	readonly title: string;
	readonly project: string;
	readonly status: TaskStatus;
	readonly assignee: number;
	readonly priority: TaskPriority;
	readonly acceptance: string;
	readonly createdAt: number;
	readonly updatedAt: number;
	readonly evidence?: string;
	readonly blockedReason?: string;
	readonly dependsOn: readonly string[];
	/** 被依赖且未完成 → 卡片显示「等待 T-x」。 */
	readonly waitingFor: readonly string[];
};

/**
 * 看板视图。
 *
 * **只读 TaskDoc**。不再从「谁在忙」推导卡片——那是运行时状态，不是任务。
 * `blocked` 不进四列（它不是「在做」，是「卡住了」），单独由 `blocked` 数组给。
 */
export function boardOf(
	state: TaskState,
	options: { readonly project?: string; readonly limitDone?: number } = {},
): { readonly columns: Readonly<Record<BoardColumnId, readonly BoardCard[]>>; readonly blocked: readonly BoardCard[] } {
	const limitDone = options.limitDone ?? 20;
	const all = Object.values(state.tasks).filter(
		(task) => options.project === undefined || task.project === options.project,
	);
	const byId = new Map(all.map((task) => [task.id, task]));

	const card = (task: TaskEntry): BoardCard => ({
		id: task.id,
		title: task.title,
		project: task.project,
		status: task.status,
		assignee: task.assignee,
		priority: task.priority,
		acceptance: task.acceptance,
		createdAt: task.createdAt,
		updatedAt: task.progress.at(-1)?.at ?? task.doneAt ?? task.startedAt ?? task.createdAt,
		...(task.evidence === undefined ? {} : { evidence: task.evidence }),
		...(task.blockedReason === undefined ? {} : { blockedReason: task.blockedReason }),
		dependsOn: task.dependsOn,
		waitingFor: task.dependsOn.filter((id) => {
			const dep = byId.get(id);
			return dep !== undefined && !isTerminal(dep.status);
		}),
	});

	const columns = {} as Record<BoardColumnId, BoardCard[]>;
	for (const column of BOARD_COLUMNS) {
		const items = all.filter((task) => task.status === column).sort(byPriorityThenAge).map(card);
		// done 只留最近 N 条，避免历史把看板撑爆
		columns[column] = column === "done" ? items.slice(0, limitDone) : items;
	}
	return {
		columns,
		blocked: all.filter((task) => task.status === "blocked").sort(byPriorityThenAge).map(card),
	};
}

// ── 提醒判定（看门狗用） ────────────────────────────────────────────────────

/** 任务多久没有任何进度算「该催一下」。 */
export const STALE_TASK_MS = 60 * 60_000;

/**
 * 需要提醒的任务。
 *
 * 两种：
 * - `blocked` 超过 `blockedMs`：卡住的事没人管
 * - `doing` 超过 `staleMs` 且没有新进度：可能在空转
 *
 * 纯函数，看门狗直接消费。返回原因供告警文案使用。
 */
export function staleTasks(
	state: TaskState,
	now: number,
	options: { readonly blockedMs?: number; readonly staleMs?: number } = {},
): readonly { readonly task: TaskEntry; readonly reason: "blocked-too-long" | "no-progress" }[] {
	const blockedMs = options.blockedMs ?? 60 * 60_000;
	const staleMs = options.staleMs ?? STALE_TASK_MS;
	const out: { task: TaskEntry; reason: "blocked-too-long" | "no-progress" }[] = [];
	for (const task of Object.values(state.tasks)) {
		if (isTerminal(task.status)) continue;
		const last = task.progress.at(-1)?.at ?? task.startedAt ?? task.createdAt;
		const age = now - last;
		if (task.status === "blocked" && age >= blockedMs) out.push({ task, reason: "blocked-too-long" });
		else if (task.status === "doing" && age >= staleMs) out.push({ task, reason: "no-progress" });
	}
	return out;
}
