/**
 * 右栏宽度读盘时的下限：`clampDockWidth`。
 *
 * 拖拽时 `PanelGrip` 夹过一次，但落盘的数是别的窗口尺寸下算的 —— 换个窗口宽度
 * 再读就可能越界。这里守的是「读回来一定还在可用区间里」。
 */
import { describe, expect, it } from "vitest";
import { DOCK_KEEP_MAIN, DOCK_MIN, clampDockWidth } from "../../ui/app/src/state/store.ts";

describe("右栏宽度夹取", () => {
	it("正常值原样返回", () => {
		expect(clampDockWidth(442, 1920)).toBe(442);
	});

	it("比下限还小：抬到 320（拖成零高就是这个的下界）", () => {
		expect(clampDockWidth(0, 1920)).toBe(DOCK_MIN);
		expect(clampDockWidth(-50, 1920)).toBe(DOCK_MIN);
		expect(clampDockWidth(12, 1920)).toBe(DOCK_MIN);
	});

	it("窗口变窄后原来的宽度越界：收到给正文留 420 为止", () => {
		// 1920 上存的 1200，换到 1280 再读：最多 860。
		expect(clampDockWidth(1200, 1280)).toBe(1280 - DOCK_KEEP_MAIN);
	});

	it("窗口窄到连下限都放不下：仍保 320，不返回负数", () => {
		expect(clampDockWidth(500, 400)).toBe(DOCK_MIN);
		expect(clampDockWidth(500, 100)).toBe(DOCK_MIN);
	});
});
