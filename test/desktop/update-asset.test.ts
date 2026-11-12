/**
 * 自动升级那条路的资产地址。
 *
 * 两层，判据不同，别混：
 * - **问 API 那一层**（`upgradeAssetSource`，2.9.18 改的）：`api.github.com` 拿不到就**直接失败、
 *   不回落** `github.com/.../latest/download/` —— 回落等于让「检查更新」在那儿白等 30 秒、
 *   界面上一个字都没有（2.9.16 砍掉的正是那条路，2.9.17 升级这边还留着）。
 * - **单条资产那一层**（`upgradeAssetUrl`，行为一个字不变）：接口通了、清单里没这个包 / 地址是空串
 *   时照旧回落 `base + 名字` —— 老版本用户装不上更新比撞一个坏地址更糟。这条钉子留着。
 */
import { describe, expect, it } from "vitest";
import { upgradeAssetSource, upgradeAssetUrl } from "../../desktop/src/update-asset.ts";
import { errorDetail, updateFailureMessage } from "../../desktop/src/update-failure.ts";

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

describe("问 API 那一层：拿不到就失败，不回落", () => {
	const asked: string[] = [];
	const answer = (body: unknown, status = 200) => async (url: string): Promise<string> => {
		asked.push(url);
		if (status !== 200) throw new TypeError(`取 ${url} 失败：${String(status)}`);
		return JSON.stringify(body);
	};

	it("拿到了：走 API 直链，问一次就够", async () => {
		asked.length = 0;
		const asset = await upgradeAssetSource(FEED, answer(release));
		expect(asked).toEqual(["https://api.github.com/repos/kirer/Solo/releases/latest"]);
		expect(asset("Solo-2.9.15-arm64.zip")).toBe("https://api.github.com/repos/kirer/Solo/releases/assets/42");
	});

	it("接口不通（限流 403 / 连不上）：抛，**一次都不碰 github.com 那条短链**", async () => {
		asked.length = 0;
		await expect(upgradeAssetSource(FEED, answer({ message: "API rate limit exceeded" }, 403))).rejects.toThrow("更新接口没通");
		expect(asked.filter((url) => url.startsWith("https://github.com/"))).toEqual([]);

		const offline = async (): Promise<string> => {
			throw new TypeError("fetch failed", { cause: Object.assign(new Error("getaddrinfo ENOTFOUND api.github.com"), { code: "ENOTFOUND" }) });
		};
		const error = await upgradeAssetSource(FEED, offline).catch((thrown: unknown) => thrown);
		expect(updateFailureMessage(error)).toBe("检查更新没连上，稍后重试");
		// 日志里看得到根因（`TypeError: fetch failed` 分不出拒绝还是超时）。
		expect(errorDetail(error)).toContain("ENOTFOUND");
	});

	it("接口通了但回的看不懂：抛，别拿它拼地址", async () => {
		const broken = async (): Promise<string> => "<html>502</html>";
		await expect(upgradeAssetSource(FEED, broken)).rejects.toThrow("看不懂");
	});

	it("认不出仓库的源（自建 / 本机目录）：本来没有 API，照旧拼 `base + 名字`", async () => {
		asked.length = 0;
		const asset = await upgradeAssetSource("http://127.0.0.1:9", answer(release));
		expect(asked).toEqual([]);
		expect(asset("latest-win.json")).toBe("http://127.0.0.1:9/latest-win.json");
	});
});

describe("失败那句话：限流 / 连不上 / 签名 三种分得开", () => {
	it("三种各自一句人话，不把原文直接丢给用户", () => {
		expect(updateFailureMessage(new Error("更新接口没通：403 Forbidden"))).toBe("检查更新没连上（GitHub 限流），稍后重试");
		expect(updateFailureMessage(new Error("更新接口没通：fetch failed"))).toBe("检查更新没连上，稍后重试");
		expect(updateFailureMessage(new Error("清单签名不对"))).toBe("更新清单签名不对，已拒绝这个版本");
		expect(updateFailureMessage(new Error("校验失败：sha512 对不上"))).toBe("下载回来的包校验没过，已拒绝安装");
		// 认不出的：至少别撒谎，把原文带上。
		expect(updateFailureMessage(new Error("说不清"))).toBe("检查更新失败：说不清");
	});

	it("`cause` 链一直打到最里层（最多四层）", () => {
		const root = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:9"), { code: "ECONNREFUSED" });
		const middle = new TypeError("fetch failed", { cause: root });
		expect(errorDetail(new Error("更新接口没通：fetch failed", { cause: middle }))).toBe(
			"Error: 更新接口没通：fetch failed ← TypeError: fetch failed ← Error: connect ECONNREFUSED 127.0.0.1:9 [ECONNREFUSED]",
		);
		expect(errorDetail(undefined)).toBe("");
	});
});
