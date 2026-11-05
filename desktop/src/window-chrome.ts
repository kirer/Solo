/**
 * 窗口的「外壳」：标题栏怎么藏、系统窗口按钮什么颜色。macOS 一律用系统标题栏，
 * 所以它这里什么都不设（ADR-088）。
 *
 * 单独一份纯函数是为了能在 node 里测（`test/desktop/window-chrome.test.ts`）：
 * 真正的 `BrowserWindow` 只有 Electron 里才有，选错了平台选项在 mac 上又看不出来。
 * 颜色跟界面的 `--frame` / `--ink` 对齐（`ui/app/src/styles/base.css`），
 * 这样右边那三个系统按钮和标题带是同一块底。
 */
import type { BrowserWindowConstructorOptions } from "electron";

/** 和界面标题带同高（`shell.css` 的 `--titlebar-h`）。 */
export const TITLEBAR_HEIGHT = 40;

export const TITLEBAR_COLORS = {
	light: { color: "#f9fafb", symbolColor: "#0f1115" },
	dark: { color: "#0f0f0f", symbolColor: "#f9fafb" },
} as const;

export type TitlebarTheme = keyof typeof TITLEBAR_COLORS;

type WindowChrome = Pick<BrowserWindowConstructorOptions, "titleBarStyle" | "titleBarOverlay" | "autoHideMenuBar">;

export function windowChrome(platform: NodeJS.Platform, theme: TitlebarTheme): WindowChrome {
	if (platform === "darwin") {
		// 系统自带标题栏：红绿灯与标题在窗口顶上单独一条，不压进界面（ADR-088）。
		return {};
	}
	if (platform === "win32") {
		// hidden + titleBarOverlay：原生标题栏不画，最小化 / 最大化 / 关闭仍由系统画在最右边。
		// 菜单栏也藏掉 —— 同样两项菜单由界面画在标题带里（`ui/app/src/titlebar/`）；
		// 原生 Menu 对象留着，只为 Ctrl+R / Ctrl+Shift+I 这些加速键还能用。
		return {
			titleBarStyle: "hidden",
			titleBarOverlay: { ...TITLEBAR_COLORS[theme], height: TITLEBAR_HEIGHT },
			autoHideMenuBar: false,
		};
	}
	return {};
}
