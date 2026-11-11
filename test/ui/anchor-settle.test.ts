import { describe, expect, it } from "vitest";
import { seqOfRow } from "../../ui/app/src/stream/VirtualFeed.tsx";

// `settleAnchor` 的差值算法：只补「同一行因为内容长高而变大的那段」，
// 不补用户自己滚过的那段（拿老值算会写出一整屏的回弹）。
const settle = (wasTop: number, nowTop: number, scrolling: boolean, viewport: number): number => {
	const delta = nowTop - wasTop;
	if (scrolling && delta < viewport * 3) return 0;
	return delta <= 0.5 ? 0 : delta;
};

describe("补历史之后补差值", () => {
	it("用户正往上滚、涨得不多：一点都不补（不许把手上那一格吞掉）", () => {
		// 内容长高 120px，用户在滚 —— 回弹就是这么来的。
		expect(settle(100, 220, true, 662)).toBe(0);
	});

	it("用户正往上滚、但已经欠了 3 屏以上：必须一次补齐", () => {
		expect(settle(100, 100 + 662 * 3 + 1, true, 662)).toBe(662 * 3 + 1);
	});

	it("手停了：立刻补，一次到位（不分帧）", () => {
		expect(settle(100, 220, false, 662)).toBe(120);
	});

	it("内容反而变短（行被量矮了）：不往回拽", () => {
		expect(settle(100, 40, false, 662)).toBe(0);
	});

	it("窗口高度是判据的换算基准，不是固定值", () => {
		// 一屏 200：欠 300 已经超过 3 屏（600）？没有 —— 留手停再补。
		expect(settle(0, 300, true, 200)).toBe(0);
		expect(settle(0, 701, true, 200)).toBe(701);
		// 一屏 2000：欠 300 远不够 3 屏，同样不动。
		expect(settle(0, 300, true, 2000)).toBe(0);
	});
});

describe("seqOfRow", () => {
	it("消息行认得出 seq，时间分隔和横幅认不出", () => {
		expect(seqOfRow({ key: "a", type: "say", message: { seq: 42 } } as never)).toBe(42);
		expect(seqOfRow({ key: "b", type: "note", message: { seq: 7 } } as never)).toBe(7);
		expect(seqOfRow({ key: "c", type: "time" } as never)).toBeUndefined();
		expect(seqOfRow({ key: "d", type: "unread" } as never)).toBeUndefined();
	});
});
