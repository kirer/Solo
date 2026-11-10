/**
 * 出厂插件「悬浮球」：贴边的一颗球，点麦克风就能跟助理说话。
 *
 * 这里钉的是「装得上、不越界」：
 * - 清单读得出来，后端只加**一条**转写路由，不加工具 / 提示词 / 听消息 / 策略；
 * - 前端只往宿主已有的 `overlays` 插槽里注册自己的格子（插槽表在 DESIGN §2.8）。
 *
 * 转写本身要系统模型和 swiftc，单测不碰；这里只守「输入不合格时它拒绝得干净」，
 * 以及那条路由的地址（前端写死了 `/api/orb/transcribe`，路由必须是纯 ASCII）。
 */
import { spawn } from "node:child_process";
import { chmod, cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { existsAt } from "../../src/core/runtime/io.ts";
import { loadPlugins } from "../../src/core/plugin/index.ts";

const boxes: string[] = [];

afterEach(async () => {
	for (const box of boxes.splice(0)) await rm(box, { recursive: true, force: true });
});

const SEED = fileURLToPath(new URL("../../seed/plugins/悬浮球", import.meta.url));

/**
 * `client.js` 里**真正的代码行**：注释里会引用「以前长什么样」的旧代码，
 * 拿整份源码去 `not.toMatch` 会连带把注释也匹配上，测的就不是代码了。
 */
async function codeLines(): Promise<string> {
	const source = await readFile(join(SEED, "client.js"), "utf8");
	return source
		.split("\n")
		.filter((line) => !/^\s*(\/\/|\*|\/\*)/u.test(line))
		.join("\n");
}

/**
 * 起一份悬浮球。
 *
 * `afconvert` 指到的路径可以在副本里换掉：真机上 afconvert 是 `/usr/bin/afconvert`，
 * 而 Linux 的 CI 上根本没有这个文件 —— 那条「解不开的录音要报解不开」的用例换了台机器就会
 * 先撞上「这台机器上没有 afconvert」，验不到要验的东西。传 `afconvert` 就把副本里那一行换掉。
 */
async function boot(options: { readonly afconvert?: string } = {}): Promise<Awaited<ReturnType<typeof loadPlugins>>> {
	const root = await mkdtemp(join(tmpdir(), "orb-plugin-"));
	boxes.push(root);
	const workspace = join(root, "workspace");
	await mkdir(join(workspace, "plugins"), { recursive: true });
	await cp(SEED, join(workspace, "plugins", "悬浮球"), { recursive: true });
	if (options.afconvert !== undefined) {
		const file = join(workspace, "plugins", "悬浮球", "plugin.js");
		const source = await readFile(file, "utf8");
		await writeFile(file, source.replace('"/usr/bin/afconvert"', JSON.stringify(options.afconvert)), "utf8");
	}
	return loadPlugins({
		pluginsRoot: join(workspace, "plugins"),
		workspace,
		logsRoot: join(root, "logs"),
		log: () => {},
	});
}

describe("悬浮球", () => {
	it("装得上：只加语音那九条路由，不加工具 / 提示词 / 听消息 / 策略", async () => {
		const host = await boot();
		expect(host.errors).toEqual([]);
		expect(host.tools).toEqual([]);
		expect(host.prompt).toEqual([]);
		expect(host.messages).toEqual([]);
		expect(host.flow).toEqual([]);
		expect(host.routes.map((route) => [route.method, route.pattern])).toEqual([
			["GET", "/api/orb/voice"],
			["POST", "/api/orb/voice"],
			["GET", "/api/orb/speech"],
			["POST", "/api/orb/speech"],
			["POST", "/api/orb/speak"],
			["GET", "/api/orb/wake"],
			["POST", "/api/orb/wake"],
			["POST", "/api/orb/kws"],
			["POST", "/api/orb/transcribe"],
		]);

		const summary = host.plugins.find((plugin) => plugin.slug === "悬浮球");
		expect(summary?.enabled).toBe(true);
		expect(summary?.client).toBe(true);
		expect(summary?.error).toBeUndefined();
	});

	it("转写路由拒绝空录音与超长录音，不碰模型", async () => {
		const host = await boot();
		const route = host.routes.find((item) => item.pattern === "/api/orb/transcribe");
		expect(route).toBeDefined();
		const empty = await route?.handle({ method: "POST", params: {}, query: {}, body: {} });
		expect(empty).toEqual({ error: "没有收到录音" });

		const huge = await route?.handle({
			method: "POST",
			params: {},
			query: {},
			body: { audio: "A".repeat(1_400_001), mime: "audio/wav" },
		});
		expect(huge).toEqual({ error: "这段录音太长了（上限约 30 秒）" });
	});

	it("解不开的录音在进转写器之前就报错，不把它喂进去挂着", async () => {
		// 用一个假 afconvert：跑起来就失败（真机上的残缺容器也是这样 —— 报错、退出码非零、
		// 还落下个空产物），这样在各平台的 CI 上都验的是「解不开」而不是「没有 afconvert」。
		const fakeBin = await mkdtemp(join(tmpdir(), "fake-afconvert-"));
		boxes.push(fakeBin);
		const size = "\"$5\"";
		// 假工具得**在各个平台上都跑得起来**：Linux / macOS 是 sh，Windows 的 Git bash 跑不了
		// 无扩展名的 sh 脚本（会落到 CreateProcess 直接 ENOENT，于是这条用例验的是「没这个工具」
		// 而不是「解不开」）。所以按平台给后缀，Windows 用 .cmd。
		const fake = process.platform === "win32" ? join(fakeBin, "afconvert.cmd") : join(fakeBin, "afconvert");
		const body =
			process.platform === "win32"
				? `@echo off\r\ntype nul > ${size}\r\necho Error: couldn't set destination file's estimated duration ('off?') 1>&2\r\nexit /b 1\r\n`
				: `#!/bin/sh\n: > ${size}\necho "Error: couldn't set destination file's estimated duration ('off?')" >&2\nexit 1\n`;
		await writeFile(fake, body, "utf8");
		await chmod(fake, 0o755);
		try {
			const host = await boot({ afconvert: fake });
			const route = host.routes.find((item) => item.pattern === "/api/orb/transcribe");
			expect(route).toBeDefined();
			// 2 KB 的垃圾字节：过得了「>= 1 KB」那道闸，但 afconvert 打不开。
			const junk = Buffer.alloc(2_048, 0x5a).toString("base64");
			const result = await route?.handle({ method: "POST", params: {}, query: {}, body: { audio: junk, mime: "audio/mp4" } });
			expect(result?.error).toMatch(/解不开/u);
			expect(result?.text).toBeUndefined();
		} finally {
			await rm(fakeBin, { recursive: true, force: true });
			boxes.splice(boxes.indexOf(fakeBin), 1);
		}
	});

	it("模型没下时朗读不硬来：报 needModel，并说清多大", async () => {
		const host = await boot();
		const status = host.routes.find((item) => item.method === "GET" && item.pattern === "/api/orb/voice");
		expect(await status?.handle({ method: "GET", params: {}, query: {} })).toMatchObject({
			present: false,
			downloading: false,
			bytes: 362296536,
			default: 47,
			// 音色要能换：八个中文 speaker id 一并给出来（设置页只负责挑）。
			voices: [45, 46, 47, 48, 49, 50, 51, 52].map((id) => ({ id })),
		});
		const speak = host.routes.find((item) => item.pattern === "/api/orb/speak");
		expect(await speak?.handle({ method: "POST", params: {}, query: {}, body: { text: "你好" } })).toEqual({
			error: "语音模型还没下载",
			needModel: true,
		});
	});

	it("播报引擎可切：默认本机，千问的 Key 存下但不回给前端", async () => {
		const host = await boot();
		const speech = host.routes.find((item) => item.method === "GET" && item.pattern === "/api/orb/speech");
		const save = host.routes.find((item) => item.method === "POST" && item.pattern === "/api/orb/speech");
		const initial = await speech?.handle({ method: "GET", params: {}, query: {} });
		expect(initial).toMatchObject({ engine: "local", hasKey: false, qwenVoice: "Cherry", defaultVoice: "Cherry" });
		expect(initial).not.toHaveProperty("apiKey");

		const saved = await save?.handle({
			method: "POST",
			params: {},
			query: {},
			body: { engine: "qwen", apiKey: "sk-unit-test" },
		});
		expect(saved).toMatchObject({ engine: "qwen", hasKey: true });
		expect(saved).not.toHaveProperty("apiKey");
		expect(JSON.stringify(saved)).not.toContain("sk-unit-test");

		// 千问没 Key 时明说，不去联网。
		const cleared = await save?.handle({ method: "POST", params: {}, query: {}, body: { apiKey: "" } });
		expect(cleared).toMatchObject({ engine: "qwen", hasKey: false });
		const speak = host.routes.find((item) => item.pattern === "/api/orb/speak");
		expect(await speak?.handle({ method: "POST", params: {}, query: {}, body: { text: "你好" } })).toEqual({
			error: "千问还没填 API Key",
			needKey: true,
		});
	});

	it("唤醒模型没下时不装听，叫醒接口报 needModel", async () => {
		const host = await boot();
		const wake = host.routes.find((item) => item.method === "GET" && item.pattern === "/api/orb/wake");
		expect(await wake?.handle({ method: "GET", params: {}, query: {} })).toMatchObject({
			present: false,
			downloading: false,
			bytes: 5055019,
		});
		const kws = host.routes.find((item) => item.pattern === "/api/orb/kws");
		expect(await kws?.handle({ method: "POST", params: {}, query: {}, body: { samples: "AAAA" } })).toEqual({
			error: "唤醒模型还没下载",
			needModel: true,
		});
	});

	it("千问音色表：48 个（38 普通话 / 10 方言）、默认 Cherry、语速夹在 0.5–2", async () => {
		const qwen = await import("../../seed/plugins/悬浮球/qwen.js");
		expect(qwen.QWEN_VOICES).toHaveLength(48);
		expect(new Set(qwen.QWEN_VOICES.map((item) => item.voice)).size).toBe(48);
		expect(qwen.QWEN_VOICES.filter((item) => item.group === "dialect")).toHaveLength(10);
		expect(qwen.QWEN_VOICES.find((item) => item.voice === "Cherry")).toBeDefined();
		expect(qwen.DEFAULT_QWEN_VOICE).toBe("Cherry");
		expect(qwen.isQwenVoice("Eldric Sage")).toBe(true);
		expect(qwen.isQwenVoice("cherry")).toBe(false);
		expect(qwen.clampQwenSpeed(9)).toBe(2);
		expect(qwen.clampQwenSpeed(0.1)).toBe(0.5);
		expect(qwen.clampQwenSpeed("x")).toBe(qwen.DEFAULT_QWEN_SPEED);
	});

	it("朗读走本地模型：前端不再碰系统 speechSynthesis", async () => {
		const source = await readFile(join(SEED, "client.js"), "utf8");
		expect(source).not.toMatch(/speechSynthesis/u);
		expect(source).toMatch(/\/api\/orb\/speak/u);
	});

	// 老板 2026-11-09：面板收着也要念。诊断见 `teams/Solo/workspace/诊断-播报没声音-2026-11-09.md`。
	it("面板收着也念：朗读的触发条件里没有 `open`", async () => {
		const source = await readFile(join(SEED, "client.js"), "utf8");
		// 以前是 `if (!speakOn || !open) return;` —— 收着就一句不念，还没有任何痕迹。
		// 注释里会引用这句旧代码，所以只看真正的代码行。
		const code = await codeLines();
		expect(code).not.toMatch(/!speakOn\s*\|\|\s*!open/u);
		// 2026-11-11 老板：主界面那颗球点了「打开朗读」也不出声，因为这里还挡着
		// `ORB_MODE === "inline"`。挡声音的只能是开关本身，不是「你在哪扇窗里」。
		//
		// **必须比 `codeLines()`，不能比 `source`**（程砚 2026-11-11 提的）：注释里就引着
		// 那句旧代码，拿整份源码比等于什么都没钉 —— 改回旧写法照样过。
		// 反过来的方向也放宽一点：只要代码里出现 `ORB_MODE === "inline"` 就算退回去，
		// 不管它写成大括号、`return undefined` 还是塞进别的条件里。
		expect(code).not.toMatch(/ORB_MODE === "inline"/u);
		expect(code).toMatch(/if \(!speakOn\) return;/u);
	});

	// 老板 2026-11-11：老库里存着 `speak:false` 的人，升上来还是哑的 —— 那个 false 是**旧版默认值**
	// 写下去的，不是他点的。分不出就一刀切翻开会违背用户选择，所以往后存都带 `touched`：
	// 只迁「没标记 + 正好是旧默认值 false」这一种。
	it("老库的 `speak:false` 迁成开，但人自己关过的不动", async () => {
		const source = await readFile(join(SEED, "client.js"), "utf8");
		const code = await codeLines();
		// 判据：没有 touched 标记 + 存的正好是 false。
		expect(code).toMatch(/value\?\.touched !== true && value\?\.speak === false/u);
		// 迁移只把「没标记的 false」翻成开，别的照旧按存的走。
		expect(code).toMatch(/speak: legacy \? true : value\?\.speak !== false/u);
		// 存盘时盖上标记，这样迁完往后都算「人动过的」，不会迁第二次。
		expect(code).toMatch(/JSON\.stringify\(\{ \.\.\.readPrefs\(\), \.\.\.next, touched: true \}\)/u);
		// 默认值本身还是开（没存过就开）。
		expect(source).toMatch(/speak: true/u);
	});

	// 老板 2026-11-10：念的应该是「有人跟他说话」，不是把我们改代码的过程播给他。
	// 以前团队频道里每条助理回复都念，结果把 SIGTERM、osascript、reinstall 播出来。
	it("只念跟老板有关的：私聊、或者点名找他的那条", async () => {
		const code = await codeLines();
		// 私聊那份（`inDm`）整条念；别的会话只念 `needsYou`（核心算的，只认显式 @）。
		expect(code).toMatch(/const inDm = /u);
		expect(code).toMatch(/isAssistantChat\(message\) && message\.needsYou === true/u);
	});

	// 老板 2026-11-10：面板收起 = 他在干别的，才更需要被叫。收起时也得拉私聊。
	it("收起面板也拉私聊：轮询的触发条件里没有 `open`", async () => {
		const code = await codeLines();
		expect(code).not.toMatch(/if \(!open \|\| dmId === null/u);
	});

	// 老板 2026-11-10：播放出来的是「undefined」这个词本身。`fresh` 里装的是轨道
	// `{ chatId, message }`，不是消息本身；写成 `speakText(message.text)` 取的是轨道上的
	// `text`，永远 undefined，`plainText` 把它 String() 成 "undefined"，后端照合成。
	it("念的是消息正文：取 track.message.text，不是 track.text", async () => {
		const code = await codeLines();
		expect(code).toMatch(/for \(const track of fresh\) speakText\(track\.message\.text\);/u);
		expect(code).not.toMatch(/for \(const message of fresh\)/u);
	});

	// 老板 2026-11-10：`currentId === dmId` 时也得拉。悬浮窗是独立的一扇窗，它自己的
	// `store.detail` 是空的，主窗口那份流不过来——留着这半个条件，`currentId` 一停在
	// 私聊上就一次都不拉，`fresh` 恒空，一句都不念（就是老板听不到声音的那次）。
	it("正看着私聊时也拉：轮询的触发条件里没有 `currentId === dmId`", async () => {
		const code = await codeLines();
		expect(code).not.toMatch(/currentId === dmId\) return undefined;/u);
		expect(code).toMatch(/if \(dmId === null\) return undefined;/u);
	});

	it("念什么不跟当前打开的频道走：数据源是私聊那份", async () => {
		const code = await codeLines();
		// 拿 `shown` 当数据源的话，面板停在团队频道时读不到私聊，收起后更读不到。
		expect(code).toMatch(/const inDm = \[\.\.\.dmMessages\.values\(\)\]\.filter\(isAssistantChat\)/u);
		expect(code).toMatch(/liveDetail\?\.messages/u);
	});

	// 季衡 2026-11-10：双击启动的桌面版语音整体哑，报「语音运行时没装好」，其实装得好好的。
	// 根因：worker 自己按 cwd / 插件目录猜安装根，而 Finder 起的主进程 cwd 是 `/`，全落空。
	// 修法是把安装根经 env 递给 worker。这条从 `/` 起、插件复制到仓库外，才验得出 env 真起作用。
	it("worker 靠 env 找到安装根，不靠 cwd", async () => {
		const box = await mkdtemp(join(tmpdir(), "tts-cwd-"));
		boxes.push(box);
		// 插件复制到仓库外：兜底那几处「往上两级」就落不到本仓库的 node_modules 上了。
		const plugin = join(box, "plugins", "悬浮球");
		await mkdir(join(box, "plugins"), { recursive: true });
		await cp(SEED, plugin, { recursive: true });
		const worker = join(plugin, "tts-worker.js");

		const run = (env) =>
			new Promise((done) => {
				const child = spawn(process.execPath, [worker], {
					cwd: "/",
					env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", ...env },
					stdio: ["pipe", "pipe", "pipe"],
				});
				let out = "";
				child.stdout.on("data", (chunk) => (out += chunk));
				child.on("close", () => done(out));
				child.stdin.end(JSON.stringify({ text: "", speed: 1, sid: 47 }));
			});

		// 递了根：模块找得到，往下走会撞上「模型没下」，而不是「找不到运行时」。
		const handed = JSON.parse(await run({ SOLO_SHERPA_ROOT: fileURLToPath(new URL("../..", import.meta.url)) }));
		expect(String(handed.error ?? "")).not.toMatch(/找不到 sherpa-onnx-node/u);

		// 没递根、cwd 又是 `/`：必须明说是找不到运行时，并且把找过的路径报出来。
		const missing = JSON.parse(await run({ SOLO_SHERPA_ROOT: "" }));
		expect(String(missing.error ?? "")).toMatch(/找不到 sherpa-onnx-node/u);
		// 文案别把人往错的方向带：不是「没装好」，说清是安装不完整、重装能修。
		expect(String(missing.error ?? "")).toMatch(/重装/u);
	});

	// 老板 2026-11-10：几条消息一起进来会并发起好几个 tts-worker（每个读 310MB 模型），
	// CPU 冲到 700%。合成必须串行，待念的只留一个，后面的丢。
	it("合成串行：不并发起多个，待念只留一个", async () => {
		const code = await codeLines();
		// 不能再有「for 里 void speakText」那种甩出去就不管的写法。
		expect(code).not.toMatch(/void speakText\(/u);
		// 串行靠这三个：正在合成的标记、一个待念槽位、串着跑的循环。
		expect(code).toMatch(/synthesizingRef = useRef\(false\)/u);
		expect(code).toMatch(/pendingRef = useRef\(null\)/u);
		expect(code).toMatch(/while \(pendingRef\.current !== null\)/u);
		// speakText 只登记、不 await 合成：它同步返回。
		expect(code).not.toMatch(/const speakText = async/u);
		expect(code).toMatch(/const speakText = \(raw\) =>/u);
	});

	it("合成回来时不看面板开没开：收起不丢这一片", async () => {
		const source = await readFile(join(SEED, "client.js"), "utf8");
		// 以前这里 `if (!openRef.current) return;`：跑到一半收起面板，回来的 wav 直接扔了。
		expect(source).not.toMatch(/if \(!openRef\.current\) return;/u);
	});

	it("收起面板不掐正在念的：closeAll 里没有 stopAudio", async () => {
		const source = await readFile(join(SEED, "client.js"), "utf8");
		const closeAll = source.slice(source.indexOf("const closeAll = () => {"));
		const body = closeAll.slice(0, closeAll.indexOf("setMenu(false);"));
		expect(body).not.toMatch(/stopAudio\(\)/u);
		// 录音还是要停：麦克风不能跟着面板收到后台去。
		expect(body).toMatch(/recorder\.stop\(\)/u);
	});

	it("播放失败要说出来，不能当成念完了静默跳过", async () => {
		const source = await readFile(join(SEED, "client.js"), "utf8");
		// 以前 `player.onerror = playNext`：解码失败被当成「这段播完了」，一路静音跳完。
		expect(await codeLines()).not.toMatch(/player\.onerror = playNext/u);
		expect(source).toMatch(/player\.onerror = \(\) => speechFailed\(/u);
		expect(source).toMatch(/speechFailed\(/u);
		// 念不出来要有字：面板开着写进面板，收着攒在 speechProblemRef，下次打开补一句。
		expect(source).toMatch(/speechProblemRef\.current = line/u);
		expect(source).toMatch(/没念出来：/u);
	});

	it("录音在前端就封成 WAV：不交给 MediaRecorder", async () => {
		const source = await readFile(join(SEED, "client.js"), "utf8");
		// Chromium 的 MediaRecorder 只肯录 webm+opus，macOS 自带的 afconvert 打不开
		// （报 `Couldn't open input file ('typ?')`），所以录音直接收 PCM、前端封 WAV。
		expect(source).not.toMatch(/new MediaRecorder/u);
		expect(source).toMatch(/createScriptProcessor/u);
		expect(source).toMatch(/mime: "audio\/wav"/u);
	});

	/**
	 * 2.9.0 就是这么发出去的：`client.js` 里有一行 `const startMouth = (player) => {` 被写了
	 * 两遍，语法坏掉。插件是 `import()` 进来的，解析期就抛，连 `catch` 里的 warn 都没机会说
	 * —— 日志一片干净，界面上一颗球都没有（采样 64260 点全透明）。
	 *
	 * 1105 例测试全绿，因为没有一条去看这份文件的语法。这条补上：`seed/plugins/*` 下的
	 * 每份 `client.js` 都过一遍 `node --check`，改坏立刻红。
	 *
	 * 用真的 `node --check` 而不是「在 vitest 里 import 一下」：这份文件是浏览器 ESM、还引
	 * 了 `document`，在 node 里 import 会先死在环境上，验不出语法；`--check` 只解析不执行，
	 * 正好是插件在浏览器里加载时最先做的那一步。
	 */
	it("每份 client.js 都能被解析（语法坏了插件整份加载失败，界面一片空白）", async () => {
		const root = fileURLToPath(new URL("../../seed/plugins", import.meta.url));
		const entries = await readdir(root, { withFileTypes: true });
		const broken: string[] = [];
		let checked = 0;
		for (const entry of entries) {
			if (!entry.isDirectory()) continue;
			const file = join(root, entry.name, "client.js");
			if (!(await existsAt(file))) continue;
			checked += 1;
			const result = await new Promise<string | null>((done) => {
				const child = spawn(process.execPath, ["--check", file], { stdio: ["ignore", "ignore", "pipe"] });
				let err = "";
				child.stderr.on("data", (chunk) => (err += chunk));
				child.on("close", (code) => done(code === 0 ? null : err));
			});
			if (result !== null) broken.push(`${entry.name}/client.js:\n${result.trim()}`);
		}
		// 一个都没扫到说明路径算错了 —— 别让这条测试靠「没有插件」变绿。
		expect(checked).toBeGreaterThan(0);
		expect(broken).toEqual([]);
	});

	it("只放进宿主已有的插槽，不自己 import 别的模块", async () => {
		const source = await readFile(join(SEED, "client.js"), "utf8");
		// 前端入口是浏览器直接 import 的一段 ESM：它拿到的只有宿主递过来的 `ui`，
		// 想 import 别的模块就会 404（没有打包器）。
		expect(source).not.toMatch(/^\s*import\s/m);
		const slots = [...source.matchAll(/register\("([^"]+)"/gu)].map((match) => match[1]);
		// 球在 `overlays`；设置里的「悬浮球语音」一行 + 一整页走 `app.entry` / `app.page`。
		expect(slots).toEqual(["overlays", "app.entry", "app.page"]);
	});
});
