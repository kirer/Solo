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
import { chmod, cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { loadPlugins } from "../../src/core/plugin/index.ts";

const boxes: string[] = [];

afterEach(async () => {
	for (const box of boxes.splice(0)) await rm(box, { recursive: true, force: true });
});

const SEED = fileURLToPath(new URL("../../seed/plugins/悬浮球", import.meta.url));

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

	it("录音在前端就封成 WAV：不交给 MediaRecorder", async () => {
		const source = await readFile(join(SEED, "client.js"), "utf8");
		// Chromium 的 MediaRecorder 只肯录 webm+opus，macOS 自带的 afconvert 打不开
		// （报 `Couldn't open input file ('typ?')`），所以录音直接收 PCM、前端封 WAV。
		expect(source).not.toMatch(/new MediaRecorder/u);
		expect(source).toMatch(/createScriptProcessor/u);
		expect(source).toMatch(/mime: "audio\/wav"/u);
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
