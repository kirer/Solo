/**
 * Solo 桌面壳：一个窗口，加载本机后端发的同一个界面（ADR-002 早就这么定了，ADR-028 落的地）。
 *
 * 它只管四件事：拉起后端、开窗口、收尾（退出 / 重启 / 装更新时先把后端停干净）、更新。
 * 界面一行都没改 —— 页面从 `http://127.0.0.1:<port>/` 加载，相对路径、SSE、来源闸全都照旧。
 *
 * 两个根：应用私有的东西（助理、提示词、内置插件、配置、库）在 `app.getPath("userData")`；
 * 我的组织（成员、团队、技能、规矩）在 `~/.solo`。开发态两个根都放临时目录，跑坏了删掉即可。
 */
import { app, BrowserWindow, dialog, shell } from "electron";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { startBackend, type Backend } from "./backend.ts";
import { installMenu } from "./menu.ts";
import { createUpdater, type Updater } from "./updates.ts";

const DEV = !app.isPackaged;
// userData 决定 SQLite、日志、localStorage 的位置，必须在单实例锁之前定下来。
if (DEV) app.setPath("userData", join(tmpdir(), "solo-desktop-dev-userdata"));

const appRoot = app.getPath("userData");
// 开发态别写真实的 `~/.solo`：那是正在用的组织。
const userRoot = DEV ? join(tmpdir(), "solo-desktop-dev-home") : join(homedir(), ".solo");
const logFile = join(appRoot, "logs", "core.log");

let backend: Backend | undefined;
let updater: Updater | undefined;
let win: BrowserWindow | undefined;
let quitting = false;

function createWindow(url: string): BrowserWindow {
	const window = new BrowserWindow({
		width: 1280,
		height: 800,
		minWidth: 960,
		minHeight: 640,
		show: false,
		backgroundColor: "#0f0f10",
		title: "Solo",
		// 标题栏藏进界面里（和 DSH 一样）：红绿灯浮在侧栏左上角那块留白上。
		// Windows 保持系统标题栏 —— 覆盖式按钮要配合界面右内边距，先不冒这个险。
		...(process.platform === "darwin"
			? { titleBarStyle: "hiddenInset" as const, trafficLightPosition: { x: 18, y: 20 } }
			: {}),
		webPreferences: {
			contextIsolation: true,
			nodeIntegration: false,
			sandbox: true,
		},
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

	// `?shell=desktop`：界面据此让出红绿灯的位置、装好拖拽把手（`ui/app/src/main.tsx`）。
	void window.loadURL(`${url}?shell=desktop`);
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
		app.relaunch();
		app.exit(0);
	});
}

async function start(): Promise<void> {
	// 第二个实例只负责把已有窗口叫到前面：两个后端连同一个 core.sqlite 会抢锁。
	if (!app.requestSingleInstanceLock()) {
		app.quit();
		return;
	}
	app.on("second-instance", () => {
		if (win === undefined) return;
		if (win.isMinimized()) win.restore();
		win.show();
		win.focus();
	});
	app.on("window-all-closed", () => {
		if (process.platform !== "darwin") void quit();
	});
	app.on("activate", () => win?.show());
	// 退出必须先停后端：它是本进程的子进程，只管退出会留下一个占着 7788 和 sqlite 的孤儿。
	app.on("before-quit", (event) => {
		if (quitting) return;
		event.preventDefault();
		void quit();
	});

	try {
		backend = await startBackend({
			entry: join(app.getAppPath(), "src/core/shell/main.ts"),
			appRoot,
			userRoot,
			logFile,
			onLog: (line) => console.log(line),
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
	updater = createUpdater({ window: () => win, beforeInstall: async () => void (await backend?.stop()) });
	installMenu({ checkUpdates: () => updater?.checkNow(), restart });
	updater.start();
}

void app
	.whenReady()
	.then(start)
	.catch((error: unknown) => {
		console.error("[shell] 启动失败：", error);
		app.exit(1);
	});
