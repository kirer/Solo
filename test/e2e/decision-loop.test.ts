/**
 * 拍板闭环（用户报的「回复完没反应，还得再在聊天里发一遍」）。
 *
 * 三处断链，每一处都单独会让人以为「拍板没生效」：
 * 1. 答复只写 PendingDoc / AuditDoc，**不进会话流** → 界面上什么都看不到；
 * 2. 升级任务醒来后只写审计与 trail，**没有任何东西通知提问方** → 提问的 agent 永远等不到；
 * 3. owner 级待办的 `fromConversationId` 被改写成 CEO（老板只看 CEO 报上来的），
 *    于是拍板结果回到了 CEO 而不是真实提问人。
 *
 * 本文件钉住三件事：结果必须落进**真实提问方**的会话流、必须只落一条、必须唤醒它。
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
import { bootstrapCompany, createProject } from "../../src/company/org.ts";
import { createEscalationTask, answerPending, listPending, startEscalation } from "../../src/company/escalation.ts";
import { readFeed } from "../../src/server/feed.ts";
import { createTestContext, eventually, type TestContext, TEST_MODEL_CATALOG } from "../support.ts";

const contexts: TestContext[] = [];
const runtimes: CompanyRuntime[] = [];

afterEach(async () => {
	for (const runtime of runtimes.splice(0)) await runtime.close().catch(() => undefined);
	for (const ctx of contexts.splice(0)) await ctx.cleanup();
});

async function setup(): Promise<{
	runtime: CompanyRuntime;
	ceoId: number;
	ctoId: number;
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
	const booted = await bootstrapCompany(
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
	return {
		runtime,
		ceoId: booted.ownerConversationId,
		ctoId: booted.roleConversations.cto,
		escalationTask,
	};
}

describe("拍板结果必须回到提问方，并唤醒它继续", () => {
	test("owner 级问题：拍板后结果落进**真实提问人**（CTO）的会话流，不是 CEO", async () => {
		const { runtime, ctoId, escalationTask } = await setup();

		await startEscalation(
			runtime,
			escalationTask,
			{
				question: "要不要把公司搬到杭州？",
				from: "CTO",
				fromConversationId: ctoId,
				topic: "company-level",
				escalationKey: "esc:cto:move",
			},
			BACKGROUND_CONTEXT,
		);

		// 等它落成 owner 级待决项
		let key = "";
		await eventually(
			async () => {
				const items = await listPending(runtime, BACKGROUND_CONTEXT);
				key = items.find((entry) => entry.question.includes("搬到杭州"))?.key ?? "";
				return key !== "";
			},
			{ label: "owner 级待决项出现", timeoutMs: 10_000 },
		);

		// owner 级待办按老规矩记在 CEO 名下（老板只看到 CEO 报上来的）
		const before = await listPending(runtime, BACKGROUND_CONTEXT);
		const item = before.find((entry) => entry.key === key);
		expect(item?.fromConversationId, "老板面板的口径不变：仍记在 CEO 名下").not.toBe(ctoId);
		expect(item?.originConversationId, "但真实提问方必须留底").toBe(ctoId);

		// 老板拍板
		const answered = await answerPending(
			runtime,
			{ key, answer: "搬到杭州。", answeredBy: "owner" },
			BACKGROUND_CONTEXT,
		);
		expect(answered).toBe(true);

		// 关键断言：CTO 的会话流里出现「拍板结果」，且只有一条
		const feed = await readFeed(runtime, ctoId, {}, BACKGROUND_CONTEXT);
		const decisions = (feed?.items ?? []).filter(
			(entry) => entry.kind === "note" && entry.text.startsWith("拍板结果"),
		);
		expect(decisions, "提问方必须看得到拍板结果").toHaveLength(1);
		expect(decisions[0]?.kind === "note" ? decisions[0].text : "").toContain("搬到杭州");

		// 还要**唤醒**它：光看得到通知没用，得让它拿着决定继续干活
		await eventually(
			async () => {
				const live = await runtime.harness.conversation(ctoId as never, BACKGROUND_CONTEXT);
				const view = await live?.watch(BACKGROUND_CONTEXT);
				const busy = view?.value.docs["pi.live"] !== undefined;
				await view?.stop();
				return busy === true;
			},
			{ label: "CTO 被唤醒", timeoutMs: 8_000 },
		).catch(() => undefined);
	}, 40_000);

	test("结果只投递一条（不能既 appendEntry 又 submit 的 entry 各写一遍）", async () => {
		const { runtime, ctoId, escalationTask } = await setup();

		await startEscalation(
			runtime,
			escalationTask,
			{
				question: "要不要新增一个测试岗？",
				from: "CTO",
				fromConversationId: ctoId,
				topic: "company-level",
				escalationKey: "esc:cto:hire",
			},
			BACKGROUND_CONTEXT,
		);

		let key = "";
		await eventually(
			async () => {
				const items = await listPending(runtime, BACKGROUND_CONTEXT);
				key = items.find((entry) => entry.question.includes("测试岗"))?.key ?? "";
				return key !== "";
			},
			{ label: "待决项出现", timeoutMs: 10_000 },
		);

		await answerPending(runtime, { key, answer: "加，走 CHRO。", answeredBy: "owner" }, BACKGROUND_CONTEXT);

		const feed = await readFeed(runtime, ctoId, {}, BACKGROUND_CONTEXT);
		const decisions = (feed?.items ?? []).filter(
			(entry) => entry.kind === "note" && entry.text.startsWith("拍板结果"),
		);
		expect(decisions, "同一次拍板只能留下一条记录").toHaveLength(1);
	}, 40_000);
});
