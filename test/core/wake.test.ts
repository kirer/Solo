/**
 * `wake()` 的收尾判据：结算成什么样，才该在频道里留痕。
 *
 * 合并唤醒会撤掉「还没开始」的排队项，那些消息并没有丢 —— 新的那一轮会把它们一起答。
 * 被撤的提交按 `unanswered/aborted` 结算，但它**不是**「没答上来」，不能留痕。
 */
import { describe, expect, test } from "vitest";
import { wake, type WakeNote } from "../../src/core/channel/wake.ts";

const settled = () => new Promise((resolve) => setTimeout(resolve, 0));

function conversationOf(settle: { status: string; reason?: string; answer?: unknown }) {
	const submit = async () => ({ id: 1, wait: async () => settle });
	return async () =>
		({
			id: 1,
			submit,
		}) as never;
}

const input = {
	slug: "林越",
	requestId: "r1",
	bodyOf: () => "干活",
	whenBusy: "steer" as const,
	coalesce: false,
	note: { channelId: "team:alpha", seq: 7, label: "林越" },
};

describe("wake 的结算收尾", () => {
	test("aborted（被后来的一条合并唤醒撤掉）不留痕", async () => {
		const notes: WakeNote[] = [];
		const result = await wake(
			{ conversationOf: conversationOf({ status: "unanswered", reason: "aborted" }), noteUnanswered: (note) => void notes.push(note) },
			input,
		);
		expect(result.status).toBe("delivered");
		await settled();
		expect(notes).toEqual([]);
	});

	test("no_model 这类真失败照样留痕", async () => {
		const notes: WakeNote[] = [];
		await wake(
			{ conversationOf: conversationOf({ status: "unanswered", reason: "no_model" }), noteUnanswered: (note) => void notes.push(note) },
			input,
		);
		await settled();
		expect(notes).toEqual([{ slug: "林越", label: "林越", seq: 7, reason: "no_model" }]);
	});

	test("done 走收尾，不留「没答上来」", async () => {
		const notes: WakeNote[] = [];
		let finished = 0;
		await wake(
			{
				conversationOf: conversationOf({ status: "done", answer: "做完了" }),
				noteUnanswered: (note) => void notes.push(note),
				finishTurn: async () => {
					finished += 1;
				},
			},
			{
				...input,
				wakeRecord: {
					reply: { channelId: "team:alpha", seq: 7, from: "owner", at: 1 },
					task: { channelId: "team:alpha", seq: 7, from: "owner", at: 1 },
				},
			},
		);
		await settled();
		expect(notes).toEqual([]);
		expect(finished).toBe(1);
	});
});
