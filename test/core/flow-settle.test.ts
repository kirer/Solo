/**
 * 收尾：两种结算、一个入口。
 *
 * 这里只喂假端口 —— `settle` 的职责是「判断 + 调 publish / 留痕」，
 * 投递本身在 `flow-publish` / `turn` 里测。判断用内置策略，所以补发/不补的
 * 四条理由（找不到正文 / PASS / 已说过 / 同一句已存在）都在这一份里断言。
 */
import { describe, expect, it } from "vitest";
import { BACKGROUND_CONTEXT } from "../../src/core/runtime/index.ts";
import type { EntryRecord } from "../../src/core/runtime/index.ts";
import { createSettle } from "../../src/core/flow/settle.ts";
import { defaultSettler } from "../../src/core/flow/defaults/settle.ts";
import type { MessageStore } from "../../src/core/flow/ports.ts";
import type { PublishInput } from "../../src/core/flow/types.ts";
import type { Channel, ChannelState, Message } from "../../src/core/channel/types.ts";
import type { WakeRecord } from "../../src/core/channel/turn/record.ts";

const CHANNEL = "group:demo";
const SLUG = "a";

const channel: Channel = {
	id: CHANNEL,
	title: "演示群",
	members: ["owner", SLUG, "b"],
	wakeOnAll: [],
	createdAt: 1,
};

const wake = (seq = 1): WakeRecord => {
	const target = { channelId: CHANNEL, seq, from: "owner", at: 1 };
	return { reply: target, task: target };
};

const answer = (id: number, text: string): EntryRecord =>
	({
		id,
		kind: "pi.assistant",
		model: [{ role: "assistant", content: [{ type: "text", text }] }],
	}) as unknown as EntryRecord;

const entriesOf = (items: EntryRecord[]) => ({
	entries: async () => ({ items }),
});

function makeWorld(existing: readonly Message[] = []) {
	const state: ChannelState = {
		channels: { [CHANNEL]: channel },
		messages: { [CHANNEL]: [...existing] },
		nextSeq: { [CHANNEL]: existing.length + 1 },
		readMarks: {},
	};
	const calls = { publish: [] as PublishInput[], notes: [] as string[], reposts: 0 };
	const store: MessageStore = {
		async snapshot() {
			return state;
		},
		async read(channelId) {
			const found = state.channels[channelId];
			return found === undefined ? undefined : { state, channel: found };
		},
		async append() {
			return undefined;
		},
		async note(input) {
			calls.notes.push(input.text);
		},
	};
	const settle = createSettle({
		store,
		settler: defaultSettler(),
		publish: async (input) => {
			calls.publish.push(input);
			return {
				channel,
				message: { seq: 9, from: input.from, at: input.at, text: input.text, mentions: [], kind: "chat" },
				delivery: { delivered: [], failed: [], skipped: [] },
			};
		},
		gate: async (fn) => {
			calls.reposts += 1;
			return fn();
		},
	});
	return { state, calls, settle };
}

describe("settle", () => {
	it("done：他没说过话 → 把最后一段正文补进被叫醒的频道", async () => {
		const world = makeWorld();
		await world.settle(
			{
				kind: "done",
				slug: SLUG,
				answer: 42,
				wake: wake(),
				entries: entriesOf([answer(42, "跑完了，耗时 45 秒。")]),
			},
			BACKGROUND_CONTEXT,
		);

		expect(world.calls.reposts).toBe(1);
		expect(world.calls.publish).toHaveLength(1);
		expect(world.calls.publish[0]).toMatchObject({
			channelId: CHANNEL,
			from: SLUG,
			text: "跑完了，耗时 45 秒。",
		});
	});

	it("done：频道里已经有一模一样的一句 → 不补（多条提交只补一次）", async () => {
		const world = makeWorld([
			{ seq: 2, from: SLUG, at: 2, text: "跑完了，耗时 45 秒。", mentions: [], kind: "chat" },
		]);
		await world.settle(
			{
				kind: "done",
				slug: SLUG,
				answer: 42,
				wake: wake(),
				entries: entriesOf([answer(42, "跑完了，耗时 45 秒。")]),
			},
			BACKGROUND_CONTEXT,
		);

		expect(world.calls.publish).toHaveLength(0);
	});

	it("done：[PASS] 与空正文不补", async () => {
		const world = makeWorld();
		for (const text of ["[PASS]", "   "]) {
			await world.settle(
				{ kind: "done", slug: SLUG, answer: 42, wake: wake(), entries: entriesOf([answer(42, text)]) },
				BACKGROUND_CONTEXT,
			);
		}

		expect(world.calls.publish).toHaveLength(0);
	});

	it("done：会话里找不到答案条目 → 不补", async () => {
		const world = makeWorld();
		await world.settle(
			{ kind: "done", slug: SLUG, answer: 42, wake: wake(), entries: entriesOf([]) },
			BACKGROUND_CONTEXT,
		);

		expect(world.calls.publish).toHaveLength(0);
	});

	it("unanswered：只留一行痕，不补发", async () => {
		const world = makeWorld();
		await world.settle(
			{ kind: "unanswered", channelId: CHANNEL, text: "#1 叫了 a，但他这一轮没答上来：模型出错" },
			BACKGROUND_CONTEXT,
		);

		expect(world.calls.notes).toEqual(["#1 叫了 a，但他这一轮没答上来：模型出错"]);
		expect(world.calls.publish).toHaveLength(0);
		// 没产出不需要收尾闸：它只写一条留痕，不和补发抢。
		expect(world.calls.reposts).toBe(0);
	});
});
