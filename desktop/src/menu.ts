/**
 * 菜单：macOS 走系统菜单栏，Windows 上只留一个最小菜单（界面的主操作都在页面里）。
 *
 * 「重新加载页面」与「切换开发者工具」在打包后也留着：界面是本地服务发的静态文件，
 * 改完 `ui/app` 重新 `npm run ui:build` 之后，用户 refresh 一次就能看到 —— 不用重启应用。
 */
import { Menu, type MenuItemConstructorOptions } from "electron";

export type MenuActions = {
	readonly checkUpdates: () => void;
	readonly restart: () => void;
};

export function installMenu(actions: MenuActions): void {
	const viewItems: MenuItemConstructorOptions[] = [
		{ label: "重新加载页面", role: "reload" },
		{ label: "切换开发者工具", role: "toggleDevTools" },
	];
	const updateItem: MenuItemConstructorOptions = { label: "检查更新…", click: actions.checkUpdates };

	if (process.platform !== "darwin") {
		Menu.setApplicationMenu(
			Menu.buildFromTemplate([
				{
					label: "Solo",
					submenu: [updateItem, { label: "重启", click: actions.restart }, { type: "separator" }, { role: "quit", label: "退出" }],
				},
				{ label: "视图", submenu: viewItems },
			]),
		);
		return;
	}

	Menu.setApplicationMenu(
		Menu.buildFromTemplate([
			{
				label: "Solo",
				submenu: [
					{ label: "关于 Solo", role: "about" },
					updateItem,
					{ type: "separator" },
					{ label: "重启 Solo", click: actions.restart },
					{ type: "separator" },
					{ role: "hide", label: "隐藏 Solo" },
					{ role: "hideOthers", label: "隐藏其他" },
					{ role: "unhide", label: "全部显示" },
					{ type: "separator" },
					{ role: "quit", label: "退出 Solo" },
				],
			},
			{ role: "editMenu", label: "编辑" },
			{ label: "视图", submenu: viewItems },
			{ role: "windowMenu", label: "窗口" },
		]),
	);
}
