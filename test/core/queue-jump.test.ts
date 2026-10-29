import { describe, expect, it } from "vitest";
import { choresAheadOf } from "../../src/core/channel/deliver.ts";

/**
 * 「老板问话插队」的判据。
 *
 * 这里只测纯函数：哪些排队项该让路。真正的撤销由 `clearQueueAhead()` 做，
 * 靠线上实测（老板在别人忙的时候问一句，看回应时间）。
 */
const sub = (
	id: number,
	conversationId: number,
	status: string,
	requestId?: string,
) => ({ id, conversationId, status, requestId });

describe("谁该给老板让路", () => {
	it("同一个会话里排队等着的，都要让", () => {
		const chores = choresAheadOf(
			[sub(1, 100, "queued", "ch:proj:solo:40:林骁"), sub(2, 100, "queued", "ch:proj:solo:41:林骁")],
			100,
			"ch:owner:company:9:知言",
		);
		expect(chores).toEqual([1, 2]);
	});

	it("别的会话不碰", () => {
		expect(
			choresAheadOf([sub(1, 200, "queued", "ch:x:1:a")], 100, "ch:owner:company:9:知言"),
		).toEqual([]);
	});

	it("已经在跑的不碰（`placed`）—— 撤不掉正在跑的那一轮", () => {
		expect(
			choresAheadOf([sub(1, 100, "placed", "ch:x:1:a")], 100, "ch:owner:company:9:知言"),
		).toEqual([]);
	});

	it("老板自己排的也不让：他连说三句就按顺序答三句", () => {
		expect(
			choresAheadOf(
				[sub(1, 100, "queued", "ch:owner:company:7:知言"), sub(2, 100, "queued", "ch:x:1:a")],
				100,
				"ch:owner:company:9:知言",
			),
		).toEqual([2]);
	});

	it("自己这条不撤", () => {
		expect(
			choresAheadOf([sub(1, 100, "queued", "ch:owner:company:9:知言")], 100, "ch:owner:company:9:知言"),
		).toEqual([]);
	});

	it("最多撤 5 条：一次清空整个积压等于替老板做了排期决定", () => {
		const many = Array.from({ length: 9 }, (_, i) => sub(i + 1, 100, "queued", `ch:x:${i}:a`));
		expect(choresAheadOf(many, 100, "ch:owner:company:9:知言")).toHaveLength(5);
	});

	it("没有排队项时什么都不做", () => {
		expect(choresAheadOf([], 100, "ch:owner:company:9:知言")).toEqual([]);
	});
});
