/**
 * 叫醒之后的收尾判据：结算成什么样，才该在频道里留痕。
 *
 * 合并唤醒会撤掉「还没开始」的排队项，那些消息并没有丢 —— 新的那一轮会把它们一起答。
 * 被撤的提交按 `unanswered/aborted` 结算，但它**不是**「没答上来」，不能留痕。
 *
 * 这里走 `fanOut()` 这一条公开的路，不直接调内部步骤：叫醒是它的一个阶段，判据要钉
 * 在「投递一条消息之后频道里会多什么」。
 */
import { describe, expect, test } from "vitest";
import { BACKGROUND_CONTEXT } from "../../src/core/runtime/index.ts";
import { enqueue, fanOut, type WakeNote } from "../../src/core/flow/runner.ts";
import { appendMessage, ensureChannel } from "../../src/core/channel/rules.ts";
import type { ChannelState } from "../../src/core/channel/types.ts";
import { SEED_DELIVERY_PROMPT } from "./seed-prompt.ts";
import { SEED_TEXT } from "./catalog.ts";

const settled = () => new Promise((resolve) => setTimeout(resolve, 0));

function fixture(settle: { status: string; reason?: string; detail?: string; answer?: unknown }) {
	const state: ChannelState = ensureChannel(
		{ channels: {}, messages: {}, nextSeq: {}, readMarks: {} },
		{ id: "team:alpha", title: "Alpha", members: ["owner", "林越"], at: 1 },
	);
	const { message } = appendMessage(state, "team:alpha", { from: "owner", text: "@林越 干活", at: 1 });
	const conversation = { id: 1, submit: async () => ({ id: 1, wait: async () => settle }) };
	return { channel: state.channels["team:alpha"]!, message, conversation };
}

function delivery(
	fixtureOf: ReturnType<typeof fixture>,
	extra: Pick<Parameters<typeof fanOut>[0], "noteUnanswered">,
) {
	return fanOut({
		digests: new Map(),
		prompt: SEED_DELIVERY_PROMPT,
		text: SEED_TEXT,
		channel: fixtureOf.channel,
		message: fixtureOf.message,
		targets: ["林越"],
		conversationOf: async () => fixtureOf.conversation as never,
		...extra,
	}, BACKGROUND_CONTEXT);
}

const wakeRecord = {
	reply: { channelId: "team:alpha", seq: 1, from: "owner", at: 1 },
	task: { channelId: "team:alpha", seq: 1, from: "owner", at: 1 },
};

const wakeInput = {
	slug: "林越",
	requestId: "r1",
	bodyOf: () => "干活",
	wakeRecord,
};

describe("记 wake 与入队原子（ADR-076）", () => {
	test("wake 与准入在同一个 commit 里，句柄提交后再取", async () => {
		const order: string[] = [];
		const conversation = {
			id: 1,
			commit: async (change: (tx: { tag: string }) => unknown) => {
				order.push("commit");
				const out = await change({ tag: "tx" });
				order.push("committed");
				return out;
			},
			submit: async (...args: unknown[]) => {
				if (args.length === 2) {
					order.push(`admit:${(args[0] as { tag: string }).tag}`);
					return 9;
				}
				order.push("submit-now");
				return { id: 9 };
			},
		};
		const result = await enqueue(
			{
				conversationOf: async () => conversation as never,
				wakeTogether: {
					rememberWake: async (tx, slug) => {
						order.push(`wake:${(tx as { tag: string }).tag}:${slug}`);
					},
					submissionOf: async (id) => {
						order.push(`handle:${id}`);
						return { id } as never;
					},
				},
			},
			wakeInput,
			BACKGROUND_CONTEXT,
		);
		expect(result).toEqual({ status: "delivered", merged: 0 });
		expect(order).toEqual(["commit", "wake:tx:林越", "admit:tx", "committed", "handle:9"]);
	});

	test("准入之前抛错：两个都不落", async () => {
		let admitted = false;
		const result = await enqueue(
			{
				conversationOf: async () =>
					({
						id: 1,
						commit: async (change: (tx: object) => unknown) => change({}),
						submit: async () => {
							admitted = true;
							return 9;
						},
					}) as never,
				wakeTogether: {
					rememberWake: async () => {
						throw new Error("doc write failed");
					},
					submissionOf: async () => undefined,
				},
			},
			wakeInput,
			BACKGROUND_CONTEXT,
		);
		expect(result.status).toBe("failed");
		expect(admitted).toBe(false);
	});

	test("没接原子路径时仍是先记 wake、再提交", async () => {
		const order: string[] = [];
		const result = await enqueue(
			{
				conversationOf: async () =>
					({
						id: 1,
						submit: async () => {
							order.push("submit");
							return { id: 1 };
						},
					}) as never,
				rememberWake: async () => {
					order.push("remember");
				},
			},
			wakeInput,
			BACKGROUND_CONTEXT,
		);
		expect(result.status).toBe("delivered");
		expect(order).toEqual(["remember", "submit"]);
	});
});

describe("叫醒之后的结算收尾", () => {
	test("aborted（被后来的一条合并唤醒撤掉）不留痕", async () => {
		const notes: WakeNote[] = [];
		const result = await delivery(fixture({ status: "unanswered", reason: "aborted" }), {
			noteUnanswered: (note) => void notes.push(note),
		});
		expect(result.delivered).toEqual(["林越"]);
		await settled();
		expect(notes).toEqual([]);
	});

	test("no_model 这类真失败照样留痕", async () => {
		const notes: WakeNote[] = [];
		await delivery(fixture({ status: "unanswered", reason: "no_model" }), {
			noteUnanswered: (note) => void notes.push(note),
		});
		await settled();
		expect(notes).toEqual([{ slug: "林越", label: "林越", seq: 1, reason: "no_model" }]);
	});

	test("nothing_to_answer（上下文已经答完）不留痕", async () => {
		const notes: WakeNote[] = [];
		await delivery(fixture({ status: "unanswered", reason: "nothing_to_answer" }), {
			noteUnanswered: (note) => void notes.push(note),
		});
		await settled();
		expect(notes).toEqual([]);
	});

	test("失败细节跟着留痕走（模型错误正文是唯一的线索）", async () => {
		const notes: WakeNote[] = [];
		await delivery(fixture({ status: "unanswered", reason: "model_error", detail: "gateway 502" }), {
			noteUnanswered: (note) => void notes.push(note),
		});
		await settled();
		expect(notes).toEqual([{ slug: "林越", label: "林越", seq: 1, reason: "model_error", detail: "gateway 502" }]);
	});

	test("done 不留「没答上来」—— 收尾交给 durable task（ADR-077）", async () => {
		const notes: WakeNote[] = [];
		await delivery(fixture({ status: "done", answer: "做完了" }), {
			noteUnanswered: (note) => void notes.push(note),
		});
		await settled();
		expect(notes).toEqual([]);
	});
});
