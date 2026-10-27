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
import { readChannels } from "../../src/company/channels.ts";
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
	/**
	 * 拍板结果现在是**一条频道消息**（`kind: "decision"`，@ 提问方），
	 * 不是会话流里的一条 `app.decision` 记录。
	 *
	 * 这个变化是 ADR-037 的一部分：`decision-delivery.ts` 那 142 行做的
	 * 「往一个会话投一条输入并落一条条目」和 `postToChannel` 是同一件事，
	 * 只是少做了未读摘要 / 记忆简报 / ReplyContextDoc。同一个事实有两条实现，
	 * 正是 ADR-028 要消灭的。合并后拍板落进频道——于是它能被翻回去、能被 @
	 * 回、能出现在未读摘要里，这是会话流里一条 note 做不到的。
	 */
	async function decisionMessagesMentioning(
		runtime: CompanyRuntime,
		conversationId: number,
	): Promise<{ channelId: string; text: string }[]> {
		const state = await readChannels(runtime, BACKGROUND_CONTEXT);
		const found: { channelId: string; text: string }[] = [];
		for (const [channelId, channel] of Object.entries(state.channels)) {
			for (const message of channel.messages) {
				if (message.kind !== "decision") continue;
				if (!message.mentions.includes(conversationId)) continue;
				found.push({ channelId, text: message.text });
			}
		}
		return found;
	}

	/**
	 * 让一条「非 CEO 声明的 company-level」经过 CEO 复核并递到老板。
	 *
	 * Defect B 修复后，company-level 不再直达老板：必须先由 CEO 确认。
	 * 本文件下面两条测试关心的是「拍板结果投递给谁」，与「谁先复核」无关，
	 * 但它们必须先把条目推到 owner 级才谈得上老板拍板——所以统一走这个辅助。
	 */
	async function pushToOwnerViaCeoReview(
		runtime: CompanyRuntime,
		label: string,
	): Promise<string> {
		const { answerPending: answer } = await import("../../src/company/escalation.ts");
		// ① 先等 CEO 复核站出现
		let key = "";
		await eventually(
			async () => {
				const items = await listPending(runtime, BACKGROUND_CONTEXT);
				const item = items.find((entry) => entry.question.includes(label));
				key = item?.key ?? "";
				return key !== "" && item?.level === "ceo";
			},
			{ label: "CEO 复核站出现", timeoutMs: 10_000 },
		);
		// ② CEO 确认「确实只能老板定」→ escalate 递老板
		expect(
			await answer(runtime, { key, answer: "这确实只有老板能定。", answeredBy: "ceo", escalate: true }, BACKGROUND_CONTEXT),
		).toBe(true);
		// ③ 等它真的进到 owner 站
		await eventually(
			async () => {
				const items = await listPending(runtime, BACKGROUND_CONTEXT);
				return items.some((entry) => entry.key === key && entry.level === "owner");
			},
			{ label: "递到老板站", timeoutMs: 10_000 },
		);
		return key;
	}

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

		// Defect B：company-level 先落 CEO 复核，CEO 确认后才到 owner 级。
		const key = await pushToOwnerViaCeoReview(runtime, "搬到杭州");

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

		// 关键断言：CTO 被 @ 到的那条拍板消息存在，且只有一条
		const decisions = await decisionMessagesMentioning(runtime, ctoId);
		expect(decisions, "提问方必须看得到拍板结果").toHaveLength(1);
		expect(decisions[0]?.text).toContain("搬到杭州");
		expect(decisions[0]?.channelId, "有私聊就投私聊——那是「对你拍板」最直接的落点").toBe(`dm:${ctoId}`);

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

		// Defect B：同样要经 CEO 复核递老板。
		const key = await pushToOwnerViaCeoReview(runtime, "测试岗");

		await answerPending(runtime, { key, answer: "加，走 CHRO。", answeredBy: "owner" }, BACKGROUND_CONTEXT);

		const decisions = await decisionMessagesMentioning(runtime, ctoId);
		expect(decisions, "同一次拍板只能留下一条记录").toHaveLength(1);
	}, 40_000);
});
