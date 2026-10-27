/**
 * 老板级待办只能由 CEO 递给老板（老板 2026-10-26 的硬规则）。
 *
 * > 需要我（老板）拍板确认的事情，只能 CEO 给我。其他问题，他们自己找上级决定，
 * > 如果上级决定不了，上级再交给他的上级。直到我。
 *
 * 三个必须成立的行为：
 * 1. **逐级上升**：员工 → 负责人 → 管理层 → CEO，一层都不能跳
 * 2. **只有 CEO 能进老板层**：非 CEO 无论怎么声明都进不了 ask-owner
 * 3. **CEO 复核后才能递老板**：CEO 自己发起、或 CEO 明确 escalate
 */
import { afterEach, describe, expect, test } from "vitest";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createRegistry, openCompany, recover, type CompanyRuntime } from "../../src/runtime/index.ts";
import { bootstrapCompany, createProject, escalateUp, hireStaff } from "../../src/company/org.ts";
import { answerPending, createEscalationTask, listPending } from "../../src/company/escalation.ts";
import { canReachOwner, decideOwner, levelOfTarget } from "../../src/domain/routing.ts";
import { escalationPath, nextLevelUp, type Org } from "../../src/domain/membership.ts";
import { CompanyDoc } from "../../src/company/docs.ts";
import { buildOrg } from "../../src/company/org-model.ts";
import { createTestContext, eventually, type TestContext, TEST_MODEL_CATALOG, waitEscalation } from "../support.ts";

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
			companyName: "层级测试",
			registry,
			workspaceRoot: join(ctx.dir, "projects"),
			escalationTask,
		},
		BACKGROUND_CONTEXT,
	);
	const { project } = await createProject(
		runtime,
		{ name: "Alpha", slug: "alpha", brief: "测试", workspaceRoot: join(ctx.dir, "projects") },
		BACKGROUND_CONTEXT,
	);
	await hireStaff(runtime, { project: "alpha", name: "林越", role: "开发", manager: "cto", registry }, BACKGROUND_CONTEXT);
	const state = await runtime.harness.snapshot(CompanyDoc, BACKGROUND_CONTEXT);
	const org = buildOrg(state);
	const staff = Object.values(state?.staff ?? {}).find((person) => person.name === "林越");
	return { ctx, runtime, booted, project, org, staff, escalationTask, roles: state?.roles ?? {} };
}

afterEach(async () => {
	for (const runtime of runtimes) await runtime.close().catch(() => undefined);
	for (const ctx of contexts) await ctx.cleanup();
	runtimes = [];
	contexts = [];
});

describe("canReachOwner：唯一入口判定", () => {
	test("非 CEO 一律不能到老板", () => {
		for (const level of ["staff", "leader:alpha", "cto", "cfo", "coo"]) {
			const result = canReachOwner({ callerLevel: level, startAtOwner: true });
			expect(result.allowed, level).toBe(false);
			expect(result.reason).toContain("只有 CEO");
		}
	});

	test("CEO 显式 startAtOwner 才能到老板", () => {
		expect(canReachOwner({ callerLevel: "ceo", startAtOwner: true }).allowed).toBe(true);
	});

	test("CEO 不显式声明时也先进自己的待办", () => {
		const result = canReachOwner({ callerLevel: "ceo" });
		expect(result.allowed).toBe(false);
		expect(result.reason).toContain("CEO 自己的待办");
	});
});

describe("逐级上升：一层都不能跳", () => {
	test("nextLevelUp 沿 manager 链走", async () => {
		const { org, project, staff } = await setup();
		// 员工 → 负责人
		const staffLevel = "staff";
		void staffLevel;
		const leaderLevel = `leader:alpha`;
		// 负责人的上级是 CTO（因为员工的 manager 是 cto）
		expect(nextLevelUp(org, leaderLevel)).toBe("cto");
		// CTO 的上级是 CEO
		expect(nextLevelUp(org, "cto")).toBe("ceo");
		// CEO 的上级是老板
		expect(nextLevelUp(org, "ceo")).toBe("owner");
		void project;
		void staff;
	});

	test("escalationPath 给出完整链条", async () => {
		const { org, project } = await setup();
		const path = escalationPath(org, project.leader);
		expect(path[0]).toBe("leader:alpha");
		expect(path).toContain("cto");
		expect(path).toContain("ceo");
		expect(path.at(-1)).toBe("owner");
	});

	test("员工上报先落到负责人，不是 CEO", async () => {
		const { runtime, project, staff, escalationTask } = await setup();
		expect(staff).toBeDefined();
		const reply = await escalateUp(
			runtime,
			{
				question: "这个接口的字段名用 userName 还是 user_name？",
				from: "林越",
				conversationId: staff?.conversationId ?? 0,
				topic: "project",
			},
			escalationTask,
			BACKGROUND_CONTEXT,
		);
		// 项目内事项归负责人，不该到 CEO
		expect(reply).toContain("负责人");
		await eventually(
			async () =>
				(await listPending(runtime, BACKGROUND_CONTEXT)).some(
					(item) => item.level === `leader:${project.slug}`,
				),
			{ label: "负责人待办出现" },
		);
		const pending = await listPending(runtime, BACKGROUND_CONTEXT);
		expect(pending.some((item) => item.level === "ceo" || item.level === "owner")).toBe(false);
	});

	test("负责人拍不了 → 逐级到管理层，不直接跳 CEO", async () => {
		const { runtime, project, escalationTask } = await setup();
		const { startEscalation } = await import("../../src/company/escalation.ts");
		await startEscalation(
			runtime,
			escalationTask,
			{
				question: "要不要换掉整个前端框架？",
				from: "许砚舟",
				fromConversationId: project.leader,
				manager: `leader:${project.slug}` as never,
				escalationKey: "esc-chain-1",
				project: project.slug,
			},
			BACKGROUND_CONTEXT,
		);
		await eventually(
			async () =>
				(await listPending(runtime, BACKGROUND_CONTEXT)).some((item) => item.level === `leader:${project.slug}`),
			{ label: "负责人待办" },
		);
		// 负责人说「我也拍不了」
		await answerPending(
			runtime,
			{ key: "esc-chain-1", answer: "这超出项目范围。", answeredBy: `leader:${project.slug}`, escalate: true },
			BACKGROUND_CONTEXT,
		);
		// 必须落到 CTO（上一级），而不是 CEO
		await eventually(
			async () => (await listPending(runtime, BACKGROUND_CONTEXT)).some((item) => item.level === "cto"),
			{ label: "CTO 待办出现" },
		);
		const pending = await listPending(runtime, BACKGROUND_CONTEXT);
		expect(pending.some((item) => item.level === "ceo"), "不该跳过 CTO 直接到 CEO").toBe(false);
		expect(pending.some((item) => item.level === "owner"), "更不该到老板").toBe(false);
	});

	test("管理层说拍不了 → 到 CEO，仍不到老板", async () => {
		const { runtime, project, escalationTask } = await setup();
		const { startEscalation } = await import("../../src/company/escalation.ts");
		await startEscalation(
			runtime,
			escalationTask,
			{
				question: "要不要换掉整个前端框架？",
				from: "许砚舟",
				fromConversationId: project.leader,
				manager: "cto",
				escalationKey: "esc-chain-2",
				project: project.slug,
			},
			BACKGROUND_CONTEXT,
		);
		await eventually(
			async () => (await listPending(runtime, BACKGROUND_CONTEXT)).some((item) => item.level === "cto"),
			{ label: "CTO 待办" },
		);
		await answerPending(
			runtime,
			{ key: "esc-chain-2", answer: "这涉及公司技术路线。", answeredBy: "cto", escalate: true },
			BACKGROUND_CONTEXT,
		);
		await eventually(
			async () => (await listPending(runtime, BACKGROUND_CONTEXT)).some((item) => item.level === "ceo"),
			{ label: "CEO 待办" },
		);
		// 此时还没有老板级待办
		expect((await listPending(runtime, BACKGROUND_CONTEXT)).some((item) => item.level === "owner")).toBe(false);
	});

	test("CEO 说拍不了 → 才到老板", async () => {
		const { runtime, project, escalationTask } = await setup();
		const { startEscalation } = await import("../../src/company/escalation.ts");
		const taskId = await startEscalation(
			runtime,
			escalationTask,
			{
				question: "要不要把公司搬到杭州？",
				from: "许砚舟",
				fromConversationId: project.leader,
				manager: "ceo",
				escalationKey: "esc-chain-3",
			},
			BACKGROUND_CONTEXT,
		);
		await eventually(
			async () => (await listPending(runtime, BACKGROUND_CONTEXT)).some((item) => item.level === "ceo"),
			{ label: "CEO 待办" },
		);
		await answerPending(
			runtime,
			{ key: "esc-chain-3", answer: "这是公司战略，只能老板定。", answeredBy: "ceo", escalate: true },
			BACKGROUND_CONTEXT,
		);
		await eventually(
			async () => (await listPending(runtime, BACKGROUND_CONTEXT)).some((item) => item.level === "owner"),
			{ label: "老板待办出现" },
		);
		// 老板级待办必须记在 CEO 名下（老板只看得到 CEO 报上来的问题）
		const ownerItem = (await listPending(runtime, BACKGROUND_CONTEXT)).find((item) => item.level === "owner");
		expect(ownerItem?.from).toBe("CEO");

		await answerPending(runtime, { key: "esc-chain-3", answer: "搬。", answeredBy: "owner" }, BACKGROUND_CONTEXT);
		const result = await waitEscalation(runtime, taskId, BACKGROUND_CONTEXT);
		expect(result?.decidedBy).toBe("owner");
		// path 的第一项是发起人显示名（历史行为），其后是真实走过的层级
		expect(result?.path).toContain("ceo");
		expect(result?.path).toContain("owner");
		// 不能出现两个连续的 ceo（那是「没问过却记了一笔」的假象）
		const joined = (result?.path ?? []).join(">");
		expect(joined).not.toContain("ceo>ceo");
	});
});

describe("decisionOwner 与 level 的关系", () => {
	test("company-level 的决策人是老板，但起点仍是 CEO 复核", async () => {
		const { runtime, org } = await setup();
		const target = decideOwner(undefined, "company-level", {});
		expect(levelOfTarget(target)).toBe("owner");
		void runtime;
		void org;
	});

	test("非 CEO 声明 company-level 不会直达老板", async () => {
		const { runtime, project, escalationTask } = await setup();
		const reply = await escalateUp(
			runtime,
			{
				question: "要不要收购另一家公司？",
				from: "许砚舟",
				conversationId: project.leader,
				topic: "company-level",
			},
			escalationTask,
			BACKGROUND_CONTEXT,
		);
		expect(reply).toContain("CEO");
		await eventually(
			async () => (await listPending(runtime, BACKGROUND_CONTEXT)).some((item) => item.level === "ceo"),
			{ label: "先落 CEO 复核" },
		);
		expect((await listPending(runtime, BACKGROUND_CONTEXT)).some((item) => item.level === "owner")).toBe(false);
	});
});
