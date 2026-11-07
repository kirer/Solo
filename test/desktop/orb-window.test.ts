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
	ORB_SIZE,
	orbStatePath,
	parseOrbState,
	serializeOrbState,
} from "../../desktop/src/orb-window.ts";

const AREA = { x: 0, y: 25, width: 1512, height: 945 };

describe("悬浮窗的位置", () => {
	it("默认贴右上：整扇窗留在可用区里，球落在菜单栏下面", () => {
		expect(defaultOrbBounds(AREA)).toEqual({
			x: AREA.width - ORB_SIZE.width - 12,
			y: AREA.y + 12,
		});
	});

	it("拖到哪儿都留在屏幕里（左上右下都夹住）", () => {
		expect(clampOrbBounds({ x: -400, y: -400 }, AREA)).toEqual({ x: 0, y: AREA.y });
		expect(clampOrbBounds({ x: 9999, y: 9999 }, AREA)).toEqual({
			x: AREA.width - ORB_SIZE.width,
			y: AREA.y + AREA.height - ORB_SIZE.height,
		});
		expect(clampOrbBounds({ x: 200, y: 200 }, AREA)).toEqual({ x: 200, y: 200 });
	});

	it("换屏幕 / 分辨率变小后，位置还在屏内就留着，否则回默认", () => {
		const inside = { x: 100, y: 100 };
		expect(fitOrbBounds(inside, AREA)).toEqual(inside);
		// 外接屏拔掉后存的位置：不再落在可用区里，回到主屏右上。
		expect(fitOrbBounds({ x: 2200, y: 300 }, AREA)).toEqual(defaultOrbBounds(AREA));
		expect(fitOrbBounds({ x: 0, y: 0 }, AREA)).toEqual(defaultOrbBounds(AREA));
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
