/**
 * 项目终止的测试。
 *
 * 老板跟 CEO 说「停掉这个项目」时，系统要真的停下来：
 * 员工在跑的活中断、状态标记终止、员工归档、待办清掉、数据不丢。
 */
import { afterEach, describe, expect, test } from "vitest";
import { join } from "node:path";
import { BACKGROUND_CONTEXT, createRegistry, openCompany, recover, type CompanyRuntime } from "../../src/runtime/index.ts";
import {
	bootstrapCompany,
	COMPANY_TASKS_EXTENSION,
	createProject,
	deleteProject,
	hireStaff,
	listStaff,
	readCompany,
	terminateProject,
} from "../../src/company/org.ts";
import { createEscalationTask, listPending, startEscalation } from "../../src/company/escalation.ts";
import { buildOrgView } from "../../src/server/org-view.ts";
import { askAndWait, createTestContext, eventually, slowAnswer, TEST_MODEL_CATALOG, type TestContext } from "../support.ts";

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
	registry.install(COMPANY_TASKS_EXTENSION);
	const escalationTask = createEscalationTask(runtime);
	registry.install({ name: "escalation", tasks: [escalationTask] } as never);

	const boot = await bootstrapCompany(
		runtime,
		{
			companyName: "测试公司",
			modelCatalog: [...TEST_MODEL_CATALOG],
			registry,
			workspaceRoot: join(ctx.dir, "projects"),
			escalationTask,
		},
		BACKGROUND_CONTEXT,
	);

	const { project } = await createProject(
		runtime,
		{ name: "坦克大战", slug: "tank-battle", brief: "网页游戏", leaderName: "陆沉", workspaceRoot: join(ctx.dir, "projects") },
		BACKGROUND_CONTEXT,
	);

	for (const [name, role] of [
		["林越", "开发"],
		["沈舟", "测试"],
	] as const) {
		await hireStaff(runtime, { project: "tank-battle", name, role, manager: "cto", registry }, BACKGROUND_CONTEXT);
	}

	return { ctx, runtime, boot, project, escalationTask };
}

afterEach(async () => {
	for (const runtime of runtimes) await runtime.close().catch(() => undefined);
	for (const ctx of contexts) await ctx.cleanup();
	runtimes = [];
	contexts = [];
});

describe("终止项目", () => {
	test("状态变终止并记下原因", async () => {
		const { runtime, boot, project } = await setup();

		const result = await terminateProject(
			runtime,
			{
				project: "tank-battle",
				reason: "优先级调整，先不做了",
				by: "CEO",
				fromConversationId: boot.ownerConversationId,
			},
			BACKGROUND_CONTEXT,
		);

		expect(result.ok).toBe(true);
		expect(result.archivedStaff).toBe(2);

		const state = await readCompany(runtime, BACKGROUND_CONTEXT);
		const entry = state?.projects["tank-battle"];
		expect(entry?.status).toBe("terminated");
		expect(entry?.terminated?.reason).toBe("优先级调整，先不做了");
		expect(entry?.terminated?.by).toBe("CEO");
		void project;
	});

	test("员工全部归档，不再出现在在岗名单", async () => {
		const { runtime, boot } = await setup();
		await terminateProject(
			runtime,
			{ project: "tank-battle", reason: "不做了", by: "CEO", fromConversationId: boot.ownerConversationId },
			BACKGROUND_CONTEXT,
		);

		expect(await listStaff(runtime, "tank-battle", BACKGROUND_CONTEXT)).toEqual([]);
	});

	test("正在跑的活被中断", async () => {
		const { ctx, runtime, boot, project } = await setup();

		// 让员工干一件慢活。
		// 注：faux 的慢响应不理会中断信号，所以要等它自然结束；
		// 真实 provider 会立刻中断（实测 7ms）。
		ctx.faux.setResponses([slowAnswer(1_200, "慢慢做")]);
		const staff = (await listStaff(runtime, "tank-battle", BACKGROUND_CONTEXT)).find((person) => person.name === "林越");
		const pending = askAndWait(
			runtime,
			{ conversationId: staff?.conversationId as number, text: "写个很长的东西", from: "负责人" },
			BACKGROUND_CONTEXT,
		);

		// 等它真的开始跑
		await eventually(
			async () => {
				const inspection = await runtime.harness.inspect(BACKGROUND_CONTEXT);
				return inspection.tasks.some((task) => task.state.kind === "running");
			},
			{ label: "员工开始干活" },
		);

		const result = await terminateProject(
			runtime,
			{ project: "tank-battle", reason: "立刻停", by: "CEO", fromConversationId: boot.ownerConversationId },
			BACKGROUND_CONTEXT,
		);
		expect(result.stoppedConversations).toBeGreaterThanOrEqual(2);

		// 这一轮应当以失败收场（被中断的不该算做完）
		const outcome = await pending;
		expect(outcome.ok, "被中断的一轮不应算成功").toBe(false);
	}, 20_000);

	test("该项目挂着的待办自动关闭", async () => {
		const { runtime, boot, project, escalationTask } = await setup();

		await startEscalation(
			runtime,
			escalationTask,
			{
				question: "坦克大战要不要加联机？",
				from: "林越",
				fromConversationId: project.leader,
				manager: "ceo",
				escalationKey: "term-esc",
				project: "tank-battle",
			},
			BACKGROUND_CONTEXT,
		);
		await eventually(async () => (await listPending(runtime, BACKGROUND_CONTEXT)).length > 0, { label: "待决出现" });

		await terminateProject(
			runtime,
			{ project: "tank-battle", reason: "不做了", by: "CEO", fromConversationId: boot.ownerConversationId },
			BACKGROUND_CONTEXT,
		);

		const pending = await listPending(runtime, BACKGROUND_CONTEXT);
		expect(pending, "项目终止后不应残留该项目的待办").toEqual([]);
	});

	test("重复终止返回明确提示而不是报错", async () => {
		const { runtime, boot } = await setup();
		await terminateProject(
			runtime,
			{ project: "tank-battle", reason: "第一次", by: "CEO", fromConversationId: boot.ownerConversationId },
			BACKGROUND_CONTEXT,
		);

		const second = await terminateProject(
			runtime,
			{ project: "tank-battle", reason: "第二次", by: "CEO", fromConversationId: boot.ownerConversationId },
			BACKGROUND_CONTEXT,
		);

		expect(second.ok).toBe(false);
		expect(second.message).toContain("已经终止");
	});

	test("终止不存在的项目返回失败", async () => {
		const { runtime, boot } = await setup();
		const result = await terminateProject(
			runtime,
			{ project: "nope", reason: "x", by: "CEO", fromConversationId: boot.ownerConversationId },
			BACKGROUND_CONTEXT,
		);
		expect(result.ok).toBe(false);
	});

	test("终止后组织视图里能看到终止标记与归档员工", async () => {
		const { runtime, boot } = await setup();
		await terminateProject(
			runtime,
			{ project: "tank-battle", reason: "预算不够", by: "CEO", fromConversationId: boot.ownerConversationId },
			BACKGROUND_CONTEXT,
		);

		const view = await buildOrgView(runtime, BACKGROUND_CONTEXT);
		const project = view.projects.find((item) => item.slug === "tank-battle");

		expect(project?.status).toBe("terminated");
		expect(project?.terminated?.reason).toBe("预算不够");
		expect(project?.staff.every((person) => person.archived === true)).toBe(true);
		expect(project?.staff.length, "员工仍应列出，只是标成已归档").toBe(2);
	});
});

describe("确认后彻底删除", () => {
	test("未终止的项目不能删", async () => {
		const { runtime, boot } = await setup();
		const result = await deleteProject(
			runtime,
			{ project: "tank-battle", by: "CEO", fromConversationId: boot.ownerConversationId },
			BACKGROUND_CONTEXT,
		);

		expect(result.ok).toBe(false);
		expect(result.message, "应当提示先终止").toContain("还没终止");
	});

	test("终止后删除：项目、员工、产物全部清掉", async () => {
		const { runtime, boot, project } = await setup();

		// 先在工作空间里放一些"产物"
		const { writeFile, mkdir, readdir } = await import("node:fs/promises");
		await mkdir(join(project.workspace, "src"), { recursive: true });
		await writeFile(join(project.workspace, "index.html"), "<canvas/>", "utf8");
		await writeFile(join(project.workspace, "src", "main.js"), "// game", "utf8");

		await terminateProject(
			runtime,
			{ project: "tank-battle", reason: "不做了", by: "CEO", fromConversationId: boot.ownerConversationId },
			BACKGROUND_CONTEXT,
		);

		const result = await deleteProject(
			runtime,
			{ project: "tank-battle", by: "CEO", fromConversationId: boot.ownerConversationId },
			BACKGROUND_CONTEXT,
		);

		expect(result.ok).toBe(true);
		expect(result.removedStaff).toBe(2);
		expect(result.removedFiles).toBeGreaterThanOrEqual(3);

		// 项目索引没了
		const state = await readCompany(runtime, BACKGROUND_CONTEXT);
		expect(state?.projects["tank-battle"]).toBeUndefined();
		expect(Object.keys(state?.staff ?? {}).filter((key) => key.startsWith("tank-battle/"))).toEqual([]);

		// 磁盘目录没了
		const entries = await readdir(project.workspace).catch(() => null);
		expect(entries, "工作空间目录应被删除").toBeNull();
	});

	test("删除后组织视图里不再出现该项目", async () => {
		const { runtime, boot } = await setup();
		await terminateProject(
			runtime,
			{ project: "tank-battle", reason: "不做了", by: "CEO", fromConversationId: boot.ownerConversationId },
			BACKGROUND_CONTEXT,
		);
		await deleteProject(
			runtime,
			{ project: "tank-battle", by: "CEO", fromConversationId: boot.ownerConversationId },
			BACKGROUND_CONTEXT,
		);

		const view = await buildOrgView(runtime, BACKGROUND_CONTEXT);
		expect(view.projects.find((item) => item.slug === "tank-battle")).toBeUndefined();
	});

	test("重复删除返回项目不存在", async () => {
		const { runtime, boot } = await setup();
		await terminateProject(
			runtime,
			{ project: "tank-battle", reason: "不做了", by: "CEO", fromConversationId: boot.ownerConversationId },
			BACKGROUND_CONTEXT,
		);
		await deleteProject(
			runtime,
			{ project: "tank-battle", by: "CEO", fromConversationId: boot.ownerConversationId },
			BACKGROUND_CONTEXT,
		);

		const again = await deleteProject(
			runtime,
			{ project: "tank-battle", by: "CEO", fromConversationId: boot.ownerConversationId },
			BACKGROUND_CONTEXT,
		);
		expect(again.ok).toBe(false);
	});

	test("路径不在工作空间根下时拒绝删文件", async () => {
		const { runtime, boot, ctx } = await setup();

		// 造一个「路径被改错」的项目：指向工作空间根之外
		const outsider = join(ctx.dir, "不该被删的目录");
		const { mkdir, writeFile, readdir } = await import("node:fs/promises");
		await mkdir(outsider, { recursive: true });
		await writeFile(join(outsider, "重要文件.txt"), "别删我", "utf8");

		const { CompanyDoc } = await import("../../src/company/docs.ts");
		await runtime.harness.commit(async (tx) => {
			const company = await tx.doc(CompanyDoc);
			const project = company.projects["tank-battle"];
			if (project !== undefined) {
				company.projects["tank-battle"] = {
					...project,
					status: "terminated",
					terminated: { at: Date.now(), by: "CEO", reason: "测试" },
					workspace: outsider,
				};
			}
		}, BACKGROUND_CONTEXT);

		const result = await deleteProject(
			runtime,
			{ project: "tank-battle", by: "CEO", fromConversationId: boot.ownerConversationId },
			BACKGROUND_CONTEXT,
		);

		expect(result.ok, "校验不通过时必须拒绝").toBe(false);
		expect(result.message).toContain("校验未通过");
		// 目录还在
		expect((await readdir(outsider)).length).toBe(1);
	});

	test("删除会留下审计记录", async () => {
		const { runtime, boot } = await setup();
		await terminateProject(
			runtime,
			{ project: "tank-battle", reason: "不做了", by: "CEO", fromConversationId: boot.ownerConversationId },
			BACKGROUND_CONTEXT,
		);
		await deleteProject(
			runtime,
			{ project: "tank-battle", by: "CEO", fromConversationId: boot.ownerConversationId },
			BACKGROUND_CONTEXT,
		);

		const { AuditDoc } = await import("../../src/company/docs.ts");
		const audit = await runtime.harness.snapshot(AuditDoc, boot.ownerConversationId as never, BACKGROUND_CONTEXT);
		expect(audit?.events.some((event) => event.ref === "delete:tank-battle")).toBe(true);
	});
});

describe("CEO 的工具里有终止能力", () => {
	test("CEO 拿到 project_terminate", async () => {
		const { runtime, boot } = await setup();
		const ceo = await runtime.harness.conversation(boot.ownerConversationId as never, BACKGROUND_CONTEXT);
		const tools = (await ceo?.agent(BACKGROUND_CONTEXT))?.tools.map((tool) => tool.name) ?? [];

		expect(tools).toContain("project_terminate");
		expect(tools).toContain("project_delete");
		expect(tools).toContain("project_list");
	});

	test("员工没有终止项目的能力", async () => {
		const { runtime } = await setup();
		const staff = await listStaff(runtime, "tank-battle", BACKGROUND_CONTEXT);
		const conversation = await runtime.harness.conversation(staff[0]?.conversationId as never, BACKGROUND_CONTEXT);
		const tools = (await conversation?.agent(BACKGROUND_CONTEXT))?.tools.map((tool) => tool.name) ?? [];

		expect(tools).not.toContain("project_terminate");
		expect(tools).not.toContain("project_delete");
	});
});
