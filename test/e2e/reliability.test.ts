/**
 * 可靠性与真实可用性的回归测试。
 *
 * 覆盖一批「只有真跑才会发现」的问题：
 * - 重启后角色能力是否还在（registry 是内存态）
 * - CEO 是否被误给了全部工具
 * - 员工是否按角色拿到工具（没有工具就干不了活）
 * - 输出被截断时派活是否判失败（不能当成做完了）
 */
import { afterEach, describe, expect, test } from "vitest";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createRegistry, openCompany, recover, type CompanyRuntime } from "../../src/runtime/index.ts";
import { bootstrapCompany, COMPANY_TASKS_EXTENSION, createProject, hireStaff } from "../../src/company/org.ts";
import { toolsForRole, toolNamesForRole } from "../../src/company/staff-tools.ts";
import { delegate } from "../../src/company/delegation.ts";
import { createTestContext, type TestContext, TEST_MODEL_CATALOG } from "../support.ts";

let contexts: TestContext[] = [];
let runtimes: CompanyRuntime[] = [];

async function boot(runtime: CompanyRuntime, registry: ReturnType<typeof createRegistry>, dir: string) {
	return bootstrapCompany(
		runtime,
		{
			modelCatalog: [...TEST_MODEL_CATALOG],
			companyName: "测试公司",
			registry,
			workspaceRoot: join(dir, "projects"),
			...(process.env.TEST_MODEL === undefined
				? { modelCatalog: [{ id: "faux-1", provider: "faux", modelId: "faux-1", label: "测试", inputPerMTok: 0, outputPerMTok: 0 }] }
				: {}),
		},
		BACKGROUND_CONTEXT,
	);
}

afterEach(async () => {
	for (const runtime of runtimes) await runtime.close().catch(() => undefined);
	for (const ctx of contexts) await ctx.cleanup();
	runtimes = [];
	contexts = [];
});

describe("重启后角色能力不能丢", () => {
	test("第二次启动（幂等分支）后管理层仍有工具", async () => {
		const ctx = await createTestContext();
		contexts.push(ctx);
		const db = ctx.databasePath;

		// 第一次启动
		const registryA = createRegistry();
		const first = await openCompany({ databasePath: db, models: ctx.models, registry: registryA }, BACKGROUND_CONTEXT);
		await recover(first, BACKGROUND_CONTEXT);
		const bootA = await boot(first, registryA, ctx.dir);
		await first.close();

		// 第二次启动：全新 registry（内存态不持久化）
		const registryB = createRegistry();
		const second = await openCompany({ databasePath: db, models: ctx.models, registry: registryB }, BACKGROUND_CONTEXT);
		runtimes.push(second);
		await recover(second, BACKGROUND_CONTEXT);
		const bootB = await boot(second, registryB, ctx.dir);

		expect(bootB.created, "第二次应走幂等分支").toBe(false);

		for (const [role, id] of Object.entries(bootB.roleConversations)) {
			const conversation = await second.harness.conversation(id as never, BACKGROUND_CONTEXT);
			const tools = (await conversation?.agent(BACKGROUND_CONTEXT))?.tools.map((tool) => tool.name) ?? [];
			expect(tools.length, `重启后 ${role} 应有工具，实际为空`).toBeGreaterThan(0);
		}
		void bootA;
	});

	test("内置任务注册后员工锚点不阻塞", async () => {
		const ctx = await createTestContext();
		contexts.push(ctx);
		const registry = createRegistry();
		const runtime = await openCompany(
			{ databasePath: ctx.databasePath, models: ctx.models, registry },
			BACKGROUND_CONTEXT,
		);
		runtimes.push(runtime);
		await recover(runtime, BACKGROUND_CONTEXT);
		registry.install(COMPANY_TASKS_EXTENSION);
		await boot(runtime, registry, ctx.dir);

		await createProject(runtime, { name: "A", slug: "a", brief: "b", workspaceRoot: join(ctx.dir, "projects") }, BACKGROUND_CONTEXT);
		await hireStaff(runtime, { project: "a", name: "dev-1", role: "开发", manager: "cto", registry }, BACKGROUND_CONTEXT);

		await new Promise((resolve) => setTimeout(resolve, 200));
		const inspection = await runtime.harness.inspect(BACKGROUND_CONTEXT);
		const blocked = inspection.tasks.filter((task) => task.state.kind === "blocked");
		expect(blocked, "员工锚点不应受阻").toEqual([]);
	});
});

describe("CEO 不能越权", () => {
	test("CEO 只有组织视图与上报能力，没有招聘与立项", async () => {
		const ctx = await createTestContext();
		contexts.push(ctx);
		const registry = createRegistry();
		const runtime = await openCompany(
			{ databasePath: ctx.databasePath, models: ctx.models, registry },
			BACKGROUND_CONTEXT,
		);
		runtimes.push(runtime);
		await recover(runtime, BACKGROUND_CONTEXT);
		const booted = await boot(runtime, registry, ctx.dir);

		const ceo = await runtime.harness.conversation(booted.ownerConversationId as never, BACKGROUND_CONTEXT);
		const tools = (await ceo?.agent(BACKGROUND_CONTEXT))?.tools.map((tool) => tool.name) ?? [];

		expect(tools).toContain("org_tree");
		expect(tools).toContain("escalate");
		expect(tools, "CEO 不应自己招人").not.toContain("staff_hire");
		expect(tools, "CEO 不应自己立项").not.toContain("project_create");
	});
});

describe("员工按角色拿到执行工具", () => {
	test("开发拿到读写与命令执行", () => {
		expect(toolNamesForRole("开发")).toEqual(["read", "write", "edit", "bash"]);
	});

	test("产品只能读写，不能跑命令", () => {
		expect(toolNamesForRole("产品")).toEqual(["read", "write", "edit"]);
		expect(toolNamesForRole("产品")).not.toContain("bash");
	});

	test("未知角色最保守：只读", () => {
		expect(toolNamesForRole("不存在的角色")).toEqual(["read"]);
	});

	test("招聘时按角色自动分配工具", async () => {
		const ctx = await createTestContext();
		contexts.push(ctx);
		const registry = createRegistry();
		const runtime = await openCompany(
			{ databasePath: ctx.databasePath, models: ctx.models, registry },
			BACKGROUND_CONTEXT,
		);
		runtimes.push(runtime);
		await recover(runtime, BACKGROUND_CONTEXT);
		await boot(runtime, registry, ctx.dir);
		await createProject(runtime, { name: "A", slug: "a", brief: "b", workspaceRoot: join(ctx.dir, "projects") }, BACKGROUND_CONTEXT);

		const dev = await hireStaff(runtime, { project: "a", name: "dev-1", role: "开发", manager: "cto", registry }, BACKGROUND_CONTEXT);
		const qa = await hireStaff(runtime, { project: "a", name: "qa-1", role: "测试", manager: "cto", registry }, BACKGROUND_CONTEXT);

		const devConv = await runtime.harness.conversation(dev.conversationId as never, BACKGROUND_CONTEXT);
		const devTools = (await devConv?.agent(BACKGROUND_CONTEXT))?.tools.map((tool) => tool.name) ?? [];
		expect(devTools).toContain("write");
		expect(devTools).toContain("bash");

		const qaConv = await runtime.harness.conversation(qa.conversationId as never, BACKGROUND_CONTEXT);
		const qaTools = (await qaConv?.agent(BACKGROUND_CONTEXT))?.tools.map((tool) => tool.name) ?? [];
		expect(qaTools).toContain("write");
	});
});

describe("多个员工各有独立能力包", () => {
	test("招四个员工后每人都有工具且互不覆盖", async () => {
		const ctx = await createTestContext();
		contexts.push(ctx);
		const registry = createRegistry();
		const runtime = await openCompany(
			{ databasePath: ctx.databasePath, models: ctx.models, registry },
			BACKGROUND_CONTEXT,
		);
		runtimes.push(runtime);
		await recover(runtime, BACKGROUND_CONTEXT);
		await boot(runtime, registry, ctx.dir);
		await createProject(runtime, { name: "A", slug: "a", brief: "b", workspaceRoot: join(ctx.dir, "projects") }, BACKGROUND_CONTEXT);

		const hired = [];
		for (const [name, role] of [
			["pm-1", "产品"],
			["ui-1", "设计"],
			["dev-1", "开发"],
			["qa-1", "测试"],
		] as const) {
			hired.push(await hireStaff(runtime, { project: "a", name, role, manager: "cto", registry }, BACKGROUND_CONTEXT));
		}

		for (const person of hired) {
			const conversation = await runtime.harness.conversation(person.conversationId as never, BACKGROUND_CONTEXT);
			const tools = (await conversation?.agent(BACKGROUND_CONTEXT))?.tools.map((tool) => tool.name) ?? [];
			expect(tools.length, `${person.staff.name} 应有工具，实际为空`).toBeGreaterThan(0);
		}

		// 开发有 bash，产品没有
		const dev = hired.find((person) => person.staff.role === "开发");
		const pm = hired.find((person) => person.staff.role === "产品");
		const devConv = await runtime.harness.conversation(dev?.conversationId as never, BACKGROUND_CONTEXT);
		const pmConv = await runtime.harness.conversation(pm?.conversationId as never, BACKGROUND_CONTEXT);
		const devTools = (await devConv?.agent(BACKGROUND_CONTEXT))?.tools.map((tool) => tool.name) ?? [];
		const pmTools = (await pmConv?.agent(BACKGROUND_CONTEXT))?.tools.map((tool) => tool.name) ?? [];

		expect(devTools).toContain("bash");
		expect(pmTools).not.toContain("bash");
	});
});

describe("截断不能被当成完成", () => {
	test("助手消息以 length 结束时派活判失败", async () => {
		const ctx = await createTestContext();
		contexts.push(ctx);
		const registry = createRegistry();
		const runtime = await openCompany(
			{ databasePath: ctx.databasePath, models: ctx.models, registry },
			BACKGROUND_CONTEXT,
		);
		runtimes.push(runtime);
		await recover(runtime, BACKGROUND_CONTEXT);
		await boot(runtime, registry, ctx.dir);
		const { project } = await createProject(
			runtime,
			{ name: "A", slug: "a", brief: "b", workspaceRoot: join(ctx.dir, "projects") },
			BACKGROUND_CONTEXT,
		);
		await hireStaff(runtime, { project: "a", name: "dev-1", role: "开发", manager: "cto", registry }, BACKGROUND_CONTEXT);

		// 模拟输出被长度截断
		ctx.faux.setResponses([
			{
				role: "assistant",
				content: [{ type: "text", text: "我来实现（被截断）" }],
				api: "faux",
				provider: "faux",
				model: "faux-1",
				usage: { input: 10, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 20 },
				stopReason: "length",
				timestamp: Date.now(),
			} as never,
		]);

		const result = await delegate(
			runtime,
			{
				project: "a",
				employee: "dev-1",
				task: "写一个长文件",
				fromConversationId: project.leader,
				from: "负责人",
			},
			BACKGROUND_CONTEXT,
		);

		expect(result.ok, "截断不得当作成功").toBe(false);
		expect(result.reason).toBe("failed");
		expect(result.text).toContain("截断");
	});
});
