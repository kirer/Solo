/**
 * 「只有 CEO 能把问题递到老板面前」的回归测试。
 *
 * 事故背景：老板被大量待拍板淹没，其中多数是管理层自己授权范围内的事
 * （技术方案、排期、人员配置），甚至开发员工的执行环境问题也一路飘到老板桌上。
 *
 * 规则（本文件锁死）：
 * 1. 任何角色的上报最多到 CEO；只有 CEO 发起的问题才进入老板队列（level=owner）。
 * 2. 老板侧的「待你拍板」只统计 owner 级；CEO 自己队列里的不算老板的。
 * 3. CEO 不能替老板拍板（owner 级），也不能替下属拍板（manager 级）。
 * 4. 老板的答复入口只接受 owner 级问题。
 */
import { afterEach, describe, expect, test } from "vitest";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createRegistry, openCompany, recover, type CompanyRuntime } from "../../src/runtime/index.ts";
import { bootstrapCompany, createProject, readCompany } from "../../src/company/org.ts";
import {
	answerPendingAsCeo,
	createEscalationTask,
	listPending,
	startEscalation,
} from "../../src/company/escalation.ts";
import { buildOrgView } from "../../src/server/org-view.ts";
import { serve, type Server } from "../../src/server/http.ts";
import { createTestContext, eventually, type TestContext, TEST_MODEL_CATALOG } from "../support.ts";

let contexts: TestContext[] = [];
let runtimes: CompanyRuntime[] = [];
let servers: Server[] = [];

async function setup() {
	const ctx = await createTestContext();
	contexts.push(ctx);
	const registry = createRegistry();
	const runtime = await openCompany(
		{ databasePath: ctx.databasePath, models: ctx.models, registry },
		BACKGROUND_CONTEXT,
	);
	runtimes.push(runtime);
	await recover(runtime, BACKGROUND_CONTEXT);

	const escalationTask = createEscalationTask(runtime);
	registry.install({ name: "escalation", tasks: [escalationTask] } as never);

	await bootstrapCompany(
		runtime,
		{
			modelCatalog: [...TEST_MODEL_CATALOG],
			companyName: "测试公司",
			registry,
			workspaceRoot: join(ctx.dir, "projects"),
		},
		BACKGROUND_CONTEXT,
	);

	const { project } = await createProject(
		runtime,
		{ name: "Alpha", slug: "alpha", brief: "测试", workspaceRoot: join(ctx.dir, "projects") },
		BACKGROUND_CONTEXT,
	);
	const state = await readCompany(runtime, BACKGROUND_CONTEXT);
	return { ctx, runtime, project, escalationTask, roles: state?.roles ?? {}, ceoId: state?.roles.ceo ?? 1 };
}

afterEach(async () => {
	for (const server of servers) await server.close().catch(() => undefined);
	for (const runtime of runtimes) await runtime.close().catch(() => undefined);
	for (const ctx of contexts) await ctx.cleanup();
	runtimes = [];
	contexts = [];
	servers = [];
});

describe("其他人的上报只到 CEO", () => {
	test("项目负责人上报：待办落在 CEO 级，老板看不到", async () => {
		const { runtime, project, escalationTask } = await setup();

		await startEscalation(
			runtime,
			escalationTask,
			{
				question: "要不要引入 WebGL？",
				from: project.leaderName,
				fromConversationId: project.leader,
				escalationKey: "gate-1",
			},
			BACKGROUND_CONTEXT,
		);

		await eventually(async () => (await listPending(runtime, BACKGROUND_CONTEXT)).length > 0, {
			label: "待办出现",
		});
		const pending = await listPending(runtime, BACKGROUND_CONTEXT);
		expect(pending.every((item) => item.level === "ceo")).toBe(true);

		const org = await buildOrgView(runtime, BACKGROUND_CONTEXT);
		expect(org.pending.every((item) => item.forYou === false), "老板不该看到这一条").toBe(true);
		expect(org.ceo.awaitingYou, "CEO 也没有要老板拍的事").toBe(0);
	});

	test("CEO 上报：直接进入老板队列，且记在 CEO 名下", async () => {
		const { runtime, ceoId, escalationTask } = await setup();

		await startEscalation(
			runtime,
			escalationTask,
			{
				question: "要不要对外承诺三个月上线？",
				from: "CEO",
				fromConversationId: ceoId,
				escalationKey: "gate-2",
				startAtOwner: true,
			},
			BACKGROUND_CONTEXT,
		);

		await eventually(
			async () => (await listPending(runtime, BACKGROUND_CONTEXT)).some((item) => item.level === "owner"),
			{ label: "老板待办出现" },
		);

		const org = await buildOrgView(runtime, BACKGROUND_CONTEXT);
		const mine = org.pending.filter((item) => item.forYou);
		expect(mine).toHaveLength(1);
		expect(mine[0]?.key).toBe("gate-2");
		expect(org.ceo.awaitingYou, "老板的待办挂在 CEO 名下").toBe(1);
		// 老板队列里不能有 manager 级的东西
		expect((await listPending(runtime, BACKGROUND_CONTEXT)).filter((item) => item.level !== "owner")).toEqual([]);
	});
});

describe("CEO 的授权边界", () => {
	test("CEO 不能替老板拍板", async () => {
		const { runtime, ceoId, escalationTask } = await setup();
		await startEscalation(
			runtime,
			escalationTask,
			{
				question: "要不要对外承诺？",
				from: "CEO",
				fromConversationId: ceoId,
				escalationKey: "gate-3",
				startAtOwner: true,
			},
			BACKGROUND_CONTEXT,
		);
		await eventually(
			async () => (await listPending(runtime, BACKGROUND_CONTEXT)).some((item) => item.level === "owner"),
			{ label: "老板待办出现" },
		);

		const ok = await answerPendingAsCeo(runtime, { key: "gate-3", answer: "我替他定" }, BACKGROUND_CONTEXT);
		expect(ok, "owner 级只能老板答").toBe(false);
		expect((await listPending(runtime, BACKGROUND_CONTEXT)).some((item) => item.key === "gate-3")).toBe(true);
	});

	test("CEO 不能替下属拍板", async () => {
		const { runtime, project, escalationTask } = await setup();
		await startEscalation(
			runtime,
			escalationTask,
			{
				question: "用哪个状态管理库？",
				from: project.leaderName,
				fromConversationId: project.leader,
				manager: "cto",
				escalationKey: "gate-4",
			},
			BACKGROUND_CONTEXT,
		);
		await eventually(
			async () => (await listPending(runtime, BACKGROUND_CONTEXT)).some((item) => item.level === "cto"),
			{ label: "CTO 待办出现" },
		);

		const ok = await answerPendingAsCeo(runtime, { key: "gate-4", answer: "用 Zustand" }, BACKGROUND_CONTEXT);
		expect(ok, "cto 级的问题 CEO 不该越俎代庖").toBe(false);
	});

	test("CEO 可以拍自己这一级的问题", async () => {
		const { runtime, project, escalationTask } = await setup();
		await startEscalation(
			runtime,
			escalationTask,
			{
				question: "是否给项目加一台测试机？",
				from: project.leaderName,
				fromConversationId: project.leader,
				escalationKey: "gate-5",
			},
			BACKGROUND_CONTEXT,
		);
		await eventually(async () => (await listPending(runtime, BACKGROUND_CONTEXT)).length > 0, {
			label: "待办出现",
		});

		const ok = await answerPendingAsCeo(runtime, { key: "gate-5", answer: "不加，先用现有机器" }, BACKGROUND_CONTEXT);
		expect(ok).toBe(true);
		expect(await listPending(runtime, BACKGROUND_CONTEXT)).toEqual([]);
	});
});

describe("老板的答复入口只收自己这一级的问题", () => {
	test("CEO 队列里的问题从老板接口提交会被拒绝", async () => {
		const { runtime, project, escalationTask } = await setup();
		const server = await serve({ runtime, port: 0, uiDir: join(process.cwd(), "ui") });
		servers.push(server);

		await startEscalation(
			runtime,
			escalationTask,
			{
				question: "要不要给项目加一台测试机？",
				from: project.leaderName,
				fromConversationId: project.leader,
				escalationKey: "gate-6",
			},
			BACKGROUND_CONTEXT,
		);
		await eventually(async () => (await listPending(runtime, BACKGROUND_CONTEXT)).length > 0, {
			label: "待办出现",
		});

		const response = await fetch(`${server.url}api/answer`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ key: "gate-6", text: "老板替 CEO 拍了" }),
		});
		expect(response.status, "不该让老板替 CEO 拍板").toBe(409);
		expect((await listPending(runtime, BACKGROUND_CONTEXT)).length).toBe(1);
	});

	test("owner 级的问题老板可以正常拍板", async () => {
		const { runtime, ceoId, escalationTask } = await setup();
		const server = await serve({ runtime, port: 0, uiDir: join(process.cwd(), "ui") });
		servers.push(server);

		await startEscalation(
			runtime,
			escalationTask,
			{
				question: "要对外承诺三个月上线吗？",
				from: "CEO",
				fromConversationId: ceoId,
				escalationKey: "gate-7",
				startAtOwner: true,
			},
			BACKGROUND_CONTEXT,
		);
		await eventually(
			async () => (await listPending(runtime, BACKGROUND_CONTEXT)).some((item) => item.level === "owner"),
			{ label: "老板待办出现" },
		);

		const response = await fetch(`${server.url}api/answer`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ key: "gate-7", text: "不承诺，先做出来再说" }),
		});
		expect((await response.json()) as { ok: boolean }).toEqual({ ok: true });
		expect(await listPending(runtime, BACKGROUND_CONTEXT)).toEqual([]);
	});
});
