/**
 * 发布验收：真起一个 Solo，**真点一条引用**，看跳过去落在哪、以及两秒后还在不在那儿。
 *
 * 为什么必须真机点（Solo 2026-11-15 定的）：`focusScrollTop()` / `keepAnchor()` 单测能验算式，
 * 验不到「补历史那一帧真把锚点换成了焦点行」—— 那条只有真窗口里补一次页才现原形，而它正是
 * 这个功能的命门（跳过去、两秒后飘走）。
 *
 * 走的是哪条路：界面上 `goToSeq()` 只有一个入口是**真能点到的**——消息里的引用
 * （任务看板那入口还没挂进界面：接口没实现，Solo #2580 定的不挂假数据）。两条路共用
 * `goToSeq()`，所以这条点得到，落点与锚点就验得到。
 *
 * 做法：
 * 1. 直跑二进制，带 `--remote-debugging-port`；`HOME=` 和 `--user-data-dir=` 都指临时目录
 *    （只带 `HOME=` 挡不住 Electron 的 userData，会写进真实库）。
 * 2. 在页面里用同源 `fetch` **造一个自己的频道**：200 条消息，最后一条引用第 100 条
 *    （`--anchor-index`）。首屏最多 40 条（`PAGE_MAX`），200 条里首屏只给最后 60 条，
 *    所以第 100 条必然在窗口外 —— 点它必然要补历史，这一步就是「故意让补历史发生一次」。
 *    为什么不是第 1 条：第 1 条上面什么都没有，35% 的落点会被夹到 0（滚到最顶），
 *    验不出落点算得准不准，只能验出「它到顶了」。
 *    发这条引用之前要先 `GET ?around=` 把服务端窗口挪到目标附近 —— `messageView()` 是在
 *    `state.messages[频道]` 里找 `replyTo` 的，找不到就把引用整个丢掉、消息退化成普通一句。
 * 3. 点之前断言目标不在 DOM（否则这次跳转根本没跨窗口，不算验过）。
 * 4. 点 `[data-jump-seq]` 那个引用 → 等 `[data-seq="第 1 条"]` 出现。
 * 5. 落点：行顶应在 **35% 视口高**（±24px，行高按估的）。
 * 6. 每一百毫秒读一次焦点行相对视口的位置，读满 2.3 秒：2 秒那点和 2.3 秒那点差 ≤3px
 *    （慢性漂移），整段极差 ≤8px（补页落定那一跳）。
 * 7. 再把滚动条拖到最顶，让补历史真发生一次：视口首行在**逐帧**采样里不许被推走
 *    （固定间隔的数字不作数，会抓到中间帧误判）。补没补上认「窗口里最早那条的 seq 变小了」，
 *    **不数 DOM 行数** —— 行是虚拟化的，视口一矮窗口条数恒定，补页发生时行数也不变。
 *
 * 原生对话框由 `SOLO_VERIFY_NO_DIALOG=1` 关掉（本脚本自己设的，runner 上没人点）。
 * 用法：node scripts/verify-focus-jump.mjs --app <二进制> --out <目录> [--project <项目路径>]
 *   `--project` 给的是**没打包**的跑法：`electron <项目路径>`（脚本会把项目路径当第一个参数传）。
 *   **`--project` 跑之前必须先 `npm run ui:build`**：界面加载的是被 git 跟踪的 `ui/web` 产物，
 *   不 build 就是仓库里那份旧的，上面根本没有 `data-jump-seq`，脚本只会一直说「找不到引用」
 *   ——2026-11-15 在这上面白跑了几轮。
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
	console.error("用法：node scripts/verify-focus-jump.mjs --app <二进制> --out <目录> [--project <项目路径>] [--port 9333]");
	process.exit(2);
}
/** 没打包跑法（`--app` 指 electron 二进制、`--project` 指仓库根）。 */
const project = args.get("--project");
const port = Number(args.get("--port") ?? "9333");
const bootTimeout = Number(args.get("--boot-timeout") ?? "180000");
/** 造多少条消息：首屏上限 40，90 条保证第 1 条落在窗口外。 */
const count = Number(args.get("--count") ?? "200");
/** 跳过去之后看多久：2 秒是 Solo 定的点，多给 300ms 用来做第二次连读。 */
const watchMs = Number(args.get("--watch") ?? "2300");
const sampleGap = 100;
/** 落点容差：行高是估的 + 补偿会修几像素，24px 以内就不算「没跳到位」。 */
const arrivalTolerance = Number(args.get("--tolerance") ?? "24");
/** 慢性漂移的上限。 */
const driftTolerance = 3;
/** 中途一跳（补页落定）的上限。 */
const spreadTolerance = 8;
/** 落点在视口高度的这个比例上（和 `focusScrollTop()` 对齐；实现改了这里就该红）。 */
const anchorRatio = 0.35;
/**
 * 群名带时间戳：`--project` 跑法用的是 `tmpdir()/solo-desktop-dev-userdata`，
 * 那个 SQLite 是**跨次保留**的，固定名字第二次跑会撞「已经有叫这个的群了」。
 */
const channelTitle = `验收-跳回起源-${String(Date.now())}`;
/**
 * 引用的目标：第几条消息。
 *
 * 要同时满足两件事 —— 目标在首屏窗口外（才会触发补历史）、目标上方还有 ≥35% 视口高的内容
 * （才验得到落点，而不是被夹到最顶）。20 条 × 每行几十像素，离顶部够远。
 */
const anchorIndex = Number(args.get("--anchor-index") ?? "100");

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

await mkdir(outDir, { recursive: true });
const scratch = await mkdtemp(join(tmpdir(), "solo-verify-focus-"));
const home = join(scratch, "home");
const userData = join(scratch, "userdata");
await mkdir(home, { recursive: true });
await mkdir(userData, { recursive: true });
// 一只模型都没有时首屏是整屏引导，没有左边栏就没有频道列表。占位模型只为跳过引导，
// 地址指向没人听的端口，永远不会真发请求（和 `verify-update-click.mjs` 同一招）。
//
// 写哪儿有讲究：**没打包**跑（`--project`）时 `desktop/src/main.ts` 会把 userData 改到
// `tmpdir()/solo-desktop-dev-userdata`（`--user-data-dir` 被它覆盖掉），所以占位必须写到那儿，
// 否则界面停在首屏引导，脚本只会说「没等到左边栏」。
const settingsDir = project === undefined ? userData : join(tmpdir(), "solo-desktop-dev-userdata");
await mkdir(settingsDir, { recursive: true });
await writeFile(
	join(settingsDir, "settings.json"),
	`${JSON.stringify(
		{
			defaultModel: "verify/placeholder",
			providers: [
				{
					id: "verify",
					name: "验收占位（不会真发请求）",
					baseUrl: "http://127.0.0.1:9/v1",
					apiKey: "verify",
					models: [{ id: "placeholder" }],
				},
			],
		},
		null,
		2,
	)}\n`,
);

const logs = [];
const notes = [];
const note = (line) => {
	notes.push(line);
	console.log(line);
};

const spawnArgs = [
	...(project === undefined ? [] : [project]),
	`--remote-debugging-port=${port}`,
	`--user-data-dir=${userData}`,
];
// `ELECTRON_RUN_AS_NODE`：有的环境（开发机上的工具链、某些 CI 镜像）会带着它，
// 一带上 Electron 就变成「拿 node 跑 main.js」，起不来窗口，报的还是 `electron` 模块
// 少导出的怪错。验收要的是真窗口，所以这里明确摘掉。
const env = { ...process.env, HOME: home, SOLO_VERIFY_NO_DIALOG: "1" };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(appPath, spawnArgs, { env, stdio: ["ignore", "pipe", "pipe"] });
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

class Cdp {
	constructor(socket) {
		this.socket = socket;
		this.next = 0;
		this.pending = new Map();
		/** 不是请求响应的事件（渲染进程抛的错、console） —— 失败时打出来，不然只能瞎猜。 */
		this.events = [];
		socket.addEventListener("message", (event) => {
			const message = JSON.parse(event.data);
			if (message.id === undefined) {
				this.events.push(message);
				if (this.events.length > 300) this.events.shift();
				return;
			}
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

/** 主窗口和悬浮球都是 page：找有左边栏（设置那颗按钮）的那个。 */
async function findMain(deadline) {
	let report = [];
	while (Date.now() < deadline) {
		const list = await targets();
		report = [];
		for (const target of list) {
			let cdp;
			try {
				cdp = await Cdp.open(target.webSocketDebuggerUrl);
				await cdp.send("Runtime.enable");
				await cdp.send("Page.enable");
				const info = await cdp.evaluate(`(() => ({
					url: location.href,
					ready: document.readyState,
					rail: document.querySelector('[aria-label="设置"]') !== null,
					setup: document.querySelector('#page-setup') !== null,
					text: (document.body === null ? "" : document.body.innerText).slice(0, 600),
				}))()`);
				report.push({ url: target.url, info });
				if (info?.rail === true) return { cdp, report };
			} catch (error) {
				report.push({ url: target.url, info: { error: String(error) } });
			}
			if (cdp !== undefined) cdp.close();
		}
		if (exited) break;
		await sleep(500);
	}
	return { cdp: undefined, report };
}

async function dumpPages(report) {
	const blocks = report.map((one) =>
		[
			`url: ${String(one.url)}`,
			`readyState: ${String(one.info?.ready ?? "")}`,
			`有左边栏: ${one.info?.rail === true ? "是" : "不是"}`,
			`是引导页: ${one.info?.setup === true ? "是" : "不是"}`,
			one.info?.error === undefined ? "" : `出错: ${String(one.info.error)}`,
			"正文：",
			String(one.info?.text ?? ""),
		].join("\n"),
	);
	await writeFile(join(outDir, "pages.txt"), `${blocks.join("\n\n----\n\n")}\n`);
}

// ---- 跑 ----

const bootDeadline = Date.now() + bootTimeout;
const { cdp, report } = await findMain(bootDeadline);
if (cdp === undefined) {
	await dumpPages(report);
	await fail(`${String(bootTimeout)}ms 内没等到带左边栏的主窗口（见 pages.txt）`);
}
note("已连上渲染进程");

/**
 * 在页面里造数据：建一个只有自己的频道，第 1 条 + 后续 count-1 条 + 最后一条引用第 1 条。
 *
 * 全部走同源 `fetch`（和界面用的是同一个后端），不碰任何真实库：这个实例的 userData
 * 是临时目录，`HOME` 也是临时目录。
 */
const seeded = await cdp.evaluate(`(async () => {
	const post = async (path, body) => {
		const response = await fetch(path, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
		});
		if (!response.ok) throw new Error(path + " → " + String(response.status) + " " + (await response.text()).slice(0, 300));
		return response.json();
	};
	// 群至少要有两个人（你 + 一个成员），所以先看组织里有谁。挑一个非助理：
	// 助理带着一整套提示词，回起话来动静大；反正模型是占位（连不上），谁都不会真回。
	const org = await (await fetch("/api/org")).json();
	const people = Array.isArray(org.people) ? org.people : [];
	const mate = people.find((one) => one.assistant !== true && one.slug !== "you") ?? people[0];
	if (mate === undefined) throw new Error("组织里一个人都没有，建不了群");
	const made = await post("/api/channels", { title: ${JSON.stringify(channelTitle)}, members: [mate.slug] });
	const id = made.id;
	await post("/api/channels/" + encodeURIComponent(id) + "/messages", { text: "验收第 1 条" });
	const firstPage = await (await fetch("/api/channels/" + encodeURIComponent(id) + "?limit=5")).json();
	const first = firstPage.messages.find((one) => one.text === "验收第 1 条");
	if (first === undefined) throw new Error("第 1 条没进库：" + JSON.stringify(firstPage.messages.map((one) => one.text)));
	// 目标那条的 seq：发到它的时候它就是最新的，顺手读回来（最后一条引用它）。
	const targetIndex = ${String(anchorIndex)};
	let anchorSeq = null;
	for (let index = 2; index <= ${String(count)}; index += 1) {
		await post("/api/channels/" + encodeURIComponent(id) + "/messages", { text: "验收第 " + String(index) + " 条" });
		if (index === targetIndex) {
			const page = await (await fetch("/api/channels/" + encodeURIComponent(id) + "?limit=5")).json();
			anchorSeq = (page.messages.find((one) => one.text === "验收第 " + String(index) + " 条") ?? {}).seq ?? null;
		}
	}
	if (anchorSeq === null) throw new Error("没拿到第 " + String(targetIndex) + " 条的 seq");
	// 引用能不能渲染出来，取决于服务端窗口里有没有那条：messageView() 是在
	// state.messages[频道] 里找 replyTo 的（src/app/project.ts:179），找不到就把
	// replyTo 整个丢掉，消息退化成普通一句。这里先把窗口挪到目标附近再说引用
	// —— 少了这一步，界面上根本没有可点的引用（2026-11-15 本地就是栽在这里）。
	await fetch("/api/channels/" + encodeURIComponent(id) + "?around=" + String(anchorSeq) + "&limit=60");
	await post("/api/channels/" + encodeURIComponent(id) + "/messages", { text: "验收：引用第 " + String(targetIndex) + " 条", replyTo: anchorSeq });
	return { id, anchorSeq, targetIndex, mate: mate.slug, total: ${String(count)} + 1 };
})()`).catch(async (error) => {
	await fail(`造数据失败：${String(error)}`);
});
const channelId = String(seeded?.id ?? "");
const seq1 = Number(seeded?.anchorSeq ?? 0);
if (channelId === "" || !Number.isFinite(seq1) || seq1 <= 0) await fail(`造数据没拿到 id/seq：${JSON.stringify(seeded)}`);
note(`造好频道 ${channelId}：${String(count)} 条 + 1 条引用，引用的是第 ${String(anchorIndex)} 条（seq=${String(seq1)}）`);

// 重新加载一次，让左边栏把新频道拉进来（不然列表里没有它，点不到）。
await cdp.send("Page.reload");
await sleep(500);
let opened = false;
const openDeadline = Date.now() + 60_000;
while (!opened && Date.now() < openDeadline) {
	opened =
		(await cdp
			.evaluate(`(() => {
				const row = document.querySelector('[data-channel="${channelId}"]');
				if (row === null) return false;
				row.click();
				return true;
			})()`)
			.catch(() => false)) === true;
	if (!opened) await sleep(300);
}
if (!opened) {
	const text = await cdp.evaluate("document.body.innerText.slice(0, 3000)").catch(() => "");
	await writeFile(join(outDir, "body-text.txt"), String(text));
	await fail("左边栏里点不到验收频道（[data-channel=...] 没出现）");
}
note("已打开验收频道");

/** 等 `.feed` 里出现引用，且目标不在这一屏里。 */
let before = null;
const readyDeadline = Date.now() + 60_000;
while (Date.now() < readyDeadline) {
	before = await cdp.evaluate(`(() => {
		const flow = document.querySelector("#flow");
		const feed = document.querySelector("#feed");
		if (flow === null || feed === null) return { waiting: true };
		const quote = feed.querySelector('[data-jump-seq="${String(seq1)}"]');
		const target = feed.querySelector('[data-seq="${String(seq1)}"]');
		// 引用是窗口里最后一条。看不到它通常是「进频道后没落到最底」—— 行是虚拟化的，
		// 窗口停在上面时最后那条根本不在 DOM 里。这里主动滚到底再看（读到就不动，幂等）。
		if (quote === null) flow.scrollTop = flow.scrollHeight;
		return {
			waiting: false,
			rows: feed.querySelectorAll("[data-seq]").length,
			hasQuote: quote !== null,
			hasTarget: target !== null,
			quoteText: quote === null ? "" : (quote.textContent ?? "").slice(0, 80),
			scrollTop: Math.round(flow.scrollTop),
			viewport: flow.clientHeight,
		};
	})()`).catch(() => ({ waiting: true }));
	if (before?.waiting === false && before.hasQuote === true && before.rows > 0) break;
	await sleep(300);
}
if (before?.hasQuote !== true) {
	await fail(`这一屏里找不到指向第 ${String(anchorIndex)} 条（seq=${String(seq1)}）的引用：${JSON.stringify(before)}`);
}
if (before.hasTarget === true) {
	await fail(`第 1 条本来就在这一屏里（${String(before.rows)} 行）—— 这次跳转没跨窗口，验不到补历史；把 --count 调大`);
}
note(`点之前：这一屏 ${String(before.rows)} 行、目标不在里面（引用文字「${String(before.quoteText)}」），视口 ${String(before.viewport)}px`);

await cdp.evaluate(`(() => {
	window.__hit = 0;
	const one = document.querySelector('[data-jump-seq="${String(seq1)}"]');
	if (one !== null) one.addEventListener("click", () => { window.__hit += 1; }, true);
	return one !== null;
})()`);

/**
 * 点下去 —— **不用 `el.click()`，用真的鼠标事件打在坐标上**。
 *
 * `el.click()` 能过、真人点不到的情况我们踩过：元素被别的层盖着、宽度是 0、滚在视口外，
 * 合成点击一律照过。所以这里先问 `elementFromPoint` 那个点上到底是谁，再用 CDP 的
 * `Input.dispatchMouseEvent` 按下抬起，和真人点击走同一条路。
 */
await cdp.send("Page.bringToFront").catch(() => undefined);
const spot = await cdp.evaluate(`(() => {
	const one = document.querySelector('#feed [data-jump-seq="${String(seq1)}"]');
	if (one === null) return null;
	one.scrollIntoView({ block: "nearest" });
	const box = one.getBoundingClientRect();
	const x = Math.round(box.left + box.width / 2);
	const y = Math.round(box.top + box.height / 2);
	const hit = document.elementFromPoint(x, y);
	return {
		x,
		y,
		width: Math.round(box.width),
		height: Math.round(box.height),
		reachable: hit !== null && (one === hit || one.contains(hit)),
		hit: hit === null ? null : hit.tagName + "." + String(hit.className),
	};
})()`);
if (spot === null) await fail("页面上找不到那颗引用按钮");
if (spot.width === 0 || spot.height === 0) await fail(`那颗引用按钮没有面积（${String(spot.width)}×${String(spot.height)}），真人点不到`);
if (spot.reachable !== true) await fail(`那颗引用按钮的中心点被挡住了：那个点上是 ${String(spot.hit)}`);
for (const type of ["mousePressed", "mouseReleased"]) {
	await cdp.send("Input.dispatchMouseEvent", { type, x: spot.x, y: spot.y, button: "left", clickCount: 1 });
}
const hitOnce = await cdp.evaluate("(() => window.__hit ?? 0)()");
if (hitOnce < 1) await fail("鼠标事件打上去了，但没落到那颗按钮上");

/** 读焦点行相对 `.flow` 顶的位置（不在 DOM 里 = null）。 */
const readFocus = () =>
	cdp.evaluate(`(() => {
		const flow = document.querySelector("#flow");
		const row = document.querySelector('#feed [data-seq="${String(seq1)}"]');
		if (flow === null || row === null) return null;
		return {
			top: Math.round(row.getBoundingClientRect().top - flow.getBoundingClientRect().top),
			viewport: flow.clientHeight,
			rows: document.querySelectorAll("#feed [data-seq]").length,
			scrollTop: Math.round(flow.scrollTop),
		};
	})()`);

/** 等目标出现（补历史要几趟往返）。 */
const arriveDeadline = Date.now() + 30_000;
let arrived = null;
/** 点击之后界面到底动没动：每 200ms 记一条，超时的时候就是全部证据。 */
const trace = [];
while (Date.now() < arriveDeadline) {
	arrived = await readFocus();
	if (arrived !== null) break;
	if (trace.length < 80) {
		const state = await cdp.evaluate(`(() => ({
			rows: document.querySelectorAll("#feed [data-seq]").length,
			scrollTop: Math.round(document.querySelector("#flow")?.scrollTop ?? -1),
			scrollHeight: Math.round(document.querySelector("#flow")?.scrollHeight ?? -1),
			top: document.querySelector('#feed [data-seq]') === null ? null : Math.round(document.querySelector('#feed [data-seq]').getBoundingClientRect().top),
		}))()`);
		const before = trace[trace.length - 1];
		if (before === undefined || JSON.stringify(before.state) !== JSON.stringify(state)) {
			trace.push({ at: Date.now() - (arriveDeadline - 30_000), state });
		}
	}
	await sleep(100);
}
if (arrived === null) {
	const bad = cdp.events
		.filter((one) => one.method === "Runtime.exceptionThrown" || one.method === "Runtime.consoleAPICalled")
		.map((one) => {
			const text = one.params?.exceptionDetails?.exception?.description ?? JSON.stringify(one.params?.args ?? one.params);
			return `${String(one.method)}: ${String(text).slice(0, 400)}`;
		});
	await fail(
		[
			"点了引用，30 秒内目标行都没出现在 DOM 里（补历史没补上 / 跳转没发生）",
			`界面轨迹（变化才记）：${JSON.stringify(trace)}`,
			`点后发出的请求：${JSON.stringify(await cdp.evaluate("(() => (window.__req ?? []).slice(-20))()").catch(() => []))}`,
			`点击到达元素次数：${String(await cdp.evaluate("(() => window.__hit ?? 0)()").catch(() => "读不到"))}`,
			`那颗按钮：${String(await cdp.evaluate(`(() => document.querySelector('[data-jump-seq="${String(seq1)}"]')?.outerHTML.slice(0, 240) ?? "找不到")()`).catch(() => "读不到"))}`,
			bad.length === 0 ? "渲染进程没报错" : `渲染进程报错：\n${bad.join("\n")}`,
		].join("\n"),
	);
}
note(`跳到了：top=${String(arrived.top)}px，这一屏 ${String(arrived.rows)} 行（点之前 ${String(before.rows)} 行 → 补历史确实发生了）`);

/** 之后每 100ms 读一次，读满 watchMs。 */
const samples = [{ at: 0, top: arrived.top, scrollTop: arrived.scrollTop }];
const startedAt = Date.now();
while (Date.now() - startedAt < watchMs) {
	await sleep(sampleGap);
	const now = await readFocus();
	samples.push({ at: Date.now() - startedAt, top: now === null ? null : now.top, scrollTop: now === null ? null : now.scrollTop });
}
const tops = samples.filter((one) => typeof one.top === "number").map((one) => one.top);
const viewport = arrived.viewport;
const expected = Math.round(viewport * anchorRatio);
const offBy = Math.abs(arrived.top - expected);
const spread = tops.length === 0 ? 0 : Math.max(...tops) - Math.min(...tops);
/** 2 秒那一点和 2.3 秒那一点（「隔 2 秒连读两次」）。 */
const nearTwo = samples.filter((one) => one.at >= 2000);
const drift = nearTwo.length < 2 ? 0 : Math.max(...nearTwo.map((one) => one.top)) - Math.min(...nearTwo.map((one) => one.top));
const stillThere = tops.length > 0 && tops[tops.length - 1] !== null;

/**
 * 第二段：跳过去之后**再故意让补历史发生一次**，看锚点有没有换手。
 *
 * 做法是人真的会做的那个动作 —— 把滚动条拖到最顶，触发「加载更早」。上面的行插进来时，
 * 如果补偿没接上、锚点被换回「视口首行」，视口里那行就会往下掉一截（看着像自己跳了下）。
 * 判据：滚到顶那一刻视口里第一行记为锚点，之后它相对视口的位置不许动超过 3px。
 */
await cdp.evaluate(`(() => {
	const flow = document.querySelector("#flow");
	if (flow === null) return false;
	flow.scrollTop = 0;
	return true;
})()`);
const anchorKey = await cdp.evaluate(`(() => {
	const flow = document.querySelector("#flow");
	if (flow === null) return null;
	const flowTop = flow.getBoundingClientRect().top;
	const first = [...document.querySelectorAll("#feed [data-row-key]")].find(
		(one) => one.getBoundingClientRect().bottom > flowTop + 1,
	);
	return first === undefined ? null : first.getAttribute("data-row-key");
})()`);
if (anchorKey === null) await fail("滚到顶之后找不到视口里第一行，锚点这半段验不了");
/**
 * 采样按**帧**来，不按 100ms。
 *
 * 100ms 一次会漏掉「只错位一帧」的情况，也会把「一帧都没错位但采样点踩在中间」误判成跳。
 * 这里在页面里挂一个 rAF 循环，每一帧记一次，最后数「有几帧是错的」——
 * 用户看到的闪动就是帧，不是毫秒。
 */
await cdp.evaluate(`(() => {
	window.__anchorLog = [];
	const key = ${JSON.stringify(String(anchorKey))};
	const tick = () => {
		const flow = document.querySelector("#flow");
		const rows = [...document.querySelectorAll("#feed [data-row-key]")];
		const row = rows.find((one) => one.getAttribute("data-row-key") === key);
		if (flow !== null) {
			window.__anchorLog.push({
				top: row === undefined ? null : Math.round(row.getBoundingClientRect().top - flow.getBoundingClientRect().top),
				rows: document.querySelectorAll("#feed [data-seq]").length,
				minSeq: document.querySelector("#feed [data-seq]") === null
					? null
					: Math.min(...[...document.querySelectorAll("#feed [data-seq]")].map((one) => Number(one.getAttribute("data-seq")))),
				scrollTop: Math.round(flow.scrollTop),
			});
		}
		if (window.__anchorLog.length < 160) requestAnimationFrame(tick);
	};
	requestAnimationFrame(tick);
	return true;
})()`);
await sleep(3000);
const anchorSamples = await cdp.evaluate("(() => (window.__anchorLog ?? []))()");
if (anchorSamples.length === 0) await fail("一帧都没采到，锚点这半段验不了");
const seen = anchorSamples.map((one) => one.top).filter((one) => one !== null);
const base = seen.length === 0 ? 0 : seen[Math.floor(seen.length / 2)];
const anchorMoved = seen.length === 0 ? 0 : Math.max(...seen.map((one) => Math.abs(one - base)));
/** 错位超过 3px 的帧数：允许 1 帧（补页那一帧浏览器合成可能还没跟上），再多就是人眼看得见的闪。 */
const badFrames = seen.filter((one) => Math.abs(one - base) > 3).length;
/**
 * 「更早的历史真补进来了」不数行数：视口一矮，虚拟化的窗口也跟着窄，补回来的行不一定都进
 * DOM —— CI 上就是行数一直 60、其实补页发生了（2026-11-15 那趟红在这）。认窗口里最早那条
 * 的 `seq` 变小，跟虚拟化没关系。
 */
const firstSeq = anchorSamples[0]?.minSeq ?? null;
const laterSeq = anchorSamples.map((one) => one.minSeq).filter((one) => one !== null);
const earliestSeq = laterSeq.length === 0 ? null : Math.min(...laterSeq);
const rowsGrew = firstSeq !== null && earliestSeq !== null && earliestSeq < firstSeq;
if (!rowsGrew) {
	const scrollTrace = anchorSamples.map((one) => one.scrollTop);
	await fail(
		`滚到最顶之后没补进来更早的历史（最早那条一直是 seq=${String(firstSeq)}，${String(anchorSamples[0]?.rows ?? 0)} 行），锚点这半段验不到。` +
			`诊断：${String(anchorSamples.length)} 帧、scrollTop 从 ${String(scrollTrace[0])} 走到 ${String(scrollTrace.at(-1))}、` +
			`最小值 ${String(Math.min(...scrollTrace))}、引用还在不在这屏 ${String(seen.length)} 帧有值`,
	);
}
if (badFrames > 1) {
	await fail(
		`补历史插到上面时，视口里原来那行有 ${String(badFrames)} 帧被推走了（最多 1 帧），最大偏 ${String(anchorMoved)}px —— 锚点换手了：${JSON.stringify(seen.slice(0, 40))}`,
	);
}

const shot = await cdp.send("Page.captureScreenshot", { format: "png" }).catch(() => undefined);
if (shot?.data !== undefined) {
	await writeFile(join(outDir, "focus-after.png"), Buffer.from(shot.data, "base64"));
	note("截图已存 focus-after.png");
}

const evidence = {
	channelId,
	seq1,
	viewport,
	expectedTop: expected,
	arrivedTop: arrived.top,
	offBy,
	arrivalTolerance,
	rowsBefore: before.rows,
	rowsAfter: arrived.rows,
	scrollTopBefore: before.scrollTop,
	scrollTopAfter: arrived.scrollTop,
	spread,
	spreadTolerance,
	drift,
	driftTolerance,
	anchorKey,
	anchorMoved,
	anchorFrames: seen.length,
	anchorBadFrames: badFrames,
	anchorRows: anchorSamples.map((one) => one.rows).slice(0, 160),
	samples,
	stillThere,
	screenshot: shot?.data === undefined ? null : "focus-after.png",
};
await writeFile(join(outDir, "focus-jump.json"), `${JSON.stringify(evidence, null, 2)}\n`);
await saveLog();

if (arrived.scrollTop === 0) {
	await fail(
		`滚到了最顶（scrollTop=0），目标行落在 ${String(arrived.top)}px —— 说明它上面没有 35% 视口高的内容，落点被夹住了，这一轮验不出准不准。把 --anchor-index 调大`,
	);
}
if (offBy > arrivalTolerance) {
	await fail(`落点不对：视口 ${String(viewport)}px，应在 ${String(expected)}px 附近（35%），实际 ${String(arrived.top)}px，偏 ${String(offBy)}px`);
}
if (!stillThere) await fail("两秒之后那一行不见了（被回收 / 被换掉）");
if (spread > spreadTolerance) {
	await fail(`两秒多里焦点行相对视口跳了 ${String(spread)}px（上限 ${String(spreadTolerance)}px）—— 补页落定那一帧有人把锚点换回了「视口首行」：${JSON.stringify(tops)}`);
}
if (drift > driftTolerance) {
	await fail(`2 秒后连读两次差 ${String(drift)}px（上限 ${String(driftTolerance)}px）—— 还在慢慢飘：${JSON.stringify(nearTwo)}`);
}

cdp.close();
await stop();
await writeFile(join(outDir, "result.txt"), `通过\n\n${notes.join("\n")}\n`);
note(
	`通过：落在 ${String(arrived.top)}px（目标 ${String(expected)}px），2 秒内极差 ${String(spread)}px，连读差 ${String(drift)}px；` +
		`再补一页历史时 ${String(seen.length)} 帧里错位 ${String(badFrames)} 帧、最大 ${String(anchorMoved)}px` +
		`（窗口里最早那条从 seq=${String(firstSeq)} 补到 seq=${String(earliestSeq)}）`,
);
process.exit(0);
