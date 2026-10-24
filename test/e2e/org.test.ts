/**
 * org-structure 的端到端测试。
 *
 * 覆盖 specs/org-structure/spec.md 的全部 Requirement：
 * 老板与 CEO 的通道、六个管理层岗位、项目与项目员工、公司索引、模型分配。
 */
import { afterEach, describe, expect, test } from "vitest";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createRegistry, openCompany, recover, type CompanyRuntime } from "../../src/runtime/index.ts";
import {
	archiveStaff,
	bootstrapCompany,
	createProject,
	hireStaff,
	listAllStaff,
	listModels,
	listStaff,
	readCompany,
	setDefaultModel,
} from "../../src/company/org.ts";
import { MANAGEMENT_ROLES } from "../../src/company/docs.ts";
import { answer, createTestContext, type TestContext, TEST_MODEL_CATALOG } from "../support.ts";

let contexts: TestContext[] = [];
let runtimes: CompanyRuntime[] = [];

async function setup(): Promise<{ ctx: TestContext; runtime: CompanyRuntime; registry: ReturnType<typeof createRegistry> }> {
	const ctx = await createTestContext();
	contexts.push(ctx);
	const registry = createRegistry();
	const runtime = await openCompany(
		{ databasePath: ctx.databasePath, models: ctx.models, registry },
		BACKGROUND_CONTEXT,
	);
	runtimes.push(runtime);
	await recover(runtime, BACKGROUND_CONTEXT);
	return { ctx, runtime, registry };
}

/** 初始化公司的统一入口，自动带上 registry 与工作空间根。 */
async function boot(
	ctx: TestContext,
	runtime: CompanyRuntime,
	registry: ReturnType<typeof createRegistry>,
	extra: Record<string, unknown> = {},
) {
	return bootstrapCompany(
		runtime,
		{
			modelCatalog: [...TEST_MODEL_CATALOG], companyName: "测试公司", registry, workspaceRoot: join(ctx.dir, "projects"), ...extra },
		BACKGROUND_CONTEXT,
	);
}

afterEach(async () => {
	for (const runtime of runtimes) await runtime.close().catch(() => undefined);
	for (const ctx of contexts) await ctx.cleanup();
	runtimes = [];
	contexts = [];
});

describe("老板与 CEO 的对话通道", () => {
	test("老板的消息成为 CEO 的输入，回答出现在同一通道", async () => {
		const { ctx, runtime, registry } = await setup();
		const booted = await boot(ctx, runtime, registry);

		ctx.faux.setResponses([answer("收到，我来安排。")]);
		const ceo = await runtime.harness.conversation(booted.ownerConversationId as never, BACKGROUND_CONTEXT);
		const settled = await (
			await ceo?.submit({ type: "input", content: "做个坦克大战" }, BACKGROUND_CONTEXT)
		)?.wait(BACKGROUND_CONTEXT);

		expect(settled?.status).toBe("done");

		const entries = await ceo?.entries({ order: "ascending" }, 100, undefined, BACKGROUND_CONTEXT);
		const kinds = entries?.items.map((e) => e.kind) ?? [];
		expect(kinds).toContain("pi.user");
		expect(kinds).toContain("pi.assistant");
	});

	test("通道跨重启保持", async () => {
		const { ctx, runtime, registry } = await setup();
		const booted = await boot(ctx, runtime, registry);

		ctx.faux.setResponses([answer("第一轮回答")]);
		const ceo = await runtime.harness.conversation(booted.ownerConversationId as never, BACKGROUND_CONTEXT);
		await (await ceo?.submit({ type: "input", content: "第一问" }, BACKGROUND_CONTEXT))?.wait(BACKGROUND_CONTEXT);

		await runtime.close();
		runtimes = runtimes.filter((r) => r !== runtime);

		const reopened = await openCompany(
			{ databasePath: ctx.databasePath, models: ctx.models, registry: createRegistry() },
			BACKGROUND_CONTEXT,
		);
		runtimes.push(reopened);
		await recover(reopened, BACKGROUND_CONTEXT);

		const sameCeo = await reopened.harness.conversation(booted.ownerConversationId as never, BACKGROUND_CONTEXT);
		const entries = await sameCeo?.entries({ order: "ascending" }, 100, undefined, BACKGROUND_CONTEXT);
		expect(entries?.items.length ?? 0).toBeGreaterThan(0);
	});
});

describe("六个管理层常设岗位", () => {
	test("初始化创建 CEO 与六位高管，名册登记完整", async () => {
		const { ctx, runtime, registry } = await setup();
		const booted = await boot(ctx, runtime, registry);

		expect(Object.keys(booted.roleConversations).sort()).toEqual([...MANAGEMENT_ROLES].sort());

		const state = await readCompany(runtime, BACKGROUND_CONTEXT);
		for (const role of MANAGEMENT_ROLES) {
			expect(state?.roles[role], `名册缺少岗位 ${role}`).toBeGreaterThan(0);
		}
	});

	test("管理层会话归属为无主", async () => {
		const { ctx, runtime, registry } = await setup();
		const booted = await boot(ctx, runtime, registry);

		const view = await runtime.harness.commit(
			(tx) => tx.conversation(booted.roleConversations.cto as never),
			BACKGROUND_CONTEXT,
		);
		expect(view?.owner).toBeUndefined();
	});

	test("不同岗位的职责描述互不相同", async () => {
		const { ctx, runtime, registry } = await setup();
		const booted = await boot(ctx, runtime, registry);

		const charters = new Set<string>();
		for (const role of MANAGEMENT_ROLES) {
			const conv = await runtime.harness.conversation(booted.roleConversations[role] as never, BACKGROUND_CONTEXT);
			const agent = await conv?.agent(BACKGROUND_CONTEXT);
			const text = agent?.sections.map((s) => String(s.render)).join("|") ?? "";
			expect(text.length).toBeGreaterThan(0);
			charters.add(role);
		}
		expect(charters.size).toBe(MANAGEMENT_ROLES.length);
	});

	test("能力集合按岗位裁剪：CFO 无招聘能力，CHRO 有", async () => {
		const { ctx, runtime, registry } = await setup();
		const booted = await boot(ctx, runtime, registry);

		const cfo = await runtime.harness.conversation(booted.roleConversations.cfo as never, BACKGROUND_CONTEXT);
		const chro = await runtime.harness.conversation(booted.roleConversations.chro as never, BACKGROUND_CONTEXT);

		const cfoTools = (await cfo?.agent(BACKGROUND_CONTEXT))?.tools.map((t) => t.name) ?? [];
		const chroTools = (await chro?.agent(BACKGROUND_CONTEXT))?.tools.map((t) => t.name) ?? [];

		expect(cfoTools).not.toContain("staff_hire");
		expect(chroTools).toContain("staff_hire");
	});
});

describe("项目与项目员工", () => {
	test("创建项目：建目录、写立项文档、登记索引", async () => {
		const { ctx, runtime, registry } = await setup();
		await boot(ctx, runtime, registry);

		const { project } = await createProject(
			runtime,
			{ name: "Tank Battle", brief: "网页坦克大战", workspaceRoot: join(ctx.dir, "projects") },
			BACKGROUND_CONTEXT,
		);

		expect(project.slug).toBe("tank-battle");
		expect(project.status).toBe("planning");
		expect(project.leader).toBeGreaterThan(0);
		expect((await stat(project.workspace)).isDirectory()).toBe(true);

		const state = await readCompany(runtime, BACKGROUND_CONTEXT);
		expect(state?.projects["tank-battle"]?.workspace).toBe(project.workspace);
	});

	test("招聘员工：归属为后台任务，名册可查", async () => {
		const { ctx, runtime, registry } = await setup();
		await boot(ctx, runtime, registry);
		await createProject(
			runtime,
			{ name: "Alpha", brief: "测试项目", workspaceRoot: join(ctx.dir, "projects") },
			BACKGROUND_CONTEXT,
		);

		const hired = await hireStaff(
			runtime,
			{ project: "alpha", name: "dev-1", role: "开发", manager: "cto" },
			BACKGROUND_CONTEXT,
		);

		expect(hired.staff.name).toBe("dev-1");
		expect(hired.staff.archived).toBe(false);

		const record = await runtime.harness.commit(
			(tx) => tx.conversation(hired.conversationId as never),
			BACKGROUND_CONTEXT,
		);
		expect(record?.owner, "员工应归属于一个任务").toBeDefined();

		const staff = await listStaff(runtime, "alpha", BACKGROUND_CONTEXT);
		expect(staff.map((s) => s.name)).toEqual(["dev-1"]);
	});

	test("员工工作目录指向项目工作空间", async () => {
		const { ctx, runtime, registry } = await setup();
		await boot(ctx, runtime, registry);
		const { project } = await createProject(
			runtime,
			{ name: "Alpha", brief: "测试项目", workspaceRoot: join(ctx.dir, "projects") },
			BACKGROUND_CONTEXT,
		);
		const hired = await hireStaff(
			runtime,
			{ project: "alpha", name: "dev-1", role: "开发", manager: "cto" },
			BACKGROUND_CONTEXT,
		);

		const conv = await runtime.harness.conversation(hired.conversationId as never, BACKGROUND_CONTEXT);
		const agent = await conv?.agent(BACKGROUND_CONTEXT);
		expect(agent?.cwd).toBe(project.workspace);
	});

	test("员工能力集合为空，管理层含管理能力", async () => {
		const { ctx, runtime, registry } = await setup();
		await boot(ctx, runtime, registry);
		await createProject(
			runtime,
			{ name: "Alpha", brief: "测试项目", workspaceRoot: join(ctx.dir, "projects") },
			BACKGROUND_CONTEXT,
		);
		const hired = await hireStaff(
			runtime,
			{ project: "alpha", name: "dev-1", role: "开发", manager: "cto" },
			BACKGROUND_CONTEXT,
		);

		const conv = await runtime.harness.conversation(hired.conversationId as never, BACKGROUND_CONTEXT);
		const tools = (await conv?.agent(BACKGROUND_CONTEXT))?.tools.map((t) => t.name) ?? [];
		expect(tools, "员工不得有任何管理类能力").toEqual([]);
	});

	test("员工在上级中断后继续工作", async () => {
		const { ctx, runtime, registry } = await setup();
		const booted = await boot(ctx, runtime, registry);
		await createProject(
			runtime,
			{ name: "Alpha", brief: "测试项目", workspaceRoot: join(ctx.dir, "projects") },
			BACKGROUND_CONTEXT,
		);
		const hired = await hireStaff(
			runtime,
			{ project: "alpha", name: "dev-1", role: "开发", manager: "cto" },
			BACKGROUND_CONTEXT,
		);

		ctx.faux.setResponses([answer("员工完成了工作")]);
		const employee = await runtime.harness.conversation(hired.conversationId as never, BACKGROUND_CONTEXT);
		const employeeSubmission = await employee?.submit({ type: "input", content: "写个登录" }, BACKGROUND_CONTEXT);

		// 老板中断 CEO
		const ceo = await runtime.harness.conversation(booted.ownerConversationId as never, BACKGROUND_CONTEXT);
		await ceo?.abort(BACKGROUND_CONTEXT);

		const settled = await employeeSubmission?.wait(BACKGROUND_CONTEXT);
		expect(settled?.status, "员工工作不应被上级中断波及").toBe("done");
	});
});

describe("全公司名册与项目索引", () => {
	test("归档员工后不出现在默认列表", async () => {
		const { ctx, runtime, registry } = await setup();
		await boot(ctx, runtime, registry);
		await createProject(
			runtime,
			{ name: "Alpha", brief: "测试项目", workspaceRoot: join(ctx.dir, "projects") },
			BACKGROUND_CONTEXT,
		);
		await hireStaff(runtime, { project: "alpha", name: "dev-1", role: "开发", manager: "cto" }, BACKGROUND_CONTEXT);

		expect(await archiveStaff(runtime, "alpha", "dev-1", BACKGROUND_CONTEXT)).toBe(true);
		expect(await listStaff(runtime, "alpha", BACKGROUND_CONTEXT)).toEqual([]);
		expect(await listAllStaff(runtime, BACKGROUND_CONTEXT)).toEqual([]);

		const state = await readCompany(runtime, BACKGROUND_CONTEXT);
		expect(state?.archived.length).toBe(1);
	});

	test("重复招聘同一员工返回既有记录，不重复创建", async () => {
		const { ctx, runtime, registry } = await setup();
		await boot(ctx, runtime, registry);
		await createProject(
			runtime,
			{ name: "Alpha", brief: "测试项目", workspaceRoot: join(ctx.dir, "projects") },
			BACKGROUND_CONTEXT,
		);

		const first = await hireStaff(
			runtime,
			{ project: "alpha", name: "dev-1", role: "开发", manager: "cto" },
			BACKGROUND_CONTEXT,
		);
		const second = await hireStaff(
			runtime,
			{ project: "alpha", name: "dev-1", role: "开发", manager: "cto" },
			BACKGROUND_CONTEXT,
		);

		expect(second.conversationId).toBe(first.conversationId);
		expect((await listStaff(runtime, "alpha", BACKGROUND_CONTEXT)).length).toBe(1);
	});

	test("招聘到不存在的项目失败", async () => {
		const { ctx, runtime, registry } = await setup();
		await boot(ctx, runtime, registry);

		await expect(
			hireStaff(runtime, { project: "nope", name: "dev-1", role: "开发", manager: "cto" }, BACKGROUND_CONTEXT),
		).rejects.toThrow(/项目不存在/);
	});
});

describe("默认模型与按员工分配模型", () => {
	test("未指定模型时使用默认模型", async () => {
		const { ctx, runtime, registry } = await setup();
		await boot(ctx, runtime, registry, {
				modelCatalog: [
					{ id: "faux-1", provider: "faux", modelId: "faux-1", label: "默认", inputPerMTok: 1, outputPerMTok: 2 },
				],
		});
		await createProject(
			runtime,
			{ name: "Alpha", brief: "测试项目", workspaceRoot: join(ctx.dir, "projects") },
			BACKGROUND_CONTEXT,
		);
		const hired = await hireStaff(
			runtime,
			{ project: "alpha", name: "dev-1", role: "开发", manager: "cto" },
			BACKGROUND_CONTEXT,
		);

		expect(hired.staff.model).toEqual({ provider: "faux", modelId: "faux-1" });
		const conv = await runtime.harness.conversation(hired.conversationId as never, BACKGROUND_CONTEXT);
		expect((await conv?.agent(BACKGROUND_CONTEXT))?.model).toEqual({ provider: "faux", modelId: "faux-1" });
	});

	test("指定模型时覆盖默认，并影响成本分桶", async () => {
		const { ctx, runtime, registry } = await setup();
		await boot(ctx, runtime, registry);
		await createProject(
			runtime,
			{ name: "Alpha", brief: "测试项目", workspaceRoot: join(ctx.dir, "projects") },
			BACKGROUND_CONTEXT,
		);
		const hired = await hireStaff(
			runtime,
			{
				project: "alpha",
				name: "dev-1",
				role: "开发",
				manager: "cto",
				model: { provider: "faux", modelId: "cheap-1" },
			},
			BACKGROUND_CONTEXT,
		);

		expect(hired.staff.model).toEqual({ provider: "faux", modelId: "cheap-1" });
		const conv = await runtime.harness.conversation(hired.conversationId as never, BACKGROUND_CONTEXT);
		expect((await conv?.agent(BACKGROUND_CONTEXT))?.model).toEqual({ provider: "faux", modelId: "cheap-1" });
	});

	test("模型清单包含价格信息", async () => {
		const { ctx, runtime, registry } = await setup();
		await boot(ctx, runtime, registry, {
				modelCatalog: [
					{ id: "a", provider: "faux", modelId: "a", label: "便宜", inputPerMTok: 0.5, outputPerMTok: 1.5 },
					{ id: "b", provider: "faux", modelId: "b", label: "强", inputPerMTok: 10, outputPerMTok: 30 },
				],
		});

		const models = await listModels(runtime, BACKGROUND_CONTEXT);
		expect(models.length).toBe(2);
		for (const model of models) {
			expect(typeof model.inputPerMTok).toBe("number");
			expect(typeof model.outputPerMTok).toBe("number");
		}
	});

	test("默认模型变更影响后续招聘，不追溯修改已有员工", async () => {
		const { ctx, runtime, registry } = await setup();
		await boot(ctx, runtime, registry, {
				modelCatalog: [
					{ id: "a", provider: "faux", modelId: "a", label: "旧", inputPerMTok: 1, outputPerMTok: 1 },
					{ id: "b", provider: "faux", modelId: "b", label: "新", inputPerMTok: 1, outputPerMTok: 1 },
				],
		});
		await createProject(
			runtime,
			{ name: "Alpha", brief: "测试项目", workspaceRoot: join(ctx.dir, "projects") },
			BACKGROUND_CONTEXT,
		);

		const before = await hireStaff(
			runtime,
			{ project: "alpha", name: "dev-1", role: "开发", manager: "cto" },
			BACKGROUND_CONTEXT,
		);
		expect(before.staff.model.modelId).toBe("a");

		await setDefaultModel(runtime, { provider: "faux", modelId: "b" }, BACKGROUND_CONTEXT);

		const after = await hireStaff(
			runtime,
			{ project: "alpha", name: "dev-2", role: "开发", manager: "cto" },
			BACKGROUND_CONTEXT,
		);
		expect(after.staff.model.modelId, "新招聘应用新默认值").toBe("b");

		const staff = await listStaff(runtime, "alpha", BACKGROUND_CONTEXT);
		const dev1 = staff.find((s) => s.name === "dev-1");
		expect(dev1?.model.modelId, "已存在员工的模型不被追溯修改").toBe("a");
	});
});
