/**
 * 桌面壳注入的窄桥（`desktop/src/preload.cts`）。浏览器里没有这个对象，调用处一律 `?.`。
 * 动作名和 `titlebar/menu.ts` / `desktop/src/main.ts` 的 `setupBridge` 三处对齐。
 */
interface Window {
	soloDesktop?: {
		menu: (action: "check-updates" | "restart" | "quit" | "reload" | "toggle-devtools") => void;
		setTheme: (theme: "light" | "dark") => void;
		/** 应用版本（vite 在浏览器里没有这段桥，界面上要 `?.`）。 */
		version?: () => Promise<string>;
		/**
		 * 上一次检查更新的结果（2.9.18）：`{ at, ok, message }`，没查过是 `null`。
		 * 失败那句人话在 `message` 里，设置页「检查更新」那行说明就读它。
		 */
		updateStatus?: () => Promise<{ at: number; ok: boolean; message?: string } | null>;
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
