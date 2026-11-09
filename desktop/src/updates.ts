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
import { app, dialog, session, type BrowserWindow, type MessageBoxOptions } from "electron";
import { feedUrl } from "./feed.ts";
import { scheduleInstall } from "./install.ts";
import { fileFor, isNewer, parseManifest, verifyManifest } from "./manifest.ts";
import { assetHeaders, assetUrlOf, latestReleaseApi } from "./release-assets.ts";
import { UPDATE_PUBLIC_KEY } from "./update-key.ts";
import { readUpdateProxy } from "./update-proxy.ts";

const CHECK_INTERVAL = 6 * 60 * 60 * 1000;
const FIRST_CHECK_DELAY = 30_000;

export type UpdaterOptions = {
	/** 现在的窗口：对话框挂在它上面，进度条画在它的 Dock/任务栏图标上。 */
	window: () => BrowserWindow | undefined;
	/** 安装前收尾（停后端）。返回之后才会退出重启。 */
	beforeInstall: () => Promise<void>;
	/** `settings.json`：每次检查更新前读一遍 `updateProxy`（改了不用重启）。 */
	settingsFile: string;
};

export type Updater = {
	start: () => void;
	checkNow: () => void;
};

const manifestName = (): string => (process.platform === "darwin" ? "latest-mac.json" : "latest-win.json");

/** 有代理就换一条会话走它；没有就直连。用独立分区，别碰界面那条会话的代理。 */
async function fetchUpdate(url: string, proxy: string | undefined): Promise<Response> {
	const headers = assetHeaders(url);
	const init: RequestInit = headers === undefined ? {} : { headers };
	if (proxy === undefined) return fetch(url, init);
	const ses = session.fromPartition("solo-update");
	await ses.setProxy({ proxyRules: proxy });
	return (await ses.fetch(url, init)) as unknown as Response;
}

const ATTEMPTS = 3;

/**
 * 路上抖一下很常见（网关 504、连接被掐）：5xx / 429 / 网络错误等一下重试两次；
 * 4xx（404 之类）直接报 —— 那不是抖，是地址或权限不对。下载包也走它：
 * 只对「还没开始下」的那次请求重试，不重下一半的包。
 */
async function requestOk(url: string, proxy: string | undefined): Promise<Response> {
	let last: Error | undefined;
	for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
		let response: Response | undefined;
		try {
			response = await fetchUpdate(url, proxy);
		} catch (error) {
			last = error instanceof Error ? error : new Error(String(error));
		}
		if (response !== undefined) {
			if (response.ok) return response;
			last = new Error(`${response.status} ${response.statusText}（${url}）`);
			if (response.status < 500 && response.status !== 429) throw last;
		}
		if (attempt < ATTEMPTS - 1) await new Promise<void>((done) => setTimeout(done, 600 * (attempt + 1)));
	}
	throw last ?? new Error(`请求失败（${url}）`);
}

async function fetchText(url: string, proxy: string | undefined): Promise<string> {
	return (await requestOk(url, proxy)).text();
}

/**
 * 资产地址：GitHub 源优先问 `api.github.com` 要直链（`github.com/.../download/` 在
 * 有些网络里连不上，API 和资产域却能到）；API 不通就退回原地址。每个检查只问一次 API。
 */
async function assetUrls(feed: string, proxy: string | undefined): Promise<(name: string) => Promise<string>> {
	const base = feed.endsWith("/") ? feed : `${feed}/`;
	const api = latestReleaseApi(base);
	if (api === undefined) return async (name) => `${base}${name}`;
	let release: unknown;
	try {
		release = JSON.parse(await fetchText(api, proxy)) as unknown;
	} catch (error) {
		console.warn(`[update] 取资产直链失败，退回 ${base}：${(error as Error).message}`);
		release = undefined;
	}
	return async (name) => assetUrlOf(release, base, name);
}

/** 下到临时目录，边下边报进度，下完核对 sha512。 */
async function download(
	url: string,
	sha512: string,
	onProgress: (ratio: number) => void,
	proxy: string | undefined,
): Promise<string> {
	const response = await requestOk(url, proxy);
	if (response.body === null) throw new Error("下载失败：没有响应体");
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

	// 下载和对话框都是异步的，窗口可能已经关了：对销毁的窗口调任何方法都会抛
	// `Object has been destroyed`，这时退回无父窗口的对话框。
	const windowNow = (): BrowserWindow | undefined => {
		const win = options.window();
		return win === undefined || win.isDestroyed() ? undefined : win;
	};

	const notify = (body: MessageBoxOptions): Promise<number> => {
		const win = windowNow();
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
			// 每次检查都重读：用户在设置里改了代理，下一次（或手动「检查更新」）就生效。
			const proxy = readUpdateProxy(options.settingsFile);
			const asset = await assetUrls(base, proxy);
			const text = await fetchText(await asset(manifestName()), proxy);
			const signature = await fetchText(await asset(`${manifestName()}.sig`), proxy);
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
			const zip = await download(
				await asset(file.file),
				file.sha512,
				(ratio) => windowNow()?.setProgressBar(Math.max(0, Math.min(1, ratio))),
				proxy,
			);
			windowNow()?.setProgressBar(-1);
			const install = await notify({
				type: "info",
				message: `新版本 ${manifest.version} 已下载`,
				detail: "应用会关闭并自动重开（可能要一两分钟），安装期间请不要手动打开。正在跑的事会中断。",
				buttons: ["立即重启安装", "稍后"],
				defaultId: 0,
				cancelId: 1,
			});
			if (install !== 0) return;
			const exe = app.getPath("exe");
			try {
				// 先确认安装器真的跑起来，再停后端 / 退出；否则用户点完只看到应用关掉。
				await scheduleInstall({
					pid: process.pid,
					appPath: installDir(),
					appDir: installDir(),
					zipPath: zip,
					exePath: exe,
					version: manifest.version,
					fromVersion: app.getVersion(),
				});
			} catch (error) {
				await notify({
					type: "warning",
					message: "更新安装器没起来",
					detail: `${(error as Error).message}\n\n应用没有退出，可以再试一次，或下载新版安装包手动安装。`,
					buttons: ["知道了"],
				});
				return;
			}
			await options.beforeInstall();
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
