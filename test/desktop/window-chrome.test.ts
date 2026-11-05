/**
 * 窗口外壳：macOS 的红绿灯、Windows 的覆盖式系统按钮。
 *
 * 这些选项只有在对应平台上才看得出来；选错了在开发机（macOS）上一切正常，
 * 到 Windows 才会变成「标题栏多一条」或「右上角没有关闭键」。
 */
import { describe, expect, it } from "vitest";
import { TITLEBAR_COLORS, TITLEBAR_HEIGHT, windowChrome } from "../../desktop/src/window-chrome.ts";

describe("桌面窗口的标题栏", () => {
	it("macOS 用系统标题栏，不碰窗口选项", () => {
		// 红绿灯和标题单独占顶上一条，不压进界面（ADR-088）。
		expect(windowChrome("darwin", "light")).toEqual({});
	});

	it("Windows 藏起原生标题栏，系统窗口按钮覆盖在最右边", () => {
		const chrome = windowChrome("win32", "dark");
		expect(chrome.titleBarStyle).toBe("hidden");
		expect(chrome.titleBarOverlay).toEqual({ ...TITLEBAR_COLORS.dark, height: TITLEBAR_HEIGHT });
		// 原生菜单栏不显示（菜单在界面标题带里），但菜单对象留着给 Ctrl+R 等加速键。
		expect(chrome.autoHideMenuBar).toBe(false);
	});

	it("浅色主题的按钮颜色跟界面的 --frame / --ink 对齐", () => {
		expect(windowChrome("win32", "light").titleBarOverlay).toEqual({
			color: "#f9fafb",
			symbolColor: "#0f1115",
			height: 40,
		});
	});

	it("别的平台不碰窗口选项", () => {
		expect(windowChrome("linux", "dark")).toEqual({});
	});
});
