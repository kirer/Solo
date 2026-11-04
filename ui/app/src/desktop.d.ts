/**
 * 桌面壳注入的窄桥（`desktop/src/preload.cts`）。浏览器里没有这个对象，调用处一律 `?.`。
 * 动作名和 `titlebar/menu.ts` / `desktop/src/main.ts` 的 `setupBridge` 三处对齐。
 */
interface Window {
	soloDesktop?: {
		menu: (action: "check-updates" | "restart" | "quit" | "reload" | "toggle-devtools") => void;
		setTheme: (theme: "light" | "dark") => void;
	};
}
