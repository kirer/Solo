/**
 * 独立悬浮窗的几何与落盘（ADR-114）。
 *
 * 真窗口只有 Electron 里才有；这里守的是「摆哪儿、坏了怎么办」：
 * 默认贴右上、拖不出屏幕、换屏幕后不落到看不见的地方、状态文件读不懂就当没有。
 */
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	clampOrbBounds,
	defaultOrbBounds,
	fitOrbBounds,
	ORB_GROWTH,
	ORB_SIZE,
	orbStatePath,
	parseOrbState,
	serializeOrbState,
} from "../../desktop/src/orb-window.ts";

const AREA = { x: 0, y: 25, width: 1512, height: 945 };

describe("悬浮窗的位置", () => {
	it("默认贴右上：整扇窗留在可用区里，球落在菜单栏下面", () => {
		// 右边多让 ORB_GROWTH：窗口右边缘固定，加宽的那 40 从左边长出去。
		expect(defaultOrbBounds(AREA)).toEqual({
			x: AREA.width - ORB_SIZE.width - 12 + ORB_GROWTH,
			y: AREA.y + 12,
		});
	});

	it("窗加宽以后小人原地不动：窗户右边缘贴住屏幕右边，球相对右边缘不变", () => {
		// 界面里球是 `right: 18px` 定位的，所以球的屏幕横坐标 = 窗右边缘 − 18 − 80。
		// 只要「窗右边缘」不动，小人就在原地 —— 这正是右边补 40 的意义。
		const BALL = 80;
		const BALL_RIGHT = 18;
		const before = { x: AREA.width - 380 - 12, width: 380 };
		const after = defaultOrbBounds(AREA);
		const afterRight = after.x + ORB_SIZE.width;

		expect(afterRight).toBe(before.x + before.width);
		// 球的屏幕横坐标，加宽前后一致。
		expect(afterRight - BALL_RIGHT - BALL).toBe(before.x + before.width - BALL_RIGHT - BALL);
		// 窗确实是 420×612：宽给面板让位，高让面板拿满 480。
		// 球 top20 + 球高 96 + 间距 16 + 面板 480 = 612；540 时下面只余 408，面板会被压矮 72。
		expect(ORB_SIZE).toEqual({ width: 420, height: 612 });
		expect(20 + 96 + 16 + 480).toBe(ORB_SIZE.height);
		// 补偿项必须是 0：真加 40 就会把球推出屏幕右边 40px。
		expect(ORB_GROWTH).toBe(0);
		// 加宽前的老位置（窗 380、贴右边）：x=1120。加宽后 x 少 40（窗口从左边长），
		// 右边缘不动 —— 小人原地，这是这一版唯一要保证的事。
		expect(after.x).toBe(AREA.width - 420 - 12);
	});

	it("拖到哪儿都留在屏幕里（左上右下都夹住）", () => {
		expect(clampOrbBounds({ x: -400, y: -400 }, AREA)).toEqual({ x: 0, y: AREA.y });
		expect(clampOrbBounds({ x: 9999, y: 9999 }, AREA)).toEqual({
			x: AREA.width - ORB_SIZE.width,
			y: AREA.y + AREA.height - ORB_SIZE.height,
		});
		expect(clampOrbBounds({ x: 200, y: 200 }, AREA)).toEqual({ x: 200, y: 200 });
	});

	it("换屏幕 / 分辨率变小后，位置还在屏内就留着", () => {
		const inside = { x: 100, y: 100 };
		expect(fitOrbBounds(inside, AREA)).toEqual(inside);
	});

	it("只出界一点就收回来，不整份丢回默认（这条是「存了就丢」的根因）", () => {
		// 存的是菜单栏上方的 y=0：以前整份复位，人拖的位置一次都留不住。
		expect(fitOrbBounds({ x: 0, y: 0 }, AREA)).toEqual({ x: 0, y: AREA.y });
		// 右边出界：只把 x 收回来，y 原样保留。
		expect(fitOrbBounds({ x: 2200, y: 300 }, AREA)).toEqual({
			x: AREA.width - ORB_SIZE.width,
			y: 300,
		});
		// 下边出界：只收 y。
		expect(fitOrbBounds({ x: 120, y: 9999 }, AREA)).toEqual({
			x: 120,
			y: AREA.y + AREA.height - ORB_SIZE.height,
		});
	});

	it("屏幕比窗口还小才回默认位置", () => {
		const tiny = { x: 0, y: 0, width: 300, height: 400 };
		expect(fitOrbBounds({ x: 50, y: 50 }, tiny)).toEqual(defaultOrbBounds(tiny));
	});
});

describe("悬浮窗的状态文件", () => {
	it("写得进、读得回；没写 visible 时默认显示", () => {
		const state = { x: 120, y: 80, visible: false };
		expect(parseOrbState(serializeOrbState(state))).toEqual(state);
		expect(parseOrbState('{"x":1.6,"y":2.4}')).toEqual({ x: 2, y: 2, visible: true });
	});

	it("读不懂就当没有：不拦启动，回默认位置", () => {
		expect(parseOrbState(undefined)).toBeUndefined();
		expect(parseOrbState("")).toBeUndefined();
		expect(parseOrbState("{")).toBeUndefined();
		expect(parseOrbState("null")).toBeUndefined();
		expect(parseOrbState('{"x":"a","y":2}')).toBeUndefined();
	});

	it("状态文件放在应用私有根里", () => {
		expect(orbStatePath("/tmp/app")).toBe(join("/tmp/app", "orb-window.json"));
	});
});
