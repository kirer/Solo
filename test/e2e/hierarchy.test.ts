/**
 * 组织汇报线与工作目录的回归测试。
 *
 * 两个真实事故：
 *
 * 1) **负责人被架空**：立项时没给项目负责人装能力包，他没有任何工具，
 *    全程 0 token；管理层（CTO）于是用 staff_assign 越过他直接指挥项目员工。
 *    正确链路是 员工 → 项目负责人 → 管理层。
 *
 * 2) **员工命令全废**：工作空间登记成相对路径（`--workspace workspace/company-empty`
 *    启动时就会这样），执行环境把相对 cwd 又拼了一次进程目录，最终路径
 *    `<进程目录>/<相对路径>/<相对路径>` 不存在，bash 一律报
 *    「Working directory does not exist」——连 `echo test` 都跑不了。
 */
import { afterEach, describe, expect, test } from "vitest";
import { stat } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
	createEnvironmentRegistry,
	createRegistry,
	openCompany,
	recover,
	type CompanyRuntime,
} from "../../src/runtime/index.ts";
import {
	bootstrapCompany,
	createProject,
	deleteProject,
	hireStaff,
	migrateWorkspacePaths,
	readCompany,
	terminateProject,
} from "../../src/company/org.ts";
import { CompanyDoc } from "../../src/company/docs.ts";
import { delegate } from "../../src/company/delegation.ts";
import { answer, createTestContext, toolCall, type TestContext, TEST_MODEL_CATALOG } from "../support.ts";

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

async function boot(
	ctx: TestContext,
	runtime: CompanyRuntime,
	registry: ReturnType<typeof createRegistry>,
): Promise<void> {
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
}

afterEach(async () => {
	for (const runtime of runtimes) await runtime.close().catch(() => undefined);
	for (const ctx of contexts) await ctx.cleanup();
	runtimes = [];
	contexts = [];
});

describe("工作空间路径必须是绝对路径", () => {
	test("workspaceRoot 给相对路径时，立项仍登记绝对路径", async () => {
		const { ctx, runtime, registry } = await setup();
		await boot(ctx, runtime, registry);

		// 模拟 `--workspace workspace/company-empty`：调用方传的是相对路径
		const { project } = await createProject(
			runtime,
			{ name: "Alpha", brief: "测试项目", workspaceRoot: "workspace/company-empty/projects" },
			BACKGROUND_CONTEXT,
		);

		expect(isAbsolute(project.workspace), `workspace 应为绝对路径：${project.workspace}`).toBe(true);
		expect((await stat(project.workspace)).isDirectory()).toBe(true);

		const state = await readCompany(runtime, BACKGROUND_CONTEXT);
		expect(state?.projects.alpha?.workspace).toBe(project.workspace);
	});

	test("相对 cwd 被规整成绝对路径后 bash 可用", async () => {
		const environments = createEnvironmentRegistry();
		// 相对 cwd 正是事故里的形态：执行环境若原样使用，就会再拼一次进程目录
		const env = await environments.factory(
			{ conversationId: 1, cwd: "workspace/company-empty/projects/dino-runner" },
			BACKGROUND_CONTEXT,
		);
		expect(env).toBeDefined();
		expect(env?.cwd).toBe(join(process.cwd(), "workspace/company-empty/projects/dino-runner"));

		// 目录不存在时会报 spawn_error；这里只断言「没有被拼成重复路径」
		const result = await env?.exec("pwd", undefined, BACKGROUND_CONTEXT);
		if (result?.ok === false) {
			expect(result.error.message).not.toContain(
				"workspace/company-empty/projects/dino-runner/workspace/company-empty/projects/dino-runner",
			);
		}
		await environments.cleanup(BACKGROUND_CONTEXT);
	});

	test("员工与负责人拿到的是项目绝对路径", async () => {
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

		const leader = await runtime.harness.conversation(project.leader as never, BACKGROUND_CONTEXT);
		const staff = await runtime.harness.conversation(hired.conversationId as never, BACKGROUND_CONTEXT);
		expect((await leader?.agent(BACKGROUND_CONTEXT))?.cwd).toBe(project.workspace);
		expect((await staff?.agent(BACKGROUND_CONTEXT))?.cwd).toBe(project.workspace);
	});

	test("历史相对路径被迁移成绝对路径", async () => {
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

		// 复刻事故现场：索引与两个会话的 cwd 都被写成相对路径
		await runtime.harness.commit(async (tx) => {
			const company = await tx.doc(CompanyDoc);
			const entry = company.projects.alpha;
			if (entry !== undefined) company.projects.alpha = { ...entry, workspace: "projects/alpha" };
		}, BACKGROUND_CONTEXT);
		for (const id of [project.leader, hired.conversationId]) {
			const conversation = await runtime.harness.conversation(id as never, BACKGROUND_CONTEXT);
			await conversation?.configure({ cwd: "projects/alpha" }, BACKGROUND_CONTEXT);
		}

		const migrated = await migrateWorkspacePaths(runtime, BACKGROUND_CONTEXT);
		expect(migrated).toBeGreaterThanOrEqual(2);

		// 相对路径按进程目录解析（这正是 CLI 传相对 --workspace 时的语义）
		const expected = join(process.cwd(), "projects/alpha");
		const state = await readCompany(runtime, BACKGROUND_CONTEXT);
		expect(state?.projects.alpha?.workspace).toBe(expected);
		expect(isAbsolute(state?.projects.alpha?.workspace ?? "")).toBe(true);

		const leader = await runtime.harness.conversation(project.leader as never, BACKGROUND_CONTEXT);
		const agent = await leader?.agent(BACKGROUND_CONTEXT);
		expect(agent?.cwd).toBe(expected);
	});

	test("旧负责人只选了部分能力包时会被纠正为唯一 role-leader", async () => {
		const { ctx, runtime, registry } = await setup();
		await boot(ctx, runtime, registry);
		const { project } = await createProject(
			runtime,
			{ name: "Alpha", brief: "测试项目", workspaceRoot: join(ctx.dir, "projects") },
			BACKGROUND_CONTEXT,
		);

		// 复刻旧数据：负责人会话没显式选过能力包（底层默认=全部已注册）。
		const leader = await runtime.harness.conversation(project.leader as never, BACKGROUND_CONTEXT);
		await leader?.configure({ extensions: [] }, BACKGROUND_CONTEXT);
		const before = (await leader?.agent(BACKGROUND_CONTEXT))?.extensions.length ?? 0;
		expect(before).toBe(0);

		// 再跑一次启动装配（幂等入口）
		await boot(ctx, runtime, registry);

		const after = await leader?.agent(BACKGROUND_CONTEXT);
		expect(after?.extensions.map((item) => item.name)).toEqual(["role-leader"]);
		expect(after?.instructions).toContain("你是「Alpha」项目的负责人");
	});

	test("迁移重开后不再重复写库（幂等）", async () => {
		const { ctx, runtime, registry } = await setup();
		await boot(ctx, runtime, registry);
		await createProject(
			runtime,
			{ name: "Alpha", brief: "测试项目", workspaceRoot: join(ctx.dir, "projects") },
			BACKGROUND_CONTEXT,
		);

		expect(await migrateWorkspacePaths(runtime, BACKGROUND_CONTEXT)).toBe(0);
	});
});

describe("换工作空间根启动后仍然能删除项目", () => {
	test("启动时刷新 workspaceRoot，project_delete 的路径校验不再误拒", async () => {
		const { ctx, runtime, registry } = await setup();
		// 用相对根启动（等价于 `--workspace workspace/company-empty`）
		const relativeRoot = "workspace/company-empty/projects";
		await bootstrapCompany(
			runtime,
			{
				modelCatalog: [...TEST_MODEL_CATALOG],
				companyName: "测试公司",
				registry,
				workspaceRoot: relativeRoot,
			},
			BACKGROUND_CONTEXT,
		);

		const { project } = await createProject(
			runtime,
			{ name: "Alpha", brief: "测试项目", workspaceRoot: relativeRoot },
			BACKGROUND_CONTEXT,
		);
		const absoluteRoot = join(process.cwd(), relativeRoot);
		expect((await readCompany(runtime, BACKGROUND_CONTEXT))?.workspaceRoot).toBe(absoluteRoot);

		await terminateProject(
			runtime,
			{ project: "alpha", reason: "老板要求删除", by: "CEO", fromConversationId: 1 },
			BACKGROUND_CONTEXT,
		);
		const result = await deleteProject(
			runtime,
			{ project: "alpha", by: "CEO", fromConversationId: 1 },
			BACKGROUND_CONTEXT,
		);

		expect(result.ok, result.message).toBe(true);
		expect(result.removedFiles).toBeGreaterThan(0);
		expect(result.workspace).toBe(project.workspace);
	});
});

describe("项目负责人是员工与管理层之间的一层", () => {
	test("负责人有派活、上报、写计划的能力", async () => {
		const { ctx, runtime, registry } = await setup();
		await boot(ctx, runtime, registry);
		const { project } = await createProject(
			runtime,
			{ name: "Alpha", brief: "测试项目", workspaceRoot: join(ctx.dir, "projects") },
			BACKGROUND_CONTEXT,
		);

		const leader = await runtime.harness.conversation(project.leader as never, BACKGROUND_CONTEXT);
		const agent = await leader?.agent(BACKGROUND_CONTEXT);
		const tools = agent?.tools.map((tool) => tool.name) ?? [];

		expect(tools).toContain("staff_assign");
		expect(tools).toContain("staff_list");
		expect(tools).toContain("escalate");
		expect(tools).toContain("delegate_to_role");
		expect(tools).toContain("project_plan");
		// 公司级动作不在负责人手上
		expect(tools).not.toContain("project_create");
		expect(tools).not.toContain("project_terminate");
		expect(tools).not.toContain("staff_hire");
	});

	test("负责人可以给自己项目的员工派活", async () => {
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

		ctx.faux.setResponses([answer("写好了")]);
		const result = await delegate(
			runtime,
			{
				project: "alpha",
				employee: "dev-1",
				task: "实现首页",
				fromConversationId: project.leader,
				from: project.leaderName,
			},
			BACKGROUND_CONTEXT,
		);

		expect(result.ok).toBe(true);
		expect(result.text).toContain("写好了");
		expect(result.conversationId).toBe(hired.conversationId);
	});

	test("管理层通过负责人推进工作，不直接指挥员工", async () => {
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
		const state = await readCompany(runtime, BACKGROUND_CONTEXT);
		const ctoId = state?.roles.cto ?? 0;
		expect(ctoId).toBeGreaterThan(0);

		// CTO 收到「推进项目」→ 调 delegate_to_leader；负责人拆活派给 dev-1。
		ctx.faux.setResponses([
			toolCall("delegate_to_leader", { project: "alpha", task: "把首页做出来" }),
			toolCall("staff_assign", { project: "alpha", employee: "dev-1", task: "写 index.html" }),
			answer("首页已完成"),
			answer("负责人回报：首页已完成"),
			answer("CTO 汇报：项目已推进"),
		]);

		const cto = await runtime.harness.conversation(ctoId as never, BACKGROUND_CONTEXT);
		const settled = await (
			await cto?.submit({ type: "input", content: "推进 Alpha 项目" }, BACKGROUND_CONTEXT)
		)?.wait(BACKGROUND_CONTEXT);
		expect(settled?.status).toBe("done");

		// 员工确实被负责人派到了活
		const employee = await runtime.harness.conversation(hired.conversationId as never, BACKGROUND_CONTEXT);
		const entries = await employee?.entries({ order: "ascending" }, 100, undefined, BACKGROUND_CONTEXT);
		const userTexts = (entries?.items ?? [])
			.filter((entry) => entry.kind === "pi.user" || entry.kind === "app.delegate")
			.map((entry) => JSON.stringify(entry.model))
			.join("\n");
		expect(userTexts).toContain("写 index.html");
	});

	test("CTO 的能力里不再有 staff_assign 这个直连员工的工具", async () => {
		const { ctx, runtime, registry } = await setup();
		await boot(ctx, runtime, registry);

		const state = await readCompany(runtime, BACKGROUND_CONTEXT);
		const cto = await runtime.harness.conversation((state?.roles.cto ?? 0) as never, BACKGROUND_CONTEXT);
		const tools = (await cto?.agent(BACKGROUND_CONTEXT))?.tools.map((tool) => tool.name) ?? [];
		expect(tools).toContain("delegate_to_leader");
		expect(tools).not.toContain("staff_assign");
	});

	test("负责人不能给别的项目派活", async () => {
		const { ctx, runtime, registry } = await setup();
		await boot(ctx, runtime, registry);
		const alpha = (
			await createProject(
				runtime,
				{ name: "Alpha", brief: "测试项目", workspaceRoot: join(ctx.dir, "projects") },
				BACKGROUND_CONTEXT,
			)
		).project;
		await createProject(
			runtime,
			{ name: "Beta", brief: "另一个项目", workspaceRoot: join(ctx.dir, "projects") },
			BACKGROUND_CONTEXT,
		);
		await hireStaff(runtime, { project: "beta", name: "dev-2", role: "开发", manager: "cto" }, BACKGROUND_CONTEXT);

		const result = await delegate(
			runtime,
			{
				project: "beta",
				employee: "dev-2",
				task: "帮个忙",
				fromConversationId: alpha.leader,
				from: alpha.leaderName,
			},
			BACKGROUND_CONTEXT,
		);

		expect(result.ok).toBe(false);
		expect(result.reason).toBe("cross-project");
		expect(result.text).toContain("CHRO");
	});
});

describe("圆桌讨论的能力只给该给的人", () => {
	test("项目负责人与员工都没有 roundtable", async () => {
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

		const leaderTools =
			(await (await runtime.harness.conversation(project.leader as never, BACKGROUND_CONTEXT))?.agent(
				BACKGROUND_CONTEXT,
			))?.tools.map((tool) => tool.name) ?? [];
		const staffTools =
			(await (await runtime.harness.conversation(hired.conversationId as never, BACKGROUND_CONTEXT))?.agent(
				BACKGROUND_CONTEXT,
			))?.tools.map((tool) => tool.name) ?? [];

		// 圆桌是管理层拍板用的：负责人与员工都不能自己召集管理层开会（ADR-004）
		expect(leaderTools).not.toContain("roundtable");
		expect(staffTools).not.toContain("roundtable");
		expect(staffTools).toEqual([]);
	});
});
