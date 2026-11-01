/**
 * 升级：`electron-updater` + 自建更新源（`scripts/update-server.ts` 发的那个静态目录）。
 *
 * 几条刻意的选择：
 * - **不后台下载**：自动检查只查、不下载、不弹窗；下载和安装各要一次明确点击。
 * - **不自动装**：安装要先把后端停干净（它占着 sqlite，还在跑后台命令），所以走
 *   `beforeInstall` 回调，由 `main.ts` 负责收尾顺序。
 * - **macOS 未签名不装**：Squirrel.Mac 换包前会核对新旧 `.app` 的签名身份，没有 Developer ID
 *   证书必然失败。探测到没签名就只提示、给下载地址 —— 让「重启安装」点下去变成应用直接退出
 *   是最糟的结果。
 */
import { execFile } from "node:child_process";
import { app, dialog, shell, type BrowserWindow, type MessageBoxOptions } from "electron";
import electronUpdater from "electron-updater";
import { resolveFeedUrl } from "./feed.ts";

const { autoUpdater } = electronUpdater;

const CHECK_INTERVAL = 6 * 60 * 60 * 1000;
const FIRST_CHECK_DELAY = 30_000;

export type UpdaterOptions = {
	/** 现在的窗口：对话框挂在它上面，进度条画在它的 Dock/任务栏图标上。 */
	window: () => BrowserWindow | undefined;
	/** 安装前收尾（停后端）。返回之后才会退出重启。 */
	beforeInstall: () => Promise<void>;
};

export type Updater = {
	/** 启动后自动检查（静默：只在有新版本时问）。 */
	start: () => void;
	/** 菜单里点「检查更新…」：连「已是最新」「出错」也要说出来。 */
	checkNow: () => void;
};

/** 打包后的 macOS 应用是不是 Developer ID 签过名（没签名就装不了更新）。 */
function canInstallOnThisBuild(): Promise<boolean> {
	if (process.platform !== "darwin") return Promise.resolve(true);
	return new Promise((resolve) => {
		execFile("codesign", ["-dv", "--verbose=2", app.getPath("exe")], (_error, _stdout, stderr) =>
			resolve(stderr.includes("Authority=Developer ID Application")),
		);
	});
}

export function createUpdater(options: UpdaterOptions): Updater {
	let manual = false;
	let timer: ReturnType<typeof setInterval> | undefined;
	let installable: boolean | undefined;

	const notify = (body: MessageBoxOptions): Promise<number> => {
		const win = options.window();
		const shown = win === undefined ? dialog.showMessageBox(body) : dialog.showMessageBox(win, body);
		return shown.then((result) => result.response);
	};

	autoUpdater.autoDownload = false;
	autoUpdater.autoInstallOnAppQuit = false;
	autoUpdater.allowDowngrade = false;
	autoUpdater.allowPrerelease = false;

	// 运行时用环境变量换更新源：验证本地假 feed 时不必重新打包。
	const feed = resolveFeedUrl(process.env["SOLO_UPDATE_URL"]);
	if (feed !== undefined) autoUpdater.setFeedURL({ provider: "generic", url: feed });

	autoUpdater.on("update-available", (info) => {
		console.log(`[update] 有新版本 ${info.version}（当前 ${app.getVersion()}）`);
		void (async () => {
			const answered = await notify({
				type: "info",
				message: `有新版本 ${info.version}`,
				detail: `当前是 ${app.getVersion()}。现在下载吗？下载完会再问你一次要不要重启安装。`,
				buttons: ["下载", "稍后"],
				defaultId: 0,
				cancelId: 1,
			});
			if (answered !== 0) return;
			await autoUpdater.downloadUpdate();
		})();
	});

	autoUpdater.on("download-progress", (progress) => {
		options.window()?.setProgressBar(Math.max(0, Math.min(1, progress.percent / 100)));
	});

	autoUpdater.on("update-downloaded", (info) => {
		void (async () => {
			options.window()?.setProgressBar(-1);
			installable ??= await canInstallOnThisBuild();
			if (!installable) {
				// 未签名：装不上。给下载地址，别让用户点了「重启安装」然后看着应用消失。
				const answered = await notify({
					type: "warning",
					message: `新版本 ${info.version} 已下载，但这个构建不能自动安装`,
					detail: "macOS 只允许同一签名身份的新版本原地替换。去下载页拿新的安装包，拖进「应用程序」覆盖即可。",
					buttons: ["打开下载页", "稍后"],
					defaultId: 0,
					cancelId: 1,
				});
				if (answered === 0 && feed !== undefined) await shell.openExternal(feed);
				return;
			}
			const answered = await notify({
				type: "info",
				message: `新版本 ${info.version} 已就绪`,
				detail: "重启后安装。这期间会先停掉后台（正在跑的事会中断）。",
				buttons: ["立即重启安装", "稍后"],
				defaultId: 0,
				cancelId: 1,
			});
			if (answered !== 0) return;
			await options.beforeInstall();
			autoUpdater.quitAndInstall(false, true);
		})();
	});

	autoUpdater.on("update-not-available", () => {
		console.log(`[update] 已是最新（${app.getVersion()}）`);
		if (!manual) return;
		manual = false;
		void notify({ type: "info", message: "已经是最新版本", detail: `当前 ${app.getVersion()}。` });
	});

	autoUpdater.on("error", (error) => {
		console.warn(`[update] ${error.message}`);
		if (!manual) return;
		manual = false;
		const feed = resolveFeedUrl(process.env["SOLO_UPDATE_URL"]);
		void notify({
			type: "warning",
			message: "检查更新失败",
			detail: `${error.message}${feed === undefined ? "" : `\n更新源：${feed}`}`,
			buttons: ["知道了"],
		});
	});

	const check = (): void => {
		if (!app.isPackaged) {
			if (manual) void notify({ type: "info", message: "开发态不检查更新", detail: "打包后（desktop:dist:mac）才会。" });
			manual = false;
			return;
		}
		void autoUpdater.checkForUpdates().catch(() => undefined);
	};

	return {
		start: () => {
			setTimeout(check, FIRST_CHECK_DELAY).unref();
			timer = setInterval(check, CHECK_INTERVAL);
			timer.unref();
		},
		checkNow: () => {
			manual = true;
			check();
		},
	};
}
