/**
 * 更新资产的地址（ADR-123）：GitHub 源问 API 要直链，别的源照旧拼地址。
 * 真请求在 `updates.ts`（要 Electron），这里只守纯函数。
 */
import { describe, expect, it } from "vitest";
import { assetHeaders, assetUrlOf, githubRepoOf, latestReleaseApi } from "../../desktop/src/release-assets.ts";

const FEED = "https://github.com/kirer/Solo/releases/latest/download/";

describe("认更新源", () => {
	it("GitHub Releases 的源认得出仓库（带不带结尾的斜杠都行）", () => {
		expect(githubRepoOf(FEED)).toEqual({ owner: "kirer", repo: "Solo" });
		expect(githubRepoOf("https://github.com/kirer/Solo/releases/latest/download")).toEqual({
			owner: "kirer",
			repo: "Solo",
		});
	});

	it("自建更新源不认成 GitHub", () => {
		expect(githubRepoOf("https://updates.example.com/")).toBeUndefined();
		expect(githubRepoOf("http://127.0.0.1:8793/")).toBeUndefined();
	});

	it("API 地址只在 GitHub 源上有", () => {
		expect(latestReleaseApi(FEED)).toBe("https://api.github.com/repos/kirer/Solo/releases/latest");
		expect(latestReleaseApi("https://updates.example.com/")).toBeUndefined();
	});
});

describe("挑资产", () => {
	const release = {
		assets: [
			{ name: "latest-mac.json", url: "https://api.github.com/repos/kirer/Solo/releases/assets/42" },
			{ name: 3 },
			{ name: "latest-mac.json.sig", url: "" },
		],
	};

	it("清单里有的资产用 API 的资产地址（不是 github.com 上的直链）", () => {
		expect(assetUrlOf(release, FEED, "latest-mac.json")).toBe(
			"https://api.github.com/repos/kirer/Solo/releases/assets/42",
		);
	});

	it("挑不到 / 地址是空串就退回源地址", () => {
		expect(assetUrlOf(release, FEED, "latest-mac.json.sig")).toBe(`${FEED}latest-mac.json.sig`);
		expect(assetUrlOf(release, FEED, "Solo-2.3.4-arm64.zip")).toBe(`${FEED}Solo-2.3.4-arm64.zip`);
		expect(assetUrlOf({}, FEED, "latest-mac.json")).toBe(`${FEED}latest-mac.json`);
		expect(assetUrlOf(undefined, "https://updates.example.com", "latest-win.json")).toBe(
			"https://updates.example.com/latest-win.json",
		);
	});
});

describe("取资产的请求头", () => {
	it("API 的资产地址要 application/octet-stream，别的一概不带", () => {
		expect(assetHeaders("https://api.github.com/repos/kirer/Solo/releases/assets/42")).toEqual({
			Accept: "application/octet-stream",
		});
		expect(assetHeaders(FEED + "latest-mac.json")).toBeUndefined();
		expect(assetHeaders("https://updates.example.com/latest-win.json")).toBeUndefined();
	});
});
