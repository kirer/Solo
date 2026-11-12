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
 * 从 `/releases/latest` 的返回里挑一个资产。
 *
 * 三种走向：
 * - 有资产列表、名字对得上、地址可用 → 回那个地址（正常路径）。
 * - 有资产列表、但没这个名字（发布时漏传），或者名字对上了地址却是空串 / 不是字符串 →
 *   **抛「清单里没有这个包」**，不再回落 `github.com`：那条直链在一些网络里就是连不上，
 *   回落等于让人白等到超时，界面上只剩「稍后重试」指不到真原因（程砚-2 2026-11-12）。
 * - 根本没有资产列表（`release` 是 `undefined` / `{}`，即认不出仓库的自建源、本机目录、
 *   或者 API 没拿到）→ 退回 `base + name`，这条必须留着，镜像与自建源靠它。
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
			// 名字对上了、地址却是空串或不是字符串：和「清单里没这个包」同一条路。
			// 再回落去 `github.com` 只会白等到超时，界面上那句「稍后重试」指不到真原因。
			if (typeof url === "string" && url !== "") return url;
			throw new Error(missingPackageOf(name));
		}
		// 接口通了、清单里真没这个包（发布时漏传）：直接失败，别回落去那条连不上的直链。
		throw new Error(missingPackageOf(name));
	}
	// 名字要编码：清单和资产名将来可能带空格 / `#` / 中文，裸拼会让 `#` 之后全变成 fragment。
	// 资产名是单个文件名（不含 `/`），所以按整段编码就够。
	return `${base.endsWith("/") ? base : `${base}/`}${encodeURIComponent(name)}`;
}

/**
 * 「清单里没这个包」那一句话。`src/shell/plugin-download.ts` 的 `humanMessage` 认这个短语
 * 换成人话给界面看；`desktop/src/updates.ts` 那条自动升级路径接住它、照旧回落 `base + 名字`。
 */
function missingPackageOf(name: string): string {
	return `清单里没有这个包：${name}`;
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
