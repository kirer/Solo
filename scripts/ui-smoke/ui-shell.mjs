/**
 * 无头界面验的壳：一份**完全隔离**的后端 + 一个**归自己**的 headless Chrome，给调用者一个 page。
 *
 * 两条硬前提是 2026-11-16 踩出来的，别再犯：
 *
 * ① **两个根都要指到临时目录。** `--user-root` 只隔离组织文件（members/teams/skills/rules），
 *    数据库 `core.sqlite`、附件、插件、提示词、文案都在 `appRoot` 里 —— 只改一个就等于
 *    读写别人的库（那次拿仓库 `./.solo-app` 当 appRoot，写进去还顺手回收了 12 条记录）。
 *
 * ② **CDP 端口不能写死。** 别人的 Chrome 占着 9223 时 `connect(9223)` 会连到别人的标签页，
 *    截到的是**别人打开的页面**（那次截出了真实的会话记录，看着像自己的假数据）。这里
 *    随机挑空闲端口，再用 `/json/version` 校验 `webSocketDebuggerUrl` 的端口是自己起的那个。
 *
 * 用法（CLI：起一整套、造点数据、截一张、收工）。CI 里跑的是同一条命令：
 *
 * ```bash
 * node scripts/ui-smoke/ui-shell.mjs --shot /tmp/ui-shots
 * ```
 *
 * 当模块用：
 *
 * ```js
 * import { startUi } from "./scripts/ui-smoke/ui-shell.mjs";
 * const ui = await startUi({ shotDir: "/tmp/ui-shots" });   // 已经把页面打开好了
 * console.log(await ui.page.eval(`return document.title`));
 * await ui.shot("board");                                    // 落到 shotDir/board.png
 * await ui.stop();                                           // 杀进程、删临时目录
 * ```
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { connect } from "./cdp.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
// 仓库根 = 这个文件往上两级（`scripts/ui-smoke/` → 仓库）。CI 上 checkout 到哪都对，
// 本地也不用再设 SOLO_REPO。要验别的副本再用 SOLO_REPO 覆盖。
const REPO = process.env.SOLO_REPO ?? join(HERE, "..", "..");
const CHROME = process.env.SOLO_CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

/** 让系统给一个空闲端口：绑 0 拿到就关，别人抢了就算了（只求不撞）。 */
function freePort() {
	return new Promise((resolve, reject) => {
		const srv = createServer();
		srv.once("error", reject);
		srv.listen(0, "127.0.0.1", () => {
			const { port } = srv.address();
			srv.close(() => resolve(port));
		});
	});
}

async function waitFor(check, { timeoutMs = 90000, stepMs = 300, what = "条件" } = {}) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await check()) return true;
		await new Promise((r) => setTimeout(r, stepMs));
	}
	throw new Error(`等了 ${timeoutMs}ms，${what} 一直没成`);
}

/**
 * 起一整套。返回 `{ url, page, post, shot, stop, dirs }`。
 *
 * - `shotDir`：截图落到哪（默认临时目录里）
 * - `keep`：收工时不删临时目录（要留证据时用）
 * - `seedData`：要不要造点数据好进主界面（默认造：一个群 + 两条消息）
 */
export async function startUi({ shotDir, keep = false, seedData = true, fakeModel = true } = {}) {
	if (!existsSync(CHROME)) throw new Error(`找不到 Chrome：${CHROME}`);
	if (!existsSync(join(REPO, "src/shell/main.ts"))) throw new Error(`SOLO_REPO 不像仓库：${REPO}`);

	const root = mkdtempSync(join(tmpdir(), "solo-ui-"));
	const dirs = {
		root,
		user: join(root, "user"),
		app: join(root, "app"),
		home: join(root, "home"),
		chrome: join(root, "chrome"),
		shots: shotDir ?? join(root, "shots"),
	};
	for (const d of Object.values(dirs)) mkdirSync(d, { recursive: true });

	const bePort = await freePort();
	const cdpPort = await freePort();

	// 假模型：界面的引导页是「`/api/models` 一个都没有」时出现的（`state/store.ts` 的 bootstrap）。
	// 塞一份装配得起来的 settings.json，界面就直接进主界面；baseUrl 指着本地一个不存在的端口，
	// 所以真发消息才会失败 —— 界面验本来也不该发消息。
	if (fakeModel) {
		writeFileSync(
			join(dirs.app, "settings.json"),
			JSON.stringify(
				{
					defaultModel: "ui-check/model",
					providers: [
						{
							id: "ui-check",
							name: "界面验的假模型",
							baseUrl: "http://127.0.0.1:1/v1",
							apiKey: "ui-check",
							api: "openai",
							models: [{ id: "model", name: "model" }],
						},
					],
				},
				null,
				2,
			),
		);
	}

	// ── 后端：两个根都指到临时目录 ──────────────────────────────
	const beLog = [];
	const be = spawn(
		process.execPath,
		[
			"--experimental-strip-types",
			"src/shell/main.ts",
			"--port", String(bePort),
			"--user-root", dirs.user,
			"--app-root", dirs.app,
		],
		{ cwd: REPO, env: { ...process.env, HOME: dirs.home }, stdio: ["ignore", "pipe", "pipe"] },
	);
	be.stdout.on("data", (b) => beLog.push(b.toString()));
	be.stderr.on("data", (b) => beLog.push(b.toString()));
	be.on("exit", (code) => beLog.push(`[后端退出 ${code}]`));

	const url = `http://127.0.0.1:${bePort}/`;
	await waitFor(
		async () => {
			try {
				const r = await fetch(`http://127.0.0.1:${bePort}/api/org`);
				return r.ok;
			} catch {
				return false;
			}
		},
		{ what: "后端起来" },
	).catch((e) => {
		throw new Error(`${e.message}\n后端日志：\n${beLog.join("").slice(-2000)}`);
	});

	// ── Chrome：随机端口 + 校验是自己起的那个 ───────────────────
	const chromeLog = [];
	const chrome = spawn(
		CHROME,
		[
			"--headless=new",
			`--remote-debugging-port=${cdpPort}`,
			`--user-data-dir=${dirs.chrome}`,
			"--no-first-run",
			"--no-default-browser-check",
			"--disable-gpu",
			"--hide-scrollbars",
			"about:blank",
		],
		{ stdio: ["ignore", "pipe", "pipe"] },
	);
	chrome.stdout.on("data", (b) => chromeLog.push(b.toString()));
	chrome.stderr.on("data", (b) => chromeLog.push(b.toString()));

	let version;
	await waitFor(
		async () => {
			try {
				const r = await fetch(`http://127.0.0.1:${cdpPort}/json/version`);
				if (!r.ok) return false;
				version = await r.json();
				return true;
			} catch {
				return false;
			}
		},
		{ what: `Chrome 的 ${cdpPort} 端口起来` },
	).catch((e) => {
		throw new Error(`${e.message}\nChrome 日志：\n${chromeLog.join("").slice(-1500)}`);
	});

	// 校验：这个端口上的调试器确实是我刚起的这只 Chrome
	const wsPort = Number(new URL(version.webSocketDebuggerUrl).port);
	if (wsPort !== cdpPort) {
		throw new Error(`端口不是自己的：${cdpPort} 上的调试器报 ${wsPort}（大概是别人的 Chrome）`);
	}

	const page = await connect(cdpPort);
	await page.viewport(1214, 944);
	await page.goto(url);

	/** 走真接口造数据（写到临时库，不碰任何人）。 */
	const post = async (path, body) => {
		const r = await fetch(`http://127.0.0.1:${bePort}${path}`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body ?? {}),
		});
		const text = await r.text();
		if (!r.ok) throw new Error(`POST ${path} → ${r.status}：${text.slice(0, 200)}`);
		return text ? JSON.parse(text) : undefined;
	};

	if (seedData) {
		// 群至少要有两个人：我，加上至少一个成员。seed 只造了助理一个，就拉他。
		const org = await (await fetch(`http://127.0.0.1:${bePort}/api/org`)).json();
		const other = org?.people?.[0]?.slug;
		if (!other) throw new Error("隔离后端里没有可拉进群的人（seed 没跑？）");
		const made = await post("/api/channels", { title: "无头验的群", members: [other] });
		const id = made?.channel?.id ?? made?.id;
		if (id) {
			for (const text of ["第一条：界面验用的假消息。", "第二条：看列表会不会跟着长。"]) {
				await post(`/api/channels/${encodeURIComponent(id)}/messages`, { text }).catch(() => {});
			}
		}
		await page.goto(url); // 造完再刷一次，首屏带上假数据
	}

	const shot = async (name) => {
		const path = join(dirs.shots, `${name}.png`);
		await page.shot(path);
		return path;
	};

	let stopped = false;
	const stop = async () => {
		if (stopped) return;
		stopped = true;
		try {
			page.close();
		} catch {}
		chrome.kill("SIGTERM");
		be.kill("SIGTERM");
		await new Promise((r) => setTimeout(r, 600));
		if (!keep) {
			try {
				rmSync(root, { recursive: true, force: true });
			} catch {}
		} else {
			console.log(`保留临时目录：${root}`);
		}
	};

	return { url, page, post, shot, stop, dirs, logs: { backend: beLog, chrome: chromeLog }, repo: REPO };
}

// ── CLI：跑一遍冒烟，截图落盘，顺便当「这套还能用」的自检 ──────────
if (process.argv[1] === fileURLToPath(import.meta.url)) {
	const args = process.argv.slice(2);
	const shotDir = args.includes("--shot") ? args[args.indexOf("--shot") + 1] : undefined;
	const keep = args.includes("--keep");
	const ui = await startUi({ shotDir, keep }).catch((e) => {
		console.error(String(e.message ?? e));
		process.exit(1);
	});
	// 点开造出来的那个群：截图和断言都落在「有内容」的那一屏，而不是首屏那个空私聊。
	// 选择器照 `浏览器自动化` 技能：频道行是 [data-channel="group:<名>"]，
	// 按文字找元素找不到（列表项的文字被拆在好几个节点里）。
	const 点开 = await ui.page.eval(`
		const 目标 = document.querySelector('[data-channel="group:无头验的群"]');
		if (!目标) return false;
		目标.click();
		return true;
	`);
	if (点开) await new Promise((r) => setTimeout(r, 700));

	const info = await ui.page.eval(`
		const 文字 = document.body.innerText;
		return {
			标题: document.title,
			侧栏: document.querySelector(".sidebar") !== null,
			进了主界面: document.querySelector(".app") !== null && document.querySelector(".sidebar") !== null,
			不是引导页: !文字.includes("说一句要什么"),
			看得到假消息: 文字.includes("界面验用的假消息"),
			字数: 文字.length,
		};
	`);
	console.log(JSON.stringify(info, null, 1));
	const shot = await ui.shot("smoke");
	console.log(`截图：${shot}`);
	// 断言放在最后（要问后端，所以得在 stop 之前）：停在引导页、或者假数据没造进去，都算这套壳没起作用。
	const 缺 = [];
	if (!info.进了主界面) 缺.push("没进主界面（多半停在引导页：appRoot/settings.json 没写进去？）");
	if (!info.不是引导页) 缺.push("页面上还是引导语 —— 模型没装配起来");
	if (点开 && !info.看得到假消息) 缺.push("点开了群，正文里却没有假消息 —— 消息没渲染出来");
	// 首屏是助理私聊（`store.ts` 的 bootstrap 会跳过去），群名字不会出现在正文里，
	// 所以假数据从接口那边核：造进去了、而且库里真有。
	const list = await (await fetch(`${ui.url}api/channels`)).json();
	const group = (list.channels ?? []).find((c) => c.title === "无头验的群");
	if (!group) 缺.push("接口里没有造出来的「无头验的群」");
	else {
		const 详情 = await (await fetch(`${ui.url}api/channels/${encodeURIComponent(group.id)}?limit=10`)).json();
		if (!(详情.messages ?? []).some((m) => String(m.text).includes("界面验用的假消息")))
			缺.push("群里没造出假消息");
	}
	await ui.stop();
	if (缺.length > 0) {
		console.error(`这套壳没起作用：${缺.join("；")}`);
		process.exit(1);
	}
}
