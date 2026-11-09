/**
 * Solo 桌面壳：一个窗口，加载本机后端发的同一个界面（ADR-002 早就这么定了，ADR-028 落的地）。
 *
 * 它只管四件事：拉起后端、开窗口、收尾（退出 / 重启 / 装更新时先把后端停干净）、更新。
 * 界面一行都没改 —— 页面从 `http://127.0.0.1:<port>/` 加载，相对路径、SSE、来源闸全都照旧。
 *
 * 两个根：应用私有的东西（助理、提示词、内置插件、配置、库）在 `app.getPath("userData")`；
 * 我的组织（成员、团队、技能、规矩）在 `~/.solo`。开发态两个根都放临时目录，跑坏了删掉即可。
 */
import {
	app,
	BrowserWindow,
	dialog,
	ipcMain,
	Menu,
	nativeImage,
	nativeTheme,
	screen,
	shell,
	Tray,
	type IpcMainEvent,
	type IpcMainInvokeEvent,
} from "electron";
import { readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { startBackend, type Backend } from "./backend.ts";
import { installMenu } from "./menu.ts";
import {
	clampOrbBounds,
	defaultOrbBounds,
	fitOrbBounds,
	ORB_SIZE,
	orbStatePath,
	parseOrbState,
	serializeOrbState,
	type OrbState,
} from "./orb-window.ts";
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
let orbWin: BrowserWindow | undefined;
let tray: Tray | undefined;
let orbState: OrbState | undefined;
let quitting = false;

function createWindow(url: string): BrowserWindow {
	// 小屏幕（1280×800 那类笔记本）上别把窗口开到屏幕外面去。
	const area = screen.getPrimaryDisplay().workAreaSize;
	const window = new BrowserWindow({
		// 桌面默认给一个「宽窗口」：右边能同时放下对话与资料栏（≥901 是两栏那一档），
		// 不再一开窗就是手机比例。窄到 360 仍是单列（ADR-084），直接拖小也不会坏。
		width: Math.min(1180, area.width - 80),
		height: Math.min(820, area.height - 80),
		minWidth: 360,
		minHeight: 560,
		show: false,
		backgroundColor: "#0f0f10",
		title: "Solo",
		// macOS 用系统标题栏（ADR-088）；Windows 原生标题栏不画，界面画一条 40px 的标题带，
		// 最小化 / 最大化 / 关闭仍由系统画在右边（titleBarOverlay，ADR-028 / ADR-069）。
		...windowChrome(process.platform, nativeTheme.shouldUseDarkColors ? "dark" : "light"),
		webPreferences: {
			// 菜单动作两边都要（设置里的「检查更新」也走它）；只有取色那条主进程认 Windows。
			preload: join(app.getAppPath(), "desktop/dist/preload.cjs"),
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
	window.once("ready-to-show", () => {
		window.show();
		// macOS 上 `show()` 不一定把应用叫到前台：悬浮球那扇 `showInactive` 的窗子一开，
		// 主窗口虽然看得见，菜单栏（左上角）却还留在上一个应用那儿。启动时显式激活一次。
		if (process.platform === "darwin") app.focus({ steal: true });
	});

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
		if (quitting) return;
		if (process.platform === "darwin") {
			event.preventDefault();
			window.hide();
			return;
		}
		// 别的平台关主窗口就是退出：独立悬浮窗不能把进程留在后台（托盘图标还在）。
		if (orbWin !== undefined && !orbWin.isDestroyed()) orbWin.close();
	});

	// `?shell=desktop`：界面据此让出红绿灯的位置、装好拖拽把手；`platform` 决定
	// Windows 要不要画标题带（`ui/app/src/main.tsx` 落在 `data-os` 上）。
	void window.loadURL(`${url}?shell=desktop&platform=${process.platform}`);
	if (DEV) window.webContents.openDevTools({ mode: "detach" });
	return window;
}

/** 悬浮窗的可用区：拖到哪块屏幕上，就按那块屏幕算边界。 */
function areaFor(window: BrowserWindow): Electron.Rectangle {
	return screen.getDisplayMatching(window.getBounds()).workArea;
}

function readOrbState(): OrbState | undefined {
	try {
		return parseOrbState(readFileSync(orbStatePath(appRoot), "utf8"));
	} catch {
		return undefined;
	}
}

/** 位置存不下来只影响「下次开在哪」，不该拦住启动。 */
function writeOrbState(state: OrbState): void {
	try {
		writeFileSync(orbStatePath(appRoot), serializeOrbState(state), "utf8");
	} catch {
		// 只在这一轮里生效。
	}
}

/**
 * 独立悬浮窗（ADR-116）：透明、无边框、置顶、不占 Dock。
 *
 * 加载的是同一个界面，只是带 `?orb=1` —— 那一页只画插件的 `overlays` 插槽，
 * 插件据此把球画成窗口里的固定位置（拖动交给主进程挪窗口）。
 * 透明区域默认点击穿透；鼠标移进球里时界面再打开命中。
 */
function createOrbWindow(url: string): BrowserWindow {
	const saved = readOrbState();
	const savedBounds =
		saved === undefined ? undefined : { x: saved.x, y: saved.y, width: ORB_SIZE.width, height: ORB_SIZE.height };
	const display = savedBounds === undefined ? screen.getPrimaryDisplay() : screen.getDisplayMatching(savedBounds);
	const bounds = saved === undefined ? defaultOrbBounds(display.workArea) : fitOrbBounds(saved, display.workArea);
	orbState = { ...bounds, visible: saved?.visible ?? true };

	const window = new BrowserWindow({
		...bounds,
		width: ORB_SIZE.width,
		height: ORB_SIZE.height,
		show: false,
		frame: false,
		transparent: true,
		backgroundColor: "#00000000",
		hasShadow: false,
		resizable: false,
		minimizable: false,
		maximizable: false,
		fullscreenable: false,
		skipTaskbar: true,
		alwaysOnTop: true,
		// 第一次点球就能用：不必先点一下把窗口叫活。
		acceptFirstMouse: true,
		webPreferences: {
			preload: join(app.getAppPath(), "desktop/dist/orb-preload.cjs"),
			contextIsolation: true,
			nodeIntegration: false,
			sandbox: true,
		},
	});

	window.setAlwaysOnTop(true, "floating");
	if (process.platform === "darwin") window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
	window.setIgnoreMouseEvents(true, { forward: true });

	window.once("ready-to-show", () => {
		if (orbState?.visible !== false) window.showInactive();
	});
	window.on("closed", () => {
		orbWin = undefined;
	});

	// 和主窗口一样：外链交给系统浏览器，页面不许离开后端这一份 origin。
	window.webContents.setWindowOpenHandler(({ url: target }) => {
		if (target.startsWith("http://") || target.startsWith("https://")) void shell.openExternal(target);
		return { action: "deny" };
	});
	window.webContents.on("will-navigate", (event, target) => {
		if (target.startsWith(url)) return;
		event.preventDefault();
		if (target.startsWith("http")) void shell.openExternal(target);
	});

	void window.loadURL(`${url}?orb=1&shell=desktop&platform=${process.platform}`);
	return window;
}

/**
 * 悬浮窗的桥。来源只认这扇窗、这个后端 origin —— preload 在页面里，
 * 页面里的任何脚本都能发消息，不校验就等于把「挪窗口 / 藏起来」交给网页。
 */
function setupOrbBridge(window: BrowserWindow): void {
	const trusted = (event: IpcMainEvent): boolean => {
		const url = backend?.url;
		return (
			url !== undefined &&
			!window.isDestroyed() &&
			event.sender === window.webContents &&
			(event.senderFrame?.url.startsWith(url) ?? false)
		);
	};

	ipcMain.on("orb:interactive", (event, on: unknown) => {
		if (!trusted(event)) return;
		window.setIgnoreMouseEvents(on !== true, { forward: true });
	});

	ipcMain.on("orb:drag", (event, dx: unknown, dy: unknown) => {
		if (!trusted(event)) return;
		if (typeof dx !== "number" || typeof dy !== "number" || !Number.isFinite(dx) || !Number.isFinite(dy)) return;
		// 一次拖太远是坏消息（或脚本）：夹到 200px，窗口不会一帧飞出屏幕。
		const step = (value: number): number => Math.max(-200, Math.min(200, Math.round(value)));
		const position = window.getPosition();
		const next = clampOrbBounds({ x: (position[0] ?? 0) + step(dx), y: (position[1] ?? 0) + step(dy) }, areaFor(window));
		window.setPosition(next.x, next.y);
		if (orbState !== undefined) orbState = { ...orbState, x: next.x, y: next.y };
	});

	ipcMain.on("orb:drag-end", (event) => {
		const state = orbState;
		if (!trusted(event) || state === undefined) return;
		const position = window.getPosition();
		orbState = { ...state, x: position[0] ?? state.x, y: position[1] ?? state.y };
		writeOrbState(orbState);
	});

	ipcMain.on("orb:recenter", (event) => {
		if (!trusted(event)) return;
		const bounds = defaultOrbBounds(screen.getPrimaryDisplay().workArea);
		window.setPosition(bounds.x, bounds.y);
		orbState = { ...bounds, visible: true };
		writeOrbState(orbState);
	});

	ipcMain.on("orb:hide", (event) => {
		if (!trusted(event)) return;
		hideOrb();
	});
}

function showOrb(): void {
	if (orbWin === undefined || orbWin.isDestroyed()) return;
	orbWin.showInactive();
	if (orbState !== undefined) {
		orbState = { ...orbState, visible: true };
		writeOrbState(orbState);
	}
}

function hideOrb(): void {
	if (orbWin === undefined || orbWin.isDestroyed()) return;
	orbWin.hide();
	// 藏起来的时候把命中关回去：下次打开时透明区域照旧穿过去。
	orbWin.setIgnoreMouseEvents(true, { forward: true });
	if (orbState !== undefined) {
		orbState = { ...orbState, visible: false };
		writeOrbState(orbState);
	}
}

function toggleOrb(): void {
	if (orbWin === undefined || orbWin.isDestroyed()) return;
	if (orbWin.isVisible()) hideOrb();
	else showOrb();
}

/** macOS 要一张「模板图」（只取 alpha，系统自己上色）；别的平台用应用图标缩一个。 */
function trayIcon(): Electron.NativeImage {
	const dir = join(app.getAppPath(), "desktop");
	if (process.platform === "darwin") {
		const image = nativeImage.createFromPath(join(dir, "trayTemplate.png"));
		if (!image.isEmpty()) {
			image.setTemplateImage(true);
			return image;
		}
	}
	const fallback = nativeImage.createFromPath(join(dir, "icon.png"));
	return fallback.isEmpty() ? nativeImage.createEmpty() : fallback.resize({ width: 16, height: 16 });
}

/** 菜单每次现建：勾选状态跟着窗口此刻的可见性走。 */
function trayMenu(): Menu {
	return Menu.buildFromTemplate([
		{ label: orbWin?.isVisible() === true ? "隐藏悬浮球" : "显示悬浮球", click: toggleOrb },
		{
			label: "打开 Solo",
			click: () => {
				if (win === undefined || win.isDestroyed()) return;
				win.show();
				win.focus();
			},
		},
		{ type: "separator" },
		{ label: "退出 Solo", click: () => void quit() },
	]);
}

/** 菜单栏 / 托盘图标：左键一下开关悬浮球，右键是菜单（ADR-116）。 */
function createTray(): Tray {
	const next = new Tray(trayIcon());
	next.setToolTip("Solo");
	if (process.platform === "darwin") next.setIgnoreDoubleClickEvents(true);
	next.on("click", toggleOrb);
	next.on("right-click", () => next.popUpContextMenu(trayMenu()));
	return next;
}

async function quit(): Promise<void> {
	quitting = true;
	tray?.destroy();
	tray = undefined;
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
 * 页面的桥（两边都装）。菜单动作照抄原生菜单那几项（Windows 的标题带、macOS 设置里的
 * 「检查更新」都走它）；取色只有 Windows 认。来源只认这个窗口、这个后端 origin ——
 * preload 在页面里，页面里的任何脚本都能发消息，不校验就等于把退出 / 重启键交给网页。
 */
function setupBridge(window: BrowserWindow): void {
	const trusted = (event: IpcMainEvent | IpcMainInvokeEvent): boolean => {
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

	// 设置里显示「当前版本」：只有主进程知道版本号。
	ipcMain.handle("solo:version", (event) => (trusted(event) ? app.getVersion() : ""));

	ipcMain.on("solo:theme", (event, theme: unknown) => {
		if (!trusted(event) || process.platform !== "win32") return;
		if (theme !== "light" && theme !== "dark") return;
		window.setTitleBarOverlay({ ...TITLEBAR_COLORS[theme], height: TITLEBAR_HEIGHT });
	});
}

/** macOS 上必须是「普通应用」：UIElement 没有 Dock 图标，左上角也没有菜单栏（ADR-121）。 */
function regularApp(): void {
	if (process.platform === "darwin") app.setActivationPolicy("regular");
}

async function start(): Promise<void> {
	regularApp();
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
	// 悬浮球是同一进程里的第二扇窗（不是第二个进程）：同一个 origin，SSE / 语音权限照旧。
	orbWin = createOrbWindow(backend.url);
	// 悬浮球的 `setVisibleOnAllWorkspaces(…, { visibleOnFullScreen: true })` 会让 macOS 把
	// 进程重新注册成 UIElement（Dock 图标和左上角菜单栏一起消失）—— 开头那次声明被它盖掉了。
	regularApp();
	setupOrbBridge(orbWin);
	tray = createTray();
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
	setupBridge(win);
	if (process.platform === "win32") {
		// 菜单对象留着给加速键用，但界面上不画那一行 —— 菜单已经搬进标题带。
		win.setMenuBarVisibility(false);
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
