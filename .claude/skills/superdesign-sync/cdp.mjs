/**
 * 零依赖的 Chrome DevTools Protocol 客户端。
 *
 * 只用 Node 22+ 自带的 `WebSocket` 和 `fetch`，驱动本机装好的 Chrome / Edge / Chromium，
 * 拿它当「把界面跑一遍并截图/取 DOM」的工具。不装 puppeteer，仓库里不多一个依赖。
 *
 * 只实现这个技能用到的四个动作：开页面、跳地址、跑一段 JS、改视口。
 */

import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 找本机浏览器：先看环境变量，再按平台列常见安装位置。 */
export function findChrome() {
	const env = process.env.CHROME_PATH ?? process.env.PUPPETEER_EXECUTABLE_PATH;
	if (env !== undefined && existsSync(env)) return env;
	const home = process.env.HOME ?? "";
	const candidates = [
		"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
		"/Applications/Chromium.app/Contents/MacOS/Chromium",
		"/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
		join(home, "Applications/Google Chrome.app/Contents/MacOS/Google Chrome"),
		"/usr/bin/google-chrome",
		"/usr/bin/google-chrome-stable",
		"/usr/bin/chromium",
		"/usr/bin/chromium-browser",
		"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
		"C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
	];
	for (const path of candidates) if (path !== "" && existsSync(path)) return path;
	return null;
}

/** 一个页面（CDP 的 target），消息按 id 配对；事件忽略。 */
class Page {
	constructor(socket, sessionId) {
		this.socket = socket;
		this.sessionId = sessionId;
		this.seq = 0;
		this.pending = new Map();
		socket.addEventListener("message", (event) => {
			const message = JSON.parse(event.data);
			const waiting = this.pending.get(message.id);
			if (waiting === undefined) return;
			this.pending.delete(message.id);
			if (message.error === undefined) waiting.resolve(message.result ?? {});
			else waiting.reject(new Error(message.error.message ?? "CDP 调用失败"));
		});
	}

	send(method, params = {}) {
		const id = (this.seq += 1);
		return new Promise((resolve, reject) => {
			this.pending.set(id, { resolve, reject });
			this.socket.send(JSON.stringify({ id, method, params, sessionId: this.sessionId }));
		});
	}

	async goto(url, { waitMs = 1200 } = {}) {
		await this.send("Page.navigate", { url });
		await sleep(waitMs);
	}

	/** 在页面里跑一段表达式，返回它的值（按值序列化）。 */
	async eval(expression) {
		const result = await this.send("Runtime.evaluate", {
			expression,
			awaitPromise: true,
			returnByValue: true,
		});
		if (result.exceptionDetails !== undefined) {
			throw new Error(result.exceptionDetails.text ?? "页面里这段 JS 抛错了");
		}
		return result.result?.value;
	}

	async setViewport({ width, height, dsf = 1, mobile = false }) {
		await this.send("Emulation.setDeviceMetricsOverride", {
			width,
			height,
			deviceScaleFactor: dsf,
			mobile,
		});
	}

	async screenshot(path) {
		const { data } = await this.send("Page.captureScreenshot", { format: "png" });
		const { writeFileSync } = await import("node:fs");
		writeFileSync(path, Buffer.from(data, "base64"));
	}
}

export class Browser {
	static async launch() {
		if (typeof WebSocket === "undefined") {
			throw new Error(`需要 Node 22+（自带 WebSocket），当前 ${process.version}`);
		}
		const exe = findChrome();
		if (exe === null) throw new Error("没找到 Chrome / Edge / Chromium，可用 CHROME_PATH 指定");
		const dir = mkdtempSync(join(tmpdir(), "solo-sync-"));
		const child = spawn(
			exe,
			[
				"--headless=new",
				"--remote-debugging-port=0",
				`--user-data-dir=${dir}`,
				"--no-first-run",
				"--no-default-browser-check",
				"--disable-extensions",
				"--hide-scrollbars",
				"about:blank",
			],
			{ stdio: "ignore" },
		);
		// Chrome 把实际端口写进 profile 目录的 DevToolsActivePort（第一行是端口）。
		let port;
		for (let attempt = 0; attempt < 100; attempt += 1) {
			await sleep(100);
			try {
				port = Number(readFileSync(join(dir, "DevToolsActivePort"), "utf8").split("\n")[0]);
				break;
			} catch {
				// 还没写出来，继续等。
			}
		}
		if (port === undefined || Number.isNaN(port)) {
			child.kill();
			rmSync(dir, { recursive: true, force: true });
			throw new Error("Chrome 没有起来（DevToolsActivePort 一直没出现）");
		}
		const version = await (await fetch(`http://127.0.0.1:${String(port)}/json/version`)).json();
		const socket = new WebSocket(version.webSocketDebuggerUrl);
		await new Promise((resolve, reject) => {
			socket.addEventListener("open", resolve, { once: true });
			socket.addEventListener("error", reject, { once: true });
		});
		const browser = new Browser(socket, child, dir);
		return browser;
	}

	constructor(socket, child, dir) {
		this.socket = socket;
		this.child = child;
		this.dir = dir;
		this.seq = 0;
		this.pending = new Map();
		socket.addEventListener("message", (event) => {
			const message = JSON.parse(event.data);
			const waiting = this.pending.get(message.id);
			if (waiting === undefined) return;
			this.pending.delete(message.id);
			if (message.error === undefined) waiting.resolve(message.result ?? {});
			else waiting.reject(new Error(message.error.message ?? "CDP 调用失败"));
		});
	}

	send(method, params = {}) {
		const id = (this.seq += 1);
		return new Promise((resolve, reject) => {
			this.pending.set(id, { resolve, reject });
			this.socket.send(JSON.stringify({ id, method, params }));
		});
	}

	async newPage() {
		const { targetId } = await this.send("Target.createTarget", { url: "about:blank" });
		const { sessionId } = await this.send("Target.attachToTarget", { targetId, flatten: true });
		const page = new Page(this.socket, sessionId);
		await page.send("Page.enable");
		await page.send("Runtime.enable");
		return page;
	}

	async close() {
		try {
			this.socket.close();
		} catch {
			// 关不掉就算了，进程下面会杀掉。
		}
		this.child.kill();
		// 临时 profile 只是垃圾：Chrome 退出时还在写盘，删不掉就算了，别把一次成功的同步搞成失败。
		await sleep(300);
		try {
			rmSync(this.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
		} catch {
			// 系统会在重启时清 /tmp，这里不较真。
		}
	}
}
