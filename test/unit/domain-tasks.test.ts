/**
 * 任务领域逻辑（纯函数，无数据库）。
 *
 * 覆盖 `docs/design/COMMS-REFACTOR.md` §2.2 / §5.2：
 * 「真任务」的三条硬校验、状态机、完成必上报的判定、看板视图、超期提醒。
 */
import { describe, expect, test } from "vitest";
import {
	boardOf,
	canTransition,
	createTask,
	emptyTaskState,
	isTerminal,
	needsReport,
	openTasks,
	staleTasks,
	tasksOfAssignee,
	transitionTask,
	validateCreate,
	type CreateInput,
	type TaskState,
} from "../../src/domain/tasks.ts";

const BASE: CreateInput = {
	project: "alpha",
	channelId: "proj:alpha",
	title: "登录接口加 token 过期处理",
	brief: "过期后返回 401",
	acceptance: "返回 401 且带 WWW-Authenticate 头，有单测覆盖",
	assignee: 20,
	assignedBy: 10,
};

/** 建一个测试任务。 */
function setup(input: Partial<CreateInput> = {}): { state: TaskState; id: string } {
	const created = createTask(emptyTaskState(), { ...BASE, ...input, at: 1000 });
	return { state: created.state, id: created.task.id };
}

describe("「真任务」的三条硬校验", () => {
	test("验收标准为空 → 拒绝，且报错告诉调用方该怎么做", () => {
		const result = validateCreate({ ...BASE, acceptance: "" });
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.code).toBe("no-acceptance");
		// 报错必须可操作：模型看到才知道改用 say
		expect(result.message).toContain("say");
		expect(result.message).toContain("验收标准");
	});

	test("只有空白也算空", () => {
		expect(validateCreate({ ...BASE, acceptance: "   \n  " }).ok).toBe(false);
	});

	test("没有唯一负责人 → 拒绝", () => {
		const result = validateCreate({ ...BASE, assignee: 0 });
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.code).toBe("no-assignee");
	});

	test("没有项目 → 拒绝", () => {
		const result = validateCreate({ ...BASE, project: "" });
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.code).toBe("no-project");
	});

	test("标题为空 → 拒绝", () => {
		const result = validateCreate({ ...BASE, title: " " });
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.code).toBe("empty-title");
	});

	test("依赖不存在的任务 → 拒绝", () => {
		const result = validateCreate({ ...BASE, dependsOn: ["T-999"] });
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.code).toBe("unknown-dependency");
	});

	test("三条都满足 → 通过", () => {
		expect(validateCreate(BASE).ok).toBe(true);
	});
});

describe("创建", () => {
	test("编号从 T-1 开始单调递增", () => {
		const first = createTask(emptyTaskState(), { ...BASE, at: 1 });
		expect(first.task.id).toBe("T-1");
		const second = createTask(first.state, { ...BASE, at: 2 });
		expect(second.task.id).toBe("T-2");
	});

	test("初始状态是 todo，且没有 startedAt", () => {
		const { state, id } = setup();
		const task = state.tasks[id];
		expect(task?.status).toBe("todo");
		expect(task?.startedAt).toBeUndefined();
	});

	test("校验失败时抛错（不静默创建半个任务）", () => {
		expect(() => createTask(emptyTaskState(), { ...BASE, acceptance: "" })).toThrow(/验收标准/);
	});
});

describe("状态机", () => {
	test("只接受显式边", () => {
		expect(canTransition("todo", "doing")).toBe(true);
		expect(canTransition("doing", "review")).toBe(true);
		expect(canTransition("review", "done")).toBe(true);
		// 跳跃不允许
		expect(canTransition("todo", "done")).toBe(false);
		expect(canTransition("todo", "review")).toBe(false);
		// 终态
		expect(canTransition("done", "doing")).toBe(false);
		expect(canTransition("cancelled", "doing")).toBe(false);
		// blocked 只能回 doing
		expect(canTransition("blocked", "doing")).toBe(true);
		expect(canTransition("blocked", "done")).toBe(false);
	});

	test("同状态幂等（无 note 时状态对象不变）", () => {
		const { state, id } = setup();
		const result = transitionTask(state, id, "todo");
		expect(result.ok).toBe(true);
		expect(result.ok && result.state).toBe(state);
	});

	test("非法迁移返回可读原因", () => {
		const { state, id } = setup();
		const result = transitionTask(state, id, "done");
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.code).toBe("illegal");
			expect(result.message).toContain("todo");
			expect(result.message).toContain("doing");
		}
	});

	test("任务不存在返回 not-found", () => {
		const result = transitionTask(emptyTaskState(), "T-9", "doing");
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.code).toBe("not-found");
	});

	test("进入 doing 记 startedAt，进入 done 记 doneAt", () => {
		const { state, id } = setup();
		const doing = transitionTask(state, id, "doing", { at: 2000 });
		expect(doing.ok && doing.task.startedAt).toBe(2000);
		const done = transitionTask(doing.ok ? doing.state : state, id, "done", { at: 3000, evidence: "npm test 全绿" });
		expect(done.ok && done.task.doneAt).toBe(3000);
		expect(done.ok && done.task.evidence).toBe("npm test 全绿");
	});

	test("进入 blocked 必须有原因（缺省给一句话）", () => {
		const { state, id } = setup();
		const doing = transitionTask(state, id, "doing");
		const blocked = transitionTask(doing.ok ? doing.state : state, id, "blocked");
		expect(blocked.ok && blocked.task.blockedReason).toBe("（未说明原因）");
	});

	test("离开 blocked 时清掉原因", () => {
		const { state, id } = setup();
		const doing = transitionTask(state, id, "doing");
		const blocked = transitionTask(doing.ok ? doing.state : state, id, "blocked", { blockedReason: "等接口" });
		const back = transitionTask(blocked.ok ? blocked.state : state, id, "doing");
		expect(back.ok && back.task.blockedReason).toBeUndefined();
	});

	test("progress 只追加，不覆盖", () => {
		const { state, id } = setup();
		const first = transitionTask(state, id, "doing", { note: "开始做", by: 20, at: 2000 });
		const second = transitionTask(first.ok ? first.state : state, id, "doing", { note: "写完一半", by: 20, at: 3000 });
		expect(second.ok && second.task.progress.map((note) => note.text)).toEqual(["开始做", "写完一半"]);
	});

	test("JSON 往返后结构稳定（undefined 被清掉）", () => {
		const { state, id } = setup();
		const doing = transitionTask(state, id, "doing", { at: 2000 });
		const task = doing.ok ? doing.task : undefined;
		const roundTrip = JSON.parse(JSON.stringify(task));
		expect(roundTrip).toEqual(task);
		expect(Object.keys(roundTrip)).not.toContain("evidence");
	});
});

describe("完成必上报（结构保证）", () => {
	test("done / blocked / review 需要通知下达人", () => {
		expect(needsReport("done")).toBe(true);
		expect(needsReport("blocked")).toBe(true);
		expect(needsReport("review")).toBe(true);
	});

	test("todo / doing / cancelled 不需要", () => {
		expect(needsReport("todo")).toBe(false);
		expect(needsReport("doing")).toBe(false);
		expect(needsReport("cancelled")).toBe(false);
	});

	test("终态判定", () => {
		expect(isTerminal("done")).toBe(true);
		expect(isTerminal("cancelled")).toBe(true);
		expect(isTerminal("doing")).toBe(false);
	});
});

describe("查询与看板", () => {
	test("按项目、按负责人过滤", () => {
		let state = emptyTaskState();
		const a = createTask(state, { ...BASE, at: 1 });
		state = a.state;
		const b = createTask(state, { ...BASE, project: "beta", assignee: 21, at: 2 });
		state = b.state;

		expect(tasksOfAssignee(state, 20).map((task) => task.id)).toEqual(["T-1"]);
		const board = boardOf(state, { project: "beta" });
		expect(board.columns.todo.map((card) => card.id)).toEqual(["T-2"]);
	});

	test("未完成任务不含终态", () => {
		const { state, id } = setup();
		const doing = transitionTask(state, id, "doing");
		const done = transitionTask(doing.ok ? doing.state : state, id, "done");
		expect(openTasks(done.ok ? done.state : state)).toEqual([]);
	});

	test("看板四列 + blocked 单独给", () => {
		let state = emptyTaskState();
		const ids: string[] = [];
		for (let i = 0; i < 4; i += 1) {
			const created = createTask(state, { ...BASE, title: `任务 ${i}`, at: i });
			state = created.state;
			ids.push(created.task.id);
		}
		state = (transitionTask(state, ids[0] as string, "doing") as { state: TaskState }).state;
		state = (transitionTask(state, ids[1] as string, "doing") as { state: TaskState }).state;
		state = (transitionTask(state, ids[1] as string, "blocked", { blockedReason: "等接口" }) as { state: TaskState }).state;
		state = (transitionTask(state, ids[2] as string, "doing") as { state: TaskState }).state;
		state = (transitionTask(state, ids[2] as string, "review") as { state: TaskState }).state;

		const board = boardOf(state);
		expect(board.columns.todo.map((c) => c.id)).toEqual([ids[3]]);
		expect(board.columns.doing.map((c) => c.id)).toEqual([ids[0]]);
		expect(board.columns.review.map((c) => c.id)).toEqual([ids[2]]);
		expect(board.blocked.map((c) => c.id)).toEqual([ids[1]]);
		expect(board.blocked[0]?.blockedReason).toBe("等接口");
	});

	test("依赖未完成时卡片显示 waitingFor", () => {
		let state = emptyTaskState();
		const first = createTask(state, { ...BASE, at: 1 });
		state = first.state;
		const second = createTask(state, { ...BASE, title: "第二件", dependsOn: [first.task.id], at: 2 });
		state = second.state;

		const board = boardOf(state);
		const card = board.columns.todo.find((entry) => entry.id === second.task.id);
		expect(card?.waitingFor).toEqual([first.task.id]);

		// 依赖完成后不再等待
		state = (transitionTask(state, first.task.id, "doing") as { state: TaskState }).state;
		state = (transitionTask(state, first.task.id, "done") as { state: TaskState }).state;
		expect(boardOf(state).columns.todo.find((entry) => entry.id === second.task.id)?.waitingFor).toEqual([]);
	});

	test("done 列有上限，避免历史撑爆看板", () => {
		let state = emptyTaskState();
		for (let i = 0; i < 30; i += 1) {
			const created = createTask(state, { ...BASE, title: `任务 ${i}`, at: i });
			state = created.state;
			state = (transitionTask(state, created.task.id, "doing") as { state: TaskState }).state;
			state = (transitionTask(state, created.task.id, "done") as { state: TaskState }).state;
		}
		expect(boardOf(state, { limitDone: 5 }).columns.done.length).toBe(5);
	});
});

describe("超期提醒", () => {
	test("blocked 太久 → blocked-too-long", () => {
		let state = emptyTaskState();
		const created = createTask(state, { ...BASE, at: 0 });
		state = created.state;
		state = (transitionTask(state, created.task.id, "doing", { at: 0 }) as { state: TaskState }).state;
		state = (transitionTask(state, created.task.id, "blocked", { at: 0, blockedReason: "等接口" }) as { state: TaskState }).state;

		const stale = staleTasks(state, 2 * 60 * 60_000);
		expect(stale.length).toBe(1);
		expect(stale[0]?.reason).toBe("blocked-too-long");
	});

	test("doing 长时间没进度 → no-progress", () => {
		let state = emptyTaskState();
		const created = createTask(state, { ...BASE, at: 0 });
		state = created.state;
		state = (transitionTask(state, created.task.id, "doing", { at: 0 }) as { state: TaskState }).state;

		expect(staleTasks(state, 30 * 60_000)).toEqual([]); // 30 分钟不算
		const stale = staleTasks(state, 2 * 60 * 60_000);
		expect(stale[0]?.reason).toBe("no-progress");
	});

	test("终态不提醒", () => {
		let state = emptyTaskState();
		const created = createTask(state, { ...BASE, at: 0 });
		state = created.state;
		state = (transitionTask(state, created.task.id, "doing", { at: 0 }) as { state: TaskState }).state;
		state = (transitionTask(state, created.task.id, "done", { at: 0 }) as { state: TaskState }).state;
		expect(staleTasks(state, 99 * 60 * 60_000)).toEqual([]);
	});
});
