/**
 * 自动升级那条路的资产地址。
 *
 * 分两层，别混（取顺序见下面的 `fetchAssetText`：直链优先，API 只做回落）：
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

/** 直链：`base + 编码后的名字`，走 release 资产，**不计 `api.github.com` 的额度**。 */
export function directAssetUrl(feed: string, name: string): string {
	const base = feed.endsWith("/") ? feed : `${feed}/`;
	return `${base}${encodeURIComponent(name)}`;
}

/**
 * 取清单 / 签名：**先直链，直链不通才问 API**（2026-11-16 翻的，原来是先问 API）。
 *
 * 反转的理由：`api.github.com` 未认证只有 60 次/小时，**按出口 IP 算**。同一个出口上
 * CI、真机验收、界面冒烟轮着刷，额度就见底了，老板机器上于是只看到
 * 「检查更新失败：没连上（GitHub 限流）」。直链走 release 资产（`…/releases/latest/download/<名字>`，
 * 302 到 CDN），一次都不占那个额度。
 *
 * 没把 API 整条砍掉：有些网络到不了 `github.com`、`api.github.com` 和资产域却能到（ADR-123
 * 当初就是为这个才改成问 API 的）。那类网络直链先失败一次、再问到 API，慢几秒但拿到了。
 * `via` 交回给调用方：清单是直链取到的，包也走直链，不再问第二次 API。
 */
export async function fetchAssetText(
	feed: string,
	name: string,
	fetchText: (url: string) => Promise<string>,
): Promise<{ readonly text: string; readonly via: "direct" | "api" }> {
	try {
		return { text: await fetchText(directAssetUrl(feed, name)), via: "direct" };
	} catch (error) {
		console.warn(`[update] 直链取 ${name} 没成（${(error as Error).message}），改问 API`);
	}
	const source = await upgradeAssetSource(feed, fetchText);
	return { text: await fetchText(source(name)), via: "api" };
}

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
