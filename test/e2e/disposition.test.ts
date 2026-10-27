/**
 * ADR-026 落地第二步：处置与恢复的端到端测试。
 *
 * 锁死三件事（都是决策 4/5 的原文要求）：
 * 1. 老板发 `now` 档消息打断正在跑的工作时，**自动生成一条处置待办**，
 *    带「项目/任务、进度几/几、token」和两个选项；
 * 2. 默认暂搁、5 分钟期限、恢复条件默认 30 分钟——且
 *    **没有恢复条件的暂搁不成立**；
 * 3. 到期按默认执行，留痕能分清「机器决定了」还是「人决定了」。
 */
import { afterEach, describe, expect, test } from "vitest";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createRegistry, openCompany, recover, type CompanyRuntime } from "../../src/runtime/index.ts";
import { bootstrapCompany, createProject } from "../../src/company/org.ts";
import { createEscalationTask, listPending } from "../../src/company/escalation.ts";
import {
	DEFAULT_RESUME_AFTER_MS,
	DISPOSITION_DEADLINE_MS,
	settleDueDispositions,
	applyDueResumeReminders,
	createDispositionPending,
	readDisposition,
	settleDisposition,
} from "../../src/company/disposition.ts";
import { serve, type Server } from "../../src/server/http.ts";
import { createTestContext, eventually, slowAnswer, type TestContext, TEST_MODEL_CATALOG } from "../support.ts";

let contexts: TestContext[] = [];
let runtimes: CompanyRuntime[] = [];
let servers: Server[] = [];

async function setup(): Promise<{ ctx: TestContext; runtime: CompanyRuntime; server: Server; rootId: number }> {
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

	await createProject(
		runtime,
		{ name: "Alpha", slug: "alpha", brief: "测试", workspaceRoot: join(ctx.dir, "projects") },
		BACKGROUND_CONTEXT,
	);

	const root = await runtime.harness.root(BACKGROUND_CONTEXT, {
		agent: { model: { provider: "faux", modelId: "faux-1" } },
	});
	const server = await serve({ runtime: () => runtime, port: 0 });
	servers.push(server);
	return { ctx, runtime, server, rootId: root.id };
}

afterEach(async () => {
	for (const server of servers.splice(0)) await server.close().catch(() => undefined);
	for (const runtime of runtimes.splice(0)) await runtime.close().catch(() => undefined);
	for (const ctx of contexts.splice(0)) await ctx.cleanup();
});

describe("打断 → 处置待办", () => {
	test("打断正在跑的工作时，自动生成结构化处置待办（默认暂搁 / 5 分钟 / 恢复条件 30 分钟）", async () => {
		const { ctx, runtime, server, rootId } = await setup();

		// 让 root 会话真的忙起来：一个慢回答占住这一轮
		ctx.faux.setResponses([slowAnswer(3_000)]);
		await runtime.harness
			.conversation(rootId as never, BACKGROUND_CONTEXT)
			.then((conversation) =>
				conversation?.submit({ type: "input", content: "开始一个长任务" }, BACKGROUND_CONTEXT),
			);

		// 等到任务真的 running，否则打断时采不到「正在跑什么」
		await eventually(
			async () => {
				const inspection = await runtime.harness.inspect(BACKGROUND_CONTEXT);
				return inspection.tasks.some((task) => task.state.kind === "running");
			},
			{ label: "任务进入 running" },
		);

		// 打断入口（`POST /api/interrupt`）随会话流视图一起删除（ADR-040）。
		// 这里直接走它背后的两个函数：采集「正在跑的工作」→ 生成处置待办。
		// 采集是纯机械推导（inspect + 条目配对 + 用量），不调模型。
		const { captureInterruptedWork, createDispositionPending } = await import("../../src/company/disposition.ts");
		const work = await captureInterruptedWork(runtime, rootId, BACKGROUND_CONTEXT);
		expect(work, "有正在跑的任务才采集得到").toBeDefined();
		if (work !== undefined) await createDispositionPending(runtime, work);

		await eventually(
			async () => (await listPending(runtime, BACKGROUND_CONTEXT)).some((item) => item.disposition !== undefined),
			{ label: "处置待办出现" },
		);

		const pending = await listPending(runtime, BACKGROUND_CONTEXT);
		const item = pending.find((entry) => entry.disposition !== undefined);
		expect(item).toBeDefined();
		const payload = item?.disposition;
		expect(payload?.type).toBe("disposition");
		expect(payload?.defaultDisposition).toBe("shelve");
		expect(payload?.resumeAfterMs).toBe(DEFAULT_RESUME_AFTER_MS);

		// 问题正文结构化：带任务、进度、两个选项、恢复条件
		expect(item?.question).toContain("被打断的工作：");
		expect(item?.question).toContain("进度：");
		expect(item?.question).toContain("① 暂搁（推荐）② 永久放弃");
		expect(item?.question).toContain("恢复条件");
	});

	test("暂搁必须带恢复条件：不合法答复被拒绝，待办保持未决", async () => {
		const { runtime } = await setup();
		const { createDispositionPending } = await import("../../src/company/disposition.ts");

		const { key } = await createDispositionPending(
			runtime,
			{
				taskId: "9",
				taskKind: "pi.tool",
				conversationId: 1,
				startedAt: null,
				project: "alpha",
				assignedBy: "老板",
				assignedByConversationId: null,
				progress: {
					completedToolCalls: 1,
					totalToolCalls: 3,
					step: 2,
					totalSteps: 3,
					tokensUsed: 900,
				},
			},
			{ now: 1_000 },
		);

		const { settleDisposition } = await import("../../src/company/disposition.ts");

		// 说不清 → 拒绝
		const bad = await settleDisposition(runtime, { key, answer: "嗯", answeredBy: "老板" });
		expect(bad.ok).toBe(false);

		// 只说了「暂搁」但没给恢复条件 → 必须被拒（ADR-026 决策 4：必填项不是可选项）
		const noCondition = await settleDisposition(runtime, { key, answer: "暂搁", answeredBy: "老板" });
		expect(noCondition.ok).toBe(false);
		if (!noCondition.ok) expect(noCondition.reason).toContain("恢复条件");

		// 明确的暂搁 + 恢复条件 → 成立
		const good = await settleDisposition(runtime, {
			key,
			answer: "暂搁：30 分钟后提醒我",
			answeredBy: "老板",
		});
		expect(good.ok).toBe(true);
		if (good.ok) expect(good.resumeCondition).toContain("30 分钟后提醒我");
	});

	test("到期按默认暂搁执行，留痕区分「机器默认」与「人决定」", async () => {
		const { runtime } = await setup();
		const { createDispositionPending } = await import("../../src/company/disposition.ts");

		const now = 5_000;
		const { key } = await createDispositionPending(
			runtime,
			{
				taskId: "11",
				taskKind: "pi.tool",
				conversationId: 1,
				startedAt: null,
				project: "alpha",
				assignedBy: null,
				assignedByConversationId: null,
				progress: {
					completedToolCalls: 0,
					totalToolCalls: 2,
					step: 1,
					totalSteps: 2,
					tokensUsed: 100,
				},
			},
			{ now },
		);

		// 未到期：不兜底
		expect(await settleDueDispositions(runtime, now + 1_000)).toBe(0);

		// 到期：按暂搁执行
		expect(await settleDueDispositions(runtime, now + DISPOSITION_DEADLINE_MS + 1)).toBe(1);

		const read = await readDisposition(runtime, key, {});
		expect(read?.payload.disposition).toBe("shelve");
		expect(read?.payload.decidedBy).toBe("timeout-default");
	});
});

/**
 * 决策 4/5 的「恢复」必须真的发生：暂搁不能只把条件存进库。
 *
 * 原实现只记录 resumeCondition/resumeAfterMs，到点什么也不做——那条「恢复条件」
 * 等于一行装饰文字，暂搁的工作照样无声烂掉（审计把这条列为决策 4 未落地）。
 */
describe("恢复提醒：暂搁到点必须提醒下达人", () => {
	/** 一份最小可用的被打断工作快照（下达人 = 当前会话）。 */
	function workOf(conversationId: number) {
		return {
			taskId: "501",
			taskKind: "pi.tool",
			conversationId,
			startedAt: null,
			project: "alpha",
			assignedBy: "老板",
			assignedByConversationId: conversationId,
			progress: {
				completedToolCalls: 2,
				totalToolCalls: 5,
				step: 3,
				totalSteps: 5,
				tokensUsed: 1200,
			},
		};
	}

	test("暂搁到期写一条 alert 给下达人，且只提醒一次", async () => {
		const { runtime, rootId } = await setup();
		const now = 1_000_000;
		const { key } = await createDispositionPending(
			runtime,
			workOf(rootId),
			{ now },
			BACKGROUND_CONTEXT,
		);

		// 人明确选「暂搁」，恢复条件用默认的 30 分钟
		const settled = await settleDisposition(
			runtime,
			{ key, answer: "暂搁：等接口恢复后继续", answeredBy: "老板", now },
			BACKGROUND_CONTEXT,
		);
		expect(settled.ok).toBe(true);

		// 未到恢复时刻：不提醒
		expect(await applyDueResumeReminders(runtime, now + DEFAULT_RESUME_AFTER_MS - 1_000, BACKGROUND_CONTEXT)).toBe(0);

		// 到点：提醒一次
		expect(await applyDueResumeReminders(runtime, now + DEFAULT_RESUME_AFTER_MS + 1_000, BACKGROUND_CONTEXT)).toBe(1);
		// 再跑一轮：幂等，不重复打扰
		expect(await applyDueResumeReminders(runtime, now + DEFAULT_RESUME_AFTER_MS + 2_000, BACKGROUND_CONTEXT)).toBe(0);

		// 下达人的会话流里能看到这条提醒（不是只写在某个内部字段里）
		const conversation = await runtime.harness.conversation(rootId as never, BACKGROUND_CONTEXT);
		const page = await conversation?.entries({ order: "descending" }, 20, undefined, BACKGROUND_CONTEXT);
		const alert = page?.items.find((entry) => (entry as { kind?: string }).kind === "app.alert") as
			| { data?: { text?: string; reason?: string } }
			| undefined;
		expect(alert).toBeDefined();
		expect(alert?.data?.reason).toBe("resume-reminder");
		expect(alert?.data?.text).toContain("恢复条件到点");
		expect(alert?.data?.text).toContain("等接口恢复后继续");
	}, 30_000);

	test("超时默认结算的处置仍可被人推翻（决策 5「事后可改」）", async () => {
		const { runtime, rootId } = await setup();
		const now = 1_000_000;
		const { key } = await createDispositionPending(runtime, workOf(rootId), { now }, BACKGROUND_CONTEXT);

		// 到期没人答 → 机器按可逆的一侧（暂搁）结算
		expect(await settleDueDispositions(runtime, now + DISPOSITION_DEADLINE_MS + 1)).toBe(1);
		const afterDefault = await readDisposition(runtime, key, {});
		expect(afterDefault?.payload.decidedBy).toBe("timeout-default");

		// 人回来改主意：必须能覆盖机器代做的选择，并如实留痕为 human
		const overturned = await settleDisposition(
			runtime,
			{ key, answer: "永久放弃", answeredBy: "老板", now: now + 10 * 60_000 },
			BACKGROUND_CONTEXT,
		);
		expect(overturned.ok).toBe(true);
		const read = await readDisposition(runtime, key, {});
		expect(read?.payload.decidedBy).toBe("human");
		expect(read?.payload.disposition).toBe("abandon");
	}, 30_000);
});
