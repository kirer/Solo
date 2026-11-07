/**
 * 桌面壳注入的窄桥（`desktop/src/preload.cts`）。浏览器里没有这个对象，调用处一律 `?.`。
 * 动作名和 `titlebar/menu.ts` / `desktop/src/main.ts` 的 `setupBridge` 三处对齐。
 */
interface Window {
	soloDesktop?: {
		menu: (action: "check-updates" | "restart" | "quit" | "reload" | "toggle-devtools") => void;
		setTheme: (theme: "light" | "dark") => void;
	};
	/** 独立悬浮窗的桥（`desktop/src/orb-preload.cts`），只有 `?orb=1` 那一页有。 */
	soloOrb?: {
		setInteractive: (on: boolean) => void;
		dragBy: (dx: number, dy: number) => void;
		dragEnd: () => void;
		recenter: () => void;
		hide: () => void;
	};
}
