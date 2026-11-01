/**
 * 升级：自己拉清单、自己验签、自己装（ADR-029）。
 *
 * 为什么不用 `electron-updater`：macOS 那条路是 Squirrel.Mac，换包前要求新旧 `.app`
 * 同一个 Developer ID 身份 —— 未签名构建的「重启安装」必然失败。Sparkle / Tauri 和
 * 大多数开源桌面应用走的是另一条：清单用项目自己的密钥签名，包用 zip，进程外替换。
 * 两个平台同一条路线，只有替换脚本不同（`install.ts`）。
 *
 * 几条刻意的选择：
 * - **不后台下载**：自动检查只查、不下载、不弹窗；下载和安装各要一次明确点击。
 * - **不自动装**：安装要先把后端停干净（它占着 sqlite，还在跑后台命令），所以走
 *   `beforeInstall` 回调，由 `main.ts` 负责收尾顺序。
 * - **验签在解包之前**：清单签名不过就完全不碰这个版本；包再对一遍 sha512。
 */
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { app, dialog, type BrowserWindow, type MessageBoxOptions } from "electron";
import { feedUrl } from "./feed.ts";
import { scheduleInstall } from "./install.ts";
import { fileFor, isNewer, parseManifest, verifyManifest } from "./manifest.ts";
import { UPDATE_PUBLIC_KEY } from "./update-key.ts";

const CHECK_INTERVAL = 6 * 60 * 60 * 1000;
const FIRST_CHECK_DELAY = 30_000;

export type UpdaterOptions = {
	/** 现在的窗口：对话框挂在它上面，进度条画在它的 Dock/任务栏图标上。 */
	window: () => BrowserWindow | undefined;
	/** 安装前收尾（停后端）。返回之后才会退出重启。 */
	beforeInstall: () => Promise<void>;
};

export type Updater = {
	start: () => void;
	checkNow: () => void;
};

const manifestName = (): string => (process.platform === "darwin" ? "latest-mac.json" : "latest-win.json");

async function fetchText(url: string): Promise<string> {
	const response = await fetch(url);
	if (!response.ok) throw new Error(`${response.status} ${response.statusText}（${url}）`);
	return response.text();
}

/** 下到临时目录，边下边报进度，下完核对 sha512。 */
async function download(url: string, sha512: string, onProgress: (ratio: number) => void): Promise<string> {
	const response = await fetch(url);
	if (!response.ok || response.body === null) throw new Error(`下载失败：${response.status} ${response.statusText}`);
	const total = Number(response.headers.get("content-length") ?? 0);
	const dir = await mkdtemp(join(tmpdir(), "solo-update-"));
	const path = join(dir, "update.zip");
	const hash = createHash("sha512");
	const out = createWriteStream(path);
	let received = 0;
	for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
		hash.update(chunk);
		received += chunk.byteLength;
		if (!out.write(chunk)) await new Promise<void>((done) => out.once("drain", () => done()));
		if (total > 0) onProgress(received / total);
	}
	await new Promise<void>((done, fail) => {
		out.once("error", fail);
		out.end(() => done());
	});
	if (hash.digest("base64") !== sha512) {
		await rm(dir, { recursive: true, force: true });
		throw new Error("校验失败：下载的包和清单里的 sha512 对不上");
	}
	return path;
}

export function createUpdater(options: UpdaterOptions): Updater {
	const feed = feedUrl();
	let manual = false;
	let busy = false;

	const notify = (body: MessageBoxOptions): Promise<number> => {
		const win = options.window();
		return (win === undefined ? dialog.showMessageBox(body) : dialog.showMessageBox(win, body)).then(
			(result) => result.response,
		);
	};

	const installDir = (): string => {
		const exe = app.getPath("exe");
		return process.platform === "darwin" ? resolve(exe, "../../..") : dirname(exe);
	};

	const check = async (): Promise<void> => {
		if (busy) return;
		busy = true;
		try {
			if (feed === undefined) throw new Error("更新源地址无效（要 https，本机测试可以用 http://127.0.0.1）");
			const base = feed.endsWith("/") ? feed : `${feed}/`;
			const text = await fetchText(`${base}${manifestName()}`);
			const signature = await fetchText(`${base}${manifestName()}.sig`);
			if (!verifyManifest(UPDATE_PUBLIC_KEY, text, signature)) throw new Error("清单签名不对：不是用发布密钥签的");
			const manifest = parseManifest(text);
			if (manifest === undefined) throw new Error("清单格式不对");
			const file = fileFor(manifest, process.platform);
			if (file === undefined) throw new Error(`清单里没有 ${process.platform} 的包`);
			if (!isNewer(manifest.version, app.getVersion())) {
				console.log(`[update] 已是最新（${app.getVersion()}）`);
				if (manual) void notify({ type: "info", message: "已经是最新版本", detail: `当前 ${app.getVersion()}。` });
				return;
			}
			console.log(`[update] 有新版本 ${manifest.version}（当前 ${app.getVersion()}）`);
			const answered = await notify({
				type: "info",
				message: `有新版本 ${manifest.version}`,
				detail: `当前是 ${app.getVersion()}。现在下载吗？下载完会再问一次要不要重启安装。`,
				buttons: ["下载", "稍后"],
				defaultId: 0,
				cancelId: 1,
			});
			if (answered !== 0) return;
			const zip = await download(`${base}${file.file}`, file.sha512, (ratio) =>
				options.window()?.setProgressBar(Math.max(0, Math.min(1, ratio))),
			);
			options.window()?.setProgressBar(-1);
			const install = await notify({
				type: "info",
				message: `新版本 ${manifest.version} 已下载`,
				detail: "重启后安装。这期间会先停掉后台（正在跑的事会中断）。",
				buttons: ["立即重启安装", "稍后"],
				defaultId: 0,
				cancelId: 1,
			});
			if (install !== 0) return;
			await options.beforeInstall();
			const exe = app.getPath("exe");
			scheduleInstall({
				pid: process.pid,
				appPath: installDir(),
				appDir: installDir(),
				zipPath: zip,
				exePath: exe,
			});
			app.quit();
		} catch (error) {
			console.warn(`[update] ${(error as Error).message}`);
			if (!manual) return;
			void notify({
				type: "warning",
				message: "检查更新失败",
				detail: `${(error as Error).message}${feed === undefined ? "" : `\n更新源：${feed}`}`,
				buttons: ["知道了"],
			});
		} finally {
			manual = false;
			busy = false;
		}
	};

	const guarded = (): void => {
		if (!app.isPackaged) {
			if (manual) {
				void notify({ type: "info", message: "开发态不检查更新", detail: "打包后（desktop:dist:mac）才会。" });
				manual = false;
			}
			return;
		}
		void check();
	};

	return {
		start: () => {
			setTimeout(guarded, FIRST_CHECK_DELAY).unref();
			setInterval(guarded, CHECK_INTERVAL).unref();
		},
		checkNow: () => {
			manual = true;
			if (app.isPackaged) {
				void check();
				return;
			}
			guarded();
		},
	};
}
