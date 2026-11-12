/**
 * 首次联网下载出厂插件（`Token统计`、`模型管理`）。
 *
 * 每条底线都得有能自己变红的断言，不然「验过了」只是句说法（程砚-2 2026-11-12）：
 * 1. 有网：**走 API 资产直链**（带 `Accept: application/octet-stream`，一次都不碰
 *    `github.com/.../latest/download/`）、落盘、账本基线写进去；
 * 2. 篡改分两层：改清单不重签（签名拒）、签名是真的但换掉包（sha256 拒）；
 * 3. 目录在就跳过：一个请求都不发（老用户升级上来就是这个样子）；
 * 4. 用户走过删除入口：启动时不在背后装回来；**他亲手点重试才真下**，装完从 `removed` 里摘掉；
 * 5. 更新接口拿不到就明说失败，**不静默回落**到那条不通的直链；
 * 6. 清单生成器覆盖 `plugins-src/` 里每个插件，`plugins-src/` 不进包。
 */
import { execFileSync } from "node:child_process";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	DEFAULT_PLUGIN_FEED,
	PLUGIN_MANIFEST_ASSET,
	REMOTE_PLUGINS,
	downloadRemotePlugin,
	pluginFeed,
	remotePluginStatuses,
} from "../../src/shell/plugin-download.ts";
import { resolveLayout, type Layout } from "../../src/core/layout.ts";
import { buildPluginManifest, PLUGIN_ASSETS, previousTag, releaseNotes } from "../../scripts/update-manifest.ts";

const REPO = join(import.meta.dirname, "..", "..");
const SRC = join(REPO, "plugins-src");
const NAME = "Token统计";
const API_LATEST = "https://api.github.com/repos/kirer/Solo/releases/latest";

const boxes: string[] = [];

afterEach(async () => {
	for (const box of boxes.splice(0)) await rm(box, { recursive: true, force: true });
});

async function appRoot(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "plugin-download-"));
	boxes.push(root);
	await mkdir(join(root, "plugins"), { recursive: true });
	return root;
}

/** 拿真源码树生成一份真清单 + 真包，用临时密钥签上 —— 和 CI 里那一步同一个函数。 */
function feedOf(): { manifest: string; signature: string; publicKey: string; assets: Map<string, string> } {
	const built = buildPluginManifest(SRC, "2.9.15");
	const { privateKey, publicKey } = generateKeyPairSync("ed25519");
	return {
		manifest: built.text,
		signature: sign(null, Buffer.from(built.text, "utf8"), privateKey).toString("base64"),
		publicKey: publicKey.export({ type: "spki", format: "pem" }).toString(),
		assets: new Map(built.assets),
	};
}

/** 一次请求：地址 + 带的头（要断言 API 资产必须带 `Accept`）。 */
type Call = { url: string; accept: string | undefined; headers: Record<string, string> | undefined };

type ServerOptions = {
	/** `ok`（默认）：`/releases/latest` 返回真资产列表；`500`：接口回 500；`offline`：连不上。 */
	api?: "ok" | "500" | "offline";
	/** 篡改用：按资产名换掉真正发出去的字节。 */
	override?: (name: string, body: string) => string;
};

/** 用真清单 + 临时密钥签一份下载源（不经过 GitHub 那层，直接给内容）。 */
function localFeed(feed: ReturnType<typeof feedOf>, options: { api?: "ok" | "500" | "offline"; override?: (name: string, body: string) => string } = {}) {
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
		calls.push({ url, accept: headers["Accept"], headers });
		if (url === API_LATEST) {
			if (options.api === "offline") throw new TypeError("fetch failed");
			if (options.api === "500") return new Response("rate limited", { status: 500 });
			return new Response(JSON.stringify({ assets }), { status: 200 });
		}
		const name = byId.get(url.slice(url.lastIndexOf("/") + 1));
		const body = name === undefined ? undefined : bodies.get(name);
		if (body === undefined) return new Response("没有这个资产", { status: 404 });
		return new Response(options.override?.(name, body) ?? body, { status: 200 });
	}) as typeof fetch;
	return { fetchImpl, calls };
}

const hashOf = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex").slice(0, 16);

type Ledger = {
	plugins: string[];
	removed: string[];
	pluginFiles: Record<string, Record<string, string>>;
};

async function ledgerOf(layout: Layout): Promise<Ledger> {
	return JSON.parse(await readFile(layout.seedManifestFile, "utf8")) as Ledger;
}

describe("插件首次下载", () => {
	it("有网：走 API 资产直链、落盘、账本基线也写进去", async () => {
		const root = await appRoot();
		const layout = resolveLayout({ appRoot: root, userRoot: root });
		const feed = feedOf();
		const { fetchImpl, calls } = localFeed(feed);

		expect(await downloadRemotePlugin(layout, NAME, { fetchImpl, publicKey: feed.publicKey })).toBe(true);

		// 地址：先问 `/releases/latest`，再走三个资产的 API 直链。**一次都不碰 `github.com` 那条路。**
		expect(calls[0]?.url).toBe(API_LATEST);
		expect(calls.map((call) => call.url).filter((url) => url.startsWith("https://github.com/"))).toEqual([]);
		// API 的资产地址必须带 `Accept: application/octet-stream`，不然回的是 JSON 元数据。
		for (const call of calls.slice(1)) expect(call.accept).toBe("application/octet-stream");
		expect(calls).toHaveLength(4);

		for (const file of ["plugin.js", "client.js", "plugin.md"]) {
			expect(await readFile(join(root, "plugins", NAME, file), "utf8")).toBe(await readFile(join(SRC, NAME, file), "utf8"));
		}

		const ledger = await ledgerOf(layout);
		expect(ledger.plugins).toContain(NAME);
		expect(ledger.pluginFiles[NAME]?.["plugin.js"]).toBe(hashOf(await readFile(join(SRC, NAME, "plugin.js"), "utf8")));
		expect((await remotePluginStatuses(layout)).find((one) => one.name === NAME)?.state).toBe("installed");
	});

	it("改清单不重签：签名这一层拒，盘上一个文件都不写", async () => {
		const root = await appRoot();
		const layout = resolveLayout({ appRoot: root, userRoot: root });
		const feed = feedOf();
		const { fetchImpl } = localFeed(feed, {
			override: (name, body) =>
				name === PLUGIN_MANIFEST_ASSET ? body.replace(/"sha256": "([0-9a-f])/, (_all, first: string) => `"sha256": "${first === "a" ? "b" : "a"}`) : body,
		});

		expect(await downloadRemotePlugin(layout, NAME, { fetchImpl, publicKey: feed.publicKey })).toBe(false);
		expect(await readdirSafe(join(root, "plugins", NAME))).toEqual([]);
		expect((await remotePluginStatuses(layout)).find((one) => one.name === NAME)?.message).toContain("签名");
	});

	it("清单签名是真的、包被换了：sha256 这一层拒", async () => {
		const root = await appRoot();
		const layout = resolveLayout({ appRoot: root, userRoot: root });
		const feed = feedOf();
		const { fetchImpl } = localFeed(feed, {
			override: (name, body) => (name === PLUGIN_ASSETS[NAME] ? JSON.stringify({ files: { "plugin.js": "// 改过的" } }) : body),
		});

		expect(await downloadRemotePlugin(layout, NAME, { fetchImpl, publicKey: feed.publicKey })).toBe(false);
		expect(await readdirSafe(join(root, "plugins", NAME))).toEqual([]);
		expect((await remotePluginStatuses(layout)).find((one) => one.name === NAME)?.message).toContain("校验");
	});

	it("目录已经在盘上：一个请求都不发（老用户升级上来就是这个样子）", async () => {
		const root = await appRoot();
		const layout = resolveLayout({ appRoot: root, userRoot: root });
		await mkdir(join(root, "plugins", NAME), { recursive: true });
		await writeFile(join(root, "plugins", NAME, "plugin.js"), "// 用户自己那份");
		const feed = feedOf();
		const { fetchImpl, calls } = localFeed(feed);

		expect(await downloadRemotePlugin(layout, NAME, { fetchImpl, publicKey: feed.publicKey })).toBe(true);
		expect(calls).toEqual([]);
		expect(await readFile(join(root, "plugins", NAME, "plugin.js"), "utf8")).toBe("// 用户自己那份");
	});

	it("用户走过删除入口：启动时不在背后装回来，也不发请求", async () => {
		const root = await appRoot();
		const layout = resolveLayout({ appRoot: root, userRoot: root });
		await writeFile(
			layout.seedManifestFile,
			`${JSON.stringify({ version: 2, skills: {}, plugins: [NAME], pluginFiles: {}, removed: [NAME], files: {}, textKeys: {} }, null, 2)}\n`,
		);
		const feed = feedOf();
		const { fetchImpl, calls } = localFeed(feed);

		expect(await downloadRemotePlugin(layout, NAME, { fetchImpl, publicKey: feed.publicKey })).toBe(false);
		expect(calls).toEqual([]);
	});

	it("他亲手点重试：真下，装完从 removed 里摘掉、基线写上", async () => {
		const root = await appRoot();
		const layout = resolveLayout({ appRoot: root, userRoot: root });
		await writeFile(
			layout.seedManifestFile,
			`${JSON.stringify({ version: 2, skills: {}, plugins: [NAME], pluginFiles: {}, removed: [NAME], files: {}, textKeys: {} }, null, 2)}\n`,
		);
		const feed = feedOf();
		const { fetchImpl, calls } = localFeed(feed);

		expect(await downloadRemotePlugin(layout, NAME, { fetchImpl, publicKey: feed.publicKey, explicit: true })).toBe(true);
		expect(calls.length).toBeGreaterThan(0);
		const ledger = await ledgerOf(layout);
		expect(ledger.removed).not.toContain(NAME);
		expect(ledger.plugins).toContain(NAME);
		expect(Object.keys(ledger.pluginFiles[NAME] ?? {})).toContain("client.js");
	});

	it("更新接口拿不到：明说失败，**不静默回落**到 github.com 那条直链", async () => {
		for (const api of ["500", "offline"] as const) {
			const root = await appRoot();
			const layout = resolveLayout({ appRoot: root, userRoot: root });
			const feed = feedOf();
			const { fetchImpl, calls } = localFeed(feed, { api });

			expect(await downloadRemotePlugin(layout, NAME, { fetchImpl, publicKey: feed.publicKey })).toBe(false);
			// 只问了接口那一次，没去拼 `latest/download/`。
			expect(calls).toHaveLength(1);
			expect(calls.every((call) => call.url === API_LATEST)).toBe(true);
			expect((await remotePluginStatuses(layout)).find((one) => one.name === NAME)?.message).toContain("更新接口");
			expect(await readdirSafe(join(root, "plugins", NAME))).toEqual([]);
		}
	});

	it("不在白名单里的名字：直接拒，连清单都不取", async () => {
		const root = await appRoot();
		const layout = resolveLayout({ appRoot: root, userRoot: root });
		const feed = feedOf();
		const { fetchImpl, calls } = localFeed(feed);
		expect(await downloadRemotePlugin(layout, "IM机器人", { fetchImpl, publicKey: feed.publicKey })).toBe(false);
		expect(calls).toEqual([]);
	});
});

describe("清单与出厂源对得上", () => {
	it("plugins-src 里每个插件都在生成的 plugins.json 里", async () => {
		const built = buildPluginManifest(SRC, "2.9.15");
		const manifest = JSON.parse(built.text) as { plugins: { name: string; file: string; sha256: string; size: number }[] };
		expect(manifest.plugins.map((one) => one.name).sort()).toEqual([...built.bundled].sort());
		for (const entry of manifest.plugins) {
			const text = built.assets.get(entry.file);
			expect(text, `${entry.name} 没有对应的包`).toBeDefined();
			const bytes = Buffer.from(text ?? "", "utf8");
			expect(entry.size).toBe(bytes.byteLength);
			expect(entry.sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
		}
	});

	it("代码里认的那两个名字，和生成器登记的一致", () => {
		expect(Object.keys(PLUGIN_ASSETS).sort()).toEqual([...REMOTE_PLUGINS].sort());
	});

	it("插件资产名全是 ASCII（中文名在 URL 里要编码，各处都要多一层错）", () => {
		for (const file of Object.values(PLUGIN_ASSETS)) expect(file).toMatch(/^[a-z0-9./-]+$/);
	});

	it("打包白名单里没有 plugins-src（否则体积只是从 seed 挪进安装包）", async () => {
		const yml = await readFile(join(REPO, "electron-builder.yml"), "utf8");
		const block = yml.slice(yml.indexOf("files:"));
		expect(block).not.toContain("plugins-src");
		expect(block).toContain("seed/**/*");
	});
});

describe("下载源", () => {
	it("默认线上，环境变量能盖掉（只给调试和验收用）", () => {
		expect(pluginFeed()).toBe(DEFAULT_PLUGIN_FEED);
		expect(DEFAULT_PLUGIN_FEED.startsWith("https://github.com/")).toBe(true);
		expect(pluginFeed("http://127.0.0.1:9/")).toBe("http://127.0.0.1:9/");
		expect(pluginFeed("http://127.0.0.1:9")).toBe("http://127.0.0.1:9/");
	});
});

describe("上一个 tag（notes 的时间区间）", () => {
	it("tag 就打在 HEAD 上时也要拿到上一个，不能拿到它自己", async () => {
		// 造一个真仓：三个提交、三个 tag，最后一个 tag 正好在 HEAD 上 —— 这就是发版那一刻的样子。
		// `git describe` 的默认行为在这里会返回**当前**这个 tag，于是 `prev..cur` 是 0 行、
		// CI 那道红门每次都红、版本根本发不出去（Solo 2026-11-12）。
		const box = await mkdtemp(join(tmpdir(), "prev-tag-"));
		boxes.push(box);
		const git = (...args: string[]) =>
			execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: box, encoding: "utf8" });
		git("init", "-q", "-b", "main");
		for (const [index, tag] of ["v2.9.13", "v2.9.14", "v2.9.15"].entries()) {
			await writeFile(join(box, "f.txt"), `${index}\n`);
			git("add", "f.txt");
			git("commit", "-q", "-m", `feat: 第 ${index} 个`);
			git("tag", tag);
		}

		expect(previousTag("v2.9.15", box)).toBe("v2.9.14");
		const count = execFileSync("git", ["log", "--oneline", "v2.9.14..v2.9.15"], { cwd: box, encoding: "utf8" }).trim().split("\n");
		expect(count).toHaveLength(1);
		expect(previousTag("v2.9.13", box)).toBeUndefined();
	});
});

describe("清单里的 notes", () => {
	it("只留 feat / fix，去掉前缀，去重", () => {
		expect(
			releaseNotes([
				"feat(plugins): 插件改成首次下载",
				"fix: 断网首启不再卡住",
				"chore(ci): 并发组改名",
				"docs: 补文档",
				"feat: 插件改成首次下载",
			]),
		).toEqual(["插件改成首次下载", "断网首启不再卡住"]);
	});
});

/** 目录不在时返回空数组（断言「一个文件都没写」用）。 */
async function readdirSafe(path: string): Promise<string[]> {
	try {
		const { readdir } = await import("node:fs/promises");
		return (await readdir(path)).sort();
	} catch {
		return [];
	}
}
