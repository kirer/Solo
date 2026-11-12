/**
 * 地址算法有两份：`src/core/release-assets.ts` 与 `desktop/src/release-assets.ts`。
 *
 * 桌面壳那份 tsconfig 的 `rootDir` 钉在 `desktop/src`，引不到 `src/` 下任何文件；边界规则 7
 * 也不许反过来引（一开这个口子，壳和核心就分不开了）。所以按 ADR-127 走「两边各一份 + 一条对撞」：
 * **同一批输入，两边必须算出同一个地址、同一组头**。任何人只改了一边，这里当场红。
 *
 * 覆盖三种输入（Solo / 程砚-2 2026-11-12 点名）：默认 GitHub 源、`SOLO_PLUGIN_FEED` 指本机端口、
 * 文件名带特殊字符（空格 / 中文 / `#` / `?`，抓的就是「一处编码一处裸拼」）。
 */
import { describe, expect, it } from "vitest";
import * as core from "../../src/core/release-assets.ts";
import * as desktop from "../../desktop/src/release-assets.ts";

const GITHUB = "https://github.com/kirer/Solo/releases/latest/download/";
const GITHUB_NO_SLASH = "https://github.com/kirer/Solo/releases/latest/download";
const LOCAL = "http://127.0.0.1:9";
const PLAIN = "plugins.json";
const WEIRD = "plugin 统计#1?.json";

/** 一份像样的 `/releases/latest` 返回：两个资产，第二个地址是空串（要退回直链那种）。 */
const release = {
	assets: [
		{ name: PLAIN, url: "https://api.github.com/repos/kirer/Solo/releases/assets/42" },
		{ name: WEIRD, url: "https://api.github.com/repos/kirer/Solo/releases/assets/43" },
		{ name: "plugins.json.sig", url: "" },
	],
};

const feeds = [GITHUB, GITHUB_NO_SLASH, LOCAL];

describe("两份孪生算出的地址必须一样", () => {
	it("认仓库、认最新版本接口", () => {
		for (const feed of feeds) {
			expect(core.githubRepoOf(feed)).toEqual(desktop.githubRepoOf(feed));
			expect(core.latestReleaseApi(feed)).toEqual(desktop.latestReleaseApi(feed));
		}
		expect(core.latestReleaseApi(LOCAL)).toBeUndefined();
		expect(core.latestReleaseApi(GITHUB_NO_SLASH)).toBe("https://api.github.com/repos/kirer/Solo/releases/latest");
	});

	it("尾斜杠归一", () => {
		for (const feed of feeds) expect(core.feedBase(feed)).toBe(desktop.feedBase(feed));
		expect(core.feedBase(GITHUB_NO_SLASH)).toBe(GITHUB);
		expect(core.feedBase(LOCAL)).toBe("http://127.0.0.1:9/");
	});

	it("三种输入 × 四种资产名：地址和头一字不差（抛的时候两边的原话也得一样）", () => {
		const names = [PLAIN, WEIRD, "plugins.json.sig", "plugin-token-stats.json"];
		// 缺包这一支变了语义：两边都要抛，而且抛的必须是同一句话 —— 只改一边当场红。
		const outcome = (run: () => unknown): { ok: unknown } | { err: string } => {
			try {
				return { ok: run() };
			} catch (error) {
				return { err: (error as Error).message };
			}
		};
		for (const feed of feeds) {
			for (const name of names) {
				const mine = outcome(() => core.assetRequest(feed, release, name));
				const theirs = outcome(() => desktop.assetRequest(feed, release, name));
				expect(mine, `${feed} / ${name}`).toEqual(theirs);
			}
		}
		// 名字在清单里、地址可用：仍是 API 直链（正常路径一个字没变）。
		expect(core.assetRequest(GITHUB, release, PLAIN).url).toBe("https://api.github.com/repos/kirer/Solo/releases/assets/42");
	});

	it("清单里没这个包 / 地址是空串：两边都抛「清单里没有这个包」，不回落", () => {
		for (const feed of [GITHUB, GITHUB_NO_SLASH, LOCAL]) {
			for (const name of ["plugins.json.sig", "plugin-token-stats.json"]) {
				expect(() => core.assetRequest(feed, release, name), `${feed} / ${name}`).toThrow(`清单里没有这个包：${name}`);
				expect(() => desktop.assetRequest(feed, release, name), `${feed} / ${name}`).toThrow(`清单里没有这个包：${name}`);
			}
		}
		// 名字对上了、地址不是字符串：同一条路。
		const broken = { assets: [{ name: PLAIN, url: 7 }] };
		expect(() => core.assetUrlOf(broken, GITHUB, PLAIN)).toThrow(`清单里没有这个包：${PLAIN}`);
		expect(() => desktop.assetUrlOf(broken, GITHUB, PLAIN)).toThrow(`清单里没有这个包：${PLAIN}`);
	});

	it("API 拿不到资产（release 是 undefined）时也一致，且名字要编码", () => {
		for (const feed of [GITHUB, LOCAL]) {
			const mine = core.assetRequest(feed, undefined, WEIRD);
			expect(mine).toEqual(desktop.assetRequest(feed, undefined, WEIRD));
			// 裸拼会把 `#` 之后全当 fragment、`?` 之后全当 query —— 落点就错了。
			expect(mine.url).toContain("plugin%20%E7%BB%9F%E8%AE%A1%231%3F.json");
			expect(mine.url).not.toContain("#");
			expect(mine.url).not.toContain("?");
			expect(mine.headers).toBeUndefined();
		}
		expect(core.assetRequest(LOCAL, undefined, PLAIN).url).toBe("http://127.0.0.1:9/plugins.json");
	});

	it("API 的资产地址一定带 Accept: application/octet-stream", () => {
		for (const feed of [GITHUB, GITHUB_NO_SLASH]) {
			const request = core.assetRequest(feed, release, PLAIN);
			expect(request.url).toBe("https://api.github.com/repos/kirer/Solo/releases/assets/42");
			expect(request.headers).toEqual({ Accept: "application/octet-stream" });
			expect(request).toEqual(desktop.assetRequest(feed, release, PLAIN));
		}
	});

	it("两份的源文件除了头注释之外不许各自演化", async () => {
		const { readFile } = await import("node:fs/promises");
		const strip = (source: string): string =>
			source
				.replace(/^\/\*\*[\s\S]*?\*\/\n/, "") // 文件头注释两边各写各的（各说各的用途）
				.replaceAll(/\n+/g, "\n")
				.trim();
		const mine = strip(await readFile(new URL("../../src/core/release-assets.ts", import.meta.url), "utf8"));
		const theirs = strip(await readFile(new URL("../../desktop/src/release-assets.ts", import.meta.url), "utf8"));
		expect(mine).toBe(theirs);
	});
});
