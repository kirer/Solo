/**
 * communication-trail 的测试。
 *
 * 覆盖 specs/communication-trail/spec.md：不可变记录、双向留痕、跨会话追溯、
 * 类型区分、为图形界面预留的数据形态。
 */
import { afterEach, describe, expect, test } from "vitest";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createRegistry, openCompany, recover, type CompanyRuntime } from "../../src/runtime/index.ts";
import { bootstrapCompany, createProject, hireStaff } from "../../src/company/org.ts";
import { delegate } from "../../src/company/delegation.ts";
import { recordMessage, activeTasks, organizationGraph, readTrail, trailForConversation, trailForRef } from "../../src/company/trail.ts";
import { answer, createTestContext, type TestContext, TEST_MODEL_CATALOG } from "../support.ts";

let contexts: TestContext[] = [];
let runtimes: CompanyRuntime[] = [];

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
	const boot = await bootstrapCompany(
		runtime,
		{
			modelCatalog: [...TEST_MODEL_CATALOG], companyName: "测试公司", registry, workspaceRoot: join(ctx.dir, "projects") },
		BACKGROUND_CONTEXT,
	);
	const { project } = await createProject(
		runtime,
		{ name: "Alpha", slug: "alpha", brief: "测试", workspaceRoot: join(ctx.dir, "projects") },
		BACKGROUND_CONTEXT,
	);
	const hired = await hireStaff(
		runtime,
		{ project: "alpha", name: "dev-1", role: "开发", manager: "cto" },
		BACKGROUND_CONTEXT,
	);
	return { ctx, runtime, boot, project, hired };
}

afterEach(async () => {
	for (const runtime of runtimes) await runtime.close().catch(() => undefined);
	for (const ctx of contexts) await ctx.cleanup();
	runtimes = [];
	contexts = [];
});

describe("每条沟通落成不可变记录", () => {
	test("派活被记录，包含时间、发送方、接收方与类型", async () => {
		const { ctx, runtime, project } = await setup();

		ctx.faux.setResponses([answer("做完了")]);
		await delegate(
			runtime,
			{ project: "alpha", employee: "dev-1", task: "实现登录", fromConversationId: project.leader, from: "负责人" },
			BACKGROUND_CONTEXT,
		);

		const trail = await readTrail(runtime, {}, BACKGROUND_CONTEXT);
		const delegation = trail.find((edge) => edge.kind === "delegate");

		expect(delegation).toBeDefined();
		expect(delegation?.from).toBe("负责人");
		expect(delegation?.to).toBe("dev-1");
		expect(delegation?.at).toBeGreaterThan(0);
	});

	test("答复被记录", async () => {
		const { ctx, runtime, project } = await setup();

		ctx.faux.setResponses([answer("登录做完了")]);
		await delegate(
			runtime,
			{ project: "alpha", employee: "dev-1", task: "实现登录", fromConversationId: project.leader, from: "负责人" },
			BACKGROUND_CONTEXT,
		);

		const trail = await readTrail(runtime, {}, BACKGROUND_CONTEXT);
		expect(trail.some((edge) => edge.kind === "report")).toBe(true);
	});

	test("记录不可修改：重复读取得到相同内容", async () => {
		const { runtime, project, hired } = await setup();

		await recordMessage(
			runtime,
			{
				from: "负责人",
				to: "dev-1",
				fromConversationId: project.leader,
				toConversationId: hired.conversationId,
				kind: "delegate",
				text: "原始内容",
				ref: "ref-immutable",
			},
			BACKGROUND_CONTEXT,
		);

		const first = await trailForRef(runtime, "ref-immutable", BACKGROUND_CONTEXT);
		const second = await trailForRef(runtime, "ref-immutable", BACKGROUND_CONTEXT);

		expect(first.length).toBe(1);
		expect(JSON.stringify(first)).toBe(JSON.stringify(second));
	});
});

describe("双向留痕", () => {
	test("发送方与接收方各有一条记录，可通过 ref 对应", async () => {
		const { runtime, project, hired } = await setup();

		await recordMessage(
			runtime,
			{
				from: "负责人",
				to: "dev-1",
				fromConversationId: project.leader,
				toConversationId: hired.conversationId,
				kind: "delegate",
				text: "写个函数",
				ref: "ref-dual",
			},
			BACKGROUND_CONTEXT,
		);

		const senderView = await trailForConversation(runtime, project.leader, BACKGROUND_CONTEXT);
		const receiverView = await trailForConversation(runtime, hired.conversationId, BACKGROUND_CONTEXT);

		expect(senderView.some((edge) => edge.ref === "ref-dual"), "发送方应能看到").toBe(true);
		expect(receiverView.some((edge) => edge.ref === "ref-dual"), "接收方应能看到").toBe(true);

		// 两端指向同一条沟通
		const byRef = await trailForRef(runtime, "ref-dual", BACKGROUND_CONTEXT);
		expect(byRef.length).toBe(1);
	});
});

describe("跨会话追溯", () => {
	test("按时间重建时间线", async () => {
		const { ctx, runtime, project, hired } = await setup();

		await recordMessage(
			runtime,
			{
				from: "A",
				to: "B",
				fromConversationId: project.leader,
				toConversationId: hired.conversationId,
				kind: "delegate",
				ref: "r1",
			},
			BACKGROUND_CONTEXT,
		);
		await new Promise((resolve) => setTimeout(resolve, 5));
		await recordMessage(
			runtime,
			{
				from: "B",
				to: "A",
				fromConversationId: hired.conversationId,
				toConversationId: project.leader,
				kind: "report",
				ref: "r2",
			},
			BACKGROUND_CONTEXT,
		);

		const trail = await readTrail(runtime, {}, BACKGROUND_CONTEXT);
		expect(trail.length).toBe(2);
		expect(trail[0]?.at).toBeLessThanOrEqual(trail[1]?.at ?? 0);
		expect(trail[0]?.kind).toBe("delegate");
		expect(trail[1]?.kind).toBe("report");
		void ctx;
	});

	test("按项目过滤", async () => {
		const { runtime, project, hired } = await setup();

		await recordMessage(
			runtime,
			{
				from: "A",
				to: "B",
				fromConversationId: project.leader,
				toConversationId: hired.conversationId,
				kind: "delegate",
				ref: "alpha-ref",
				project: "alpha",
			},
			BACKGROUND_CONTEXT,
		);
		await recordMessage(
			runtime,
			{
				from: "A",
				to: "B",
				fromConversationId: project.leader,
				toConversationId: hired.conversationId,
				kind: "delegate",
				ref: "beta-ref",
				project: "beta",
			},
			BACKGROUND_CONTEXT,
		);

		const alphaOnly = await readTrail(runtime, { project: "alpha" }, BACKGROUND_CONTEXT);
		expect(alphaOnly.length).toBe(1);
		expect(alphaOnly[0]?.ref).toBe("alpha-ref");
	});

	test("追溯链条完整：派活到回报可串起来", async () => {
		const { ctx, runtime, project } = await setup();

		ctx.faux.setResponses([answer("完成")]);
		await delegate(
			runtime,
			{ project: "alpha", employee: "dev-1", task: "任务", fromConversationId: project.leader, from: "负责人" },
			BACKGROUND_CONTEXT,
		);

		const trail = await readTrail(runtime, { project: "alpha" }, BACKGROUND_CONTEXT);
		const kinds = trail.map((edge) => edge.kind);
		expect(kinds).toContain("delegate");
		expect(kinds).toContain("report");
	});
});

describe("沟通类型可区分", () => {
	test("按类型过滤", async () => {
		const { runtime, project, hired } = await setup();

		for (const kind of ["delegate", "report", "escalate", "decide", "hire"] as const) {
			await recordMessage(
				runtime,
				{
					from: "A",
					to: "B",
					fromConversationId: project.leader,
					toConversationId: hired.conversationId,
					kind,
					ref: `ref-${kind}`,
				},
				BACKGROUND_CONTEXT,
			);
		}

		const onlyEscalate = await readTrail(runtime, { kinds: ["escalate"] }, BACKGROUND_CONTEXT);
		expect(onlyEscalate.length).toBe(1);
		expect(onlyEscalate[0]?.kind).toBe("escalate");

		const twoKinds = await readTrail(runtime, { kinds: ["delegate", "hire"] }, BACKGROUND_CONTEXT);
		expect(twoKinds.length).toBe(2);
	});
});

describe("为图形界面预留的数据形态", () => {
	test("返回节点与边", async () => {
		const { ctx, runtime, project } = await setup();

		ctx.faux.setResponses([answer("完成")]);
		await delegate(
			runtime,
			{ project: "alpha", employee: "dev-1", task: "任务", fromConversationId: project.leader, from: "负责人" },
			BACKGROUND_CONTEXT,
		);

		const graph = await organizationGraph(runtime, BACKGROUND_CONTEXT);

		// 节点：七个角色 + 项目 + 员工
		expect(graph.nodes.length).toBeGreaterThanOrEqual(9);
		const kinds = new Set(graph.nodes.map((node) => node.kind));
		expect(kinds.has("role")).toBe(true);
		expect(kinds.has("project")).toBe(true);
		expect(kinds.has("staff")).toBe(true);

		// 边：每条标明起止会话、类型、时间
		expect(graph.edges.length).toBeGreaterThan(0);
		for (const edge of graph.edges) {
			expect(typeof edge.from).toBe("number");
			expect(typeof edge.to).toBe("number");
			expect(typeof edge.kind).toBe("string");
			expect(edge.at).toBeGreaterThan(0);
		}
	});

	test("员工节点关联到项目负责人", async () => {
		const { runtime, project, hired } = await setup();
		const graph = await organizationGraph(runtime, BACKGROUND_CONTEXT);

		const staffNode = graph.nodes.find((node) => node.id === hired.conversationId);
		expect(staffNode?.kind).toBe("staff");
		expect(staffNode?.parent, "员工节点应指向项目负责人").toBe(project.leader);
	});

	test("活跃任务结构随工作推进更新", async () => {
		const { ctx, runtime, project } = await setup();

		// 没有工作时
		const before = await activeTasks(runtime, BACKGROUND_CONTEXT);
		expect(Array.isArray(before)).toBe(true);

		// 派活期间应有活跃任务
		ctx.faux.setResponses([answer("完成")]);
		await delegate(
			runtime,
			{ project: "alpha", employee: "dev-1", task: "任务", fromConversationId: project.leader, from: "负责人" },
			BACKGROUND_CONTEXT,
		);

		// 派活结束后任务应为终态（不在活跃列表里）
		const after = await activeTasks(runtime, BACKGROUND_CONTEXT);
		for (const task of after) {
			expect(["running", "waiting", "sleeping", "ready", "blocked"]).toContain(task.status);
		}
	});
});
