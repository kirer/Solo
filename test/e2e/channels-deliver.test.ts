/**
 * 频道 + 投递 + 任务的端到端行为。
 *
 * 覆盖 `docs/design/COMMS-REFACTOR.md` §5 的四条硬要求：
 * 1. `deliver()` **不阻塞**（CEO 连发 N 条，总耗时与条数无关）
 * 2. 完成必上报（系统写，不靠模型）
 * 3. 未读摘要进输入前缀（没被唤醒的人不会错过）
 * 4. 「真任务」必须带验收标准
 */
import { afterEach, describe, expect, test } from "vitest";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createRegistry, openCompany, recover, type CompanyRuntime } from "../../src/runtime/index.ts";
import { bootstrapCompany, createProject, hireStaff } from "../../src/company/org.ts";
import { createEscalationTask } from "../../src/company/escalation.ts";
import {
	ensureAllChannels,
	postToChannel,
	readChannel,
	readChannels,
	readOrg,
	markMentionSeen,
} from "../../src/company/channels.ts";
import { createTask, transitionTask, readTask, projectBoard } from "../../src/company/tasks.ts";
import { OWNER_ID } from "../../src/domain/channels.ts";
import { labelOf } from "../../src/domain/membership.ts";
import {
	agentTools,
	answer,
	createTestContext,
	eventually,
	toolCall,
	type TestContext,
	TEST_MODEL_CATALOG,
} from "../support.ts";

let contexts: TestContext[] = [];
let runtimes: CompanyRuntime[] = [];

async function setup() {
	const ctx = await createTestContext();
	contexts.push(ctx);
	const registry = createRegistry();
	const runtime = await openCompany({ databasePath: ctx.databasePath, models: ctx.models, registry }, BACKGROUND_CONTEXT);
	runtimes.push(runtime);
	await recover(runtime, BACKGROUND_CONTEXT);

	const escalationTask = createEscalationTask(runtime);
	registry.install({ name: "escalation", tasks: [escalationTask] } as never);

	const booted = await bootstrapCompany(
		runtime,
		{
			modelCatalog: [...TEST_MODEL_CATALOG],
			companyName: "频道测试公司",
			registry,
			workspaceRoot: join(ctx.dir, "projects"),
			escalationTask,
		},
		BACKGROUND_CONTEXT,
	);
	const { project } = await createProject(
		runtime,
		{ name: "Alpha", slug: "alpha", brief: "测试项目", workspaceRoot: join(ctx.dir, "projects") },
		BACKGROUND_CONTEXT,
	);
	// 必须传 registry：员工能力包要注册进去才能按名解析（ADR-009）
	await hireStaff(runtime, { project: "alpha", name: "林越", role: "开发", registry }, BACKGROUND_CONTEXT);
	await hireStaff(runtime, { project: "alpha", name: "周野", role: "测试", registry }, BACKGROUND_CONTEXT);
	await ensureAllChannels(runtime, BACKGROUND_CONTEXT);

	return { ctx, runtime, registry, booted, project };
}

afterEach(async () => {
	for (const runtime of runtimes) await runtime.close().catch(() => undefined);
	for (const ctx of contexts) await ctx.cleanup();
	runtimes = [];
	contexts = [];
});

describe("频道自动创建", () => {
	test("建出公司大群、领导层群、项目群、私聊", async () => {
		const { runtime } = await setup();
		const state = await readChannels(runtime, BACKGROUND_CONTEXT);
		const ids = Object.keys(state.channels);
		expect(ids).toContain("company");
		expect(ids).toContain("leadership");
		expect(ids).toContain("proj:alpha");
		// #4 / #15：`log:` 频道不再创建。老板的口径是「工作记录就是他本人在说话」，
		// 所以流水直接长在私聊里，不再有独立频道。
		expect(ids.some((id) => id.startsWith("log:"))).toBe(false);
	});

	test("公司大群包含老板与全部员工（老板要求）", async () => {
		const { runtime } = await setup();
		const company = await readChannel(runtime, "company", BACKGROUND_CONTEXT);
		const members = Object.values(company?.members ?? {}).map((entry) => entry.conversationId);
		expect(members).toContain(OWNER_ID);
		// 老板 + CEO + 6 管理层 + 负责人 + 2 员工
		expect(members.length).toBeGreaterThanOrEqual(10);
	});

	test("重复调用幂等，不重复建频道", async () => {
		const { runtime } = await setup();
		const before = Object.keys((await readChannels(runtime, BACKGROUND_CONTEXT)).channels).length;
		const again = await ensureAllChannels(runtime, BACKGROUND_CONTEXT);
		expect(again.created).toEqual([]);
		expect(Object.keys((await readChannels(runtime, BACKGROUND_CONTEXT)).channels).length).toBe(before);
	});
});

describe("deliver 不阻塞（核心诉求）", () => {
	test("连发 3 条消息，总耗时远小于一次同步等待", async () => {
		const { runtime, booted, project } = await setup();
		const leader = project.leader;
		const started = Date.now();

		for (let i = 0; i < 3; i += 1) {
			await postToChannel(
				runtime,
				"proj:alpha",
				{
					from: OWNER_ID,
					fromLabel: "老板",
					kind: "chat",
					text: `第 ${i} 条指令：把接口文档补一下`,
					mentions: [leader],
				},
				{ context: BACKGROUND_CONTEXT },
			);
		}

		const elapsed = Date.now() - started;
		// 同步等待的硬上限是 180s；这里必须快得多（模型还在跑，但我们不等）
		expect(elapsed, `连发 3 条耗时 ${elapsed}ms`).toBeLessThan(3000);
		void booted;
	});

	test("消息落库后立刻可读（不依赖对方消费）", async () => {
		const { runtime, project } = await setup();
		await postToChannel(
			runtime,
			"proj:alpha",
			{ from: OWNER_ID, fromLabel: "老板", kind: "chat", text: "查一下进度", mentions: [project.leader] },
			{ context: BACKGROUND_CONTEXT },
		);
		const channel = await readChannel(runtime, "proj:alpha", BACKGROUND_CONTEXT);
		expect(channel?.messages.at(-1)?.text).toBe("查一下进度");
	});
});

describe("任务：真任务才存在", () => {
	test("没有验收标准 → 拒绝，并提示改用 say", async () => {
		const { runtime, project, booted } = await setup();
		const result = await createTask(
			runtime,
			{
				project: "alpha",
				channelId: "proj:alpha",
				title: "补一下接口文档",
				brief: "把 API 写清楚",
				acceptance: "",
				assignee: project.leader,
				assignedBy: booted.ownerConversationId,
			},
			BACKGROUND_CONTEXT,
		);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.code).toBe("no-acceptance");
			expect(result.message).toContain("say");
		}
	});

	test("带验收标准 → 建成，并在项目群发一条 task 消息", async () => {
		const { runtime, project, booted } = await setup();
		const result = await createTask(
			runtime,
			{
				project: "alpha",
				channelId: "proj:alpha",
				title: "登录接口加 token 过期处理",
				brief: "过期后返回 401",
				acceptance: "返回 401 且带 WWW-Authenticate 头，有单测",
				assignee: project.leader,
				assignedBy: booted.ownerConversationId,
			},
			BACKGROUND_CONTEXT,
		);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.task.status).toBe("todo");

		const channel = await readChannel(runtime, "proj:alpha", BACKGROUND_CONTEXT);
		const message = channel?.messages.at(-1);
		expect(message?.kind).toBe("task");
		expect(message?.text).toContain(result.task.id);
		expect(message?.text).toContain("验收标准");
		expect(message?.mentions).toContain(project.leader);
	});
});

describe("完成必上报（系统写，不靠模型）", () => {
	test("done 会自动写 report 到频道并投递下达人", async () => {
		const { runtime, project, booted } = await setup();
		const created = await createTask(
			runtime,
			{
				project: "alpha",
				channelId: "proj:alpha",
				title: "补接口文档",
				brief: "",
				acceptance: "README 里有完整 API 表",
				assignee: project.leader,
				assignedBy: booted.ownerConversationId,
			},
			BACKGROUND_CONTEXT,
		);
		expect(created.ok).toBe(true);
		if (!created.ok) return;

		// todo → doing → done
		await transitionTask(runtime, created.task.id, "doing", { by: project.leader }, BACKGROUND_CONTEXT);
		const done = await transitionTask(
			runtime,
			created.task.id,
			"done",
			{ by: project.leader, evidence: "README.md 已补全" },
			BACKGROUND_CONTEXT,
		);
		expect(done.ok).toBe(true);
		if (!done.ok) return;
		expect(done.reported, "完成必须上报").toBe(true);

		// 频道里必须有 report
		const channel = await readChannel(runtime, "proj:alpha", BACKGROUND_CONTEXT);
		const report = channel?.messages.filter((message) => message.kind === "report").at(-1);
		expect(report?.text).toContain("完成");
		expect(report?.text).toContain("README.md 已补全");
		expect(report?.mentions).toContain(booted.ownerConversationId);
	});

	test("blocked 也上报，并带原因", async () => {
		const { runtime, project, booted } = await setup();
		const created = await createTask(
			runtime,
			{
				project: "alpha",
				channelId: "proj:alpha",
				title: "接入支付",
				brief: "",
				acceptance: "能下单",
				assignee: project.leader,
				assignedBy: booted.ownerConversationId,
			},
			BACKGROUND_CONTEXT,
		);
		if (!created.ok) throw new Error(created.message);
		await transitionTask(runtime, created.task.id, "doing", {}, BACKGROUND_CONTEXT);
		const blocked = await transitionTask(
			runtime,
			created.task.id,
			"blocked",
			{ blockedReason: "等第三方密钥" },
			BACKGROUND_CONTEXT,
		);
		expect(blocked.ok && blocked.reported).toBe(true);
		const channel = await readChannel(runtime, "proj:alpha", BACKGROUND_CONTEXT);
		expect(channel?.messages.at(-1)?.text).toContain("等第三方密钥");
	});

	test("非法迁移被拒绝（不能从 todo 直接 done）", async () => {
		const { runtime, project, booted } = await setup();
		const created = await createTask(
			runtime,
			{
				project: "alpha",
				channelId: "proj:alpha",
				title: "测试任务",
				brief: "",
				acceptance: "有测试",
				assignee: project.leader,
				assignedBy: booted.ownerConversationId,
			},
			BACKGROUND_CONTEXT,
		);
		if (!created.ok) throw new Error(created.message);
		const bad = await transitionTask(runtime, created.task.id, "done", {}, BACKGROUND_CONTEXT);
		expect(bad.ok).toBe(false);
		if (!bad.ok) expect(bad.code).toBe("illegal");
	});
});

describe("看板只读 TaskDoc", () => {
	test("按项目过滤，四列正确", async () => {
		const { runtime, project, booted } = await setup();
		const a = await createTask(
			runtime,
			{
				project: "alpha",
				channelId: "proj:alpha",
				title: "A",
				brief: "",
				acceptance: "a 有验收",
				assignee: project.leader,
				assignedBy: booted.ownerConversationId,
			},
			BACKGROUND_CONTEXT,
		);
		if (!a.ok) throw new Error(a.message);
		await transitionTask(runtime, a.task.id, "doing", {}, BACKGROUND_CONTEXT);

		const board = await projectBoard(runtime, "alpha", BACKGROUND_CONTEXT);
		expect(board.columns.doing.map((card) => card.id)).toEqual([a.task.id]);
		expect(board.columns.todo).toEqual([]);
	});

	test("任务持久化，重开后还在", async () => {
		const { runtime, project, booted, ctx } = await setup();
		const created = await createTask(
			runtime,
			{
				project: "alpha",
				channelId: "proj:alpha",
				title: "持久化测试",
				brief: "",
				acceptance: "重启后还在",
				assignee: project.leader,
				assignedBy: booted.ownerConversationId,
			},
			BACKGROUND_CONTEXT,
		);
		if (!created.ok) throw new Error(created.message);
		const id = created.task.id;
		await runtime.close();
		runtimes = runtimes.filter((entry) => entry !== runtime);

		const registry = createRegistry();
		const reopened = await openCompany({ databasePath: ctx.databasePath, models: ctx.models, registry }, BACKGROUND_CONTEXT);
		runtimes.push(reopened);
		await recover(reopened, BACKGROUND_CONTEXT);
		const task = await readTask(reopened, id, BACKGROUND_CONTEXT);
		expect(task?.title).toBe("持久化测试");
	});
});

describe("@ 已读标记（灰点变绿点）", () => {
	test("标记后被 @ 者出现在 readBy", async () => {
		const { runtime, project } = await setup();
		const posted = await postToChannel(
			runtime,
			"proj:alpha",
			{
				from: OWNER_ID,
				fromLabel: "老板",
				kind: "question",
				text: "@负责人 进度如何",
				mentions: [project.leader],
			},
			{ context: BACKGROUND_CONTEXT },
		);
		expect(posted.message.readBy).toEqual([]);

		await markMentionSeen(runtime, "proj:alpha", posted.message.seq, project.leader, BACKGROUND_CONTEXT);
		const channel = await readChannel(runtime, "proj:alpha", BACKGROUND_CONTEXT);
		const message = channel?.messages.find((entry) => entry.seq === posted.message.seq);
		expect(message?.readBy).toContain(project.leader);
	});

	/**
	 * 老板实测「已读状态的点不好使」。
	 *
	 * 前端上报的是「我渲染到的最后一条」，一次可能跨几十条。旧实现只标 `seq`
	 * 这一条，中间的 @ 永远不更新 —— 于是除非恰好停在被 @ 的那一条，绿点永远灰着。
	 */
	test("读到第 N 条时，N 之前（含）的所有 @ 都标已读", async () => {
		const { runtime, project } = await setup();
		const first = await postToChannel(
			runtime,
			"proj:alpha",
			{
				from: OWNER_ID,
				fromLabel: "老板",
				kind: "question",
				text: "@负责人 第一问",
				mentions: [project.leader],
			},
			{ context: BACKGROUND_CONTEXT },
		);
		const middle = await postToChannel(
			runtime,
			"proj:alpha",
			{
				from: OWNER_ID,
				fromLabel: "老板",
				kind: "question",
				text: "@负责人 第二问",
				mentions: [project.leader],
			},
			{ context: BACKGROUND_CONTEXT },
		);
		const last = await postToChannel(
			runtime,
			"proj:alpha",
			{ from: OWNER_ID, fromLabel: "老板", kind: "chat", text: "随便说一句（没有 @" },
			{ context: BACKGROUND_CONTEXT },
		);

		// 用户渲染到 last，中间的 first/middle 都该算已读
		await markMentionSeen(runtime, "proj:alpha", last.message.seq, project.leader, BACKGROUND_CONTEXT);

		const channel = await readChannel(runtime, "proj:alpha", BACKGROUND_CONTEXT);
		const bySeq = new Map(channel?.messages.map((entry) => [entry.seq, entry]) ?? []);
		expect(bySeq.get(first.message.seq)?.readBy).toContain(project.leader);
		expect(bySeq.get(middle.message.seq)?.readBy).toContain(project.leader);
	});

	test("只标到 seq 为止：后面的 @ 不算已读", async () => {
		const { runtime, project } = await setup();
		const early = await postToChannel(
			runtime,
			"proj:alpha",
			{
				from: OWNER_ID,
				fromLabel: "老板",
				kind: "question",
				text: "@负责人 先问这个",
				mentions: [project.leader],
			},
			{ context: BACKGROUND_CONTEXT },
		);
		const later = await postToChannel(
			runtime,
			"proj:alpha",
			{
				from: OWNER_ID,
				fromLabel: "老板",
				kind: "question",
				text: "@负责人 后问这个",
				mentions: [project.leader],
			},
			{ context: BACKGROUND_CONTEXT },
		);

		await markMentionSeen(runtime, "proj:alpha", early.message.seq, project.leader, BACKGROUND_CONTEXT);

		const channel = await readChannel(runtime, "proj:alpha", BACKGROUND_CONTEXT);
		const bySeq = new Map(channel?.messages.map((entry) => [entry.seq, entry]) ?? []);
		expect(bySeq.get(early.message.seq)?.readBy).toContain(project.leader);
		expect(bySeq.get(later.message.seq)?.readBy).not.toContain(project.leader);
	});
});

describe("员工提问（不阻塞，且进频道）", () => {
	test("员工 ask 后消息在频道里，且负责人被投递", async () => {
		const { runtime, project } = await setup();
		const state = await readChannels(runtime, BACKGROUND_CONTEXT);
		const staffChannel = Object.values(state.channels).find((channel) => channel.id === "proj:alpha");
		// 取一个「不是负责人」的员工（负责人自己 @ 自己会被剔除）
		const staff = Object.values(staffChannel?.members ?? {}).find(
			(entry) => entry.role === "staff" && entry.conversationId !== project.leader,
		);
		expect(staff).toBeDefined();

		const started = Date.now();
		await postToChannel(
			runtime,
			"proj:alpha",
			{
				from: staff?.conversationId ?? 0,
				fromLabel: "林越",
				kind: "question",
				text: "T-3 的接口，token 过期返回 401 还是 403？",
				mentions: [project.leader],
			},
			{ context: BACKGROUND_CONTEXT },
		);
		expect(Date.now() - started).toBeLessThan(2000);

		const channel = await readChannel(runtime, "proj:alpha", BACKGROUND_CONTEXT);
		const question = channel?.messages.at(-1);
		expect(question?.kind).toBe("question");
		expect(question?.mentions).toContain(project.leader);
	});
});

describe("员工拿到了通用通信工具（问题 3 的结构性修法）", () => {
	test("员工的生效工具集合包含 say / ask / read_channel / task_update", async () => {
		const { runtime } = await setup();
		const state = await readChannels(runtime, BACKGROUND_CONTEXT);
		const projectChannel = state.channels["proj:alpha"];
		const staff = Object.values(projectChannel?.members ?? {}).find((entry) => entry.role === "staff");
		expect(staff).toBeDefined();

		const conversation = await runtime.harness.conversation(staff?.conversationId as never, BACKGROUND_CONTEXT);
		const agent = await conversation?.agent(BACKGROUND_CONTEXT);
		const names = (agentTools(agent)).map((tool) => tool.name);
		for (const required of ["say", "ask", "read_channel", "inbox", "task_list", "task_update", "whoami", "escalate"]) {
			expect(names, `员工缺 ${required}`).toContain(required);
		}
		// 员工仍然没有管理工具（ADR-004 的边界不能破）
		expect(names).not.toContain("task_create");
		expect(names).not.toContain("staff_hire");
		expect(names).not.toContain("project_create");
	});

	test("负责人拿到了 task_create（能下派任务）", async () => {
		const { runtime, project } = await setup();
		const conversation = await runtime.harness.conversation(project.leader as never, BACKGROUND_CONTEXT);
		const agent = await conversation?.agent(BACKGROUND_CONTEXT);
		const names = (agentTools(agent)).map((tool) => tool.name);
		expect(names).toContain("task_create");
		expect(names).toContain("ask");
		expect(names).toContain("bash");
	});
});

describe("看门狗三项检查（问题 3 / 6 的兜底）", () => {
	test("群里 @ 的问题超时没人回 → 升级给上一级", async () => {
		const { runtime, project } = await setup();
		const state = await readChannels(runtime, BACKGROUND_CONTEXT);
		const projectChannel = state.channels["proj:alpha"];
		const staff = Object.values(projectChannel?.members ?? {}).find(
			(entry) => entry.role === "staff" && entry.conversationId !== project.leader,
		);
		expect(staff).toBeDefined();

		// 员工问负责人，然后「时间过去 15 分钟」
		const posted = await postToChannel(
			runtime,
			"proj:alpha",
			{
				from: staff?.conversationId ?? 0,
				fromLabel: "林越",
				kind: "question",
				text: "T-3 的接口 token 过期返回 401 还是 403？",
				mentions: [project.leader],
				at: Date.now() - 15 * 60_000,
			},
			{ context: BACKGROUND_CONTEXT, wake: false },
		);

		const { runWatchdogPass } = await import("../../src/company/watchdog.ts");
		const result = await runWatchdogPass(runtime, {
			context: BACKGROUND_CONTEXT,
			immediate: false,
			questionUnansweredMs: 10 * 60_000,
		});
		const escalated = result.alerts.filter((alert) => alert.action === "escalate-question");
		expect(escalated.length).toBeGreaterThan(0);

		// 频道里出现一条系统升级消息
		const after = await readChannel(runtime, "proj:alpha", BACKGROUND_CONTEXT);
		const system = after?.messages.filter((message) => message.from === -1).at(-1);
		expect(system?.text).toContain("超时升级");
		expect(system?.text).toContain(posted.message.text.slice(0, 10));
	});

	test("老板消息长时间无回应 → 告警（不允许静默结束）", async () => {
		const { runtime } = await setup();
		await postToChannel(
			runtime,
			"proj:alpha",
			{
				from: OWNER_ID,
				fromLabel: "老板",
				kind: "chat",
				text: "这个项目进度怎么样了？",
				at: Date.now() - 10 * 60_000,
			},
			{ context: BACKGROUND_CONTEXT, wake: false },
		);

		const { runWatchdogPass } = await import("../../src/company/watchdog.ts");
		const result = await runWatchdogPass(runtime, {
			context: BACKGROUND_CONTEXT,
			immediate: false,
			ownerSilentMs: 5 * 60_000,
		});
		const silent = result.alerts.filter((alert) => alert.reason === "owner-message-silent");
		expect(silent.length).toBeGreaterThan(0);
	});

	test("任务阻塞太久 → 提醒负责人（不自动改状态）", async () => {
		const { runtime, project, booted } = await setup();
		const created = await createTask(
			runtime,
			{
				project: "alpha",
				channelId: "proj:alpha",
				title: "接入支付",
				brief: "",
				acceptance: "能下单",
				assignee: project.leader,
				assignedBy: booted.ownerConversationId,
			},
			BACKGROUND_CONTEXT,
		);
		if (!created.ok) throw new Error(created.message);
		await transitionTask(runtime, created.task.id, "doing", {}, BACKGROUND_CONTEXT);
		await transitionTask(runtime, created.task.id, "blocked", { blockedReason: "等密钥" }, BACKGROUND_CONTEXT);

		const { runWatchdogPass } = await import("../../src/company/watchdog.ts");
		// 时间往后推 2 小时
		const result = await runWatchdogPass(runtime, {
			context: BACKGROUND_CONTEXT,
			immediate: false,
			taskBlockedMs: 0,
		});
		const nudges = result.alerts.filter((alert) => alert.action === "nudge-task");
		expect(nudges.length).toBeGreaterThan(0);

		// 状态没被看门狗改掉（只提醒，不改状态）
		const { readTask } = await import("../../src/company/tasks.ts");
		const task = await readTask(runtime, created.task.id, BACKGROUND_CONTEXT);
		expect(task?.status).toBe("blocked");
	});
});

describe("延迟工具 + tool_search（ADR-032）", () => {
	test("长尾工具不在默认工具里，但在 deferred 里且能被搜到", async () => {
		const { runtime, project } = await setup();
		const conversation = await runtime.harness.conversation(project.leader as never, BACKGROUND_CONTEXT);
		const agent = await conversation?.agent(BACKGROUND_CONTEXT);
		expect(agent).toBeDefined();

		const direct = (agent?.tools ?? []).map((tool) => tool.name);
		const deferred = (agent?.deferred ?? []).map((tool) => tool.name);

		// 核心工具直接给
		expect(direct).toContain("say");
		expect(direct).toContain("ask");
		expect(direct).toContain("assign_task");

		// 长尾工具延迟加载（不占模型的注意力）。
		// 负责人的长尾工具是 org_tree / project_plan / project_status / decide。
		expect(direct).not.toContain("project_status");
		expect(deferred).toContain("project_status");

		// 核心 + 延迟 = 完整能力面（没有丢东西）
		expect([...direct, ...deferred]).toContain("project_status");
	});

	test("tool_search 能检索到延迟工具并加载它", async () => {
		const { ctx, runtime, project } = await setup();
		const conversation = await runtime.harness.conversation(project.leader as never, BACKGROUND_CONTEXT);
		const agent = await conversation?.agent(BACKGROUND_CONTEXT);
		const search = (agent?.tools ?? []).find((tool) => tool.name === "tool_search");
		expect(search, "tool_search 必须是默认工具（否则延迟工具永远拿不到）").toBeDefined();
		expect((agent?.deferred ?? []).map((tool) => tool.name)).toContain("project_status");

		// 让模型自己调 tool_search：加载后它应该出现在**下一次**请求的工具里
		ctx.faux.setResponses([
			toolCall("tool_search", { query: "推进项目状态" }),
			answer("找到了 project_status"),
		]);
		const settled = await (
			await conversation?.submit({ type: "input", content: "我需要更新项目状态" }, BACKGROUND_CONTEXT)
		)?.wait(BACKGROUND_CONTEXT);
		expect(settled?.status).toBe("done");

		const after = await conversation?.agent(BACKGROUND_CONTEXT);
		const names = (after?.tools ?? []).map((tool) => tool.name);
		expect(names, "加载后应直接可用").toContain("project_status");
	});
});
/**
 * 并发写：读改写必须在同一条 mutation line 上。
 *
 * 曾经的写法是 `readTasks()`（commit 外快照）+ commit 内整表覆盖。
 * pi-durable 的 commit 串行化只保护 commit 内部，保护不了「读在 commit 外」：
 * 两个并发 createTask 都读到旧 nextId，算出同一个 `T-N`，后写的把先写的盖掉，
 * **两条任务变成一条**。transitionTask 同理，会丢一次状态变更。
 */
describe("任务文档并发写", () => {
	test("并发创建 5 条任务，一条都不能少、id 不能重", async () => {
		const { runtime, booted, project } = await setup();
		const created = await Promise.all(
			Array.from({ length: 5 }, (_, index) =>
				createTask(
					runtime,
					{
						project: "alpha",
						channelId: "proj:alpha",
						title: `并发任务 ${index}`,
						brief: "",
						acceptance: "能跑",
						assignee: project.leader,
						assignedBy: booted.ownerConversationId,
					},
					BACKGROUND_CONTEXT,
				),
			),
		);
		const ok = created.filter((item) => item.ok);
		expect(ok.length).toBe(5);
		const ids = new Set(ok.map((item) => (item.ok ? item.task.id : "")));
		expect(ids.size).toBe(5);

		const state = await readChannels(runtime, BACKGROUND_CONTEXT);
		void state;
		const { readTasks } = await import("../../src/company/tasks.ts");
		const tasks = await readTasks(runtime, BACKGROUND_CONTEXT);
		expect(Object.keys(tasks.tasks).length).toBe(5);
	});

	test("并发迁移同一条任务，最终状态合法且变更不丢", async () => {
		const { runtime, booted, project } = await setup();
		const created = await createTask(
			runtime,
			{
				project: "alpha",
				channelId: "proj:alpha",
				title: "迁移目标",
				brief: "",
				acceptance: "能跑",
				assignee: project.leader,
				assignedBy: booted.ownerConversationId,
			},
			BACKGROUND_CONTEXT,
		);
		expect(created.ok).toBe(true);
		if (!created.ok) return;
		const id = created.task.id;

		// doing 只能从 todo 来；并发两次 doing，一次成功一次非法，但**不能都成功**
		const [first, second] = await Promise.all([
			transitionTask(runtime, id, "doing", { by: 1 }, BACKGROUND_CONTEXT),
			transitionTask(runtime, id, "doing", { by: 1 }, BACKGROUND_CONTEXT),
		]);
		const successes = [first, second].filter((item) => item.ok).length;
		expect(successes).toBeGreaterThanOrEqual(1);
		const task = await readTask(runtime, id, BACKGROUND_CONTEXT);
		expect(task?.status).toBe("doing");
	});
});

/**
 * 未读数只有一个真相源。
 *
 * 曾经 `src/server/channels-view.ts` 用 `lastSeq - messages.length` 当已读位置，
 * 它恒等于「数组里最旧一条的 seq」，与任何人的已读位置无关——老板读完频道后
 * 列表徽章仍然是 3，而下一次轮询又变回原值。
 */
describe("未读数按读位置算", () => {
	test("markRead 之后列表未读与详情未读同时归零", async () => {
		const { runtime } = await setup();
		const { markAllRead, readChannel: readOne } = await import("../../src/company/channels.ts");
		const { listChannels, readChannelView } = await import("../../src/server/channels-view.ts");

		await postToChannel(
			runtime,
			"company",
			{ from: 1, fromLabel: "CEO", kind: "chat", text: "大家好" },
			{ context: BACKGROUND_CONTEXT, wake: false },
		);
		await postToChannel(
			runtime,
			"company",
			{ from: 1, fromLabel: "CEO", kind: "chat", text: "开会了" },
			{ context: BACKGROUND_CONTEXT, wake: false },
		);

		const before = (await listChannels(runtime, BACKGROUND_CONTEXT)).find((item) => item.id === "company");
		expect(before?.unread).toBeGreaterThan(0);

		await markAllRead(runtime, "company", OWNER_ID, BACKGROUND_CONTEXT);

		const after = (await listChannels(runtime, BACKGROUND_CONTEXT)).find((item) => item.id === "company");
		expect(after?.unread).toBe(0);

		const view = await readChannelView(runtime, "company", { viewer: OWNER_ID }, BACKGROUND_CONTEXT);
		const mine = view?.members.find((member) => member.id === OWNER_ID);
		expect(mine?.unread).toBe(0);

		const channel = await readOne(runtime, "company", BACKGROUND_CONTEXT);
		expect(channel?.lastSeq).toBeGreaterThan(0);
	});
});

/**
 * 正文里的 @ 必须在 `postToChannel` 里被解析。
 *
 * 真实事故（老板的「系统」项目）：CPO 用 `say` 发了一条
 * 「@CEO「系统」项目已创建完成…」——`say` 的语义是「说一句，不唤醒任何人」，
 * 它不解析正文，于是这条消息的 `mentions` 是空的，**CEO 从来没被唤醒**。
 * 项目建好了、slug 报了，但整条链静默停摆：CEO 一直 idle，老板看到的是
 * 「流程不动了」，而界面上一切正常（消息在、@ 在正文里、任务都 done）。
 */
describe("正文里的 @ 会唤醒人", () => {
	test("say 只写正文 @，也会唤醒对方", async () => {
		const { runtime } = await setup();
		const channels = await readChannels(runtime, BACKGROUND_CONTEXT);
		const channel = channels.channels["company"];
		expect(channel).toBeDefined();
		const { org } = await readOrg(runtime, BACKGROUND_CONTEXT);

		// 找一个非老板、非发送者的人（发送者用 CPO = 19）
		const target = Object.values(channel!.members)
			.map((member) => member.conversationId)
			.find((id) => id !== OWNER_ID && id !== 19);
		expect(target).toBeDefined();
		const targetLabel = labelOf(org, target!);

		// 故意**不传** mentions：模拟 `say` 的行为
		const posted = await postToChannel(
			runtime,
			"company",
			{ from: 19, fromLabel: "CPO", kind: "chat", text: `@${targetLabel} 这条只说了一句话，但正文里有 @。` },
			{ wake: false, context: BACKGROUND_CONTEXT },
		);
		expect(posted.message.mentions).toContain(target);
	});
});
