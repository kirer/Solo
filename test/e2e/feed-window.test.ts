/**
 * Feed 读取窗口（OPS-20261025-05 回归）。
 *
 * 真实故障：会话历史超过 400 条 entries 后，界面上的对话「冻结」在旧条目上——
 * 老板发消息（插入/打断）后，模型的回复永远不出现。
 * 根因是 `readFeed` 用 `entries({ order: "ascending" }, limit)` 取的是**最旧**一页。
 * 这里用直接 appendEntry 的方式钉住两件事：
 * 1. feed 必须取最新的 limit 条（新的 user/assistant 一定要出现）；
 * 2. `app.receipt` 不能被当成普通 note 重复正文（每条老板消息只出现一次）。
 */
import { afterEach, describe, expect, test } from "vitest";
import {
	BACKGROUND_CONTEXT,
	createRegistry,
	openCompany,
	type CompanyRuntime,
} from "../../src/runtime/index.ts";
import { readFeed } from "../../src/server/feed.ts";
import { createTestContext, type TestContext } from "../support.ts";

let contexts: TestContext[] = [];
let runtimes: CompanyRuntime[] = [];

afterEach(async () => {
	for (const runtime of runtimes.splice(0)) await runtime.close().catch(() => undefined);
	for (const ctx of contexts.splice(0)) await ctx.cleanup();
});

async function setup(): Promise<{ runtime: CompanyRuntime; conversationId: number }> {
	const ctx = await createTestContext();
	contexts.push(ctx);
	const runtime = await openCompany(
		{ databasePath: ctx.databasePath, models: ctx.models, registry: createRegistry() },
		BACKGROUND_CONTEXT,
	);
	runtimes.push(runtime);
	const conversation = await runtime.harness.createConversation(
		{ ownership: { kind: "ownerless" } },
		BACKGROUND_CONTEXT,
	);
	return { runtime, conversationId: Number(conversation.id) };
}

/** 往会话里追加一条用户消息 / 一条助手回复。 */
async function appendExchange(
	runtime: CompanyRuntime,
	conversationId: number,
	index: number,
	withReceipt = false,
): Promise<void> {
	await runtime.harness.commit(async (tx) => {
		if (withReceipt) {
			await tx.appendEntry(conversationId as never, {
				kind: "app.receipt",
				data: { text: `消息 ${index}`, from: "老板", timing: "now", at: 1_700_000_000_000 + index },
			});
		}
		await tx.appendEntry(conversationId as never, {
			kind: "pi.user",
			model: [{ role: "user", content: `消息 ${index}`, timestamp: 1_700_000_000_000 + index }],
		});
		await tx.appendEntry(conversationId as never, {
			kind: "pi.assistant",
			model: [
				{
					role: "assistant",
					content: [{ type: "text", text: `回复 ${index}` }],
					timestamp: 1_700_000_000_100 + index,
				},
			],
		});
	}, BACKGROUND_CONTEXT);
}

describe("feed 读取窗口：会话超过 limit 后仍然看得到新消息与新回复", () => {
	test("450 轮对话（900+ 条 entries）后，最新一轮的 user 与 assistant 都在 feed 里", async () => {
		const { runtime, conversationId } = await setup();

		for (let index = 1; index <= 450; index += 1) {
			await appendExchange(runtime, conversationId, index);
		}

		const feed = await readFeed(runtime, conversationId, { limit: 400 }, BACKGROUND_CONTEXT);
		expect(feed).toBeDefined();
		const texts = (feed?.items ?? []).map((item) => item.text ?? "");

		// 关键回归：最新的问答必须出现（旧实现只读到最旧 400 条，这里会是空的）
		expect(texts).toContain("消息 450");
		expect(texts).toContain("回复 450");
		// 窗口语义：只回最近 limit 条，不是整段历史
		expect(feed?.items.length ?? 0).toBeLessThanOrEqual(400);
		// 也不能把最早的消息混进来
		expect(texts).not.toContain("消息 1");
	}, 60_000);

	test("app.receipt 只渲染成一条短回执，不重复正文", async () => {
		const { runtime, conversationId } = await setup();
		await appendExchange(runtime, conversationId, 1, true);

		const feed = await readFeed(runtime, conversationId, BACKGROUND_CONTEXT);
		const items = feed?.items ?? [];
		const sameText = items.filter((item) => item.text === "消息 1");
		// 用户消息只出现一次（回执原先会把全文再渲染一遍）
		expect(sameText).toHaveLength(1);
		expect(sameText[0]?.kind).toBe("user");
		// 回执仍然看得见，但是短提示
		expect(items.some((item) => item.kind === "note" && item.text?.startsWith("已收到"))).toBe(true);
	}, 30_000);
});
