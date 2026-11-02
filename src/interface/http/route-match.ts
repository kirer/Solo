/**
 * 表驱动的路由匹配：这条请求归哪个 handler。
 *
 * 刻意**不引入框架**：需求只有「按段匹配 + `:param` 捕获 + 末尾通配」，
 * 三十行就够；框架带来的中间件链反而会让 handler 的调用时机变得不直观。
 */
// ── 路由匹配（原 `match.ts`）────────────────────────────────────────────
// 并进这里的原因：它是「这条请求归哪个 handler」的判据，只被 server 用。

/**
 * 表驱动的路由匹配。
 *
 * 为什么单独一个文件：之前是一条 25 个 `if` 的长链，
 * 加上 `/api/channels/:id` 这类前缀判断混在里面，「这个路径到底归谁处理」
 * 必须从头往下读才知道。表驱动把「有哪些端点」变成一张可一眼看完的表。
 *
 * 刻意**不引入框架**：需求只有「按段匹配 + `:param` 捕获 + 末尾通配」，
 * 三十行就够；框架带来的中间件链反而会让 handler 的调用时机变得不直观。
 */

/** 一条路由。 */
export type Route = {
	/**
	 * 允许的方法，`"*"` 表示全部。
	 *
	 * 省略表示 `"*"`——因为多数 handler 自己在内部再分 GET/POST。
	 * 但**同一路径不同方法**（`/api/models` 的 POST / PATCH / DELETE）
	 * 写成三条同 pattern 的路由更清楚，所以这个字段仍然有用。
	 */
	readonly method?: string | readonly string[] | "*";
	/**
	 * 路径模板，按 `/` 分段匹配。
	 *
	 * - `:name` 捕获一段（不含 `/`）；
	 * - `*name` 捕获剩余全部（可含 `/`），必须是最后一段；
	 * - 其余按字面比较。
	 */
	readonly pattern: string;
	readonly handler: RouteHandler;
};

/** handler 拿到的请求上下文。 */
export type RouteContext = {
	readonly request: import("node:http").IncomingMessage;
	readonly response: import("node:http").ServerResponse;
	readonly url: URL;
	readonly path: string;
	readonly method: string;
	/** 路径参数，值已 `decodeURIComponent`（`*name` 捕获的是整段原文，未逐段解码）。 */
	readonly params: Readonly<Record<string, string>>;
};

export type RouteHandler = (context: RouteContext) => void | Promise<void>;

/** 命中的路由与参数。 */
export type RouteMatch = {
	readonly route: Route;
	readonly params: Readonly<Record<string, string>>;
};

function allows(route: Route, method: string): boolean {
	const allowed = route.method ?? "*";
	if (allowed === "*") return true;
	return typeof allowed === "string" ? allowed === method : allowed.includes(method);
}

function segmentsOf(path: string): string[] {
	// 前后 `/` 都去掉：`/api/models` 与 `/api/models/` 是同一个端点。
	const trimmed = path.replace(/^\/+/, "").replace(/\/+$/, "");
	return trimmed === "" ? [] : trimmed.split("/");
}

function decodeSegment(raw: string): string {
	try {
		return decodeURIComponent(raw);
	} catch {
		// 非法的百分号编码不该让整个请求 400——原样返回，由 handler 自己判断。
		return raw;
	}
}

/**
 * 匹配一条路由。
 *
 * 语义上等同于「把表按顺序扫一遍，第一条同时满足方法与路径的胜出」。
 * 顺序敏感（`/api/channels/*id` 通配要放在 `/api/channels/:id/read` 之后），
 * 所以调用方必须把**具体的写在通配的前面**——`routes.ts` 里已经按这个原则排好了。
 */
export function matchRoute(
	routes: readonly Route[],
	method: string,
	path: string,
): RouteMatch | undefined {
	const actual = segmentsOf(path);
	for (const route of routes) {
		if (!allows(route, method)) continue;
		const pattern = segmentsOf(route.pattern);
		const params: Record<string, string> = {};
		let matched = true;
		for (let index = 0; index < pattern.length; index += 1) {
			const part = pattern[index] as string;
			if (part.startsWith("*")) {
				// 通配：吃掉剩余全部（含空串，`/uploads/*rest` 要能匹配 `/uploads/`）。
				params[part.slice(1)] = actual.slice(index).join("/");
				index = pattern.length;
				matched = true;
				break;
			}
			if (index >= actual.length) {
				matched = false;
				break;
			}
			const segment = actual[index] as string;
			if (part.startsWith(":")) {
				params[part.slice(1)] = decodeSegment(segment);
				continue;
			}
			if (part !== segment) {
				matched = false;
				break;
			}
		}
		// 通配已提前 break，这里只需补上「段数必须相等」。
		if (matched) {
			const hasWildcard = pattern.some((part) => part.startsWith("*"));
			if (!hasWildcard && actual.length !== pattern.length) matched = false;
		}
		if (matched) return { route, params };
	}
	return undefined;
}
