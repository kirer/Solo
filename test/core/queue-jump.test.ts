import { describe, expect, it } from "vitest";
import { queuedAhead } from "../../src/core/channel/deliver.ts";

/**
 * 「谁该让路」的判据 —— 现在只有一份（`queuedAhead`）。
 *
 * 历史：老板插队（`choresAheadOf`）和「同一个人连发只排一个唤醒」（`queuedAhead`）
 * 曾是两套口径，前者还跳过老板自己排的队。2026-10-30 老板定了新口径：连发三条也合并，
 * 于是两套合成一套，这里改成只测这一份。
 */
const sub = (id: number, conversationId: number, status: string, requestId?: string) => ({
	id,
	conversationId,
	status,
	requestId,
});

describe("谁该让路（同一会话只留一个未开始项）", () => {
	it("同一个会话里排队等着的，都撤", () => {
		expect(
			queuedAhead(
				[sub(1, 100, "queued", "ch:proj:solo:40:林越"), sub(2, 100, "queued", "ch:proj:solo:41:林越")],
				100,
				"ch:owner:company:9:知言",
			),
		).toEqual([1, 2]);
	});

	it("别的会话不碰", () => {
		expect(queuedAhead([sub(1, 200, "queued", "ch:x:1:a")], 100, "ch:owner:company:9:知言")).toEqual([]);
	});

	it("已经在跑的不碰（`placed`）—— 撤它会连新消息一起吞掉", () => {
		expect(queuedAhead([sub(1, 100, "placed", "ch:x:1:a")], 100, "ch:owner:company:9:知言")).toEqual([]);
	});

	it("老板自己排的也撤：连说三句只该排一个唤醒（三句都在频道里）", () => {
		expect(
			queuedAhead(
				[sub(1, 100, "queued", "ch:owner:company:7:知言"), sub(2, 100, "queued", "ch:x:1:a")],
				100,
				"ch:owner:company:9:知言",
			),
		).toEqual([1, 2]);
	});

	it("自己这条不撤", () => {
		expect(
			queuedAhead([sub(1, 100, "queued", "ch:owner:company:9:知言")], 100, "ch:owner:company:9:知言"),
		).toEqual([]);
	});

	it("最多撤 8 条：一次清空整个积压等于替人做了排期决定", () => {
		const many = Array.from({ length: 12 }, (_, i) => sub(i + 1, 100, "queued", `ch:x:${i}:a`));
		expect(queuedAhead(many, 100, "ch:owner:company:9:知言")).toHaveLength(8);
	});

	it("没有排队项时什么都不做", () => {
		expect(queuedAhead([], 100, "ch:owner:company:9:知言")).toEqual([]);
	});
});
