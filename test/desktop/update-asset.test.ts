/**
 * 自动升级那条路的资产地址（2.9.16）：**行为一个字不变**。
 *
 * 硬失败只给插件下载那边（`assetUrlOf` 缺包抛「清单里没有这个包」）；升级这边必须照旧回落
 * `base + 名字` —— 老版本用户装不上更新比撞一个坏地址更糟。这条用例就是那个「不许顺手改掉」的钉子。
 */
import { describe, expect, it } from "vitest";
import { upgradeAssetUrl } from "../../desktop/src/update-asset.ts";

const FEED = "https://github.com/kirer/Solo/releases/latest/download/";
const release = {
	assets: [{ name: "Solo-2.9.15-arm64.zip", url: "https://api.github.com/repos/kirer/Solo/releases/assets/42" }],
};

describe("自动升级取资产地址", () => {
	it("清单里有这个包：仍走 API 直链（正常路径没变）", () => {
		expect(upgradeAssetUrl(release, FEED, "Solo-2.9.15-arm64.zip")).toBe(
			"https://api.github.com/repos/kirer/Solo/releases/assets/42",
		);
	});

	it("清单里没这个包：不抛，照旧回落 base + 名字", () => {
		expect(upgradeAssetUrl(release, FEED, "Solo-2.9.15-x64.zip")).toBe(`${FEED}Solo-2.9.15-x64.zip`);
		// 尾斜杠不写也得拼对。
		expect(upgradeAssetUrl(release, "https://updates.example.com", "latest-mac.json")).toBe(
			"https://updates.example.com/latest-mac.json",
		);
		// 名字里有空格 / 中文照样要编码。
		expect(upgradeAssetUrl(release, FEED, "更新 包.zip")).toBe(`${FEED}%E6%9B%B4%E6%96%B0%20%E5%8C%85.zip`);
	});

	it("名字对上了、地址是空串 / 不是字符串：也照旧回落（不抛）", () => {
		expect(upgradeAssetUrl({ assets: [{ name: "a.zip", url: "" }] }, FEED, "a.zip")).toBe(`${FEED}a.zip`);
		expect(upgradeAssetUrl({ assets: [{ name: "a.zip", url: 7 }] }, FEED, "a.zip")).toBe(`${FEED}a.zip`);
	});

	it("API 没拿到（release 是 undefined / {}）：照旧回落", () => {
		expect(upgradeAssetUrl(undefined, FEED, "latest-mac.json")).toBe(`${FEED}latest-mac.json`);
		expect(upgradeAssetUrl({}, "http://127.0.0.1:9/", "latest-win.json")).toBe("http://127.0.0.1:9/latest-win.json");
	});
});
