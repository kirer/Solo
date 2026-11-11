/**
 * 高度模型 —— `ui/app/src/stream/heights.ts`（设计 §2.1 / §3.1 / §3.3）。
 *
 * 这个文件替下来的东西是「看一眼 DOM 得到 ΔH」。所以这里的断言全部是
 * **模型自己算得出、且找得回来**：锚点行被回收了也能算、占位行有高度、误差自愈。
 */
import { describe, expect, it } from "vitest";
import {
	DEFAULT_ROW_HEIGHT,
	PAGE_MAX,
	PAGE_MIN,
	anchorDelta,
	averageHeight,
	buildHeights,
	indexAt,
	measure,
	offsetOf,
	pageSizeFor,
} from "../../ui/app/src/stream/heights.ts";
import { buildRows } from "../../ui/app/src/stream/model.ts";

describe("一页 = 一屏（设计 §2.1）", () => {
	it("900 高的窗口按估算行高算出一屏条数", () => {
		expect(pageSizeFor(900, 76)).toBe(12);
	});

	it("夹在 8..40 之间：极矮窗口不至于只补 2 条，超长窗口也不至于一次拉 200 条", () => {
		expect(pageSizeFor(200, 76)).toBe(PAGE_MIN);
		expect(pageSizeFor(4000, 76)).toBe(PAGE_MAX);
	});

	it("窗口高度或行高异常时给一个能用的数，不返回 NaN / 0", () => {
		for (const height of [0, -10, Number.NaN, Number.POSITIVE_INFINITY]) {
			const size = pageSizeFor(height, 76);
			expect(Number.isFinite(size)).toBe(true);
			expect(size).toBeGreaterThanOrEqual(PAGE_MIN);
		}
	});
});

describe("偏移与渲染窗口（设计 §3.1）", () => {
	const model = buildHeights([{ key: "a" }, { key: "b", height: 120 }, { key: "c" }]);

	it("某一行距内容顶的距离是它前面所有行之和", () => {
		expect(offsetOf(model, "a")).toBe(0);
		expect(offsetOf(model, "b")).toBe(DEFAULT_ROW_HEIGHT);
		expect(offsetOf(model, "c")).toBe(DEFAULT_ROW_HEIGHT + 120);
	});

	it("找不到的行返回 undefined —— 调用方据此走兜底，绝不许拿猜的数去写", () => {
		expect(offsetOf(model, "zzz")).toBeUndefined();
	});

	it("总高是逐行相加，不是行数乘均值", () => {
		expect(model.total).toBe(DEFAULT_ROW_HEIGHT * 2 + 120);
	});

	it("按滚动位置反查落在哪一行（渲染窗口用）", () => {
		expect(indexAt(model, 0)).toBe(0);
		expect(indexAt(model, DEFAULT_ROW_HEIGHT - 1)).toBe(0);
		expect(indexAt(model, DEFAULT_ROW_HEIGHT + 1)).toBe(1);
		expect(indexAt(model, model.total + 500)).toBe(3);
	});
});

describe("锚点补偿的 ΔH（设计 §3.3：算出来，不是看 DOM）", () => {
	it("上面插进来三行，同一个 key 的偏移就往下走了三行高", () => {
		const before = buildHeights([{ key: "x" }, { key: "y" }]);
		const anchorTop = offsetOf(before, "y");
		expect(anchorTop).toBe(DEFAULT_ROW_HEIGHT);

		const after = buildHeights([{ key: "n1" }, { key: "n2" }, { key: "n3" }, { key: "x" }, { key: "y" }]);
		const delta = anchorDelta(after, "y", anchorTop as number);
		expect(delta).toBe(DEFAULT_ROW_HEIGHT * 3);
	});

	it("锚点行被回收（模型里还有它）照样算得出 ΔH", () => {
		// 这就是设计里说的「锚点找不到这个情形本身消失」：模型留着高度，DOM 有没有都无所谓。
		const after = buildHeights([{ key: "n1", height: 200 }, { key: "y" }]);
		expect(anchorDelta(after, "y", 0)).toBe(200);
	});

	it("模型里真的没有这一行 → undefined（走兜底换一行，不认输也不瞎写）", () => {
		const after = buildHeights([{ key: "n1" }]);
		expect(anchorDelta(after, "y", 0)).toBeUndefined();
	});

	it("占位行有高度、也参与偏移（页回来换真行时才不会跳）", () => {
		const withPlaceholders = buildHeights([{ key: "ph-1" }, { key: "ph-2" }, { key: "x" }]);
		expect(offsetOf(withPlaceholders, "x")).toBe(DEFAULT_ROW_HEIGHT * 2);
	});
});

describe("误差自愈（设计 §3.3 的一句话：误差会被模型吸收）", () => {
	it("量到真值之后偏移跟着变，没量到的行保持原估值", () => {
		const model = buildHeights([{ key: "a" }, { key: "b" }, { key: "c" }]);
		const measured = measure(model, [{ key: "a", height: 200 }]);
		expect(offsetOf(measured, "b")).toBe(200);
		expect(offsetOf(measured, "c")).toBe(200 + DEFAULT_ROW_HEIGHT);
	});

	it("量出来的高度是脏数据（0 / NaN / 负数）一律不吸收", () => {
		const model = buildHeights([{ key: "a" }]);
		const bad = measure(model, [
			{ key: "a", height: 0 },
			{ key: "b", height: Number.NaN },
			{ key: "c", height: -5 },
		]);
		expect(bad).toBe(model);
	});

	it("量到的和原来一样时不产生新对象（免得每帧都触发重排）", () => {
		const model = buildHeights([{ key: "a", height: 88 }]);
		expect(measure(model, [{ key: "a", height: 88 }])).toBe(model);
	});
});

describe("平均行高（给一页算条数用）", () => {
	it("空模型也不返回 0 / NaN", () => {
		expect(averageHeight(buildHeights([]))).toBe(DEFAULT_ROW_HEIGHT);
	});

	it("按平均行高算（一屏放不下一条超长消息时，一页的条数要跟着变少）", () => {
		const model = buildHeights([{ key: "long", height: 600 }, { key: "b", height: 100 }]);
		expect(averageHeight(model)).toBe(350);
		expect(pageSizeFor(900, averageHeight(model))).toBe(PAGE_MIN);
	});
});

describe("到最上面了（验收第 21 条）", () => {
	it("到头了就画一句「到最上面了」，不是一片空白", () => {
		const rows = buildRows({ messages: [], atCeiling: true });
		expect(rows[0]?.type).toBe("ceiling");
	});

	it("还有更早的、或者正在补的时候不画 —— 那时该画的是占位行", () => {
		expect(buildRows({ messages: [], atCeiling: false }).some((row) => row.type === "ceiling")).toBe(false);
		const pending = buildRows({ messages: [], atCeiling: true, pending: { count: 3, failed: false } });
		expect(pending.some((row) => row.type === "ceiling")).toBe(false);
	});

	it("它在列表最上面（用户往上翻到头才看得到，不会插在消息中间）", () => {
		const rows = buildRows({
			messages: [{ seq: 1, at: 1_700_000_000_000, fromSlug: "lin", text: "第一条", kind: "chat", mentions: [], read: true } as never],
			atCeiling: true,
		});
		expect(rows[0]?.type).toBe("ceiling");
		expect(rows.some((row) => row.type === "say")).toBe(true);
	});
});
