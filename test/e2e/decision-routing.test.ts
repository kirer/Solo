/**
 * ADR-026 决策 2 / 6：决策路由（落地第 3 步）。
 *
 * 这一段是「不用什么都由老板决定」的落地。核心断言：
 * **本该管理层 / 项目负责人拍的问题，不得出现在老板待办里。**
 *
 * 分两层测：
 * 1. 纯函数层：`decideOwner` 按权限矩阵判定归属（快、可穷举）；
 * 2. 端到端：真起运行时，走 `escalate` / `pending_list` / `answer_pending`，
 *    断言问题落在该拍的人手上。
 */
import { afterEach, describe, expect, test } from "vitest";
import { join } from "node:path";
import {
	BACKGROUND_CONTEXT,
	createRegistry,
	openCompany,
	recover,
	type CompanyRuntime,
} from "../../src/runtime/index.ts";
import { bootstrapCompany, createProject, escalateUp, hireStaff } from "../../src/company/org.ts";
import { createEscalationTask, decisionOwnerOfItem, listPending, type PendingItem } from "../../src/company/escalation.ts";
import { decideOwner, levelOfTarget } from "../../src/domain/routing.ts";
import { CompanyDoc, type CompanyState } from "../../src/company/docs.ts";
import { createTestContext, eventually, type TestContext, TEST_MODEL_CATALOG } from "../support.ts";

describe("decideOwner：按 ADR-026 决策 2 的权限矩阵判定", () => {
	const noState = undefined as unknown as CompanyState | undefined;

	test("公司级事项（立项/砍项目/预算上限/对外承诺/组织架构）→ 老板", () => {
		expect(levelOfTarget(decideOwner(noState, "company-level", { manager: "cto" }))).toBe("owner");
		// 即使发起人是 CEO 也还是老板
		expect(levelOfTarget(decideOwner(noState, "company-level", { manager: "ceo" }))).toBe("owner");
	});

	test("领域事项（技术选型/预算内支出）沿汇报线上行，停在直属管理层而不是老板", () => {
		const target = decideOwner(noState, "domain", { manager: "cto" });
		expect(target).toEqual({ kind: "role", role: "cto" });
		expect(levelOfTarget(target)).toBe("cto");
	});

	test("领域事项、发起人的直属就是 CEO → 停在 CEO，不越到老板", () => {
		expect(levelOfTarget(decideOwner(noState, "domain", { manager: "ceo" }))).toBe("ceo");
	});

	test("项目内事项（排期/拆分/调配/退回）→ 本项目负责人（leader:<slug>）", () => {
		const state = {
			projects: { alpha: { leader: 42, leaderName: "许砚舟", name: "Alpha" } },
		} as unknown as CompanyState;
		const target = decideOwner(state, "project", { project: "alpha", manager: "ceo" });
		expect(target.kind).toBe("leader");
		expect(levelOfTarget(target)).toBe("leader:alpha");
	});

	test("项目内事项但该项目没有负责人 → 退回汇报线，不能甩给老板", () => {
		const state = { projects: {} } as unknown as CompanyState;
		const target = decideOwner(state, "project", { project: "ghost", manager: "cto" });
		expect(levelOfTarget(target)).toBe("cto");
		expect(levelOfTarget(target)).not.toBe("owner");
	});

	test("未分类（默认）沿汇报线上行，且没有上级时落 CEO 而不是老板", () => {
		expect(levelOfTarget(decideOwner(noState, "unclassified", {}))).toBe("ceo");
		expect(levelOfTarget(decideOwner(noState, "unclassified", { manager: "chro" }))).toBe("chro");
	});

	test("负责人类上级用字符串引用，不自己解析（ADR-027）", () => {
		const withLeaderManager = decideOwner(noState, "domain", { manager: "leader:alpha" as never });
		expect(withLeaderManager.kind).toBe("leader");
		expect(levelOfTarget(withLeaderManager)).toBe("leader:alpha");
	});
});

describe("decisionOwnerOfItem：旧数据回退", () => {
	test("有 decisionOwner 就用它", () => {
		const item = { key: "k", level: "owner", decisionOwner: "cto" } as unknown as PendingItem;
		expect(decisionOwnerOfItem(item)).toBe("cto");
	});

	test("旧数据没有该字段 → 回退到 level（引入前写入的语义就是 level）", () => {
		const item = { key: "k", level: "owner" } as unknown as PendingItem;
		expect(decisionOwnerOfItem(item)).toBe("owner");
	});
});

describe("端到端：本该管理层拍的问题不出现在老板待办里", () => {
	let contexts: TestContext[] = [];
	let runtimes: CompanyRuntime[] = [];

	afterEach(async () => {
		for (const runtime of runtimes.splice(0)) await runtime.close?.().catch(() => undefined);
		for (const ctx of contexts.splice(0)) await ctx.cleanup();
	});

	async function setup(): Promise<{
		runtime: CompanyRuntime;
		roles: Record<string, number>;
		project: { leader: number; leaderName: string };
		escalationTask: ReturnType<typeof createEscalationTask>;
	}> {
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
				watchdog: false,
			},
			BACKGROUND_CONTEXT,
		);
		const { project } = await createProject(
			runtime,
			{ name: "Alpha", slug: "alpha", brief: "测试", workspaceRoot: join(ctx.dir, "projects") },
			BACKGROUND_CONTEXT,
		);
		await hireStaff(runtime, { project: "alpha", name: "dev-1", role: "开发", manager: "cto" }, BACKGROUND_CONTEXT);
		const state = await runtime.harness.snapshot(CompanyDoc, BACKGROUND_CONTEXT);
		return {
			runtime,
			roles: (state?.roles ?? {}) as Record<string, number>,
			project: { leader: project.leader, leaderName: project.leaderName ?? project.name },
			escalationTask,
		};
	}

	/** 取某个决策人（权限位）名下未答复的待决项。 */
	function pendingFor(items: readonly PendingItem[], level: string): PendingItem[] {
		return items.filter((item) => item.answer === undefined && decisionOwnerOfItem(item) === level);
	}

	test("CTO 下属提起的「技术选型」：决策人是 CTO，老板待办里没有它", async () => {
		const { runtime, roles } = await setup();
		const state = await runtime.harness.snapshot(CompanyDoc, BACKGROUND_CONTEXT);
		const ctoId = roles.cto as number;
		expect(ctoId).toBeDefined();

		// 直接用运行时 API 起一个升级：发起人是 CTO 的下属（dev-1），类别是领域事项。
		const devId = Object.values(state?.staff ?? {}).find((s) => s.name === "dev-1")?.conversationId as number;
		expect(devId).toBeDefined();

		const { startEscalation } = await import("../../src/company/escalation.ts");
		const escalationTask = createEscalationTask(runtime);
		await startEscalation(
			runtime,
			escalationTask,
			{
				question: "选 Postgres 还是 MySQL？",
				from: "dev-1",
				fromConversationId: devId,
				manager: "cto",
				topic: "domain",
				escalationKey: "esc:dev:1",
			},
			BACKGROUND_CONTEXT,
		);

		// 等它落成待决项
		let items: readonly PendingItem[] = [];
		await eventually(
			async () => {
				items = await listPending(runtime, BACKGROUND_CONTEXT);
				return items.some((item) => item.key === "esc:dev:1");
			},
			{ label: "待决项出现", timeoutMs: 10_000 },
		);
		const item = items.find((entry) => entry.key === "esc:dev:1");
		expect(item).toBeDefined();
		// 关键断言：决策人是 CTO，不是老板
		expect(decisionOwnerOfItem(item as PendingItem)).toBe("cto");
		// 老板待办里没有它
		expect(pendingFor(items, "owner")).toHaveLength(0);
	}, 30_000);

	test("项目内「排期」：决策人是本项目负责人，老板与 CEO 待办里都没有它", async () => {
		const { runtime, project } = await setup();
		const state = await runtime.harness.snapshot(CompanyDoc, BACKGROUND_CONTEXT);
		const devId = Object.values(state?.staff ?? {}).find((s) => s.name === "dev-1")?.conversationId as number;

		const { startEscalation } = await import("../../src/company/escalation.ts");
		const escalationTask = createEscalationTask(runtime);
		await startEscalation(
			runtime,
			escalationTask,
			{
				question: "首期交付能不能推迟两周？",
				from: "dev-1",
				fromConversationId: devId,
				project: "alpha",
				topic: "project",
				escalationKey: "esc:dev:2",
			},
			BACKGROUND_CONTEXT,
		);

		let items: readonly PendingItem[] = [];
		await eventually(
			async () => {
				items = await listPending(runtime, BACKGROUND_CONTEXT);
				return items.some((item) => item.key === "esc:dev:2");
			},
			{ label: "待决项出现", timeoutMs: 10_000 },
		);
		const item = items.find((entry) => entry.key === "esc:dev:2") as PendingItem;
		expect(decisionOwnerOfItem(item)).toBe("leader:alpha");
		// 老板与 CEO 的队列里都没有
		expect(pendingFor(items, "owner")).toHaveLength(0);
		expect(pendingFor(items, "ceo")).toHaveLength(0);
		// 负责人能拿到它
		expect(pendingFor(items, "leader:alpha").map((entry) => entry.key)).toContain("esc:dev:2");
		void project;
	}, 30_000);

	/**
	 * Defect B（原测试名「公司级事项仍然到老板」已改写为下面的三条）：
	 *
	 * 旧行为：非 CEO 声明 `topic=company-level` → **直达老板**，跳过 CEO。
	 * 新行为：先落 CEO 复核；只有 CEO 确认递老板，才进老板队列。
	 *
	 * 所以「公司级事项仍然到老板」这句话只在 **CEO 确认之后**才成立。
	 * 拆成三条测试，把这条链子钉死。
	 */
	test("公司级事项：非 CEO 声明后先落 CEO 复核，老板队列不直接出现", async () => {
		const { runtime, roles } = await setup();
		const ctoId = roles.cto as number;

		const { startEscalation } = await import("../../src/company/escalation.ts");
		const escalationTask = createEscalationTask(runtime);
		await startEscalation(
			runtime,
			escalationTask,
			{
				question: "要不要砍掉 Alpha 项目？",
				from: "CTO",
				fromConversationId: ctoId,
				manager: "ceo",
				topic: "company-level",
				escalationKey: "esc:cto:1",
			},
			BACKGROUND_CONTEXT,
		);

		let items: readonly PendingItem[] = [];
		await eventually(
			async () => {
				items = await listPending(runtime, BACKGROUND_CONTEXT);
				return items.some((item) => item.key === "esc:cto:1");
			},
			{ label: "待决项出现", timeoutMs: 10_000 },
		);
		const item = items.find((entry) => entry.key === "esc:cto:1") as PendingItem;
		// 修复后的核心断言：停在 CEO，不是老板。
		expect(item.level, "company-level 必须先到 CEO 复核，不能直达老板").toBe("ceo");
		expect(decisionOwnerOfItem(item)).toBe("ceo");
		expect(pendingFor(items, "owner").map((entry) => entry.key)).not.toContain("esc:cto:1");
		// 来源可追溯：说明这是自证的声明、请 CEO 复核。
		expect(item.trace?.declaredTopic).toBe("company-level");
		expect(item.trace?.ceoReviewed).toBe(false);
	}, 30_000);

	test("公司级事项：CEO 确认后进老板队列，且 path 含真实的 ceo 一站", async () => {
		const { runtime, roles } = await setup();
		const ctoId = roles.cto as number;
		const { startEscalation, answerPending } = await import("../../src/company/escalation.ts");
		const escalationTask = createEscalationTask(runtime);
		await startEscalation(
			runtime,
			escalationTask,
			{
				question: "要不要砍掉 Alpha 项目？",
				from: "CTO",
				fromConversationId: ctoId,
				manager: "ceo",
				topic: "company-level",
				escalationKey: "esc:cto:2",
			},
			BACKGROUND_CONTEXT,
		);

		await eventually(
			async () => (await listPending(runtime, BACKGROUND_CONTEXT)).some((item) => item.key === "esc:cto:2"),
			{ label: "CEO 站出现", timeoutMs: 10_000 },
		);
		// CEO 复核确认 → 递老板
		expect(
			await answerPending(
				runtime,
				{ key: "esc:cto:2", answer: "确实只有老板能定。", answeredBy: "ceo", escalate: true },
				BACKGROUND_CONTEXT,
			),
		).toBe(true);

		let items: readonly PendingItem[] = [];
		await eventually(
			async () => {
				items = await listPending(runtime, BACKGROUND_CONTEXT);
				return items.some((item) => item.key === "esc:cto:2" && item.level === "owner");
			},
			{ label: "递到老板站", timeoutMs: 10_000 },
		);
		const ownerItem = items.find((entry) => entry.key === "esc:cto:2" && entry.level === "owner") as PendingItem;
		expect(decisionOwnerOfItem(ownerItem)).toBe("owner");
		// 来源可追溯：这条是经 CEO 复核确认过的。
		expect(ownerItem.trace?.ceoReviewed).toBe(true);
		expect(ownerItem.trace?.note).toContain("CEO");
	}, 30_000);

	/**
	 * 接线回归（审计 R-02 的同族问题）：权限矩阵写对了，但 `escalate` 工具从来不传
	 * `project`，于是「项目内事项」在模型链路上永远走不到项目负责人——
	 * 只有直调 `startEscalation` 并手填 project 的测试能过。这条测试走**真实上报入口**，
	 * 只声明 topic，project 必须由公司结构自己补出来。
	 */
	test("escalate 入口：只声明 topic=project，也会按员工所属项目落到负责人", async () => {
		const { runtime, project, escalationTask } = await setup();
		const state = await runtime.harness.snapshot(CompanyDoc, BACKGROUND_CONTEXT);
		const dev = Object.values(state?.staff ?? {}).find((person) => person.name === "dev-1");
		expect(dev).toBeDefined();

		const reply = await escalateUp(
			runtime,
			{
				question: "首期交付能不能推迟两周？",
				from: "dev-1",
				conversationId: dev?.conversationId as number,
				topic: "project",
			},
			escalationTask,
			BACKGROUND_CONTEXT,
		);
		expect(reply).toContain("已上报");
		expect(reply).toContain(project.leaderName);

		let items: readonly PendingItem[] = [];
		await eventually(
			async () => {
				items = await listPending(runtime, BACKGROUND_CONTEXT);
				return items.some((entry) => entry.question.includes("推迟两周"));
			},
			{ label: "待决项出现", timeoutMs: 10_000 },
		);
		const item = items.find((entry) => entry.question.includes("推迟两周")) as PendingItem;
		expect(item.project, "项目要从员工记录补出来，不能由调用方手填").toBe("alpha");
		expect(decisionOwnerOfItem(item)).toBe("leader:alpha");
		expect(pendingFor(items, "owner")).toHaveLength(0);
		expect(pendingFor(items, "ceo")).toHaveLength(0);
	}, 30_000);

	test("项目负责人自己声明 project 类事项：不会生成一条自己等自己的待办", async () => {
		const { runtime, project, escalationTask } = await setup();

		const reply = await escalateUp(
			runtime,
			{
				question: "本项目排期怎么调？",
				from: project.leaderName,
				conversationId: project.leader,
				topic: "project",
			},
			escalationTask,
			BACKGROUND_CONTEXT,
		);
		expect(reply).toContain("归你自己");
		// 没有落成待办，否则它会永远挂在他名下没人来答
		expect(await listPending(runtime, BACKGROUND_CONTEXT)).toHaveLength(0);
	}, 30_000);
});
