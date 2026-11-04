/**
 * Windows 标题带里的两项菜单：和原生菜单同一套字（`desktop/src/menu.ts`）。
 *
 * 动作只是字符串，真正执行在主进程（`desktop/src/main.ts` 的 `setupBridge`）。
 * 单独一份是为了能在 node 里测（`test/ui/titlebar.test.ts`）—— 界面测试不装 DOM。
 */
export type TitlebarAction = "check-updates" | "restart" | "quit" | "reload" | "toggle-devtools";

export type TitlebarItem =
	| { readonly label: string; readonly action: TitlebarAction }
	| { readonly separator: true };

export type TitlebarMenu = {
	readonly id: string;
	readonly label: string;
	readonly items: readonly TitlebarItem[];
};

export const TITLEBAR_MENUS: readonly TitlebarMenu[] = [
	{
		id: "solo",
		label: "Solo",
		items: [
			{ label: "检查更新…", action: "check-updates" },
			{ label: "重启", action: "restart" },
			{ separator: true },
			{ label: "退出", action: "quit" },
		],
	},
	{
		id: "view",
		label: "视图",
		items: [
			{ label: "重新加载页面", action: "reload" },
			{ label: "切换开发者工具", action: "toggle-devtools" },
		],
	},
];
