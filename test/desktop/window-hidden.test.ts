/**
 * 无人值守验证的窗口开关：设了就一次都不许把窗口亮出来。
 *
 * 判据两条：**只认 `"1"`**（写成 `true` 不算，宁可没生效也不要「以为设了其实没设」），
 * 以及**不设时行为一个字不变**（默认放行）。
 */
import { describe, expect, it } from "vitest";
import { mayShowWindow } from "../../desktop/src/window-hidden.ts";

describe("SOLO_WINDOW_HIDDEN", () => {
	it("不设：照常显示，行为不变", () => {
		expect(mayShowWindow({})).toBe(true);
	});

	it("设成 1：不显示", () => {
		expect(mayShowWindow({ SOLO_WINDOW_HIDDEN: "1" })).toBe(false);
	});

	it("别的写法一律当没设：true / yes / on / 0 / 空串", () => {
		for (const value of ["true", "yes", "on", "0", "", " 1"]) {
			expect(mayShowWindow({ SOLO_WINDOW_HIDDEN: value }), value).toBe(true);
		}
	});
});
