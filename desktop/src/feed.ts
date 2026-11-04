/**
 * 更新源地址。
 *
 * 默认是本仓库的 GitHub Releases「最新版本」：`.github/workflows/release.yml` 把 zip、
 * 清单和签名作为同一个 release 的资产上传，`latest/download/<名字>` 会跳到最新那一版。
 * 运行时环境变量 `SOLO_UPDATE_URL` 可以覆盖它，好处是**不用重新打包**就能指到本地 feed
 * 上验证升级。
 *
 * 只信 https，或者 http 但主机是本机（本地测试用）。其他一律不认 —— 更新包是可以执行的东西，
 * 不该被一个随手设的环境变量指去明文端口。
 */
const GITHUB_FEED = "https://github.com/kirer/Solo/releases/latest/download/";

export const DEFAULT_FEED_URL = GITHUB_FEED;

export function resolveFeedUrl(raw: string | undefined): string | undefined {
	if (raw === undefined || raw.trim() === "") return undefined;
	let url: URL;
	try {
		url = new URL(raw.trim());
	} catch {
		return undefined;
	}
	if (url.protocol === "https:") return url.href;
	const local = url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]";
	return url.protocol === "http:" && local ? url.href : undefined;
}

/** 环境变量优先，坏值当作没设（回落到默认）。 */
export function feedUrl(): string | undefined {
	const fromEnv = resolveFeedUrl(process.env["SOLO_UPDATE_URL"]);
	if (fromEnv !== undefined) return fromEnv;
	return resolveFeedUrl(DEFAULT_FEED_URL);
}
