/**
 * 更新清单和包从哪儿取（ADR-123）。
 *
 * 默认更新源是 `https://github.com/<owner>/<repo>/releases/latest/download/`，可那个域
 * （`github.com`）在一些网络里连不上，`api.github.com` 和资产域
 * （`objects.githubusercontent.com`）却能到。所以源的形状是 GitHub Releases 时，改成
 * 问 API 要每个资产的直链；别的源（自建更新源、本机目录）照旧拼 `base + 文件名`。
 *
 * 这里只有认地址和挑资产的纯函数 —— 请求、重试、代理都在 `updates.ts`，
 * 这样 `test/desktop/release-assets.test.ts` 能直接测。
 */

export type GithubRepo = { readonly owner: string; readonly repo: string };

/** 资产接口（`api.github.com/.../releases/assets/<id>`）要这个头才回文件本体。 */
export function assetHeaders(url: string): Record<string, string> | undefined {
	return url.startsWith("https://api.github.com/repos/") && url.includes("/releases/assets/")
		? { Accept: "application/octet-stream" }
		: undefined;
}

/** `…/releases/latest/download/` 这种源才认得出仓库；别的（自建源）返回 undefined。 */
export function githubRepoOf(feed: string): GithubRepo | undefined {
	const match = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/releases\/latest\/download\/?$/.exec(feed);
	const owner = match?.[1];
	const repo = match?.[2];
	return owner === undefined || repo === undefined ? undefined : { owner, repo };
}

/** GitHub 的「最新版本」接口；认不出仓库就没有这一条。 */
export function latestReleaseApi(feed: string): string | undefined {
	const repo = githubRepoOf(feed);
	return repo === undefined ? undefined : `https://api.github.com/repos/${repo.owner}/${repo.repo}/releases/latest`;
}

/**
 * 从 `/releases/latest` 的返回里挑一个资产；挑不到（或格式不对）就退回 `base + name`。
 *
 * 用 `url`（`api.github.com/.../releases/assets/<id>`）而不是 `browser_download_url`：
 * 前者在能连上 API 的网络里就能用（它 302 到 `objects.githubusercontent.com`），
 * 后者在 `github.com` 上，一些网络连不上 —— 这正是绕开的那一段。
 * 取它要带 `Accept: application/octet-stream`（`assetHeaders`）。
 */
export function assetUrlOf(release: unknown, base: string, name: string): string {
	const assets = isRecord(release) ? release["assets"] : undefined;
	if (Array.isArray(assets)) {
		for (const asset of assets) {
			if (!isRecord(asset)) continue;
			if (asset["name"] !== name) continue;
			const url = asset["url"];
			if (typeof url === "string" && url !== "") return url;
		}
	}
	return `${base.endsWith("/") ? base : `${base}/`}${name}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
