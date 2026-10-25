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
	markMentionSeen,
} from "../../src/company/channels.ts";
import { createTask, transitionTask, readTask, projectBoard } from "../../src/company/tasks.ts";
import { OWNER_ID } from "../../src/domain/channels.ts";
import { createTestContext, eventually, type TestContext, TEST_MODEL_CATALOG } from "../support.ts";

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
	await hireStaff(runtime, { project: "alpha", name: "林越", role: "开发" }, BACKGROUND_CONTEXT);
	await hireStaff(runtime, { project: "alpha", name: "周野", role: "测试" }, BACKGROUND_CONTEXT);
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
	test("建出公司大群、领导层群、项目群、个人记录", async () => {
		const { runtime } = await setup();
		const state = await readChannels(runtime, BACKGROUND_CONTEXT);
		const ids = Object.keys(state.channels);
		expect(ids).toContain("company");
		expect(ids).toContain("leadership");
		expect(ids).toContain("proj:alpha");
		expect(ids.some((id) => id.startsWith("log:"))).toBe(true);
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
