/**
 * 2.9.18：老用户升级上来，插件要跟着到新版（#2374）。
 *
 * 钉住「整份判」这条判据和它周围的原子性（ADR-097 一条不破）：
 * 1. 出厂原样 + 线上有新版 → 整份换；线上没变 → 一本清单（接口 + 清单 + 签名）就够，一个包都不取；
 * 2. 用户改过 / 加过 / 删过 → 不取它的包、盘上字节不动（清单是五个共用的那一本）；
 *    但 Finder 的 `.DS_Store`、资源管理器的 `Thumbs.db` 不算「改过」—— 它们谁都会留下；
 * 3. 老账本没有基线（2.9.14 那种机器）→ 历史 hash + 出厂文件名集合对上就升级，少一个文件就不动；
 * 4. 半途没换完（崩了 / 被 kill）→ 启动收拾残局：旧的挪回去、新的删掉，正式目录和账本不留半份；
 * 5. 失败日志带 `cause` 链（`code` 进日志，界面上仍是一句人话）；
 * 6. 断网首启不拖启动：界面立刻拿到五个「没装上 + 可重试」。
 */
import { execFileSync, spawn } from "node:child_process";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	PLUGIN_MANIFEST_ASSET,
	REMOTE_PLUGINS,
	SHIPPED_PLUGIN_FILES,
	downloadRemotePlugin,
	ensureDownloadablePlugins,
	remotePluginStatuses,
} from "../../src/shell/plugin-download.ts";
import { pluginHashes } from "../../src/shell/seed.ts";
import { resolveLayout, type Layout } from "../../src/core/layout.ts";
import { buildPluginManifest, PLUGIN_ASSETS } from "../../scripts/update-manifest.ts";

const REPO = join(import.meta.dirname, "..", "..");
const SRC = join(REPO, "plugins-src");
const NAME = "悬浮球";
const BROKEN = "文件树";
const API_LATEST = "https://api.github.com/repos/kirer/Solo/releases/latest";

const boxes: string[] = [];

/** 和 `hashOf()` 同口径（sha256 前 16 位十六进制）。 */
const hashOf = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex").slice(0, 16);

afterEach(async () => {
	for (const box of boxes.splice(0)) await rm(box, { recursive: true, force: true });
});

async function boxDir(prefix: string): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), prefix));
	boxes.push(dir);
	return dir;
}

/** 一个空的 appRoot（`plugins/` 建好）。 */
async function appRoot(): Promise<string> {
	const root = await boxDir("plugin-upgrade-");
	await mkdir(join(root, "plugins"), { recursive: true });
	return root;
}

type Feed = { manifest: string; signature: string; publicKey: string; assets: Map<string, string> };

/** 拿某个源码目录生成真清单 + 真包，用临时密钥签上（和 CI 那一步同一个函数）。 */
function feedOf(srcDir: string): Feed {
	const built = buildPluginManifest(srcDir, "2.9.18");
	const { privateKey, publicKey } = generateKeyPairSync("ed25519");
	return {
		manifest: built.text,
		signature: sign(null, Buffer.from(built.text, "utf8"), privateKey).toString("base64"),
		publicKey: publicKey.export({ type: "spki", format: "pem" }).toString(),
		assets: new Map(built.assets),
	};
}

/** 清单里某一条（拿它比 `pluginBundle` 记的 sha256）。 */
function entryOf(feed: Feed, name: string): { file: string; sha256: string; size: number } {
	const parsed = JSON.parse(feed.manifest) as { plugins: { name: string; file: string; sha256: string; size: number }[] };
	const entry = parsed.plugins.find((one) => one.name === name);
	if (entry === undefined) throw new Error(`清单里没有 ${name}`);
	return entry;
}

type Call = { url: string; accept: string | undefined; name: string | undefined };

/** 用真清单 + 临时密钥签一份下载源（走 API 资产直链那条路，和线上同形）。 */
function localFeed(feed: Feed, options: { api?: "ok" | "offline"; override?: (name: string, body: string) => string } = {}) {
	const calls: Call[] = [];
	const bodies = new Map<string, string>([
		[PLUGIN_MANIFEST_ASSET, feed.manifest],
		[`${PLUGIN_MANIFEST_ASSET}.sig`, feed.signature],
		...feed.assets,
	]);
	const byId = new Map<string, string>();
	let next = 1;
	for (const name of bodies.keys()) byId.set(String(next++), name);
	const assets = [...bodies.keys()].map((name) => ({
		name,
		url: `https://api.github.com/repos/kirer/Solo/releases/assets/${[...byId.entries()].find(([, n]) => n === name)?.[0] ?? ""}`,
	}));
	const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
		const url = String(input);
		const headers = (init?.headers ?? {}) as Record<string, string>;
		const id = url.startsWith(`${API_LATEST.slice(0, -"/latest".length)}/assets/`) ? url.slice(url.lastIndexOf("/") + 1) : undefined;
		calls.push({ url, accept: headers["Accept"], name: id === undefined ? undefined : byId.get(id) });
		if (url === API_LATEST) {
			if (options.api === "offline") throw new TypeError("fetch failed");
			return new Response(JSON.stringify({ assets }), { status: 200 });
		}
		const name = byId.get(url.slice(url.lastIndexOf("/") + 1));
		const body = name === undefined ? undefined : bodies.get(name);
		if (body === undefined) return new Response("没有这个资产", { status: 404 });
		return new Response(options.override?.(name, body) ?? body, { status: 200 });
	}) as typeof fetch;
	return { fetchImpl, calls };
}

/** 线上那份改成「新版」：复制一份源码，改一个文件（模拟发一个插件修复）。 */
async function upgradedSource(marker: string): Promise<string> {
	const dir = join(await boxDir("plugin-src-"), "src");
	await cp(SRC, dir, { recursive: true });
	await writeFile(join(dir, NAME, "client.js"), `${marker}\n`);
	return dir;
}

/** 把某个 tag 里的 `seed/plugins/<名字>` 铺到盘上：造「老机器」。 */
async function seedFromGit(root: string, tag: string, names: readonly string[] = REMOTE_PLUGINS): Promise<void> {
	for (const name of names) {
		const prefix = `seed/plugins/${name}/`;
		const list = execFileSync("git", ["-c", "core.quotepath=false", "ls-tree", "-r", "--name-only", tag, "--", `seed/plugins/${name}`], {
			cwd: REPO,
			encoding: "utf8",
		})
			.trim()
			.split("\n")
			.filter((one) => one !== "");
		for (const path of list) {
			const content = execFileSync("git", ["show", `${tag}:${path}`], { cwd: REPO, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
			const target = join(root, "plugins", name, path.slice(prefix.length));
			await mkdir(dirname(target), { recursive: true });
			await writeFile(target, content);
		}
	}
}

type Ledger = {
	plugins?: string[];
	pluginFiles?: Record<string, Record<string, string>>;
	pluginBundle?: Record<string, string>;
	removed?: string[];
};

/** 写账本。不传 `pluginFiles` / `pluginBundle` 就是 2.9.14 那种「没有插件基线」的老账本。 */
async function writeLedger(layout: Layout, ledger: Ledger = {}): Promise<void> {
	const shape = {
		version: 2,
		skills: {},
		plugins: ledger.plugins ?? [],
		pluginFiles: ledger.pluginFiles ?? {},
		pluginBundle: ledger.pluginBundle ?? {},
		removed: ledger.removed ?? [],
		files: {},
		textKeys: {},
	};
	await writeFile(layout.seedManifestFile, `${JSON.stringify(shape, null, 2)}\n`);
}

async function ledgerOf(layout: Layout): Promise<Record<string, unknown>> {
	return JSON.parse(await readFile(layout.seedManifestFile, "utf8")) as Record<string, unknown>;
}

/** 一个目录里每个文件的内容 hash（比「一个字节不动」用）。 */
async function hashesOnDisk(layout: Layout, name: string): Promise<Record<string, string>> {
	return pluginHashes(join(layout.pluginsRoot, name));
}

async function readdirSafe(path: string): Promise<string[]> {
	try {
		return (await readdir(path)).sort();
	} catch {
		return [];
	}
}

/** 一份源码目录里某个插件的 hash 表（当基线用）。 */
async function hashesOfSource(srcDir: string, name: string): Promise<Record<string, string>> {
	return pluginHashes(join(srcDir, name));
}

/** 五个插件都按 `srcDir` 铺到盘上，并把基线 + 包 sha256 记进账本（= 已经装好、没动过的机器）。 */
async function installedFrom(layout: Layout, srcDir: string, feed: Feed): Promise<void> {
	for (const name of REMOTE_PLUGINS) await cp(join(srcDir, name), join(layout.pluginsRoot, name), { recursive: true });
	const pluginFiles: Record<string, Record<string, string>> = {};
	const pluginBundle: Record<string, string> = {};
	for (const name of REMOTE_PLUGINS) {
		pluginFiles[name] = await hashesOfSource(srcDir, name);
		pluginBundle[name] = entryOf(feed, name).sha256;
	}
	await writeLedger(layout, { plugins: [...REMOTE_PLUGINS], pluginFiles, pluginBundle });
}

/** 起一个只认这几个文件名的本地源 —— 函数式 `fetchImpl` 传不过进程边界，子进程得有个真地址。 */
async function serveAssets(feed: Feed): Promise<{ base: string; close: () => Promise<void> }> {
	const bodies = new Map<string, string>([
		[PLUGIN_MANIFEST_ASSET, feed.manifest],
		[`${PLUGIN_MANIFEST_ASSET}.sig`, feed.signature],
		...feed.assets,
	]);
	const server = createServer((request, response) => {
		const name = decodeURIComponent((request.url ?? "/").replace(/^\//, ""));
		const body = bodies.get(name);
		if (body === undefined) {
			response.writeHead(404);
			response.end("没有这个资产");
			return;
		}
		response.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
		response.end(body);
	});
	await new Promise<void>((done) => {
		server.listen(0, "127.0.0.1", done);
	});
	const { port } = server.address() as AddressInfo;
	return {
		base: `http://127.0.0.1:${String(port)}/`,
		close: () =>
			new Promise<void>((done) => {
				server.close(() => {
					done();
				});
			}),
	};
}

/**
 * 一个「装到一半就把自己干掉」的子进程。
 *
 * 为什么非得真起进程：要验「被 kill 之后正式目录和账本一个字节不变」，靠 try/catch 造不出来
 * （那是抛错，不是断电）。注入点用 `setAtomicWriteFault` —— 在「临时文件已落地、还没 rename
 * 换成正式文件」那一瞬动手，这是真正危险的时刻。
 */
async function childScript(): Promise<string> {
	const path = join(await boxDir("plugin-kill-"), "child.mjs");
	const lines = [
		// 必须用 file:// —— Windows 上 `C:\...` 不是合法的 ESM 说明符（ERR_UNSUPPORTED_ESM_URL_SCHEME）。
		`import { setAtomicWriteFault } from ${JSON.stringify(pathToFileURL(join(REPO, "src/core/runtime/io.ts")).href)};`,
		`import { downloadRemotePlugin } from ${JSON.stringify(pathToFileURL(join(REPO, "src/shell/plugin-download.ts")).href)};`,
		`import { resolveLayout } from ${JSON.stringify(pathToFileURL(join(REPO, "src/core/layout.ts")).href)};`,
		`const [appRoot, feed] = process.argv.slice(2);`,
		`let writes = 0;`,
		`setAtomicWriteFault(async () => {`,
		`	writes += 1;`,
		`	if (writes === 2) process.kill(process.pid, "SIGKILL");`,
		`});`,
		`const layout = resolveLayout({ appRoot, userRoot: appRoot });`,
		`const ok = await downloadRemotePlugin(layout, ${JSON.stringify(BROKEN)}, { feed, publicKey: process.env.SOLO_TEST_PUBLIC_KEY });`,
		`console.log("没被 kill：", ok);`,
		"",
	];
	await writeFile(path, lines.join("\n"));
	return path;
}

describe("老用户升级：出厂原样才跟着升级", () => {
	it("盘上是 2.9.16 的悬浮球（账本有基线）→ 整份升到线上新版", async () => {
		const root = await appRoot();
		const layout = resolveLayout({ appRoot: root, userRoot: root });
		await seedFromGit(root, "v2.9.16", [NAME]);
		const before = await hashesOnDisk(layout, NAME);
		await writeLedger(layout, { plugins: [NAME], pluginFiles: { [NAME]: before } });

		const online = await upgradedSource("// 2.9.18 加的修复");
		const feed = feedOf(online);
		const { fetchImpl } = localFeed(feed);
		const done = await ensureDownloadablePlugins(layout, { fetchImpl, publicKey: feed.publicKey });

		expect(done).toContain(NAME);
		expect(await readFile(join(layout.pluginsRoot, NAME, "client.js"), "utf8")).toBe("// 2.9.18 加的修复\n");
		// 基线跟着换成线上这一份，第二回启动就不会再下。
		expect(await hashesOnDisk(layout, NAME)).toEqual(await hashesOfSource(online, NAME));
		const ledger = await ledgerOf(layout);
		expect((ledger["pluginBundle"] as Record<string, string>)[NAME]).toBe(entryOf(feed, NAME).sha256);
	});

	it("线上没变：只花三个请求（接口 + 清单 + 签名），一个文件都不重写", async () => {
		const root = await appRoot();
		const layout = resolveLayout({ appRoot: root, userRoot: root });
		const feed = feedOf(SRC);
		await installedFrom(layout, SRC, feed);
		const before = await hashesOnDisk(layout, NAME);
		const { fetchImpl, calls } = localFeed(feed);

		expect(await ensureDownloadablePlugins(layout, { fetchImpl, publicKey: feed.publicKey })).toEqual([]);
		// 一本清单：接口 + `plugins.json` + `plugins.json.sig`，一个插件包都没取。
		expect(calls.map((call) => call.name).filter((one) => one !== undefined)).toEqual([
			PLUGIN_MANIFEST_ASSET,
			`${PLUGIN_MANIFEST_ASSET}.sig`,
		]);
		expect(await hashesOnDisk(layout, NAME)).toEqual(before);
		expect(await readdirSafe(join(root, ".plugin-staging"))).toEqual([]);
	});

	const mutations: readonly [string, (dir: string) => Promise<void>][] = [
		["改过一个文件", (dir) => writeFile(join(dir, "client.js"), "// 我改的\n")],
		["加过一个文件", (dir) => writeFile(join(dir, "我自己加的.js"), "// 我加的\n")],
		["删过一个文件", (dir) => rm(join(dir, "kokoro.js"), { force: true })],
	];

	for (const [label, mutate] of mutations) {
		it(`${label}：0 请求、一个字节不动（线上就算有新也不碰）`, async () => {
			const root = await appRoot();
			const layout = resolveLayout({ appRoot: root, userRoot: root });
			const feed = feedOf(SRC);
			await installedFrom(layout, SRC, feed);
			await mutate(join(layout.pluginsRoot, NAME));
			const before = await hashesOnDisk(layout, NAME);
			const beforeLedger = await readFile(layout.seedManifestFile, "utf8");

			// 线上故意换成新版：判错了就会真下。
			const online = feedOf(await upgradedSource("// 线上新版"));
			const { fetchImpl, calls } = localFeed(online);
			expect(await ensureDownloadablePlugins(layout, { fetchImpl, publicKey: online.publicKey })).toEqual([]);

			// 清单是五个共用的那一本；**它自己的包一个字节都不取**。
			expect(calls.some((call) => call.name === PLUGIN_ASSETS[NAME])).toBe(false);
			expect(await hashesOnDisk(layout, NAME)).toEqual(before);
			expect(await readFile(layout.seedManifestFile, "utf8")).toBe(beforeLedger);
		});
	}

	it("目录里多一个 `.DS_Store` / `Thumbs.db`（Finder、资源管理器留的）仍算没改过，照升", async () => {
		const root = await appRoot();
		const layout = resolveLayout({ appRoot: root, userRoot: root });
		const feed = feedOf(SRC);
		await installedFrom(layout, SRC, feed);
		// 用户只是在 Finder 里打开过这个插件目录：多两个系统垃圾文件，不算他改过。
		await writeFile(join(layout.pluginsRoot, NAME, ".DS_Store"), "Bud1\x00\x00\x10\x00\x00\x00\x08\x00\x00\x00\x00\x00\x00\x00\x00\n");
		await writeFile(join(layout.pluginsRoot, NAME, "Thumbs.db"), "Windows 的缩略图缓存\n");
		expect(Object.keys(await pluginHashes(join(layout.pluginsRoot, NAME)))).not.toContain(".DS_Store");

		const onlineSrc = await upgradedSource("// 线上新版");
		const online = feedOf(onlineSrc);
		const { fetchImpl } = localFeed(online);
		expect(await ensureDownloadablePlugins(layout, { fetchImpl, publicKey: online.publicKey })).toContain(NAME);

		expect(await hashesOnDisk(layout, NAME)).toEqual(await hashesOfSource(onlineSrc, NAME));
		// 整份换掉以后那两个垃圾文件跟着旧目录一起走了。
		const names = await readdirSafe(join(layout.pluginsRoot, NAME));
		expect(names).not.toContain(".DS_Store");
		expect(names).not.toContain("Thumbs.db");
	});

	it("老账本没基线的机器也认：多一个 `.DS_Store` 照样整份升", async () => {
		const root = await appRoot();
		const layout = resolveLayout({ appRoot: root, userRoot: root });
		await seedFromGit(root, "v2.9.14", [NAME]);
		await writeLedger(layout);
		await writeFile(join(layout.pluginsRoot, NAME, ".DS_Store"), "Finder 的垃圾\n");

		const onlineSrc = await upgradedSource("// 线上新版");
		const online = feedOf(onlineSrc);
		const { fetchImpl } = localFeed(online);
		expect((await ensureDownloadablePlugins(layout, { fetchImpl, publicKey: online.publicKey })).includes(NAME)).toBe(true);
		expect(await hashesOnDisk(layout, NAME)).toEqual(await hashesOfSource(onlineSrc, NAME));
	});

	it("老账本没有基线（2.9.14 那种机器）：历史 hash + 出厂文件名对上 → 五个全升到线上新版", async () => {
		const root = await appRoot();
		const layout = resolveLayout({ appRoot: root, userRoot: root });
		await seedFromGit(root, "v2.9.14");
		await writeLedger(layout);
		const online = SRC;
		const feed = feedOf(online);
		const { fetchImpl } = localFeed(feed);

		const done = await ensureDownloadablePlugins(layout, { fetchImpl, publicKey: feed.publicKey });

		expect([...done].sort()).toEqual([...REMOTE_PLUGINS].sort());
		for (const name of REMOTE_PLUGINS) {
			expect(await hashesOnDisk(layout, name), name).toEqual(await hashesOfSource(online, name));
		}
		const ledger = await ledgerOf(layout);
		const bundle = ledger["pluginBundle"] as Record<string, string>;
		for (const name of REMOTE_PLUGINS) expect(bundle[name], name).toBe(entryOf(feed, name).sha256);
	});

	it("老账本没有基线、又少了一个文件：不动、0 请求（判不出是不是原样就别碰）", async () => {
		const root = await appRoot();
		const layout = resolveLayout({ appRoot: root, userRoot: root });
		await seedFromGit(root, "v2.9.14", [NAME]);
		await rm(join(layout.pluginsRoot, NAME, "kokoro.js"), { force: true });
		await writeLedger(layout);
		const before = await hashesOnDisk(layout, NAME);
		const online = feedOf(await upgradedSource("// 线上新版"));
		const { fetchImpl, calls } = localFeed(online);
		// 另外四个不在盘上：让它们别来捣乱（用户删过 = 启动不装回去）。
		const ledger = JSON.parse(await readFile(layout.seedManifestFile, "utf8")) as Record<string, unknown>;
		ledger["removed"] = REMOTE_PLUGINS.filter((one) => one !== NAME);
		await writeFile(layout.seedManifestFile, `${JSON.stringify(ledger, null, 2)}\n`);

		expect(await ensureDownloadablePlugins(layout, { fetchImpl, publicKey: online.publicKey })).toEqual([]);
		expect(calls.some((call) => call.name === PLUGIN_ASSETS[NAME])).toBe(false);
		expect(await hashesOnDisk(layout, NAME)).toEqual(before);
	});

	it("升级中途失败（包对不上 sha256）：正式目录与账本一个字节不变，状态可重试", async () => {
		const root = await appRoot();
		const layout = resolveLayout({ appRoot: root, userRoot: root });
		const oldFeed = feedOf(SRC);
		await installedFrom(layout, SRC, oldFeed);
		const before = await hashesOnDisk(layout, NAME);
		const beforeLedger = await readFile(layout.seedManifestFile, "utf8");

		const online = await upgradedSource("// 线上新版");
		const feed = feedOf(online);
		const { fetchImpl } = localFeed(feed, {
			override: (name, body) => (name === PLUGIN_ASSETS[NAME] ? JSON.stringify({ files: { "client.js": "// 坏包" } }) : body),
		});
		expect(await ensureDownloadablePlugins(layout, { fetchImpl, publicKey: feed.publicKey })).toEqual([]);

		expect(await hashesOnDisk(layout, NAME)).toEqual(before);
		expect(await readFile(layout.seedManifestFile, "utf8")).toBe(beforeLedger);
		expect(await readdirSafe(join(root, ".plugin-staging"))).toEqual([]);

		// 可重试：下一次网好了、包对了，就该升上去（不是「失败一次就永远不装」）。
		const good = localFeed(feed);
		expect(await ensureDownloadablePlugins(layout, { fetchImpl: good.fetchImpl, publicKey: feed.publicKey })).toEqual([NAME]);
		expect(await hashesOnDisk(layout, NAME)).toEqual(await hashesOfSource(online, NAME));
	});
});

describe("半途没换完：启动收拾残局", () => {
	it("只剩 old-（目录换走了、新的没挪进来）：挪回旧的", async () => {
		const root = await appRoot();
		const layout = resolveLayout({ appRoot: root, userRoot: root });
		const leftover = join(root, ".plugin-staging", `old-${NAME}-deadbeef`);
		await mkdir(leftover, { recursive: true });
		await writeFile(join(leftover, "plugin.js"), "// 旧的悬浮球\n");
		const feed = feedOf(SRC);
		const { fetchImpl } = localFeed(feed, { api: "offline" });

		await ensureDownloadablePlugins(layout, { fetchImpl, publicKey: feed.publicKey });

		expect(await readFile(join(layout.pluginsRoot, NAME, "plugin.js"), "utf8")).toBe("// 旧的悬浮球\n");
		expect(await readdirSafe(join(root, ".plugin-staging"))).toEqual([]);
	});

	it("只剩 new-（新目录写完没换上去）：清掉，正式目录不动", async () => {
		const root = await appRoot();
		const layout = resolveLayout({ appRoot: root, userRoot: root });
		const feed = feedOf(SRC);
		await installedFrom(layout, SRC, feed);
		const before = await hashesOnDisk(layout, NAME);
		const leftover = join(root, ".plugin-staging", `new-${NAME}-deadbeef`);
		await mkdir(leftover, { recursive: true });
		await writeFile(join(leftover, "client.js"), "// 半份新的\n");
		const { fetchImpl } = localFeed(feed, { api: "offline" });

		await ensureDownloadablePlugins(layout, { fetchImpl, publicKey: feed.publicKey });

		expect(await hashesOnDisk(layout, NAME)).toEqual(before);
		expect(await readdirSafe(join(root, ".plugin-staging"))).toEqual([]);
	});

	// Windows 上跳过：那边没有信号语义，`process.kill(pid, "SIGKILL")` 走 TerminateProcess，
	// 子进程 exit 拿到的是 code、signal 是 null，这条「真被 kill」验不了（2026-11-12 build-win 红）。
	// Windows 上「半份残局 → 启动收拾」这条路由上面「只留 new- 半成品」那条盖住。
	it.skipIf(process.platform === "win32")("写到第二个文件时被 SIGKILL：正式目录与账本逐字节不变，重启收拾干净后再装成功", async () => {
		const root = await appRoot();
		const layout = resolveLayout({ appRoot: root, userRoot: root });
		// 文件树是 2.9.16 那一份（有基线、账本里没记包）→ 一定会重下。
		await seedFromGit(root, "v2.9.16", [BROKEN]);
		await writeLedger(layout, {
			plugins: [BROKEN],
			pluginFiles: { [BROKEN]: await hashesOnDisk(layout, BROKEN) },
			removed: REMOTE_PLUGINS.filter((one) => one !== BROKEN),
		});
		const before = await hashesOnDisk(layout, BROKEN);
		const beforeLedger = await readFile(layout.seedManifestFile, "utf8");

		const feed = feedOf(SRC);
		const server = await serveAssets(feed);
		const script = await childScript();
		const exit = await new Promise<{ signal: string | null; status: number | null }>((done) => {
			const child = spawn(process.execPath, [script, root, server.base], {
				env: { ...process.env, SOLO_TEST_PUBLIC_KEY: feed.publicKey },
				stdio: "inherit",
			});
			child.on("exit", (status, signal) => {
				done({ signal, status });
			});
		});
		await server.close();

		expect(exit.signal).toBe("SIGKILL");
		// 被 kill 的那一刻：正式目录、账本都是上一次的样子，半份只在 staging 里。
		expect(await hashesOnDisk(layout, BROKEN)).toEqual(before);
		expect(await readFile(layout.seedManifestFile, "utf8")).toBe(beforeLedger);
		expect((await readdirSafe(join(root, ".plugin-staging"))).some((one) => one.startsWith(`new-${BROKEN}-`))).toBe(true);

		// 重启：先收拾残局，再装上去。
		const { fetchImpl } = localFeed(feed);
		const done = await ensureDownloadablePlugins(layout, { fetchImpl, publicKey: feed.publicKey });
		expect(done).toContain(BROKEN);
		expect(await hashesOnDisk(layout, BROKEN)).toEqual(await hashesOfSource(SRC, BROKEN));
		expect(await readdirSafe(join(root, ".plugin-staging"))).toEqual([]);
	});
});

describe("判据本身站得住", () => {
	it("`SHIPPED_PLUGIN_FILES` 和 `plugins-src/` 盘上的文件名逐个一致（它不是第二套真相）", async () => {
		for (const name of REMOTE_PLUGINS) {
			const onDisk = (await readdir(join(SRC, name), { recursive: true })).sort();
			expect([...SHIPPED_PLUGIN_FILES[name]].sort(), name).toEqual(onDisk);
		}
	});

	it("2.9.16 那份悬浮球没有 data-tip，线上这一份有", async () => {
		const old = execFileSync("git", ["show", "v2.9.16:seed/plugins/悬浮球/client.js"], { cwd: REPO, encoding: "utf8" });
		const now = await readFile(join(SRC, NAME, "client.js"), "utf8");
		expect(old.includes("data-tip")).toBe(false);
		expect(now.includes("data-tip")).toBe(true);
		expect(hashOf(old)).not.toBe(hashOf(now));
	});

	it("装成功也打一行日志：插件名 + 整份升级/装上 + 文件数 + 包 sha256（排障时不用瞎猜）", async () => {
		const root = await appRoot();
		const layout = resolveLayout({ appRoot: root, userRoot: root });
		const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
		try {
			const feed = feedOf(SRC);
			await ensureDownloadablePlugins(layout, { fetchImpl: localFeed(feed).fetchImpl, publicKey: feed.publicKey });
			const lines = log.mock.calls.map((call) => call.map(String).join(" "));
			const fresh = lines.find((line) => line.includes(`「${NAME}」装上`));
			expect(fresh).toBeDefined();
			expect(fresh).toContain("7 个文件");
			expect(fresh).toContain(entryOf(feed, NAME).sha256.slice(0, 12));

			// 老用户那条路：盘上是 2.9.16 那份，装完写「整份升级」，别和「装上」混成一样。
			const old = await appRoot();
			const oldLayout = resolveLayout({ appRoot: old, userRoot: old });
			await seedFromGit(old, "v2.9.16", [NAME]);
			await writeLedger(oldLayout, {
				plugins: [NAME],
				pluginFiles: { [NAME]: await pluginHashes(join(oldLayout.pluginsRoot, NAME)) },
			});
			log.mockClear();
			await ensureDownloadablePlugins(oldLayout, { fetchImpl: localFeed(feed).fetchImpl, publicKey: feed.publicKey });
			const upgraded = log.mock.calls.map((call) => call.map(String).join(" ")).find((line) => line.includes(`「${NAME}」整份升级`));
			expect(upgraded).toContain("7 个文件");
			// 「不用下」那条路不该打成功日志（线上没变，什么都没写）。
			log.mockClear();
			await ensureDownloadablePlugins(oldLayout, { fetchImpl: localFeed(feed).fetchImpl, publicKey: feed.publicKey });
			expect(log.mock.calls.map((call) => call.map(String).join(" ")).some((line) => line.includes(`「${NAME}」`))).toBe(false);
		} finally {
			log.mockRestore();
		}
	});

	it("断网那一次：日志里有 `cause` 的 code（ECONNREFUSED），界面上仍是一句人话", async () => {
		const root = await appRoot();
		const layout = resolveLayout({ appRoot: root, userRoot: root });
		const refused = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:9"), { code: "ECONNREFUSED" });
		const fetchImpl = (async () => {
			throw new TypeError("fetch failed", { cause: refused });
		}) as typeof fetch;
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		try {
			expect(await downloadRemotePlugin(layout, NAME, { feed: "http://127.0.0.1:9/", fetchImpl })).toBe(false);
			const logged = warn.mock.calls.map((call) => call.map(String).join(" ")).join("\n");
			expect(logged).toContain("ECONNREFUSED");
			expect(logged).toContain("这次没连上");
			expect((await remotePluginStatuses(layout)).find((one) => one.name === NAME)?.message).toBe("这次没连上，稍后重试");
		} finally {
			warn.mockRestore();
		}
	});

	it("断网首启：主流程不等它，界面立刻拿到五个「没装上」", async () => {
		const root = await appRoot();
		const layout = resolveLayout({ appRoot: root, userRoot: root });
		const never = new Promise<Response>(() => {
			/* 一直挂着：模拟连不上、也不立刻报错的那种网 */
		});
		const fetchImpl = (() => never) as unknown as typeof fetch;

		const running = ensureDownloadablePlugins(layout, { fetchImpl });

		// 主流程（`main.ts` 是 `void ensureDownloadablePlugins(...)`，没 await）立刻能问出状态。
		const statuses = await remotePluginStatuses(layout);
		expect(statuses.map((one) => one.name)).toEqual([...REMOTE_PLUGINS]);
		// 下载还挂着，界面这条路已经问完了 —— 谁先到谁算。
		const winner = await Promise.race([
			running.then(() => "下载完了"),
			new Promise((done) => {
				setTimeout(() => {
					done("界面");
				}, 30);
			}),
		]);
		expect(winner).toBe("界面");
	});
});
