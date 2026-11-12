/**
 * 插件包从哪儿取（ADR-123 / ADR-127）。
 *
 * 默认源是 `https://github.com/<owner>/<repo>/releases/latest/download/`，可那个域
 * （`github.com`）在一些网络里连不上，`api.github.com` 和资产域
 * （`objects.githubusercontent.com`）却能到。所以源的形状是 GitHub Releases 时，改成
 * 问 API 要每个资产的直链；别的源（自建更新源、本机目录）照旧拼 `base + 文件名`。
 *
 * **这是 `desktop/src/release-assets.ts` 的服务端孪生**：桌面壳那份 tsconfig 的 `rootDir`
 * 钉在 `desktop/src`，引不到 `src/` 下任何文件（边界规则 7 也不许反着引），所以各存一份、
 * 两份都只写纯函数，「同一批输入两边算出同一个地址」由
 * `test/core/release-assets.test.ts` 对撞（ADR-127）。
 *
 * 为什么要走 API 直链：同一批网络里更新包能下、插件包下不动，新装用户就永久缺这两个插件，
 * 插件页常驻「没装上」。`github.com` 那一跳正是要绕开的那段（Solo 2026-11-12）。
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
	// 名字要编码：清单和资产名将来可能带空格 / `#` / 中文，裸拼会让 `#` 之后全变成 fragment。
	// 资产名是单个文件名（不含 `/`），所以按整段编码就够。
	return `${base.endsWith("/") ? base : `${base}/`}${encodeURIComponent(name)}`;
}

/**
 * 源地址归一：末尾一定带一个 `/`，拼资产名时各层不用各自判。
 * （`SOLO_PLUGIN_FEED` / 自建源手写时经常忘了尾斜杠。）
 */
export function feedBase(feed: string): string {
	return feed.endsWith("/") ? feed : `${feed}/`;
}

/** 一个资产的请求：地址 + 该带什么头（`api.github.com` 的资产要 `Accept`，直链不用）。 */
export type AssetRequest = { readonly url: string; readonly headers: Record<string, string> | undefined };

/**
 * 「资产名 → 该请求哪儿」的**唯一**算法：有 API 返回就挑资产直链，挑不到退回 `base + 名字`。
 *
 * 服务端那份在 `src/core/release-assets.ts`，两份必须算出同一个地址
 * （`test/core/release-assets.test.ts` 拿同一批输入对撞）。桌面壳的 `rootDir` 钉在 `desktop/src`，
 * 引不到 `src/` 下任何文件，只能各存一份（ADR-127）。
 */
export function assetRequest(feed: string, release: unknown, name: string): AssetRequest {
	const url = assetUrlOf(release, feedBase(feed), name);
	return { url, headers: assetHeaders(url) };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
