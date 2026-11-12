/**
 * 自动升级那条路的资产地址。
 *
 * 分两层，别混：
 * - **问 API 这一层**（`upgradeAssetSource`）：`api.github.com` 拿不到（限流 403 / 连不上）
 *   就**直接失败**，不再回落 `github.com/.../latest/download/` —— 那条短链在有些网络里就是不通，
 *   回落等于让「检查更新」在那儿白等到超时、界面上一个字都没有（2.9.16 砍掉的就是那条路，
 *   2.9.18 把升级这边也统一了）。认不出仓库的源（自建源 / 本机目录）本来没有 API，照旧拼地址。
 * - **单条资产这一层**（`upgradeAssetUrl`）：接口通了、但清单里没这个包 / 地址是空串时照旧回落
 *   `base + 名字`。老版本用户装不上更新比撞一个坏地址更糟。
 *
 * 为什么单独一个文件：`updates.ts` 顶层 import 了 electron，vitest 里跑不了；这层语义必须有用例钉住
 * （`test/desktop/update-asset.test.ts`）。
 */
import { assetUrlOf, latestReleaseApi } from "./release-assets.ts";

/** 问一次 `/releases/latest`，返回「资产名 → 地址」。拿不到就抛，**不回落**。 */
export async function upgradeAssetSource(
	feed: string,
	fetchText: (url: string) => Promise<string>,
): Promise<(name: string) => string> {
	const base = feed.endsWith("/") ? feed : `${feed}/`;
	const api = latestReleaseApi(base);
	if (api === undefined) return (name) => `${base}${encodeURIComponent(name)}`;
	let body: string;
	try {
		body = await fetchText(api);
	} catch (error) {
		// 原因带进 `cause`：日志要能打出根因（`code` 是 ECONNREFUSED / ENOTFOUND / 超时）。
		throw new Error(`更新接口没通：${(error as Error).message}`, { cause: error });
	}
	let release: unknown;
	try {
		release = JSON.parse(body) as unknown;
	} catch {
		throw new Error("更新接口返回的东西看不懂（不是 JSON）");
	}
	return (name) => upgradeAssetUrl(release, base, name);
}

export function upgradeAssetUrl(release: unknown, feed: string, name: string): string {
	const base = feed.endsWith("/") ? feed : `${feed}/`;
	try {
		return assetUrlOf(release, base, name);
	} catch (error) {
		console.warn(`[update] ${(error as Error).message}，退回 ${base}${encodeURIComponent(name)}`);
		return `${base}${encodeURIComponent(name)}`;
	}
}
