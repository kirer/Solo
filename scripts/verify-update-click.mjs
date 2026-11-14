/**
 * 发布验收：真起一个打包好的 Solo，在设置页里**真点一下**「检查更新」，读回 `status.at` 有没有变大。
 *
 * 为什么必须真机点：`solo:update-status` 这条线（壳 → preload → 界面那行字）本地单测只能验纯函数，
 * 「点下去壳真去查了、界面真读回来了」只有真窗口点一次才算数（2.9.18 那版就是没人点过）。
 *
 * 做法（Solo 2026-11-12 定的口径）：
 * 1. 直跑二进制，带 `--remote-debugging-port`；`HOME=` 和 `--user-data-dir=` 两样都指临时目录
 *    （只带 `HOME=` 挡不住 Electron 的 userData，会写进真实库）。
 * 2. CDP 连它自己的渲染进程，按 `aria-label="检查更新"` 找到按钮，`.click()`。
 * 3. **隔 20ms 以上**回读 `soloDesktop.updateStatus()`，`at` 变大才算点通了。
 * 4. DOM 文本 + 截图 + 应用日志一起落到 `--out`，给 CI artifact。
 *
 * 壳那边的原生对话框由 `SOLO_VERIFY_NO_DIALOG=1` 关掉（本脚本自己设的）：弹了没人点，
 * 跑测的机器就一直挂着。关框时会 `console.warn` 一行「验证模式不弹框（某一步）：…」，
 * 落进 `app.log`，一并当凭据。
 *
 * **更新源默认指到没人听的本地端口**（`SOLO_UPDATE_URL`，`feed.ts` 允许 http + 本机）：
 * 这让「检查失败」是可复现的 —— 三样证据要的是「点前后 `status.at` 变大 + 界面那行字变成
 * 「检查更新没连上，稍后重试」+ 截图」。指向真 GitHub 的话，查通了那行字是「当前版本 x」，
 * 就验不到这条失败通路（而它正是 2.9.18 修的那个坑）。要验成功那条，传 `--feed` 指真源。
 *
 * 用法：node scripts/verify-update-click.mjs --app <二进制> --out <目录> [--port 9333]
 */
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const args = new Map();
for (let index = 2; index < process.argv.length; index += 2) {
	args.set(process.argv[index], process.argv[index + 1]);
}
const appPath = args.get("--app");
const outDir = args.get("--out");
if (appPath === undefined || outDir === undefined) {
	console.error("用法：node scripts/verify-update-click.mjs --app <二进制> --out <目录> [--port 9333]");
	process.exit(2);
}
const port = Number(args.get("--port") ?? "9333");
/** 冷启动要装 seed、起后端，给足时间；CI 上第一次跑偏慢。 */
const bootTimeout = Number(args.get("--boot-timeout") ?? "180000");
const clickTimeout = Number(args.get("--click-timeout") ?? "45000");
/** 回读间隔：要求「隔 20ms 以上」，留 250ms 余量（界面自己 700ms 轮询一次，读到就行）。 */
const pollGap = Number(args.get("--poll-gap") ?? "250");
/**
 * 更新源：默认指到没人听的本地端口，让「检查失败」每次都发生（见文件头）。
 * `feed.ts` 只认 https 或 http + 本机，所以别指望拿它指到任意内网地址。
 */
const feed = args.get("--feed") ?? "http://127.0.0.1:9/";
/** 失败时界面那行字（`update-failure.ts` 里网络类错误的人话）。 */
const failedLine = "检查更新没连上，稍后重试";

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

await mkdir(outDir, { recursive: true });
const scratch = await mkdtemp(join(tmpdir(), "solo-verify-click-"));
const home = join(scratch, "home");
const userData = join(scratch, "userdata");
await mkdir(home, { recursive: true });
await mkdir(userData, { recursive: true });

const logs = [];
const notes = [];
const note = (line) => {
	notes.push(line);
	console.log(line);
};

const child = spawn(appPath, [`--remote-debugging-port=${port}`, `--user-data-dir=${userData}`], {
	env: { ...process.env, HOME: home, SOLO_UPDATE_URL: feed, SOLO_VERIFY_NO_DIALOG: "1" },
	stdio: ["ignore", "pipe", "pipe"],
});
for (const stream of [child.stdout, child.stderr]) {
	stream.setEncoding("utf8");
	stream.on("data", (chunk) => {
		logs.push(chunk);
	});
}
let exited = false;
child.on("exit", (code, signal) => {
	exited = true;
	logs.push(`\n[verify] 应用退出：code=${String(code)} signal=${String(signal)}\n`);
});

const stop = async () => {
	if (!exited) child.kill("SIGKILL");
	await sleep(200);
};

const saveLog = async () => {
	await writeFile(join(outDir, "app.log"), logs.join(""));
};

const fail = async (reason) => {
	await note(`失败：${reason}`);
	await saveLog();
	await stop();
	await writeFile(join(outDir, "result.txt"), `失败：${reason}\n\n${notes.join("\n")}\n`);
	process.exit(1);
};

// ---- CDP ----

async function targets() {
	try {
		const response = await fetch(`http://127.0.0.1:${String(port)}/json/list`);
		if (!response.ok) return [];
		const list = await response.json();
		return list.filter((one) => one.type === "page" && typeof one.webSocketDebuggerUrl === "string");
	} catch {
		return [];
	}
}

async function waitTargets(deadline) {
	while (Date.now() < deadline) {
		const list = await targets();
		if (list.length > 0) return list;
		if (exited) return [];
		await sleep(300);
	}
	return [];
}

class Cdp {
	constructor(socket) {
		this.socket = socket;
		this.next = 0;
		this.pending = new Map();
		socket.addEventListener("message", (event) => {
			const message = JSON.parse(event.data);
			const waiter = this.pending.get(message.id);
			if (waiter === undefined) return;
			this.pending.delete(message.id);
			if (message.error !== undefined) waiter.reject(new Error(JSON.stringify(message.error)));
			else waiter.resolve(message.result);
		});
	}

	static async open(url) {
		const socket = new WebSocket(url);
		await new Promise((resolve, reject) => {
			socket.addEventListener("open", resolve, { once: true });
			socket.addEventListener("error", () => reject(new Error("CDP 连不上")), { once: true });
		});
		return new Cdp(socket);
	}

	send(method, params = {}) {
		const id = (this.next += 1);
		this.socket.send(JSON.stringify({ id, method, params }));
		return new Promise((resolve, reject) => {
			this.pending.set(id, { resolve, reject });
			setTimeout(() => {
				if (!this.pending.delete(id)) return;
				reject(new Error(`CDP ${method} 没回音`));
			}, 30_000).unref?.();
		});
	}

	/** 在页面里跑一段表达式，取回值（Promise 会等）。 */
	async evaluate(expression) {
		const result = await this.send("Runtime.evaluate", {
			expression,
			awaitPromise: true,
			returnByValue: true,
			userGesture: true,
		});
		if (result.exceptionDetails !== undefined) {
			throw new Error(result.exceptionDetails.exception?.description ?? JSON.stringify(result.exceptionDetails));
		}
		return result.result?.value;
	}

	close() {
		this.socket.close();
	}
}

/** 主窗口和悬浮球是两个 page：挨个问「有没有设置那个按钮」，问到哪个算哪个。 */
async function connectMain(list) {
	for (const target of list) {
		let cdp;
		try {
			cdp = await Cdp.open(target.webSocketDebuggerUrl);
			await cdp.send("Runtime.enable");
			await cdp.send("Page.enable");
			const has = await cdp.evaluate('document.querySelector(\'[aria-label="设置"]\') !== null');
			if (has === true) return cdp;
		} catch {
			// 这个 target 不是主窗口（或者已经没了），试下一个。
		}
		cdp?.close();
	}
	return undefined;
}

// ---- 跑 ----

const bootDeadline = Date.now() + bootTimeout;
const list = await waitTargets(bootDeadline);
if (list.length === 0) await fail(`${String(bootTimeout)}ms 内没等到调试端口 ${String(port)}`);

let cdp;
while (cdp === undefined && Date.now() < bootDeadline) {
	cdp = await connectMain(await targets());
	if (cdp === undefined) await sleep(500);
}
if (cdp === undefined) await fail("连上了调试端口，但没有一个页面里有设置按钮（界面没起来？）");
note(`已连上渲染进程（共 ${String(list.length)} 个 page target）`);

// 打开设置页：点左边栏那颗「设置」（和用户一样点，不直接改 store）。
const opened = await cdp.evaluate(`(() => {
	const button = document.querySelector('[aria-label="设置"]');
	if (button === null) return false;
	button.click();
	return true;
})()`);
if (opened !== true) await fail("点不动设置按钮");

let buttonReady = false;
while (!buttonReady && Date.now() < Date.now() + 20_000) {
	buttonReady = (await cdp.evaluate('document.querySelector(\'[aria-label="检查更新"]\') !== null')) === true;
	if (!buttonReady) await sleep(200);
}
if (!buttonReady) {
	const text = await cdp.evaluate("document.body.innerText.slice(0, 4000)").catch(() => "");
	await writeFile(join(outDir, "body-text.txt"), String(text));
	await fail("设置页里找不到「检查更新」（aria-label=检查更新）");
}

const readStatus = () =>
	cdp.evaluate(`(async () => {
		const bridge = window.soloDesktop;
		if (bridge === undefined || typeof bridge.updateStatus !== "function") return { missing: true };
		const status = await bridge.updateStatus();
		return status ?? null;
	})()`);

const readVersion = () =>
	cdp.evaluate(`(async () => {
		const bridge = window.soloDesktop;
		return bridge === undefined || typeof bridge.version !== "function" ? "" : await bridge.version();
	})()`);

const version = String((await readVersion()) ?? "");
const before = await readStatus();
if (before?.missing === true) await fail("界面里没有 soloDesktop.updateStatus 这条桥（版本太老？）");
note(`点之前：version=${version} status=${JSON.stringify(before)}`);

const clicked = await cdp.evaluate(`(() => {
	const button = document.querySelector('[aria-label="检查更新"]');
	if (button === null) return false;
	button.click();
	return true;
})()`);
if (clicked !== true) await fail("点不动「检查更新」");

const clickedAt = Date.now();
let after = before;
let grew = false;
while (Date.now() - clickedAt < clickTimeout) {
	await sleep(pollGap);
	after = await readStatus();
	const beforeAt = typeof before?.at === "number" ? before.at : -1;
	if (typeof after?.at === "number" && after.at > beforeAt) {
		grew = true;
		break;
	}
}
const waited = Date.now() - clickedAt;

// 界面的轮询是 700ms 一次：`status.at` 变大了不等于那行字已经重画，等它落下来再取证据。
const readDesc = () =>
	cdp.evaluate(`(() => {
		const button = document.querySelector('[aria-label="检查更新"]');
		const row = button === null ? null : button.closest(".set-row");
		const desc = row === null ? null : row.querySelector(".set-desc");
		return desc === null ? null : desc.textContent;
	})()`);
let descShown = "";
const descDeadline = Date.now() + 15_000;
while (Date.now() < descDeadline) {
	descShown = String((await readDesc()) ?? "");
	if (descShown.includes(failedLine)) break;
	await sleep(pollGap);
}

const dom = await cdp.evaluate(`(() => {
	const button = document.querySelector('[aria-label="检查更新"]');
	const row = button === null ? null : button.closest(".set-row");
	if (row === null) return null;
	const desc = row.querySelector(".set-desc");
	return {
		label: row.querySelector(".set-label")?.textContent ?? "",
		desc: desc?.textContent ?? "",
		failed: desc?.getAttribute("data-update-failed") ?? null,
		html: row.outerHTML,
	};
})()`);

await writeFile(join(outDir, "settings-row.html"), String(dom?.html ?? ""));
const shot = await cdp.send("Page.captureScreenshot", { format: "png" }).catch(() => undefined);
if (shot?.data !== undefined) {
	await writeFile(join(outDir, "settings-after.png"), Buffer.from(shot.data, "base64"));
	note("截图已存 settings-after.png");
}

await saveLog();
const verifyLogged = /验证模式不弹框/.test(logs.join(""));
const showedFailureLine = String(dom?.desc ?? "").includes(failedLine);
const evidence = {
	version,
	feed,
	before,
	after,
	waitedMs: waited,
	atGrew: grew,
	failed: after?.ok === false,
	domLine: String(dom?.desc ?? ""),
	showedFailureLine,
	dom,
	verifyModeLogged: verifyLogged,
	screenshot: shot?.data === undefined ? null : "settings-after.png",
};
await writeFile(join(outDir, "update-click.json"), `${JSON.stringify(evidence, null, 2)}\n`);

if (!grew) {
	await fail(
		`点了「检查更新」，${String(clickTimeout)}ms 内 status.at 没变大（点前 ${JSON.stringify(before)}，点后 ${JSON.stringify(after)}）`,
	);
}
if (after?.ok !== false) {
	await fail(`点通了，但 status.ok 不是 false（${JSON.stringify(after)}）—— 更新源没指到坏地址？feed=${feed}`);
}
if (!showedFailureLine) {
	await fail(`界面那行字没变成「${failedLine}」，实际是「${String(dom?.desc ?? "")}」`);
}
if (shot?.data === undefined) await fail("没截到图（Page.captureScreenshot 没回数据）");
note(`界面报的版本：${version === "" ? "（取不到，桥没通？）" : version}`);

note(`点之后：status=${JSON.stringify(after)}（等了 ${String(waited)}ms）`);
note(`界面那行字：「${String(dom?.desc ?? "")}」（data-update-failed=${String(dom?.failed)}，含失败句：${showedFailureLine ? "是" : "不是"}）`);
note(`验证模式关框日志：${verifyLogged ? "有" : "没有（这次检查没触发对话框，不算错）"}`);

cdp.close();
await stop();
await writeFile(join(outDir, "result.txt"), `通过\n\n${notes.join("\n")}\n`);
note("通过：status.at 变大了");
process.exit(0);
