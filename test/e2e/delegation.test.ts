/**
 * delegation 的端到端测试。
 *
 * 覆盖 specs/delegation/spec.md：派活、能力边界、产出回流、状态查询。
 */
import { afterEach, describe, expect, test } from "vitest";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createRegistry, openCompany, recover, type CompanyRuntime } from "../../src/runtime/index.ts";
import { bootstrapCompany, createProject, hireStaff } from "../../src/company/org.ts";
import { delegate, describeStaff, isEmployeeBusy } from "../../src/company/delegation.ts";
import { listStaff } from "../../src/company/org.ts";
import { answer, createTestContext, slowAnswer, type TestContext, TEST_MODEL_CATALOG } from "../support.ts";

let contexts: TestContext[] = [];
let runtimes: CompanyRuntime[] = [];

async function setup(): Promise<{ ctx: TestContext; runtime: CompanyRuntime; leaderId: number }> {
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
		{ name: "Alpha", slug: "alpha", brief: "测试项目", workspaceRoot: join(ctx.dir, "projects") },
		BACKGROUND_CONTEXT,
	);
	await hireStaff(runtime, { project: "alpha", name: "dev-1", role: "开发", manager: "cto" }, BACKGROUND_CONTEXT);
	void boot;
	return { ctx, runtime, leaderId: project.leader };
}

afterEach(async () => {
	for (const runtime of runtimes) await runtime.close().catch(() => undefined);
	for (const ctx of contexts) await ctx.cleanup();
	runtimes = [];
	contexts = [];
});

describe("派活给员工", () => {
	test("派活并取得答复", async () => {
		const { ctx, runtime, leaderId } = await setup();

		ctx.faux.setResponses([answer("登录模块已完成，缺少单元测试。")]);
		const result = await delegate(
			runtime,
			{ project: "alpha", employee: "dev-1", task: "实现登录模块", fromConversationId: leaderId, from: "项目负责人" },
			BACKGROUND_CONTEXT,
		);

		expect(result.ok).toBe(true);
		expect(result.text).toContain("登录模块已完成");
	});

	test("目标员工不存在时返回明确失败且不创建会话", async () => {
		const { runtime, leaderId } = await setup();
		const before = await runtime.harness.commit((tx) => tx.scanConversations({}, 100), BACKGROUND_CONTEXT);

		const result = await delegate(
			runtime,
			{ project: "alpha", employee: "nobody", task: "干活", fromConversationId: leaderId, from: "项目负责人" },
			BACKGROUND_CONTEXT,
		);

		expect(result.ok).toBe(false);
		expect(result.reason).toBe("no-employee");

		const after = await runtime.harness.commit((tx) => tx.scanConversations({}, 100), BACKGROUND_CONTEXT);
		expect(after.items.length, "失败不得创建新会话").toBe(before.items.length);
	});

	test("派活给已归档员工被拒绝", async () => {
		const { ctx, runtime, leaderId } = await setup();
		const { archiveStaff } = await import("../../src/company/org.ts");
		await archiveStaff(runtime, "alpha", "dev-1", BACKGROUND_CONTEXT);

		const result = await delegate(
			runtime,
			{ project: "alpha", employee: "dev-1", task: "干活", fromConversationId: leaderId, from: "项目负责人" },
			BACKGROUND_CONTEXT,
		);

		expect(result.ok).toBe(false);
		expect(result.reason).toBe("archived");
		void ctx;
	});
});

describe("员工能力边界", () => {
	test("员工生效工具集合不含任何管理能力", async () => {
		const { runtime } = await setup();
		const staff = await listStaff(runtime, "alpha", BACKGROUND_CONTEXT);
		const person = staff[0];
		expect(person).toBeDefined();

		const conversation = await runtime.harness.conversation(person?.conversationId as never, BACKGROUND_CONTEXT);
		const tools = (await conversation?.agent(BACKGROUND_CONTEXT))?.tools.map((tool) => tool.name) ?? [];

		for (const forbidden of ["staff_hire", "project_create", "escalate", "decide", "staff_list"]) {
			expect(tools, `员工不应有 ${forbidden}`).not.toContain(forbidden);
		}
	});

	test("管理层具备管理能力", async () => {
		const { runtime } = await setup();
		const state = await runtime.harness.snapshot(
			(await import("../../src/company/docs.ts")).CompanyDoc,
			BACKGROUND_CONTEXT,
		);
		const chro = await runtime.harness.conversation(state?.roles.chro as never, BACKGROUND_CONTEXT);
		const tools = (await chro?.agent(BACKGROUND_CONTEXT))?.tools.map((tool) => tool.name) ?? [];

		expect(tools).toContain("staff_hire");
		expect(tools).toContain("staff_list");
	});
});

describe("员工产出回流", () => {
	test("成功派活的记录出现在派活方会话", async () => {
		const { ctx, runtime, leaderId } = await setup();

		ctx.faux.setResponses([answer("做完了")]);
		await delegate(
			runtime,
			{ project: "alpha", employee: "dev-1", task: "写个函数", fromConversationId: leaderId, from: "项目负责人" },
			BACKGROUND_CONTEXT,
		);

		const { AuditDoc } = await import("../../src/company/docs.ts");
		const audit = await runtime.harness.snapshot(AuditDoc, leaderId as never, BACKGROUND_CONTEXT);
		expect(audit?.events.length ?? 0).toBeGreaterThan(0);
	});

	test("派活失败不被当作成功答复", async () => {
		const { ctx, runtime, leaderId } = await setup();

		// 模型没有可用响应 → 提交会是 unanswered
		ctx.faux.setResponses([]);
		const result = await delegate(
			runtime,
			{ project: "alpha", employee: "dev-1", task: "干活", fromConversationId: leaderId, from: "项目负责人" },
			BACKGROUND_CONTEXT,
		);

		expect(result.ok).toBe(false);
		expect(result.reason).toBe("failed");
	});
});

describe("员工状态查询", () => {
	test("列出项目员工及忙碌状态", async () => {
		const { runtime } = await setup();
		const staff = await listStaff(runtime, "alpha", BACKGROUND_CONTEXT);
		const described = await describeStaff(runtime, staff, BACKGROUND_CONTEXT);

		expect(described.length).toBe(1);
		expect(described[0]?.name).toBe("dev-1");
		expect(described[0]?.managerLabel).toBe("CTO");
		expect(typeof described[0]?.busy).toBe("boolean");
	});

	test("员工正在工作时报告忙碌", async () => {
		const { ctx, runtime, leaderId } = await setup();
		const staff = await listStaff(runtime, "alpha", BACKGROUND_CONTEXT);
		const person = staff[0];
		expect(person).toBeDefined();

		ctx.faux.setResponses([slowAnswer(300, "慢活干完了")]);
		const pending = delegate(
			runtime,
			{ project: "alpha", employee: "dev-1", task: "慢活", fromConversationId: leaderId, from: "项目负责人" },
			BACKGROUND_CONTEXT,
		);

		// 等它真的开始
		await new Promise((resolve) => setTimeout(resolve, 100));
		const busy = await isEmployeeBusy(runtime, person!, BACKGROUND_CONTEXT);
		expect(busy, "员工应在工作时报告忙碌").toBe(true);

		const result = await pending;
		expect(result.ok).toBe(true);
	});

	test("忙碌时 whenBusy=reject 被拒绝", async () => {
		const { ctx, runtime, leaderId } = await setup();

		ctx.faux.setResponses([slowAnswer(300, "第一个活"), answer("第二个活")]);
		const first = delegate(
			runtime,
			{ project: "alpha", employee: "dev-1", task: "第一个", fromConversationId: leaderId, from: "项目负责人" },
			BACKGROUND_CONTEXT,
		);

		await new Promise((resolve) => setTimeout(resolve, 100));
		const second = await delegate(
			runtime,
			{
				project: "alpha",
				employee: "dev-1",
				task: "第二个",
				fromConversationId: leaderId,
				from: "项目负责人",
				whenBusy: "reject",
			},
			BACKGROUND_CONTEXT,
		);

		expect(second.ok).toBe(false);
		expect(second.reason).toBe("busy");

		await first;
	});

	test("忙碌时默认排队为后续输入", async () => {
		const { ctx, runtime, leaderId } = await setup();

		ctx.faux.setResponses([slowAnswer(200, "第一个活"), answer("第二个活")]);
		const first = delegate(
			runtime,
			{ project: "alpha", employee: "dev-1", task: "第一个", fromConversationId: leaderId, from: "项目负责人" },
			BACKGROUND_CONTEXT,
		);
		await new Promise((resolve) => setTimeout(resolve, 50));

		const second = await delegate(
			runtime,
			{ project: "alpha", employee: "dev-1", task: "第二个", fromConversationId: leaderId, from: "项目负责人" },
			BACKGROUND_CONTEXT,
		);

		expect(second.ok).toBe(true);
		expect(second.text).toContain("第二个活");
		await first;
	});
});

describe("派活与中断", () => {
	test("老板中断派活方不波及员工", async () => {
		const { ctx, runtime, leaderId } = await setup();

		ctx.faux.setResponses([slowAnswer(200, "员工干完了")]);
		const pending = delegate(
			runtime,
			{ project: "alpha", employee: "dev-1", task: "慢活", fromConversationId: leaderId, from: "项目负责人" },
			BACKGROUND_CONTEXT,
		);
		await new Promise((resolve) => setTimeout(resolve, 50));

		// 中断项目负责人
		const leader = await runtime.harness.conversation(leaderId as never, BACKGROUND_CONTEXT);
		await leader?.abort(BACKGROUND_CONTEXT);

		// 派活本身是宿主侧的等待，不受 leader 中断影响
		const result = await pending;
		expect(result.ok, "员工工作不应被中断波及").toBe(true);
	});
});
