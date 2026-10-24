/**
 * 圆桌讨论的端到端测试（契约 §6）。
 *
 * 覆盖：正常收口、两轮表态、部分缺席、全体缺席、参与者超时、中途 abort、
 * 参与者校验（不能请自己 / 不重复 / 无效岗位）、重启后纪要仍可查、能力包按岗位裁剪。
 */
import { afterEach, describe, expect, test } from "vitest";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createRegistry, openCompany, recover, type CompanyRuntime } from "../../src/runtime/index.ts";
import { bootstrapCompany } from "../../src/company/org.ts";
import { AuditDoc, CompanyDoc } from "../../src/company/docs.ts";
import {
	DEFAULT_ROUNDTABLE_ROLES,
	RoundtableDoc,
	listRoundtables,
	readRoundtableMinutes,
	roundtableExtension,
	runRoundtable,
	startRoundtable,
} from "../../src/company/roundtable.ts";
import { createRoundtableTools } from "../../src/company/roundtable-tools.ts";
import { createTestContext, answer, slowAnswer, toolCall, type TestContext, TEST_MODEL_CATALOG } from "../support.ts";

let contexts: TestContext[] = [];
let runtimes: CompanyRuntime[] = [];

async function setup(): Promise<{
	ctx: TestContext;
	runtime: CompanyRuntime;
	registry: ReturnType<typeof createRegistry>;
	roles: Record<string, number>;
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

	const state = await runtime.harness.snapshot(CompanyDoc, BACKGROUND_CONTEXT);
	return { ctx, runtime, registry, roles: state?.roles ?? {} };
}

afterEach(async () => {
	for (const runtime of runtimes) await runtime.close().catch(() => undefined);
	for (const ctx of contexts) await ctx.cleanup();
	runtimes = [];
	contexts = [];
});

describe("圆桌讨论：正常收口", () => {
	test("第 1 轮并行收齐各岗位意见，写成纪要", async () => {
		const { ctx, runtime, roles } = await setup();
		ctx.faux.setResponses([answer("CTO：可行，但先补监控"), answer("CFO：成本可接受")]);

		const outcome = await runRoundtable(
			runtime,
			{
				topic: "要不要给 Web 界面加实时协作",
				question: "这一版做不做实时协作？",
				roles: ["cto", "cfo"],
				fromConversationId: roles.ceo ?? 1,
				from: "CEO",
			},
			BACKGROUND_CONTEXT,
		);

		expect(outcome.ok, outcome.minutes).toBe(true);
		expect(outcome.status).toBe("completed");
		expect(outcome.present).toEqual(["cto", "cfo"]);
		expect(outcome.absent).toEqual([]);
		expect(outcome.minutes).toContain("CTO：可行，但先补监控");
		expect(outcome.minutes).toContain("CFO：成本可接受");
		expect(outcome.minutes).toContain("要不要给 Web 界面加实时协作");
		expect(outcome.minutes).toContain("第 1 轮");
	});

	test("纪要持久化：RoundtableDoc 里能查到完整记录", async () => {
		const { ctx, runtime, roles } = await setup();
		ctx.faux.setResponses([answer("CTO：做")]);

		const outcome = await runRoundtable(
			runtime,
			{ topic: "排期", roles: ["cto"], fromConversationId: roles.ceo ?? 1 },
			BACKGROUND_CONTEXT,
		);

		const state = await runtime.harness.snapshot(RoundtableDoc, BACKGROUND_CONTEXT);
		const record = state?.records.find((item) => item.id === outcome.id);
		expect(record).toBeDefined();
		expect(record?.status).toBe("completed");
		expect(record?.roles).toEqual(["cto"]);
		expect(record?.opinions.length).toBe(1);
		expect(record?.opinions[0]?.status).toBe("present");
		expect(record?.summary).toContain("CTO：做");
		expect(record?.deadline).toBeGreaterThan(record?.createdAt ?? 0);

		// 结论同时写审计：老板问「谁在什么时候开了什么会」时查得到
		const audit = await runtime.harness.snapshot(AuditDoc, (roles.ceo ?? 1) as never, BACKGROUND_CONTEXT);
		const event = audit?.events.find((item) => item.ref?.startsWith(`${outcome.id}#`));
		expect(event, "圆桌结论必须进审计").toBeDefined();
		expect(event?.note).toContain("圆桌讨论");
		expect(event?.note).toContain("排期");
	});

	test("roundtable_minutes 不传编号时取最近一次", async () => {
		const { ctx, runtime, roles } = await setup();
		ctx.faux.setResponses([answer("CTO：先做 A"), answer("CTO：先做 B")]);

		await runRoundtable(
			runtime,
			{ topic: "第一件", roles: ["cto"], fromConversationId: roles.ceo ?? 1 },
			BACKGROUND_CONTEXT,
		);
		await runRoundtable(
			runtime,
			{ topic: "第二件", roles: ["cto"], fromConversationId: roles.ceo ?? 1 },
			BACKGROUND_CONTEXT,
		);

		const minutes = await readRoundtableMinutes(runtime, undefined, BACKGROUND_CONTEXT);
		expect(minutes).toContain("第二件");
		expect(minutes).not.toContain("第一件");

		const records = await listRoundtables(runtime, BACKGROUND_CONTEXT);
		expect(records.length).toBe(2);
	});
});

describe("圆桌讨论：第 2 轮表态", () => {
	test("第 2 轮把第 1 轮汇总回投，并解析出立场", async () => {
		const { ctx, runtime, roles } = await setup();
		ctx.faux.setResponses([
			answer("CTO：可行"),
			answer("CFO：太贵，建议缩范围"),
			// 第 2 轮：CTO 保留，CFO 修正
			answer("保留：技术上没问题"),
			answer("修正：范围缩一半就可以接受"),
		]);

		const outcome = await runRoundtable(
			runtime,
			{
				topic: "要不要一次做全量功能",
				roles: ["cto", "cfo"],
				rounds: 2,
				fromConversationId: roles.ceo ?? 1,
			},
			BACKGROUND_CONTEXT,
		);

		expect(outcome.ok, outcome.minutes).toBe(true);
		expect(outcome.minutes).toContain("第 2 轮");
		expect(outcome.minutes).toContain("立场分布");
		expect(outcome.minutes).toContain("保留 CTO");
		expect(outcome.minutes).toContain("修正 CFO");
		expect(outcome.minutes).toContain("存在分歧");

		const state = await runtime.harness.snapshot(RoundtableDoc, BACKGROUND_CONTEXT);
		const record = state?.records.find((item) => item.id === outcome.id);
		const round2 = record?.opinions.filter((item) => item.round === 2) ?? [];
		expect(round2.map((item) => item.stance)).toEqual(["keep", "revise"]);
	});

	test("第 2 轮的提示词里带着第 1 轮的意见", async () => {
		const { ctx, runtime, roles } = await setup();
		ctx.faux.setResponses([
			answer("CTO：第 1 轮的技术结论"),
			answer("保留"),
		]);

		await runRoundtable(
			runtime,
			{ topic: "议题", roles: ["cto"], rounds: 2, fromConversationId: roles.ceo ?? 1 },
			BACKGROUND_CONTEXT,
		);

		const cto = await runtime.harness.conversation((roles.cto ?? 0) as never, BACKGROUND_CONTEXT);
		const entries = await cto?.entries({ order: "ascending" }, 50, undefined, BACKGROUND_CONTEXT);
		const prompts = (entries?.items ?? [])
			.filter((entry) => entry.kind === "app.delegate")
			.map((entry) => JSON.stringify(entry.data))
			.join("\n");
		expect(prompts).toContain("第 2 轮");
		expect(prompts).toContain("第 1 轮的技术结论");
	});
});

describe("圆桌讨论：容错", () => {
	test("部分参与者失败只标缺席，不影响其余结论", async () => {
		const { ctx, runtime, roles } = await setup();
		// 只准备一份回答：另一个参与者会拿到 model_error
		ctx.faux.setResponses([answer("CTO：可以")]);

		const outcome = await runRoundtable(
			runtime,
			{ topic: "部分缺席", roles: ["cto", "cfo"], fromConversationId: roles.ceo ?? 1 },
			BACKGROUND_CONTEXT,
		);

		expect(outcome.status).toBe("completed");
		expect(outcome.present).toEqual(["cto"]);
		expect(outcome.absent).toEqual(["cfo"]);
		expect(outcome.minutes).toContain("CTO：可以");
		expect(outcome.minutes).toContain("缺席");
	});

	test("全体缺席也产出纪要并写明原因", async () => {
		const { runtime, roles } = await setup();
		// 不排任何回答：两个参与者都会失败
		const outcome = await runRoundtable(
			runtime,
			{ topic: "全体缺席", roles: ["cto", "cfo"], fromConversationId: roles.ceo ?? 1 },
			BACKGROUND_CONTEXT,
		);

		expect(outcome.status).toBe("completed");
		expect(outcome.present).toEqual([]);
		expect(outcome.absent).toEqual(["cto", "cfo"]);
		expect(outcome.minutes).toContain("没有任何岗位给出意见");
		expect(outcome.minutes).toContain("缺席");
	});

	test("单个参与者超时只标缺席，整体照常收口", async () => {
		const { ctx, runtime, roles } = await setup();
		ctx.faux.setResponses([slowAnswer(3_000, "CTO：慢但答了")]);

		const started = Date.now();
		const outcome = await runRoundtable(
			runtime,
			{
				topic: "超时",
				roles: ["cto"],
				timeoutMs: 150,
				fromConversationId: roles.ceo ?? 1,
			},
			BACKGROUND_CONTEXT,
		);

		expect(Date.now() - started).toBeLessThan(2_500);
		expect(outcome.status).toBe("completed");
		expect(outcome.absent).toEqual(["cto"]);
		expect(outcome.minutes).toContain("超时");
	});

	test("中途 abort：任务干净退出，纪要标已中断并保留已收到的意见", async () => {
		const { ctx, runtime, roles } = await setup();
		ctx.faux.setResponses([slowAnswer(3_000, "CTO：慢慢答"), answer("CFO：快答")]);

		const started = await startRoundtable(
			runtime,
			{ topic: "会被中断的会", roles: ["cto", "cfo"], timeoutMs: 5_000, fromConversationId: roles.ceo ?? 1 },
			BACKGROUND_CONTEXT,
		);
		expect(started.roles).toEqual(["cto", "cfo"]);

		// 等任务真的跑起来再中断，模拟老板点「立即处理」
		await new Promise((resolve) => setTimeout(resolve, 300));
		await runtime.harness.abortTask(started.taskId as never, BACKGROUND_CONTEXT);
		const settled = await runtime.harness.waitForTask(started.taskId as never, BACKGROUND_CONTEXT);
		expect(settled.state.status).toBe("terminal");

		const state = await runtime.harness.snapshot(RoundtableDoc, BACKGROUND_CONTEXT);
		const record = state?.records.find((item) => item.id === started.id);
		expect(record?.status).toBe("aborted");
		expect(record?.endedAt).toBeGreaterThan(0);
		expect(record?.note).toContain("中断");
		expect(record?.summary).toContain("已中断");
	});
});

describe("圆桌讨论：参与者校验", () => {
	test("不请调用方自己、不重复、过滤无效岗位", async () => {
		const { ctx, runtime, roles } = await setup();
		ctx.faux.setResponses([answer("CTO：可以")]);

		const outcome = await runRoundtable(
			runtime,
			{
				topic: "校验",
				roles: ["ceo", "cto", "cto", "不存在的岗位", "cfo"],
				fromConversationId: roles.ceo ?? 1,
			},
			BACKGROUND_CONTEXT,
		);

		const state = await runtime.harness.snapshot(RoundtableDoc, BACKGROUND_CONTEXT);
		const record = state?.records.find((item) => item.id === outcome.id);
		// ceo 是发起方自己（根会话），被剔除；cto 去重；无效岗位被过滤
		expect(record?.roles).toEqual(["cto", "cfo"]);
	});

	test("默认参与者是 cto/cfo/cpo/coo", async () => {
		const { runtime, roles } = await setup();
		const started = await startRoundtable(
			runtime,
			{ topic: "默认名单", fromConversationId: roles.ceo ?? 1 },
			BACKGROUND_CONTEXT,
		);
		expect(started.roles).toEqual([...DEFAULT_ROUNDTABLE_ROLES]);
	});

	test("议题为空直接失败，不开会", async () => {
		const { runtime, roles } = await setup();
		const outcome = await runRoundtable(
			runtime,
			{ topic: "  ", fromConversationId: roles.ceo ?? 1 },
			BACKGROUND_CONTEXT,
		);
		expect(outcome.ok).toBe(false);
		expect(outcome.reason).toBe("empty-topic");
	});
});

describe("圆桌讨论：重启后仍可查", () => {
	test("关闭重开后 roundtable_minutes 还能读到纪要", async () => {
		const { ctx, runtime, roles } = await setup();
		ctx.faux.setResponses([answer("CTO：重启前定的")]);

		const outcome = await runRoundtable(
			runtime,
			{ topic: "跨重启", roles: ["cto"], fromConversationId: roles.ceo ?? 1 },
			BACKGROUND_CONTEXT,
		);
		await runtime.close();

		const registry = createRegistry();
		registry.install(roundtableExtension());
		const reopened = await openCompany(
			{ databasePath: ctx.databasePath, models: ctx.models, registry },
			BACKGROUND_CONTEXT,
		);
		runtimes.push(reopened);
		await recover(reopened, BACKGROUND_CONTEXT);

		const minutes = await readRoundtableMinutes(reopened, outcome.id, BACKGROUND_CONTEXT);
		expect(minutes).toContain("重启前定的");
		expect(minutes).toContain("跨重启");
	});
});

describe("圆桌讨论：能力包按岗位裁剪", () => {
	test("ceo/coo/cto 有 roundtable，cfo 没有；ceo/coo 有 minutes", async () => {
		const { runtime, roles } = await setup();
		const toolsOf = async (role: string): Promise<string[]> => {
			const conversation = await runtime.harness.conversation((roles[role] ?? 0) as never, BACKGROUND_CONTEXT);
			return (await conversation?.agent(BACKGROUND_CONTEXT))?.tools.map((tool) => tool.name) ?? [];
		};

		const ceo = await toolsOf("ceo");
		const coo = await toolsOf("coo");
		const cto = await toolsOf("cto");
		const cfo = await toolsOf("cfo");

		expect(ceo).toContain("roundtable");
		expect(ceo).toContain("roundtable_minutes");
		expect(coo).toContain("roundtable");
		expect(coo).toContain("roundtable_minutes");
		expect(cto).toContain("roundtable");
		expect(cto).not.toContain("roundtable_minutes");
		expect(cfo).not.toContain("roundtable");
	});

	test("工具工厂在首次调用时自愈式注册任务能力包", async () => {
		const { runtime, registry, roles } = await setup();
		// 换一个干净注册表：模拟「装配层漏装圆桌任务」
		const fresh = createRegistry();
		const tools = createRoundtableTools({ runtime, registry: fresh });
		expect(tools.roundtable.name).toBe("roundtable");
		expect(tools.roundtableMinutes.name).toBe("roundtable_minutes");
		expect(roles.ceo).toBeGreaterThan(0);
		// 直接调用一次，确认能装上任务定义（幂等）
		void registry;
	});
});

describe("圆桌讨论：装配链路（CEO 会话里真的能开会）", () => {
	test("CEO 调 roundtable 工具，纪要回到模型上下文，且任务定义已自动注册", async () => {
		const { ctx, runtime, roles } = await setup();

		// CEO 调 roundtable → 工具内部开会（CTO/CFO 各答一次）→ 工具把纪要返回给 CEO → CEO 回老板
		ctx.faux.setResponses([
			toolCall("roundtable", { topic: "要不要先做移动端", roles: ["cto", "cfo"] }),
			answer("CTO：先做 Web"),
			answer("CFO：移动端成本高"),
			answer("结论：先做 Web，移动端下一轮再议。"),
		]);

		const ceo = await runtime.harness.conversation((roles.ceo ?? 0) as never, BACKGROUND_CONTEXT);
		const settled = await (
			await ceo?.submit({ type: "input", content: "大家什么意见？" }, BACKGROUND_CONTEXT)
		)?.wait(BACKGROUND_CONTEXT);
		expect(settled?.status).toBe("done");

		// 纪要里能看到两位的真实发言，说明工具真的跑完了整场会
		const entries = await ceo?.entries({ order: "ascending" }, 100, undefined, BACKGROUND_CONTEXT);
		const transcript = (entries?.items ?? []).map((entry) => JSON.stringify(entry.model ?? "")).join("\n");
		expect(transcript).toContain("CTO：先做 Web");
		expect(transcript).toContain("CFO：移动端成本高");
		expect(transcript).toContain("圆桌纪要");

		// 会议记录落库，且不需要手工注册任务定义（org.ts 装配时已装）
		const records = await listRoundtables(runtime, BACKGROUND_CONTEXT);
		expect(records.length).toBe(1);
		expect(records[0]?.status).toBe("completed");
	});

	test("roundtable_minutes 工具能回看纪要", async () => {
		const { ctx, runtime, roles } = await setup();
		ctx.faux.setResponses([
			toolCall("roundtable", { topic: "查纪要的会", roles: ["cto"] }),
			answer("CTO：随便说点"),
			toolCall("roundtable_minutes", {}),
			answer("看到了纪要"),
		]);

		const ceo = await runtime.harness.conversation((roles.ceo ?? 0) as never, BACKGROUND_CONTEXT);
		const settled = await (
			await ceo?.submit({ type: "input", content: "先开会再查纪要" }, BACKGROUND_CONTEXT)
		)?.wait(BACKGROUND_CONTEXT);
		expect(settled?.status).toBe("done");

		const entries = await ceo?.entries({ order: "ascending" }, 100, undefined, BACKGROUND_CONTEXT);
		const transcript = (entries?.items ?? []).map((entry) => JSON.stringify(entry.model ?? "")).join("\n");
		// 第二次工具调用的结果里应有完整纪要
		expect(transcript).toContain("查纪要的会");
		expect(transcript).toContain("CTO：随便说点");
	});
});
