/**
 * Solo 桌面壳：一个窗口，加载本机后端发的同一个界面（ADR-002 早就这么定了，ADR-028 落的地）。
 *
 * 它只管四件事：拉起后端、开窗口、收尾（退出 / 重启 / 装更新时先把后端停干净）、更新。
 * 界面一行都没改 —— 页面从 `http://127.0.0.1:<port>/` 加载，相对路径、SSE、来源闸全都照旧。
 *
 * 两个根：应用私有的东西（助理、提示词、内置插件、配置、库）在 `app.getPath("userData")`；
 * 我的组织（成员、团队、技能、规矩）在 `~/.solo`。开发态两个根都放临时目录，跑坏了删掉即可。
 */
import { app, BrowserWindow, dialog, ipcMain, nativeTheme, shell, type IpcMainEvent } from "electron";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { startBackend, type Backend } from "./backend.ts";
import { installMenu } from "./menu.ts";
import { createUpdater, type Updater } from "./updates.ts";
import { TITLEBAR_COLORS, TITLEBAR_HEIGHT, windowChrome } from "./window-chrome.ts";

const DEV = !app.isPackaged;
/** 和后端 `src/shell/main.ts` 的 `RELAUNCH_EXIT_CODE` 对齐：重置 / 重启完后端以 75 退出（壳不 import 内核）。 */
const RELAUNCH_EXIT_CODE = 75;
// userData 决定 SQLite、日志、localStorage 的位置，必须在单实例锁之前定下来。
if (DEV) app.setPath("userData", join(tmpdir(), "solo-desktop-dev-userdata"));

const appRoot = app.getPath("userData");
// 开发态别写真实的 `~/.solo`：那是正在用的组织。
const userRoot = DEV ? join(tmpdir(), "solo-desktop-dev-home") : join(homedir(), ".solo");
// 日志跟组织数据放在一起（ADR-041）：排查「当时组织里发生了什么」时不用两头找。
const logFile = join(userRoot, "logs", "core.log");

let backend: Backend | undefined;
let updater: Updater | undefined;
let win: BrowserWindow | undefined;
let quitting = false;

function createWindow(url: string): BrowserWindow {
	const window = new BrowserWindow({
		// 界面是单列（ADR-084），开窗就是手机比例：375×812。想放宽直接拖，
		// 最小宽度只留红绿灯 + 一列内容的位置。
		width: 375,
		height: 812,
		minWidth: 360,
		minHeight: 560,
		show: false,
		backgroundColor: "#0f0f10",
		title: "Solo",
		// macOS 用系统标题栏（ADR-088）；Windows 原生标题栏不画，界面画一条 40px 的标题带，
		// 最小化 / 最大化 / 关闭仍由系统画在右边（titleBarOverlay，ADR-028 / ADR-069）。
		...windowChrome(process.platform, nativeTheme.shouldUseDarkColors ? "dark" : "light"),
		webPreferences: {
			// 桥只在 Windows 上有用（标题带的菜单动作与取色）；别的平台不装。
			...(process.platform === "win32" ? { preload: join(app.getAppPath(), "desktop/dist/preload.cjs") } : {}),
			contextIsolation: true,
			nodeIntegration: false,
			sandbox: true,
			// 内置浏览器（工作台的网页页签）用 `<webview>`：iframe 挡不住站点的
			// `X-Frame-Options`（百度、GitHub 都拒），webview 是独立进程，不受这一条限制。
			webviewTag: true,
		},
	});

	// webview 里装的是外面的网页：不给 preload、不给 node，只许 http(s)。
	window.webContents.on("will-attach-webview", (event, webPreferences, params) => {
		delete webPreferences.preload;
		webPreferences.nodeIntegration = false;
		webPreferences.contextIsolation = true;
		webPreferences.sandbox = true;
		if (!/^https?:\/\//i.test(params.src ?? "")) event.preventDefault();
	});
	window.once("ready-to-show", () => window.show());

	// 页面里的外链一律交给系统浏览器；不在这里开新窗口（也没有 preload 可以借）。
	window.webContents.setWindowOpenHandler(({ url: target }) => {
		if (target.startsWith("http://") || target.startsWith("https://")) void shell.openExternal(target);
		return { action: "deny" };
	});
	// 只允许留在后端这一份 origin 里；别的一律交给系统浏览器。
	window.webContents.on("will-navigate", (event, target) => {
		if (target.startsWith(url)) return;
		event.preventDefault();
		if (target.startsWith("http")) void shell.openExternal(target);
	});

	// macOS：关窗口不退出（agent 还在干活），下次点 Dock 图标回来。真正退出走 Cmd+Q。
	window.on("close", (event) => {
		if (quitting || process.platform !== "darwin") return;
		event.preventDefault();
		window.hide();
	});

	// `?shell=desktop`：界面据此让出红绿灯的位置、装好拖拽把手；`platform` 决定
	// Windows 要不要画标题带（`ui/app/src/main.tsx` 落在 `data-os` 上）。
	void window.loadURL(`${url}?shell=desktop&platform=${process.platform}`);
	if (DEV) window.webContents.openDevTools({ mode: "detach" });
	return window;
}

async function quit(): Promise<void> {
	quitting = true;
	await backend?.stop().catch(() => undefined);
	app.quit();
}

function restart(): void {
	quitting = true;
	void backend?.stop().finally(() => {
		app.releaseSingleInstanceLock();
		app.relaunch();
		app.exit(0);
	});
}

/**
 * 标题带的桥（只有 Windows 装）。菜单动作照抄原生菜单那几项；取色让右边三个系统按钮
 * 跟着界面明暗走。来源只认这个窗口、这个后端 origin —— preload 在页面里，页面里的
 * 任何脚本都能发消息，不校验就等于把退出 / 重启键交给网页。
 */
function setupBridge(window: BrowserWindow): void {
	const trusted = (event: IpcMainEvent): boolean => {
		const url = backend?.url;
		return url !== undefined && event.sender === window.webContents && (event.senderFrame?.url.startsWith(url) ?? false);
	};

	ipcMain.on("solo:menu", (event, action: unknown) => {
		if (!trusted(event)) return;
		switch (action) {
			case "check-updates":
				updater?.checkNow();
				break;
			case "restart":
				restart();
				break;
			case "quit":
				void quit();
				break;
			case "reload":
				window.webContents.reload();
				break;
			case "toggle-devtools":
				window.webContents.toggleDevTools();
				break;
		}
	});

	ipcMain.on("solo:theme", (event, theme: unknown) => {
		if (!trusted(event) || process.platform !== "win32") return;
		if (theme !== "light" && theme !== "dark") return;
		window.setTitleBarOverlay({ ...TITLEBAR_COLORS[theme], height: TITLEBAR_HEIGHT });
	});
}

async function start(): Promise<void> {
	// 第二个实例只负责把已有窗口叫到前面：两个后端连同一个 core.sqlite 会抢锁。
	if (!app.requestSingleInstanceLock()) {
		app.quit();
		return;
	}
	app.on("second-instance", () => {
		// 退出途中窗口已经销毁，但进程还没走完：这时再碰 `win` 会抛
		// `Object has been destroyed`（Windows 更新后手动重开的那个报错）。
		if (quitting || win === undefined || win.isDestroyed()) return;
		if (win.isMinimized()) win.restore();
		win.show();
		win.focus();
	});
	app.on("window-all-closed", () => {
		if (process.platform !== "darwin") void quit();
	});
	app.on("activate", () => {
		if (!quitting && win !== undefined && !win.isDestroyed()) win.show();
	});
	// 锁尽量留到真退出：放早了，安装更新期间手动重开的新实例会和进程外安装器抢文件。
	app.on("will-quit", () => app.releaseSingleInstanceLock());
	// 退出必须先停后端：它是本进程的子进程，只管退出会留下一个占着 7788 和 sqlite 的孤儿。
	app.on("before-quit", (event) => {
		if (quitting) return;
		event.preventDefault();
		void quit();
	});

	try {
		backend = await startBackend({
			entry: join(app.getAppPath(), "src/shell/main.ts"),
			appRoot,
			userRoot,
			logFile,
			onLog: (line) => console.log(line),
			// 设置里的「重置所有数据」和装完插件后的「重启」：后端以 75 退出，整个应用重开一遍。
			onExit: (code) => {
				if (code === RELAUNCH_EXIT_CODE) restart();
			},
		});
	} catch (error) {
		await dialog.showMessageBox({
			type: "error",
			message: "后端没起来",
			detail: `${(error as Error).message}\n\n日志：${logFile}`,
			buttons: ["退出"],
		});
		app.exit(1);
		return;
	}

	win = createWindow(backend.url);
	updater = createUpdater({
		window: () => win,
		settingsFile: join(appRoot, "settings.json"),
		beforeInstall: async () => {
			// 装更新要走到进程退出：先停后端，再让 `updates.ts` 的 `app.quit()` 直接通过
			// `before-quit`（不然它还会再进来等一次后端）。
			await backend?.stop().catch(() => undefined);
			quitting = true;
		},
	});
	installMenu({ checkUpdates: () => updater?.checkNow(), restart });
	if (process.platform === "win32") {
		// 菜单对象留着给加速键用，但界面上不画那一行 —— 菜单已经搬进标题带。
		win.setMenuBarVisibility(false);
		setupBridge(win);
	}
	updater.start();
}

void app
	.whenReady()
	.then(start)
	.catch((error: unknown) => {
		console.error("[shell] 启动失败：", error);
		app.exit(1);
	});
