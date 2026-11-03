/**
 * 叫醒之后的收尾判据：结算成什么样，才该在频道里留痕。
 *
 * 合并唤醒会撤掉「还没开始」的排队项，那些消息并没有丢 —— 新的那一轮会把它们一起答。
 * 被撤的提交按 `unanswered/aborted` 结算，但它**不是**「没答上来」，不能留痕。
 *
 * 这里走 `deliver()` 这一条公开的路，不直接调内部步骤：叫醒是它的一个阶段，判据要钉
 * 在「投递一条消息之后频道里会多什么」。
 */
import { describe, expect, test } from "vitest";
import { deliver, type WakeNote } from "../../src/core/channel/dispatch.ts";
import { appendMessage, ensureChannel } from "../../src/core/channel/rules.ts";
import type { ChannelState } from "../../src/core/channel/types.ts";
import { SEED_DELIVERY_PROMPT } from "./seed-prompt.ts";
import { SEED_TEXT } from "./catalog.ts";

const settled = () => new Promise((resolve) => setTimeout(resolve, 0));

function fixture(settle: { status: string; reason?: string; answer?: unknown }) {
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
	extra: Pick<Parameters<typeof deliver>[0], "noteUnanswered" | "finishTurn">,
) {
	return deliver({
		digests: new Map(),
		prompt: SEED_DELIVERY_PROMPT,
		text: SEED_TEXT,
		channel: fixtureOf.channel,
		message: fixtureOf.message,
		targets: ["林越"],
		conversationOf: async () => fixtureOf.conversation as never,
		...extra,
	});
}

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

	test("done 走收尾，不留「没答上来」", async () => {
		const notes: WakeNote[] = [];
		let finished = 0;
		await delivery(fixture({ status: "done", answer: "做完了" }), {
			noteUnanswered: (note) => void notes.push(note),
			finishTurn: async () => {
				finished += 1;
			},
		});
		await settled();
		expect(notes).toEqual([]);
		expect(finished).toBe(1);
	});
});
