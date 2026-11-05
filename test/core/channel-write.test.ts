import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { BACKGROUND_CONTEXT } from "../../src/core/runtime/index.ts";
import type { CoreRuntime } from "../../src/core/runtime/open.ts";
import { ChannelDoc, type ChannelState } from "../../src/core/channel/types.ts";
import { appendMessage, ensureChannel } from "../../src/core/channel/rules.ts";
import { createChannelFlow } from "../../src/core/channel/post.ts";
import { appendNote } from "../../src/core/channel/write.ts";
import { sandboxPool } from "./support.ts";

/**
 * 频道写入的**代价**契约（不只是结果对不对）。
 *
 * 这里守的是一个曾经真实发生过的事故：消息存对了、界面也对，但每发一条消息都把
 * 该频道的**全部历史**重写一遍。一个 189 条消息的频道因此吃掉 27 MB，整个库 60 MB，
 * 而它的真实状态只有 0.7 MB —— 85 倍放大，并且随消息数平方增长。
 *
 * 所以断言不看「消息在不在」，看「写一条消息付出多少字节」。这类退化在功能测试里
 * 完全不可见：所有测试都能过，只有磁盘在涨。
 */
const pool = sandboxPool();

afterEach(() => pool.cleanup());

/** 频道文档在库里占的字节数（基线 + 全部增量）。 */
function storedBytes(file: string, kind: string): number {
	const db = new DatabaseSync(file);
	const row = db
		.prepare(
			`select coalesce(sum(length(r.content)), 0) as bytes
			 from document_revisions r join documents d on d.id = r.document_id
			 where json_extract(d.record, '$.kind') = ?`,
		)
		.get(kind) as { bytes: number } | undefined;
	db.close();
	return row?.bytes ?? 0;
}

async function setup(): Promise<{ runtime: CoreRuntime; file: string; channelId: string }> {
	const box = await pool.make("core-write-");
	const file = box.layout.databasePath;
	const runtime = await box.open();
	const channelId = "team:计费";
	await runtime.harness.commit(async (tx) => {
		const doc = (await tx.doc(ChannelDoc)) as ChannelState;
		doc.channels[channelId] = ensureChannel(doc, {
			id: channelId,
			title: "计费",
			members: ["owner", "林越"],
			wakeOnAll: [],
			at: 1,
		}).channels[channelId] as never;
		doc.nextSeq[channelId] = 1;
	}, BACKGROUND_CONTEXT);
	return { runtime, file, channelId };
}

describe("频道写入的字节代价", () => {
	it("每追加一条消息只花消息本身那么多字节，不重写整个频道", async () => {
		const { runtime, file, channelId } = await setup();
		const text = "记".repeat(200);
		const perMessage = 200 * 3 + 200; // UTF-8 三字节 + JSON 结构余量

		for (let index = 0; index < 40; index += 1) {
			const state = (await runtime.harness.snapshot(ChannelDoc, BACKGROUND_CONTEXT)) as ChannelState;
			await createChannelFlow({
				harness: runtime.harness,
				conversationOf: async () => undefined,
			}).publish(state, { channelId, from: "林越", text, at: 100 + index, wake: false }, BACKGROUND_CONTEXT);
		}

		const state = (await runtime.harness.snapshot(ChannelDoc, BACKGROUND_CONTEXT)) as ChannelState;
		expect(state.messages[channelId]?.length).toBe(40);

		// 整值替换的实现下这里是 40²/2 条消息 = 约 100 万字节级别；线性写入不到 5 万。
		const bytes = storedBytes(file, "core.channels");
		expect(bytes).toBeLessThan(40 * perMessage + 20_000);
	});

	it("压基线之后旧增量被回收，库不会只增不减", async () => {
		const { runtime, file, channelId } = await setup();
		// 触发点：`deltasSinceBase >= 64`。
		for (let index = 0; index < 70; index += 1) {
			const state = (await runtime.harness.snapshot(ChannelDoc, BACKGROUND_CONTEXT)) as ChannelState;
			await createChannelFlow({
				harness: runtime.harness,
				conversationOf: async () => undefined,
			}).publish(
				state,
				{ channelId, from: "林越", text: `第 ${index} 条`, at: 200 + index, wake: false },
				BACKGROUND_CONTEXT,
			);
		}

		const state = (await runtime.harness.snapshot(ChannelDoc, BACKGROUND_CONTEXT)) as ChannelState;
		expect(state.messages[channelId]?.length).toBe(70);

		const db = new DatabaseSync(file);
		const bases = db
			.prepare(
				`select count(*) as n from document_revisions r join documents d on d.id = r.document_id
				 where json_extract(d.record, '$.kind') = 'core.channels' and r.kind = 'base'`,
			)
			.get() as { n: number };
		db.close();
		// 压过基线就是「一个基线 + 少量增量」，不是「一个初始基线 + 70 条增量」。
		expect(bases.n).toBeGreaterThanOrEqual(1);
		const bytes = storedBytes(file, "core.channels");
		expect(bytes).toBeLessThan(120_000);
	});
});

describe("系统留痕与普通消息走同一条写入路径（ADR-096）", () => {
	it("appendNote 在 nextSeq 落后时自愈，拿到的是真实下一条 seq", async () => {
		const { runtime, channelId } = await setup();
		// 模拟「文档里的 nextSeq 落后于消息」：消息已经到 seq 5，nextSeq 还停在 1。
		// 旧实现（各写一份）里只有 postMessage 会自愈，留痕会拿到撞号的 seq。
		await runtime.harness.commit(async (tx) => {
			const doc = (await tx.doc(ChannelDoc)) as ChannelState;
			const { message } = appendMessage({ channels: doc.channels, messages: {}, nextSeq: {}, readMarks: {} }, channelId, {
				from: "林越",
				text: "旧消息",
				at: 1,
			});
			doc.messages[channelId] = [{ ...message, seq: 5 }];
			doc.nextSeq[channelId] = 1;
		}, BACKGROUND_CONTEXT);

		await appendNote({ harness: runtime.harness }, channelId, "系统留痕", 300, BACKGROUND_CONTEXT);

		const state = (await runtime.harness.snapshot(ChannelDoc, BACKGROUND_CONTEXT)) as ChannelState;
		const messages = state.messages[channelId] ?? [];
		expect(messages.map((item) => item.seq)).toEqual([5, 6]);
		expect(messages[1]?.kind).toBe("note");
		expect(state.nextSeq[channelId]).toBe(7);
	});

	it("留痕之后普通消息的 seq 紧接其后，两边连续", async () => {
		const { runtime, channelId } = await setup();
		await appendNote({ harness: runtime.harness }, channelId, "留痕", 300, BACKGROUND_CONTEXT);

		const state = (await runtime.harness.snapshot(ChannelDoc, BACKGROUND_CONTEXT)) as ChannelState;
		await createChannelFlow({
			harness: runtime.harness,
			conversationOf: async () => undefined,
		}).publish(state, { channelId, from: "林越", text: "正式回复", at: 301, wake: false }, BACKGROUND_CONTEXT);

		const after = (await runtime.harness.snapshot(ChannelDoc, BACKGROUND_CONTEXT)) as ChannelState;
		expect((after.messages[channelId] ?? []).map((item) => item.seq)).toEqual([1, 2]);
		expect(after.messages[channelId]?.[1]?.text).toBe("正式回复");
	});

	it("频道不存在时静默不写：不造孤儿消息", async () => {
		const { runtime } = await setup();
		await expect(
			appendNote({ harness: runtime.harness }, "team:不存在", "留痕", 1, BACKGROUND_CONTEXT),
		).resolves.toBeUndefined();
	});
});

describe("并发写入", () => {
	it("三个人同时 say，三条都落库、seq 不撞、没有重复", async () => {
		// 线上撞出过：一次 `say` 报 `Cannot use a settled overlay`，而消息**已经写进去了**，
		// 模型看到报错就重试，频道里于是出现两条一模一样的「在。」。
		//
		// 守的是「一次调用 = 一条消息」。注意：去掉 `postMessage` 里的串行闸，这个用例
		// **仍然会过** —— 我试过。真实的并发时序（读覆盖层被别的 agent 的提交释放）在
		// 单进程测试里复现不稳。所以串行闸是防御性的，这个用例只是把「并发调用不许
		// 撞 seq、不许丢消息」这条底线钉住。
		const { runtime, channelId } = await setup();
		const send = async (from: string, text: string) => {
			const state = (await runtime.harness.snapshot(ChannelDoc, BACKGROUND_CONTEXT)) as ChannelState;
			return createChannelFlow({
				harness: runtime.harness,
				conversationOf: async () => undefined,
			}).publish(state, { channelId, from, text, at: 200, wake: false }, BACKGROUND_CONTEXT);
		};
		await Promise.all([send("林越", "并发一"), send("林越", "并发二"), send("林越", "并发三")]);

		const state = (await runtime.harness.snapshot(ChannelDoc, BACKGROUND_CONTEXT)) as ChannelState;
		const messages = state.messages[channelId] ?? [];
		const texts = messages.map((item) => item.text).sort();
		expect(texts).toEqual(["并发一", "并发三", "并发二"]);
		const seqs = messages.map((item) => item.seq);
		expect(new Set(seqs).size).toBe(seqs.length);
	});
});
