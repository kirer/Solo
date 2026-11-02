import { afterEach, describe, expect, it } from "vitest";
import { BACKGROUND_CONTEXT } from "../../src/core/runtime/index.ts";
import type { Conversation, EntryRecord } from "../../src/core/runtime/index.ts";
import type { CoreRuntime } from "../../src/core/runtime/open.ts";
import { ChannelDoc, type ChannelState } from "../../src/core/channel/types.ts";
import { ensureChannel } from "../../src/core/channel/rules.ts";
import type { WakeRecord } from "../../src/core/channel/wake.ts";
import {
	createTurnFinisher,
	finalTextOf,
	saidLast,
	spokeAfterWake,
	turnTarget,
} from "../../src/core/channel/turn/index.ts";
import { sandboxPool } from "./support.ts";

/**
 * 「他答了，但没说出来」的收尾。
 *
 * 真事（2026-10-29）：会话 2 的 transcript 里躺着最终回答，可 `all` 频道里只有
 * 「开始处理…」。V3 以前靠 6 秒定时器兜；现在靠结算（`done` 带 `answer`）。
 * 这里守的不是「能不能发」，而是三条判据：别抢跑、别重复、别把插话的任务频道弄丢。
 */
const pool = sandboxPool();

afterEach(() => pool.cleanup());

const CHANNEL = "team:计费";
const DM = "dm:林越";
const SLUG = "林越";

async function setup(): Promise<CoreRuntime> {
	const runtime = await (await pool.make("core-turn-")).open();
	await runtime.harness.commit(async (tx) => {
		const doc = (await tx.doc(ChannelDoc)) as ChannelState;
		for (const [id, title, members] of [
			[CHANNEL, "计费", ["owner", SLUG]],
			[DM, "林越", ["owner", SLUG]],
		] as const) {
			doc.channels[id] = ensureChannel(doc, { id, title, members: [...members], wakeOnAll: [], at: 1 }).channels[id] as never;
			doc.nextSeq[id] = 1;
		}
	}, BACKGROUND_CONTEXT);
	return runtime;
}

const wakeOf = (channelId: string, seq = 1): WakeRecord => {
	const target = { channelId, seq, from: "owner", at: 1 };
	return { reply: target, task: target };
};

const answer = (id: number, text: string): EntryRecord =>
	({
		id,
		kind: "pi.assistant",
		model: [{ role: "assistant", content: [{ type: "text", text }] }],
	}) as unknown as EntryRecord;

const conversationWith = (entry: EntryRecord): Conversation =>
	({ id: 7, entries: async () => ({ items: [entry] }) }) as unknown as Conversation;

const toolCall = (id: number, name: string): EntryRecord =>
	({
		id,
		kind: "pi.assistant",
		model: [{ role: "assistant", content: [{ type: "toolCall", id: `t-${id}`, name, arguments: {} }] }],
	}) as unknown as EntryRecord;

describe("最后一段正文是不是「刚说过那句」的复述", () => {
	const final = answer(3, "游戏写完了，在 workspace/index.html。");

	it("最后一个动作是 say：复述，不再补", () => {
		// 条目按时间倒序：最新的是最终正文，再往前是那句 say。
		expect(saidLast([final, toolCall(2, "say")], final)).toBe(true);
	});

	it("说完之后又跑了命令：最后那段是新结论", () => {
		expect(saidLast([final, toolCall(2, "run"), toolCall(1, "say")], final)).toBe(false);
	});

	it("一轮里一次 say 都没调：照补", () => {
		expect(saidLast([final, toolCall(2, "run")], final)).toBe(false);
	});
});

describe("从条目里取最终正文", () => {
	it("取最后一个 assistant 文本块（一轮里可能有工具与多段正文）", () => {
		const entry = {
			model: [
				{ role: "assistant", content: [{ type: "text", text: "先查一下。" }] },
				{ role: "tool", content: [] },
				{ role: "assistant", content: [{ type: "text", text: "跑完了，耗时 45 秒。" }] },
			],
		} as unknown as EntryRecord;
		expect(finalTextOf(entry)).toBe("跑完了，耗时 45 秒。");
	});

	it("没有条目或没有正文时返回 undefined", () => {
		expect(finalTextOf(undefined)).toBeUndefined();
		expect(finalTextOf({ model: [] } as unknown as EntryRecord)).toBeUndefined();
	});
});

describe("谁说的话算「他说过」", () => {
	const at = (over: Record<string, unknown>) => ({ seq: 1, from: SLUG, text: "x", at: 1, ...over }) as never;

	it("唤醒之后他自己的发言算", () => {
		expect(spokeAfterWake([at({ seq: 5 })], SLUG, 1)).toBe(true);
	});

	it("唤醒之前的发言不算（那是上一轮的答案）", () => {
		expect(spokeAfterWake([at({ seq: 1 })], SLUG, 1)).toBe(false);
	});

	it("他自己发的留痕也算（安静的一轮，话就是 note）", () => {
		expect(spokeAfterWake([at({ seq: 5, kind: "note" })], SLUG, 1)).toBe(true);
	});

	it("系统写的留痕（我发的告警 / 报到）不算", () => {
		expect(spokeAfterWake([at({ seq: 5, from: "owner", kind: "note" })], SLUG, 1)).toBe(false);
	});

	it("别人的发言不算", () => {
		expect(spokeAfterWake([at({ seq: 5, from: "owner" })], SLUG, 1)).toBe(false);
	});
});

describe("这段正文该落到哪个频道", () => {
	const state = (messages: Record<string, unknown[]>) =>
		({ channels: {}, messages, nextSeq: {}, readMarks: {}, wake: {} }) as unknown as ChannelState;
	const say = (seq: number, from = SLUG) => ({ seq, from, text: "x", at: 1, kind: "say", mentions: [] });

	it("正常一轮：没说过话就回唤醒它的频道", () => {
		expect(turnTarget(state({ [CHANNEL]: [] }), SLUG, wakeOf(CHANNEL))).toEqual(wakeOf(CHANNEL).reply);
	});

	it("已经在那个频道说过话就不补（同一条唤醒只补一次）", () => {
		const wake = wakeOf(CHANNEL);
		expect(turnTarget(state({ [CHANNEL]: [say(2)] }), SLUG, wake)).toBeUndefined();
	});

	it("说过话、但最后又干了活：最后那段是新结论，照样补", () => {
		const wake = wakeOf(CHANNEL);
		expect(turnTarget(state({ [CHANNEL]: [say(2)] }), SLUG, wake, false)).toEqual(wake.reply);
	});

	it("私聊插话：私聊已经答过 → 这段是任务的结论，回任务频道", () => {
		const task = { channelId: CHANNEL, seq: 1, from: "owner", at: 1 };
		const reply = { channelId: DM, seq: 5, from: "owner", at: 2 };
		expect(turnTarget(state({ [DM]: [say(6)] }), SLUG, { reply, task })).toEqual(task);
	});

	it("插话一轮继承了很早的 task：上一轮的发言不算这一轮已经汇报过", () => {
		// 真实数据（2026-11-02，林越）：task 还是团队频道 #1，这次的唤醒是 #18，
		// #17 是他上一轮的「收到」。旧判据把 #17 当成「任务频道已经汇报过」，结论被吞掉。
		const task = { channelId: CHANNEL, seq: 1, from: "owner", at: 1 };
		const reply = { channelId: CHANNEL, seq: 18, from: "沈舟", at: 2 };
		expect(turnTarget(state({ [CHANNEL]: [say(17)] }), SLUG, { reply, task })).toEqual(reply);
	});

	it("私聊插话：任务频道上一轮说过话，不影响回私聊", () => {
		const task = { channelId: CHANNEL, seq: 1, from: "owner", at: 1 };
		const reply = { channelId: DM, seq: 5, from: "owner", at: 2 };
		expect(turnTarget(state({ [CHANNEL]: [say(2)], [DM]: [] }), SLUG, { reply, task })).toEqual(reply);
	});

	it("私聊插话：私聊还没答 → 先回私聊", () => {
		const task = { channelId: CHANNEL, seq: 1, from: "owner", at: 1 };
		const reply = { channelId: DM, seq: 5, from: "owner", at: 2 };
		expect(turnTarget(state({ [DM]: [] }), SLUG, { reply, task })).toEqual(reply);
	});
});

describe("收尾落库", () => {
	it("他没说过话时，替他把正文发到被叫醒的频道", async () => {
		const runtime = await setup();
		const finisher = createTurnFinisher({ harness: runtime.harness, conversationOf: async () => undefined });
		await finisher(
			{ slug: SLUG, conversation: conversationWith(answer(42, "跑完了，耗时 45 秒。")), answer: 42, wake: wakeOf(CHANNEL) },
			BACKGROUND_CONTEXT,
		);
		const state = (await runtime.harness.snapshot(ChannelDoc, BACKGROUND_CONTEXT)) as ChannelState;
		const last = (state.messages[CHANNEL] ?? []).at(-1);
		expect(last?.from).toBe(SLUG);
		expect(last?.text).toBe("跑完了，耗时 45 秒。");
		// 落库的是真发言，不是投影消息 —— 否则前端会把它当过程行折起来。
		expect(last?.kind).toBe("say");
	});

	it("他说过一句、之后又干了活：最后的结论照样落进频道", async () => {
		// 2026-11-02 陈默：被叫醒只是报个到，顺手把整个游戏写完了，频道里却只有开头那句。
		const runtime = await setup();
		await runtime.harness.commit(async (tx) => {
			const doc = (await tx.doc(ChannelDoc)) as ChannelState;
			doc.messages[CHANNEL] = [{ seq: 2, from: SLUG, at: 2, text: "我先说一句。", mentions: [], kind: "say" }];
			doc.nextSeq[CHANNEL] = 3;
		}, BACKGROUND_CONTEXT);
		const finisher = createTurnFinisher({ harness: runtime.harness, conversationOf: async () => undefined });
		const final = answer(42, "游戏写完了，在 workspace/index.html。");
		const conversation = {
			id: 7,
			entries: async () => ({ items: [final, toolCall(41, "run"), toolCall(40, "say")] }),
		} as unknown as Conversation;
		await finisher({ slug: SLUG, conversation, answer: 42, wake: wakeOf(CHANNEL) }, BACKGROUND_CONTEXT);
		const state = (await runtime.harness.snapshot(ChannelDoc, BACKGROUND_CONTEXT)) as ChannelState;
		expect((state.messages[CHANNEL] ?? []).map((item) => item.text)).toEqual([
			"我先说一句。",
			"游戏写完了，在 workspace/index.html。",
		]);
	});

	it("同一条答案被两条提交各结算一次，只补一次", async () => {
		// 2026-11-02：报到 + 投递、投递 + 后台命令跑完，两条提交都结算到同一个条目，
		// 于是频道里并排两条一模一样的话（周岚 #11/#12、沈舟 #15/#16，相隔 1 毫秒）。
		const runtime = await setup();
		const finisher = createTurnFinisher({ harness: runtime.harness, conversationOf: async () => undefined });
		const conversation = conversationWith(answer(42, "地址是 http://127.0.0.1:8080/index.html 。"));
		await finisher({ slug: SLUG, conversation, answer: 42, wake: wakeOf(CHANNEL, 1) }, BACKGROUND_CONTEXT);
		await finisher({ slug: SLUG, conversation, answer: 42, wake: wakeOf(CHANNEL, 2) }, BACKGROUND_CONTEXT);
		const state = (await runtime.harness.snapshot(ChannelDoc, BACKGROUND_CONTEXT)) as ChannelState;
		expect((state.messages[CHANNEL] ?? []).filter((item) => item.from === SLUG)).toHaveLength(1);
	});

	it("两条提交同时结算（并发），也只补一次", async () => {
		// 2026-11-02 周楠 #15/#16：两次收尾并发跑，都快照到「频道里还没有这句」，相隔 1 毫秒发了两遍。
		const runtime = await setup();
		const finisher = createTurnFinisher({ harness: runtime.harness, conversationOf: async () => undefined });
		const conversation = conversationWith(answer(42, "地址是 http://127.0.0.1:8080/index.html 。"));
		await Promise.all([
			finisher({ slug: SLUG, conversation, answer: 42, wake: wakeOf(CHANNEL, 1) }, BACKGROUND_CONTEXT),
			finisher({ slug: SLUG, conversation, answer: 42, wake: wakeOf(CHANNEL, 2) }, BACKGROUND_CONTEXT),
		]);
		const state = (await runtime.harness.snapshot(ChannelDoc, BACKGROUND_CONTEXT)) as ChannelState;
		expect((state.messages[CHANNEL] ?? []).filter((item) => item.from === SLUG)).toHaveLength(1);
	});

	it("补发会叫醒被 @ 的人：不叫醒，结论就落进一个没人看的房间", async () => {
		// 2026-11-02：沈舟的交付结论（@周岚 请验收）由收尾补发进频道，周岚没被叫醒，团队停摆。
		const runtime = await setup();
		await runtime.harness.commit(async (tx) => {
			const doc = (await tx.doc(ChannelDoc)) as ChannelState;
			doc.channels[CHANNEL] = {
				...doc.channels[CHANNEL]!,
				members: [...doc.channels[CHANNEL]!.members, "沈舟"],
			};
		}, BACKGROUND_CONTEXT);
		const asked: string[] = [];
		const finisher = createTurnFinisher({
			harness: runtime.harness,
			conversationOf: async (slug) => {
				asked.push(slug);
				return undefined;
			},
		});
		await finisher(
			{
				slug: SLUG,
				conversation: conversationWith(answer(42, "@沈舟 交付在 workspace/index.html，请验收。")),
				answer: 42,
				wake: wakeOf(CHANNEL),
			},
			BACKGROUND_CONTEXT,
		);
		expect(asked).toContain("沈舟");
	});

	it("短回答照补：他对「你在吗」只答了「在。」，吞掉就是一片沉默", async () => {
		// 2026-11-02 live：被 @ 的第一轮答了 2 个字，收尾按「太短」吞了，频道里一个字没有。
		const runtime = await setup();
		const finisher = createTurnFinisher({ harness: runtime.harness, conversationOf: async () => undefined });
		await finisher(
			{ slug: SLUG, conversation: conversationWith(answer(42, "在。")), answer: 42, wake: wakeOf(CHANNEL) },
			BACKGROUND_CONTEXT,
		);
		const state = (await runtime.harness.snapshot(ChannelDoc, BACKGROUND_CONTEXT)) as ChannelState;
		expect((state.messages[CHANNEL] ?? []).map((item) => item.text)).toEqual(["在。"]);
	});

	it("[PASS] 是哨兵，不补", async () => {
		const runtime = await setup();
		const finisher = createTurnFinisher({ harness: runtime.harness, conversationOf: async () => undefined });
		await finisher(
			{ slug: SLUG, conversation: conversationWith(answer(43, "[PASS]")), answer: 43, wake: wakeOf(CHANNEL) },
			BACKGROUND_CONTEXT,
		);
		const state = (await runtime.harness.snapshot(ChannelDoc, BACKGROUND_CONTEXT)) as ChannelState;
		expect(state.messages[CHANNEL] ?? []).toHaveLength(0);
	});

	it("找不到答案条目就跳过（不瞎猜一段正文）", async () => {
		const runtime = await setup();
		const finisher = createTurnFinisher({ harness: runtime.harness, conversationOf: async () => undefined });
		await finisher(
			{ slug: SLUG, conversation: conversationWith(answer(1, "这段不是答案。")), answer: 999, wake: wakeOf(CHANNEL) },
			BACKGROUND_CONTEXT,
		);
		const state = (await runtime.harness.snapshot(ChannelDoc, BACKGROUND_CONTEXT)) as ChannelState;
		expect(state.messages[CHANNEL] ?? []).toHaveLength(0);
	});
});
