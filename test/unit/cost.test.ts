/**
 * cost-accounting 的测试。
 *
 * 覆盖 specs/cost-accounting/spec.md：按会话取用量、分叉不重复计账、按项目与角色聚合、
 * 成本准确性前提、界面可见性。
 *
 * 最重要的一条是「分叉不重复计账」——它有反例断言，
 * 使「按历史消息求和」这种错误写法无法通过测试（ADR-003）。
 */
import { afterEach, describe, expect, test } from "vitest";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createRegistry, openCompany, recover, type CompanyRuntime } from "../../src/runtime/index.ts";
import { bootstrapCompany, createProject, hireStaff, readCompany } from "../../src/company/org.ts";
import {
	calculateCostFromCatalog,
	conversationUsage,
	costReport,
	rollupAll,
	rollupProject,
	rollupRole,
} from "../../src/company/cost.ts";
import { delegate } from "../../src/company/delegation.ts";
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
	return { ctx, runtime, registry, boot, project, hired };
}

afterEach(async () => {
	for (const runtime of runtimes) await runtime.close().catch(() => undefined);
	for (const ctx of contexts) await ctx.cleanup();
	runtimes = [];
	contexts = [];
});

describe("按会话取得用量", () => {
	test("读单会话用量，按模型分桶", async () => {
		const { ctx, runtime, boot } = await setup();

		ctx.faux.setResponses([answer("第一轮")]);
		const ceo = await runtime.harness.conversation(boot.ownerConversationId as never, BACKGROUND_CONTEXT);
		await (await ceo?.submit({ type: "input", content: "问题" }, BACKGROUND_CONTEXT))?.wait(BACKGROUND_CONTEXT);

		const usage = await conversationUsage(runtime, boot.ownerConversationId, BACKGROUND_CONTEXT);
		expect(usage.totalTokens).toBeGreaterThan(0);
		expect(Object.keys(usage.byModel).length).toBeGreaterThan(0);
	});

	test("从未执行请求的会话返回零值而非错误", async () => {
		const { runtime, boot } = await setup();
		const usage = await conversationUsage(runtime, boot.roleConversations.cfo, BACKGROUND_CONTEXT);

		expect(usage.totalTokens).toBe(0);
		expect(usage.costUsd).toBe(0);
		expect(usage.byModel).toEqual({});
	});

	test("多模型会话分别成组", async () => {
		const { ctx, runtime, boot, hired } = await setup();

		// 员工用 cheap-1
		ctx.faux.setResponses([answer("员工回答")]);
		await delegate(
			runtime,
			{ project: "alpha", employee: "dev-1", task: "干活", fromConversationId: boot.ownerConversationId, from: "CEO" },
			BACKGROUND_CONTEXT,
		);

		const usage = await conversationUsage(runtime, hired.conversationId, BACKGROUND_CONTEXT);
		const keys = Object.keys(usage.byModel);
		expect(keys.some((key) => key.includes("faux-1"))).toBe(true);
	});
});

describe("分叉会话不重复计账", () => {
	test("分叉后父子分别统计，相加等于全公司总量", async () => {
		const { ctx, runtime, boot } = await setup();

		const ceo = await runtime.harness.conversation(boot.ownerConversationId as never, BACKGROUND_CONTEXT);
		ctx.faux.setResponses([answer("父第 1 答")]);
		await (await ceo?.submit({ type: "input", content: "父问题 1" }, BACKGROUND_CONTEXT))?.wait(BACKGROUND_CONTEXT);
		ctx.faux.setResponses([answer("父第 2 答")]);
		await (await ceo?.submit({ type: "input", content: "父问题 2" }, BACKGROUND_CONTEXT))?.wait(BACKGROUND_CONTEXT);

		const entries = await ceo?.entries({ order: "ascending" }, 100, undefined, BACKGROUND_CONTEXT);
		const firstAnswer = entries?.items.find((entry) => entry.kind === "pi.assistant");
		expect(firstAnswer).toBeDefined();

		const branch = await ceo?.fork(firstAnswer!.id, { ownership: { kind: "ownerless" } }, BACKGROUND_CONTEXT);
		ctx.faux.setResponses([answer("分支答")]);
		await (await branch?.submit({ type: "input", content: "分支问题" }, BACKGROUND_CONTEXT))?.wait(BACKGROUND_CONTEXT);

		const parentUsage = await conversationUsage(runtime, boot.ownerConversationId, BACKGROUND_CONTEXT);
		const branchUsage = await conversationUsage(runtime, Number(branch?.id), BACKGROUND_CONTEXT);
		const all = await rollupAll(runtime, BACKGROUND_CONTEXT);

		expect(parentUsage.totalTokens).toBeGreaterThan(0);
		expect(branchUsage.totalTokens).toBeGreaterThan(0);
		expect(
			parentUsage.totalTokens + branchUsage.totalTokens,
			"父 + 分支 = 全公司（无重复计账）",
		).toBe(all.totalTokens);
	});

	test("反例：按历史消息求和会虚高（证明不能用那种写法）", async () => {
		const { ctx, runtime, boot } = await setup();

		const ceo = await runtime.harness.conversation(boot.ownerConversationId as never, BACKGROUND_CONTEXT);
		ctx.faux.setResponses([answer("父第 1 答")]);
		await (await ceo?.submit({ type: "input", content: "父问题 1" }, BACKGROUND_CONTEXT))?.wait(BACKGROUND_CONTEXT);
		ctx.faux.setResponses([answer("父第 2 答")]);
		await (await ceo?.submit({ type: "input", content: "父问题 2" }, BACKGROUND_CONTEXT))?.wait(BACKGROUND_CONTEXT);

		const entries = await ceo?.entries({ order: "ascending" }, 100, undefined, BACKGROUND_CONTEXT);
		const firstAnswer = entries?.items.find((entry) => entry.kind === "pi.assistant");
		const branch = await ceo?.fork(firstAnswer!.id, { ownership: { kind: "ownerless" } }, BACKGROUND_CONTEXT);
		ctx.faux.setResponses([answer("分支答")]);
		await (await branch?.submit({ type: "input", content: "分支问题" }, BACKGROUND_CONTEXT))?.wait(BACKGROUND_CONTEXT);

		// 正确值
		const branchUsage = await conversationUsage(runtime, Number(branch?.id), BACKGROUND_CONTEXT);

		// 错误写法：把分支可见历史里的 assistant 消息用量全加起来
		const branchEntries = await branch?.entries({ order: "ascending" }, 200, undefined, BACKGROUND_CONTEXT);
		let naiveSum = 0;
		for (const entry of branchEntries?.items ?? []) {
			if (entry.kind !== "pi.assistant") continue;
			const message = entry.model?.[0] as { usage?: { totalTokens?: number } } | undefined;
			naiveSum += message?.usage?.totalTokens ?? 0;
		}

		expect(naiveSum, "按历史消息求和会包含父会话的消耗").toBeGreaterThan(branchUsage.totalTokens);
	});
});

describe("按项目与角色聚合", () => {
	test("按项目聚合 = 负责人 + 全部员工", async () => {
		const { ctx, runtime, boot, project, hired } = await setup();

		ctx.faux.setResponses([answer("员工回答")]);
		await delegate(
			runtime,
			{ project: "alpha", employee: "dev-1", task: "干活", fromConversationId: project.leader, from: "负责人" },
			BACKGROUND_CONTEXT,
		);
		ctx.faux.setResponses([answer("负责人回答")]);
		const leader = await runtime.harness.conversation(project.leader as never, BACKGROUND_CONTEXT);
		await (await leader?.submit({ type: "input", content: "进度" }, BACKGROUND_CONTEXT))?.wait(BACKGROUND_CONTEXT);

		const projectUsage = await rollupProject(runtime, "alpha", BACKGROUND_CONTEXT);
		const leaderUsage = await conversationUsage(runtime, project.leader, BACKGROUND_CONTEXT);
		const staffUsage = await conversationUsage(runtime, hired.conversationId, BACKGROUND_CONTEXT);

		expect(projectUsage.totalTokens).toBe(leaderUsage.totalTokens + staffUsage.totalTokens);
		expect(projectUsage.conversations.length).toBe(2);
		void boot;
	});

	test("按角色聚合", async () => {
		const { ctx, runtime, boot } = await setup();

		ctx.faux.setResponses([answer("CTO 回答")]);
		const cto = await runtime.harness.conversation(boot.roleConversations.cto as never, BACKGROUND_CONTEXT);
		await (await cto?.submit({ type: "input", content: "技术选型" }, BACKGROUND_CONTEXT))?.wait(BACKGROUND_CONTEXT);

		const roleUsage = await rollupRole(runtime, "cto", BACKGROUND_CONTEXT);
		expect(roleUsage.totalTokens).toBeGreaterThan(0);
		expect(roleUsage.conversations.length).toBe(1);
	});

	test("全公司合计等于各会话之和", async () => {
		const { ctx, runtime, boot, project } = await setup();

		ctx.faux.setResponses([answer("CEO 回答")]);
		const ceo = await runtime.harness.conversation(boot.ownerConversationId as never, BACKGROUND_CONTEXT);
		await (await ceo?.submit({ type: "input", content: "安排" }, BACKGROUND_CONTEXT))?.wait(BACKGROUND_CONTEXT);

		ctx.faux.setResponses([answer("负责人回答")]);
		const leader = await runtime.harness.conversation(project.leader as never, BACKGROUND_CONTEXT);
		await (await leader?.submit({ type: "input", content: "计划" }, BACKGROUND_CONTEXT))?.wait(BACKGROUND_CONTEXT);

		const all = await rollupAll(runtime, BACKGROUND_CONTEXT);
		const sum = all.conversations.reduce((total, conversation) => total + conversation.totalTokens, 0);
		expect(sum).toBe(all.totalTokens);
	});
});

describe("成本数字的准确性前提", () => {
	test("提供方未声明价格时 token 准确、成本为零，且可被识别", async () => {
		const { ctx, runtime, boot } = await setup();

		ctx.faux.setResponses([answer("回答")]);
		const ceo = await runtime.harness.conversation(boot.ownerConversationId as never, BACKGROUND_CONTEXT);
		await (await ceo?.submit({ type: "input", content: "问题" }, BACKGROUND_CONTEXT))?.wait(BACKGROUND_CONTEXT);

		const usage = await conversationUsage(runtime, boot.ownerConversationId, BACKGROUND_CONTEXT);
		expect(usage.totalTokens).toBeGreaterThan(0);
		expect(usage.costUsd, "faux 未声明价格，成本应为 0").toBe(0);

		const all = await rollupAll(runtime, BACKGROUND_CONTEXT);
		expect(all.unpricedModels.length, "应能识别出未定价的模型").toBeGreaterThan(0);
	});

	test("依据已记录 token 与价格可补算历史成本", async () => {
		const { ctx, runtime, boot } = await setup();

		ctx.faux.setResponses([answer("回答")]);
		const ceo = await runtime.harness.conversation(boot.ownerConversationId as never, BACKGROUND_CONTEXT);
		await (await ceo?.submit({ type: "input", content: "问题" }, BACKGROUND_CONTEXT))?.wait(BACKGROUND_CONTEXT);

		const usage = await conversationUsage(runtime, boot.ownerConversationId, BACKGROUND_CONTEXT);
		const calculated = calculateCostFromCatalog(usage, [
			{
				id: "faux-1",
				provider: "faux",
				modelId: "faux-1",
				label: "测试",
				inputPerMTok: 10,
				outputPerMTok: 30,
			},
		]);

		expect(calculated).toBeGreaterThan(0);
	});
});

describe("界面中的成本可见", () => {
	test("成本报告包含会话与项目拆分", async () => {
		const { ctx, runtime, boot, project } = await setup();

		ctx.faux.setResponses([answer("CEO 回答")]);
		const ceo = await runtime.harness.conversation(boot.ownerConversationId as never, BACKGROUND_CONTEXT);
		await (await ceo?.submit({ type: "input", content: "安排" }, BACKGROUND_CONTEXT))?.wait(BACKGROUND_CONTEXT);

		ctx.faux.setResponses([answer("负责人回答")]);
		const leader = await runtime.harness.conversation(project.leader as never, BACKGROUND_CONTEXT);
		await (await leader?.submit({ type: "input", content: "计划" }, BACKGROUND_CONTEXT))?.wait(BACKGROUND_CONTEXT);

		const report = await costReport(runtime, {}, BACKGROUND_CONTEXT);
		expect(report).toContain("全公司 成本");
		expect(report).toContain("token 合计");
		expect(report).toContain("按会话");
		expect(report).toContain("按项目");
		expect(report).toContain("alpha");
	});

	test("按项目查成本报告只含该项目", async () => {
		const { ctx, runtime, project } = await setup();

		ctx.faux.setResponses([answer("负责人回答")]);
		const leader = await runtime.harness.conversation(project.leader as never, BACKGROUND_CONTEXT);
		await (await leader?.submit({ type: "input", content: "计划" }, BACKGROUND_CONTEXT))?.wait(BACKGROUND_CONTEXT);

		const report = await costReport(runtime, { project: "alpha" }, BACKGROUND_CONTEXT);
		expect(report).toContain("项目 alpha 成本");
		expect(report).not.toContain("按项目");
	});

	test("成本随对话推进增长", async () => {
		const { ctx, runtime, boot } = await setup();

		const ceo = await runtime.harness.conversation(boot.ownerConversationId as never, BACKGROUND_CONTEXT);
		ctx.faux.setResponses([answer("第一答")]);
		await (await ceo?.submit({ type: "input", content: "第一问" }, BACKGROUND_CONTEXT))?.wait(BACKGROUND_CONTEXT);
		const before = await conversationUsage(runtime, boot.ownerConversationId, BACKGROUND_CONTEXT);

		ctx.faux.setResponses([answer("第二答")]);
		await (await ceo?.submit({ type: "input", content: "第二问" }, BACKGROUND_CONTEXT))?.wait(BACKGROUND_CONTEXT);
		const after = await conversationUsage(runtime, boot.ownerConversationId, BACKGROUND_CONTEXT);

		expect(after.totalTokens).toBeGreaterThan(before.totalTokens);
	});
});
