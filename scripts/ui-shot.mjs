#!/usr/bin/env node
/**
 * 网页界面的真实浏览器截图与冒烟检查。
 *
 * 用 Chrome DevTools Protocol 驱动无头 Chrome：不需要 Playwright，
 * 也不引入新依赖。界面改动的验收都走这个脚本——静态阅读代码不算验收。
 *
 * 用法：
 *   node scripts/ui-shot.mjs --url http://127.0.0.1:7789/ --out .taste-skill/shots
 *   node scripts/ui-shot.mjs --sizes 1440x900,768x1024,390x844 --mobile
 *   node scripts/ui-shot.mjs --do "click:.project-front" --do "wait:700" --do "shot:flipped"
 *   node scripts/ui-shot.mjs --eval "window.__company.freeze=true" --eval "window.__company.setOrg(mock)"
 *
 * 选项：
 *   --url <url>         默认 http://127.0.0.1:7789/
 *   --out <dir>         截图目录，默认 .taste-skill/shots
 *   --name <prefix>     文件名前缀，默认 ui
 *   --sizes a,b,c       每项 WIDTHxHEIGHT，默认 1440x900
 *   --scale <n>         设备像素比，默认 2
 *   --wait <ms>         加载后额外等待，默认 1400
 *   --ready <selector>  等到该选择器出现再截图（最多 8 秒）
 *   --do <action>       可重复：click:<css> / press:<key> / wait:<ms> / shot:<name>
 *                     / eval:<js> / hover:<css> / scroll:<selector|number>
 *   --eval <js>         可重复，加载后执行
 *   --full              整页截图
 *   --mobile            触摸 + mobile 视口模拟
 *   --color-scheme      模拟系统配色：light / dark（测「跟随系统」）
 *   --console           打印页面 console.error 与未捕获异常（默认只打印错误）
 *   --keep-open         不关闭 Chrome 调试端口（调试用）
 */

import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const CHROME_CANDIDATES = [
	"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
	"/Applications/Chromium.app/Contents/MacOS/Chromium",
	"/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
	process.env.CHROME_PATH,
].filter(Boolean);

const args = process.argv.slice(2);
const options = {
	url: "http://127.0.0.1:7789/",
	out: ".taste-skill/shots",
	name: "ui",
	sizes: ["1440x900"],
	scale: 2,
	wait: 1400,
	ready: ".org-head, .chat-head",
	actions: [],
	evals: [],
	full: false,
	mobile: false,
	colorScheme: "",
	console: false,
	keepOpen: false,
};

for (let index = 0; index < args.length; index += 1) {
	const arg = args[index];
	const next = args[index + 1];
	const take = () => {
		index += 1;
		return next;
	};
	switch (arg) {
		case "--url":
			options.url = take();
			break;
		case "--out":
			options.out = take();
			break;
		case "--name":
			options.name = take();
			break;
		case "--sizes":
			options.sizes = take().split(",").map((item) => item.trim()).filter(Boolean);
			break;
		case "--scale":
			options.scale = Number(take());
			break;
		case "--wait":
			options.wait = Number(take());
			break;
		case "--ready":
			options.ready = take();
			break;
		case "--do":
			options.actions.push(take());
			break;
		case "--eval":
			options.evals.push(take());
			break;
		case "--full":
			options.full = true;
			break;
		case "--mobile":
			options.mobile = true;
			break;
		case "--color-scheme":
			options.colorScheme = take();
			break;
		case "--console":
			options.console = true;
			break;
		case "--keep-open":
			options.keepOpen = true;
			break;
		default:
			if (arg.startsWith("--")) {
				console.error(`未知选项：${arg}`);
				process.exit(2);
			}
	}
}

const chromePath = CHROME_CANDIDATES.find(Boolean);
if (chromePath === undefined) {
	console.error("找不到 Chrome / Chromium / Edge，无法截图。");
	process.exit(2);
}

const port = 9400 + (process.pid % 500);
const profile = `/tmp/ai-company-shot-${process.pid}`;
const chrome = spawn(
	chromePath,
	[
		"--headless=new",
		"--disable-gpu",
		"--hide-scrollbars",
		"--no-first-run",
		"--no-default-browser-check",
		"--disable-background-timer-throttling",
		"--disable-renderer-backgrounding",
		`--remote-debugging-port=${port}`,
		`--user-data-dir=${profile}`,
		"--window-size=1440,900",
		"about:blank",
	],
	{ stdio: "ignore" },
);

const sleep = (ms) => delay(Math.max(0, ms));
const consoleMessages = [];

async function waitForDevtools() {
	let lastError;
	for (let attempt = 0; attempt < 80; attempt += 1) {
		try {
			const response = await fetch(`http://127.0.0.1:${port}/json`);
			const targets = await response.json();
			const page = targets.find((target) => target.type === "page");
			if (page !== undefined) return page;
		} catch (error) {
			lastError = error;
		}
		await sleep(125);
	}
	throw new Error(`Chrome 调试端口未就绪：${String(lastError)}`);
}

class Cdp {
	constructor(socketUrl) {
		this.nextId = 0;
		this.pending = new Map();
		this.socket = new WebSocket(socketUrl);
		this.ready = new Promise((resolveReady, rejectReady) => {
			this.socket.addEventListener("open", resolveReady);
			this.socket.addEventListener("error", rejectReady);
		});
		this.socket.addEventListener("message", (event) => {
			const message = JSON.parse(event.data);
			if (message.id !== undefined && this.pending.has(message.id)) {
				const { resolve: resolveCall, reject: rejectCall } = this.pending.get(message.id);
				this.pending.delete(message.id);
				if (message.error !== undefined) rejectCall(new Error(message.error.message));
				else resolveCall(message.result);
				return;
			}
			if (message.method === "Runtime.consoleAPICalled") {
				const text = message.params.args
					.map((item) => item.value ?? item.description ?? item.type)
					.join(" ");
				consoleMessages.push({ type: message.params.type, text });
			}
			if (message.method === "Runtime.exceptionThrown") {
				const details = message.params.exceptionDetails;
				consoleMessages.push({
					type: "exception",
					text: details.exception?.description ?? details.text ?? "异常",
				});
			}
		});
	}

	async send(method, params = {}) {
		await this.ready;
		const id = (this.nextId += 1);
		return new Promise((resolveCall, rejectCall) => {
			this.pending.set(id, { resolve: resolveCall, reject: rejectCall });
			this.socket.send(JSON.stringify({ id, method, params }));
		});
	}

	close() {
		try {
			this.socket.close();
		} catch {
			/* 已关闭 */
		}
	}
}

function parseSize(raw) {
	const [width, height] = raw.toLowerCase().split("x").map(Number);
	if (!Number.isFinite(width) || !Number.isFinite(height)) {
		throw new Error(`尺寸格式不对：${raw}`);
	}
	return { width, height };
}

async function evaluate(cdp, expression) {
	const result = await cdp.send("Runtime.evaluate", {
		expression,
		awaitPromise: true,
		returnByValue: true,
	});
	if (result.exceptionDetails !== undefined) {
		throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
	}
	return result.result?.value;
}

async function waitFor(cdp, selector, timeoutMs = 8000) {
	const startedAt = Date.now();
	while (Date.now() - startedAt < timeoutMs) {
		const found = await evaluate(
			cdp,
			`Boolean(document.querySelector(${JSON.stringify(selector)}))`,
		).catch(() => false);
		if (found === true) return true;
		await sleep(150);
	}
	return false;
}

async function capture(cdp, path, full, scale) {
	let clip;
	if (full) {
		const metrics = await cdp.send("Page.getLayoutMetrics");
		const size = metrics.cssContentSize ?? metrics.contentSize;
		clip = {
			x: 0,
			y: 0,
			width: Math.ceil(size.width),
			height: Math.ceil(size.height),
			scale: 1,
		};
	}
	const shot = await cdp.send("Page.captureScreenshot", {
		format: "png",
		fromSurface: true,
		captureBeyondViewport: full,
		...(clip === undefined ? {} : { clip }),
	});
	await writeFile(path, Buffer.from(shot.data, "base64"));
	return path;
}

async function runAction(cdp, action, context) {
	const separator = action.indexOf(":");
	const verb = separator === -1 ? action : action.slice(0, separator);
	const value = separator === -1 ? "" : action.slice(separator + 1);
	switch (verb) {
		case "wait":
			await sleep(Number(value));
			return;
		case "click": {
			const clicked = await evaluate(
				cdp,
				`(() => { const el = document.querySelector(${JSON.stringify(value)}); if (!el) return false; el.scrollIntoView({block:"center"}); el.click(); return true; })()`,
			);
			if (clicked !== true) throw new Error(`click 找不到元素：${value}`);
			await sleep(350);
			return;
		}
		case "hover": {
			const box = await evaluate(
				cdp,
				`(() => { const el = document.querySelector(${JSON.stringify(value)}); if (!el) return null; el.scrollIntoView({block:"center"}); const r = el.getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2}; })()`,
			);
			if (box === null) throw new Error(`hover 找不到元素：${value}`);
			await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: box.x, y: box.y });
			await sleep(250);
			return;
		}
		case "press":
			for (const key of value.split("+")) await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key });
			await sleep(150);
			return;
		case "scroll": {
			if (Number.isFinite(Number(value))) {
				await evaluate(cdp, `window.scrollTo(0, ${Number(value)})`);
			} else {
				await evaluate(
					cdp,
					`document.querySelector(${JSON.stringify(value)})?.scrollIntoView({block:"start"})`,
				);
			}
			await sleep(300);
			return;
		}
		case "eval":
			await evaluate(cdp, value);
			return;
		case "shot": {
			const path = join(context.outDir, `${context.name}-${context.sizeLabel}-${value || "shot"}.png`);
			await capture(cdp, path, options.full, options.scale);
			context.saved.push(path);
			return;
		}
		default:
			throw new Error(`未知动作：${action}`);
	}
}

const outDir = resolve(options.out);
await mkdir(outDir, { recursive: true });

const page = await waitForDevtools();
const cdp = new Cdp(page.webSocketDebuggerUrl);
await cdp.send("Page.enable");
await cdp.send("Runtime.enable");
await cdp.send("Log.enable").catch(() => undefined);

const saved = [];
try {
	for (const rawSize of options.sizes) {
		const { width, height } = parseSize(rawSize);
		const sizeLabel = `${width}x${height}`;
		consoleMessages.length = 0;

		await cdp.send("Emulation.setDeviceMetricsOverride", {
			width,
			height,
			deviceScaleFactor: options.scale,
			mobile: options.mobile,
			screenWidth: width,
			screenHeight: height,
		});
		if (options.mobile) {
			await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
		}
		if (options.colorScheme !== "") {
			await cdp.send("Emulation.setEmulatedMedia", {
				features: [{ name: "prefers-color-scheme", value: options.colorScheme }],
			});
		}
		await cdp.send("Page.navigate", { url: options.url });
		await sleep(500);
		if (options.ready) await waitFor(cdp, options.ready);
		await sleep(options.wait);

		for (const expression of options.evals) await evaluate(cdp, expression);
		if (options.evals.length > 0) await sleep(250);

		const context = { outDir, name: options.name, sizeLabel, saved };
		for (const action of options.actions) await runAction(cdp, action, context);

		if (options.actions.every((action) => !action.startsWith("shot:"))) {
			const path = join(outDir, `${options.name}-${sizeLabel}.png`);
			await capture(cdp, path, options.full, options.scale);
			saved.push(path);
		}

		const errors = consoleMessages.filter(
			(message) => message.type === "error" || message.type === "exception",
		);
		if (errors.length > 0) {
			console.error(`\n[${sizeLabel}] 页面错误 ${errors.length} 条`);
			for (const message of errors.slice(0, 12)) console.error(`  - ${message.text}`);
		} else {
			console.log(`[${sizeLabel}] 无页面错误`);
		}
		if (options.console) {
			for (const message of consoleMessages) console.log(`  ${message.type}: ${message.text}`);
		}

		const summary = await evaluate(
			cdp,
			`({
				scrollWidth: document.documentElement.scrollWidth,
				clientWidth: document.documentElement.clientWidth,
				scrollHeight: document.documentElement.scrollHeight,
				chat: document.querySelector('.chat')?.getBoundingClientRect().width ?? 0,
				nodes: document.querySelectorAll('[data-conv]').length,
				edges: document.querySelectorAll('.edge').length,
			})`,
		);
		const overflow = summary.scrollWidth > summary.clientWidth + 1;
		console.log(
			`[${sizeLabel}] 页面 ${summary.scrollWidth}x${summary.scrollHeight} · 聊天 ${Math.round(summary.chat)}px · 节点 ${summary.nodes} · 连线 ${summary.edges}${overflow ? " · 横向溢出" : ""}`,
		);
		if (overflow) console.error("  横向溢出：页面比视口宽，移动端会出现横向滚动");
	}

	console.log(`\n截图 ${saved.length} 张：`);
	for (const path of saved) console.log(`  ${path}`);
} finally {
	cdp.close();
	if (!options.keepOpen) chrome.kill();
}
