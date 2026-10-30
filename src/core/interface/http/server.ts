/**
 * HTTP 的**原语**：发一份 JSON、发一个错误、读一份 JSON 正文、发一个静态文件。
 *
 * 这里不认识任何业务概念（频道、记忆、文件树都不在这），所以它不会被业务改动牵连。
 * 反过来，业务 handler 只允许用这四个原语出口，别自己拼 `writeHead` —— 否则
 * 「失败统一是 `{error}` + 4xx/5xx」这条契约会在某个角落里悄悄破掉。
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { networkInterfaces } from "node:os";
import { promisify } from "node:util";
import { brotliCompress, constants as zlibConstants, gzip } from "node:zlib";
import { extname, join, normalize, sep } from "node:path";
import { readBody, UploadTooLargeError } from "../../app/index.ts";
import { AppError, type AppErrorReason } from "../../app/errors.ts";

/** 写接口的 JSON 正文上限。正常消息几千字，1MB 已经宽得离谱。 */
const JSON_BODY_LIMIT = 1 << 20;

/** MIME 表（静态资源用；只列 `ui/` 里真正存在的类型）。 */
const MIME: Record<string, string> = {
	".html": "text/html; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".json": "application/json; charset=utf-8",
	".svg": "image/svg+xml",
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".webp": "image/webp",
	".ico": "image/x-icon",
	".woff2": "font/woff2",
	".map": "application/json; charset=utf-8",
};

export function json(response: ServerResponse, value: unknown): void {
	const body = JSON.stringify(value);
	response.writeHead(200, {
		"Content-Type": "application/json; charset=utf-8",
		"Cache-Control": "no-store",
		"Content-Length": Buffer.byteLength(body),
	});
	response.end(body);
}

export function fail(response: ServerResponse, status: number, message: string): void {
	if (response.headersSent) {
		response.end();
		return;
	}
	const body = JSON.stringify({ error: message });
	response.writeHead(status, {
		"Content-Type": "application/json; charset=utf-8",
		"Cache-Control": "no-store",
		"Content-Length": Buffer.byteLength(body),
	});
	response.end(body);
}

/**
 * 带 HTTP 状态码的错误。路由里 throw，由 `serve.ts` 的 `handle` 翻成对应响应。
 *
 * 存在的理由：`readJson` 这类底层函数拿不到 `response`，而「客户端发错了」和
 * 「服务端炸了」必须给不同的状态码 —— 都报 500 的话，前端与审计都无从判断。
 */
export class HttpError extends Error {
	readonly status: number;

	constructor(status: number, message: string) {
		super(message);
		this.name = "HttpError";
		this.status = status;
	}
}

export async function readJson<T>(
	request: IncomingMessage,
	options: { readonly requireJson?: boolean } = {},
): Promise<T> {
	// 边读边数：先读完再比上限等于没有上限（一个 4GB 的请求先把内存吃光）。
	// 超限抛 `UploadTooLargeError`，由 `handle` 翻成 413。
	const bytes = await readBody(request, JSON_BODY_LIMIT);
	const text = bytes.toString("utf8").trim();
	// 有正文就必须声明 `application/json`：浏览器的表单能把合法 JSON 塞进 `text/plain`
	// 正文（`<input name='{"text":"x","y":"' value='"}'>`），这是 Origin 闸之外最后一条
	// CSRF 写法 —— 而浏览器**不会**让跨站表单发出 `application/json`（那要预检）。
	// 没有正文的 POST（脚本点一下已读）放行：它带不动任何数据。
	// `requireJson` 给「空正文也有副作用」的接口用（诊断落盘）：没有正文的跨站表单照样能写，
	// 所以那两个接口连空正文也必须声明 JSON。
	const declared = (request.headers["content-type"] ?? "").trim().toLowerCase().startsWith("application/json");
	if ((text !== "" || options.requireJson === true) && !declared) {
		throw new HttpError(415, "写接口只收 application/json");
	}
	if (text === "") return {} as T;
	try {
		return JSON.parse(text) as T;
	} catch {
		return {} as T;
	}
}

/** 正文超限是客户端的错，别让它变成 500（500 会让人以为是服务挂了）。 */
/**
 * 用例原因 → HTTP 状态码。**这张表住在接口层**：用例层只说「找不到」，说 404 是这里的事
 * （ADR-082）。状态码本身是界面契约的一部分（前端按 4xx 决定「要不要重试」），所以不许乱改。
 */
const STATUS_OF_REASON = {
	"bad-request": 400,
	forbidden: 403,
	"not-found": 404,
	"too-large": 413,
	internal: 500,
} satisfies Record<AppErrorReason, number>;

/** 能翻成响应的异常：客户端的错（`HttpError`/附件超限）与用例的拒绝（`AppError`）。 */
export function statusOf(error: unknown): { status: number; message: string } | undefined {
	if (error instanceof UploadTooLargeError) return { status: 413, message: error.message };
	if (error instanceof HttpError) return { status: error.status, message: error.message };
	if (error instanceof AppError) return { status: STATUS_OF_REASON[error.reason], message: error.message };
	return undefined;
}

/**
 * 发静态资源：压缩 + 条件请求 + SPA 回退。
 *
 * 策略：入口页 `no-cache`（改了立刻生效）、其余资源长缓存 + ETag 验证、
 * 文本资源按 `Accept-Encoding` 协商 br/gzip。
 */
export async function serveStatic(
	response: ServerResponse,
	request: IncomingMessage,
	rootDir: string,
	path: string,
): Promise<void> {
	const relative = path === "/" ? "index.html" : path.replace(/^\/+/, "");
	const root = normalize(rootDir);
	const target = normalize(join(rootDir, relative));
	if (!insideRoot(root, target)) return fail(response, 403, "禁止访问");

	const asset: AssetEntry | undefined = await loadAsset(target);

	if (asset !== undefined) {
		return await sendAsset(response, request, asset, relative, MIME[extname(target)] ?? "application/octet-stream");
	}

	// SPA 回退只对页面路径生效：带扩展名的资源找不到就是 404，不能回 index.html
	// （否则浏览器把 HTML 当 JS 解析，报一堆莫名其妙的语法错误）。
	if (path.startsWith("/api/") || extname(path) !== "") return fail(response, 404, "未找到");
	const index = await loadAsset(join(rootDir, "index.html"));
	if (index === undefined) return fail(response, 404, "未找到");
	return await sendAsset(response, request, index, "index.html", MIME[".html"] ?? "text/html; charset=utf-8");
}

async function sendAsset(
	response: ServerResponse,
	request: IncomingMessage,
	asset: AssetEntry,
	relative: string,
	contentType: string,
): Promise<void> {
	const canCompress = compressible(contentType);
	const wanted = canCompress ? negotiateEncoding(request.headers["accept-encoding"]) : "identity";
	const { body, encoding } = await bodyFor(asset, wanted);
	const etag = etagFor(asset, encoding);
	const headers: Record<string, string> = {
		"Content-Type": contentType,
		// 只有字体和图片敢让浏览器先用旧的：它们的文件名就是内容（`plex-sans-400`、`宽图.png`），
		// 换内容一定换名字。`js` / `css` / `html` 全部 `no-cache` —— 有 ETag 与
		// Last-Modified 兜底，命中就是 304（正文 0 字节），代价是一次条件请求；
		// 但换来的是「改完刷新一定拿到新代码」。早先是 `max-age=300`，结果改完
		// 五分钟内刷新仍然是旧 JS —— 调试时 indistinguishable，白查半小时。
		"Cache-Control": /[.](?:js|css|html)$/i.test(relative) ? "no-cache" : "public, max-age=31536000, immutable",
		ETag: etag,
		"Last-Modified": asset.lastModified,
	};
	if (canCompress) headers.Vary = "Accept-Encoding";
	const ifNoneMatch = request.headers["if-none-match"];
	const fresh =
		ifNoneMatch === undefined
			? notModifiedSince(request.headers["if-modified-since"], asset.lastModified)
			: matchesEtag(ifNoneMatch, etag);
	if (fresh) {
		response.writeHead(304, headers);
		response.end();
		return;
	}
	if (encoding !== "identity") headers["Content-Encoding"] = encoding;
	headers["Content-Length"] = String(body.length);
	response.writeHead(200, headers);
	response.end(body);
}

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

// ── 监听地址（原 `network.ts`）────────────────────────────────────────────
// 并进这里的原因：它只回答「绑哪个 host」，没有第二个调用点。

/**
 * 局域网访问地址推导。
 *
 * 服务的监听地址决定「别人能不能访问」：
 * - `127.0.0.1`（默认）：只有本机可用，`lanUrls` 为空——不输出连不上的地址；
 * - `0.0.0.0` / `::`：监听所有网卡，列出全部非回环 IPv4 地址；
 * - 具体某个网卡地址：只列这一个。
 *
 * IPv4 之外的地址（IPv6、虚拟网卡 fe80）刻意不列：扫码/输入到手机时
 * 带 scope 的 fe80 地址基本不可用，列出来只会误导。
 */

/** 通配监听地址。 */
const WILDCARD_HOSTS = new Set(["0.0.0.0", "::", "[::]", "*"]);

/** 回环地址。 */
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

/** 是否是「监听所有网卡」的地址。 */
export function isWildcardHost(host: string): boolean {
	return WILDCARD_HOSTS.has(host.trim());
}

/** 是否是回环地址（只有本机能访问）。 */
export function isLoopbackHost(host: string): boolean {
	const value = host.trim().toLowerCase();
	return value === "" || LOOPBACK_HOSTS.has(value) || value.startsWith("127.");
}

/**
 * 浏览器实际应该打开的地址。
 *
 * 监听 `0.0.0.0` 时不能把 `http://0.0.0.0:port/` 丢给浏览器（多数系统
 * 打不开），退回 `127.0.0.1`，局域网地址由 {@link lanUrlsOf} 单独给出。
 */
export function browserUrlOf(host: string, port: number): string {
	if (isWildcardHost(host)) return `http://127.0.0.1:${port}/`;
	return `http://${host}:${port}/`;
}

/** 本机全部非回环 IPv4 地址（去重、保持网卡顺序）。 */
export function lanAddresses(interfaces: ReturnType<typeof networkInterfaces> = networkInterfaces()): string[] {
	const found: string[] = [];
	for (const entries of Object.values(interfaces)) {
		for (const entry of entries ?? []) {
			// Node 18+ 的 family 可能是字符串 "IPv4"，旧版本是数字 4
			const ipv4 = entry.family === "IPv4" || (entry.family as unknown as number) === 4;
			if (!ipv4) continue;
			if (entry.internal) continue;
			if (entry.address.startsWith("127.")) continue;
			if (!found.includes(entry.address)) found.push(entry.address);
		}
	}
	return found;
}

/**
 * 当前监听配置下，局域网里可用的访问地址。
 *
 * 回环监听返回空数组：这些地址此刻**连不上**，列出来等于骗人。
 */
export function lanUrlsOf(
	host: string,
	port: number,
	interfaces: ReturnType<typeof networkInterfaces> = networkInterfaces(),
): string[] {
	if (isLoopbackHost(host)) return [];
	if (isWildcardHost(host)) return lanAddresses(interfaces).map((address) => `http://${address}:${port}/`);
	// 指定网卡地址：只列它自己（如果它确实是本机地址；否则仍按用户给的列）
	return [`http://${host}:${port}/`];
}

/**
 * 启动日志用的人话提示。
 *
 * 返回空串表示「局域网未开启」，由调用方决定怎么打印。
 */

// ── 静态资源（原 `static-assets.ts`）────────────────────────────────────────────
// 并进这里的原因：它是 server 的一条分支（不是 API 就走它），独立成文件只是多一跳。

/**
 * 静态资源的压缩与条件请求协商。
 *
 * **为什么需要这一层**（不是"优化"，是原本的两个真缺陷）：
 * - ① `serve` 以前完全不压缩。`ui/` 首屏是 480 KB / 23 个文件，走隧道
 *   （比如 Cloudflare Tunnel）时这段字节是**原样跨境传输**的：边缘能替你压
 *   「浏览器 ← 边缘」，压不了「边缘 ← 源站」。gzip 后 147 KB、brotli 后 124 KB。
 * - ② 以前只会发 `Cache-Control: no-cache` 且**没有任何 ETag / Last-Modified**，
 *   浏览器的每次条件请求都只能拿到 `200` 全量响应——`no-cache` 说"要重新验证"，
 *   却没有验证凭据，等于每次全量重传 480 KB。
 *
 * 现在：内容哈希做 ETag（按编码区分）+ Last-Modified + `Vary: Accept-Encoding`，
 * 命中条件直接 `304`，正文 0 字节。
 *
 * **为什么 ETag 要按编码区分**：`br` 和 `identity` 是不同的 representation，
 * 共用一个 ETag 会让客户端拿 `br` 的凭据去验证 `identity` 的响应，缓存语义就错了。
 */


const brotliCompressAsync = promisify(brotliCompress);
const gzipAsync = promisify(gzip);

/** 可选的响应编码。`identity` 表示不压缩。 */
export type StaticEncoding = "br" | "gzip" | "identity";

/**
 * 值得压缩的 Content-Type。
 *
 * png / woff2 / 已压缩的二进制再压只会更慢更大（woff2 内部已有 brotli），
 * 所以按类型白名单而不是"全都压"。
 */
export function compressible(contentType: string): boolean {
	return /^(?:text\/|application\/(?:json|javascript|xml)|image\/svg\+xml)/.test(contentType);
}

/**
 * 按 `Accept-Encoding` 选编码，**偏好 brotli**（同内容比 gzip 再小约 15%）。
 *
 * 只做浏览器实际需要的取舍，不实现完整的 RFC 9110 协商：
 * - 解析 `q` 权重（`br;q=0` 表示明确不要 br，这在某些老客户端上会真的出现）；
 * - 缺省时视为可接受（RFC 9110 §12.5.3 规定未列出的编码 q=0，但浏览器
 *   永远会列 `gzip`，所以这里用更宽松的 `*` 兜底，避免误判成 406）；
 * - 两个都不可接受时退回 `identity` —— 静态资源永远有 `identity` 表示，
 *   没有"必须压缩否则失败"的理由。
 */
export function negotiateEncoding(header: string | undefined): StaticEncoding {
	if (header === undefined || header.trim() === "") return "identity";

	const weights = new Map<string, number>();
	for (const part of header.split(",")) {
		const [rawName = "", ...params] = part.split(";");
		const name = rawName.trim().toLowerCase();
		if (name === "") continue;
		let weight = 1;
		for (const param of params) {
			const [key, value] = param.split("=");
			if (key?.trim().toLowerCase() !== "q") continue;
			const parsed = Number(value);
			if (Number.isFinite(parsed)) weight = Math.min(1, Math.max(0, parsed));
		}
		weights.set(name, weight);
	}

	const weightOf = (name: string): number => weights.get(name) ?? weights.get("*") ?? 0;
	const br = weightOf("br");
	const gz = weightOf("gzip");

	if (br > 0 && br >= gz) return "br";
	if (gz > 0) return "gzip";
	return "identity";
}

/** 缓存里的一个文件。`compressed` 按需填充，懒压缩 + 结果复用。 */
export type AssetEntry = {
	/** `mtimeMs:size`，用来判断磁盘上的文件是否已变。 */
	readonly stamp: string;
	readonly lastModified: string;
	/** identity 表示的 ETag（带引号）。 */
	readonly etag: string;
	readonly identity: Buffer;
	readonly compressed: Map<StaticEncoding, Promise<Buffer>>;
};

/**
 * 缓存上限。
 *
 * `ui/` 目前 25 个文件，256 条足够，纯粹是防「有人往 ui/ 里塞几千个文件」
 * 时无界增长。超出后按插入顺序淘汰最旧的（Map 保证顺序）。
 */
const MAX_ENTRIES = 256;

/** key 是绝对路径。 */
const cache = new Map<string, AssetEntry>();

/** 强 ETag：内容哈希，截断到 16 个 base64url 字符（够区分，又不啰嗦）。 */
function hashOf(body: Buffer): string {
	return createHash("sha256").update(body).digest("base64url").slice(0, 16);
}

/**
 * 读一个文件并做成缓存条目；不是常规文件（不存在 / 是目录）返回 `undefined`。
 *
 * **这不是 `readFile` 的包装**：它负责把「文件变了」变成缓存未命中。
 * 用 `stat` 的 `mtimeMs + size` 做戳记，而不是只信内存里的旧条目——
 * 改完 `ui/web/js/*.js` 刷新就能立刻看到，不需要重启服务。
 */
export async function loadAsset(target: string): Promise<AssetEntry | undefined> {
	const info = await stat(target).catch(() => undefined);
	if (info === undefined || !info.isFile()) return undefined;

	const stamp = `${info.mtimeMs}:${info.size}`;
	const cached = cache.get(target);
	if (cached !== undefined && cached.stamp === stamp) return cached;

	const identity = await readFile(target).catch(() => undefined);
	if (identity === undefined) return undefined;

	const entry: AssetEntry = {
		stamp,
		lastModified: info.mtime.toUTCString(),
		etag: `"${hashOf(identity)}"`,
		identity,
		compressed: new Map(),
	};
	// 先删再插：命中时也走到这里会把条目挪到队尾，天然是 LRU 顺序。
	cache.delete(target);
	cache.set(target, entry);
	while (cache.size > MAX_ENTRIES) {
		const oldest = cache.keys().next().value;
		if (oldest === undefined) break;
		cache.delete(oldest);
	}
	return entry;
}

/** 某个编码对应的 ETag（identity 用基础值，压缩表示加后缀）。 */
export function etagFor(entry: AssetEntry, encoding: StaticEncoding): string {
	if (encoding === "identity") return entry.etag;
	return `${entry.etag.slice(0, -1)}-${encoding}"`;
}

/** 取（必要时生成）压缩后的正文。压缩失败时退回 identity，不让请求 500。 */
export async function bodyFor(
	entry: AssetEntry,
	encoding: StaticEncoding,
): Promise<{ readonly body: Buffer; readonly encoding: StaticEncoding }> {
	if (encoding === "identity") return { body: entry.identity, encoding };

	const pending = entry.compressed.get(encoding);
	if (pending !== undefined) return { body: await pending, encoding };

	const task =
		encoding === "br"
			? // quality 5：比 11 快一个数量级，体积只差几个百分点。
				// 用异步版本，避免首次请求把事件循环卡住（SSE 正在这条循环上）。
				brotliCompressAsync(entry.identity, {
					params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 5 },
				})
			: gzipAsync(entry.identity, { level: 6 });

	entry.compressed.set(encoding, task);
	try {
		return { body: await task, encoding };
	} catch {
		// 压缩失败（内存不足之类）不应该让静态资源挂掉，退回未压缩。
		entry.compressed.delete(encoding);
		return { body: entry.identity, encoding: "identity" };
	}
}

/**
 * `If-None-Match` 是否命中（弱比较）。
 *
 * 弱比较是 RFC 9110 §13.1.2 对 GET 的要求：`W/"x"` 与 `"x"` 视为相同。
 * 这里自己的 ETag 是强形式，客户端的可能被改写为弱形式，必须剥掉 `W/` 再比。
 */
export function matchesEtag(header: string | undefined, etag: string): boolean {
	if (header === undefined) return false;
	if (header.trim() === "*") return true;
	const target = etag.trim();
	for (const candidate of header.split(",")) {
		const normalized = candidate.trim().replace(/^W\//, "");
		if (normalized === target) return true;
	}
	return false;
}

/** `If-Modified-Since` 是否说明客户端已是最新（精度到秒）。 */
export function notModifiedSince(header: string | undefined, lastModified: string): boolean {
	if (header === undefined) return false;
	const since = Date.parse(header);
	const modified = Date.parse(lastModified);
	if (Number.isNaN(since) || Number.isNaN(modified)) return false;
	// HTTP 日期精度是秒，毫秒差异不能让缓存永远命中不了。
	return Math.floor(modified / 1000) <= Math.floor(since / 1000);
}

// ── 访问守卫（原 `guard.ts`）──────────────────────────────────────────────
// 并进这里的原因：它只在 server 收请求的那一处被调用（同一个地方判「能不能进来」），
// 独立成文件的结果是「路由表在 routes、守卫在 guard、装配在 server」三处互看。

/**
 * 来源闸：谁有资格让这个服务「写」。
 *
 * 服务默认监听回环地址，于是所有浏览器页面都能把它当自己的后端用 —— 我在某个网页上
 * 挂着的时候，那个页面里的脚本可以直接 `POST /api/channels/all/messages`，冒充我说话。
 * 浏览器唯一不会替你伪造的是两样东西：**Host**（请求是冲哪个域名来的）和 **Origin**
 * （发起方页面的来源）。这两样就是这里要校验的东西。
 *
 * 纯函数、不碰网络：这样「什么算可信来源」这条判断能在 node 环境里直接验，不用起服务。
 */

/** 比较前先归一：大小写、末尾点（`localhost.` 是合法写法 —— 主机名末尾带点仍是同一个域）。 */
function normalizeHost(value: string): string {
	const lowered = value.trim().toLowerCase();
	const cut = lowered.lastIndexOf(":");
	if (cut < 0) return lowered.replace(/\.$/, "");
	return `${lowered.slice(0, cut).replace(/\.$/, "")}${lowered.slice(cut)}`;
}

/**
 * Host 头是否是本服务自己。
 *
 * 防的是 DNS rebinding：攻击者把 `evil.example` 解析到 `127.0.0.1`，页面里的脚本
 * 发同源请求，Origin 也变成 `http://evil.example` —— 只查 Origin 拦不住，Host 能。
 *
 * `allowed` 里放「主机:端口」的完整串（端口不同就是另一个服务，不能放行）。
 */
export function hostAllowed(host: string | undefined, allowed: readonly string[]): boolean {
	if (host === undefined) return false;
	const value = normalizeHost(host);
	if (value === "") return false;
	return allowed.some((item) => normalizeHost(item) === value);
}

/**
 * 写请求的来源是否可信。
 *
 * - `Origin` 存在：必须是自己这一份页面的来源（同源）。跨站、`null`（沙箱 iframe /
 *   `file://` 页面）一律拒。
 * - `Origin` 缺失：现代浏览器跨站请求**一定**带 `Sec-Fetch-Site: cross-site`，所以看它；
 *   两者都缺 = curl / 脚本 / 同源导航，放行（本机脚本本来就有全部权限，拦它没有意义）。
 */
export function originAllowed(
	origin: string | undefined,
	fetchSite: string | undefined,
	selfOrigins: readonly string[],
): boolean {
	const value = (origin ?? "").trim();
	if (value !== "") {
		const lowered = value.toLowerCase();
		return selfOrigins.some((self) => self.trim().toLowerCase() === lowered);
	}
	const site = (fetchSite ?? "").trim().toLowerCase();
	return site === "" || site === "same-origin" || site === "none";
}

/**
 * 允许的 Host 头。
 *
 * 由**实际监听地址**推出，不是由「用户可能用什么地址打开」猜：监听回环就只认
 * 回环的三种写法；监听通配地址时把本机局域网地址也算上（否则手机上打开就 403）。
 *
 * 参数都是明文给进来的（端口、绑定地址、环境变量、网卡地址），函数本身不读
 * `process.env`、不看网卡 —— 这样「什么算可信来源」这条判断能在单测里直接跑。
 */
export type AllowedHostsOptions = {
	readonly port: number;
	/** 实际绑定的地址（`127.0.0.1` / `0.0.0.0` / `::` / 具体网卡地址）。 */
	readonly boundHost: string;
	/** 启动参数里显式给的地址（与 `boundHost` 多数时候相同）。 */
	readonly requestedHost?: string | undefined;
	/** `SOLO_ALLOWED_HOSTS` 的原值（逗号分隔，隧道/反代域名）。 */
	readonly allowList?: string | undefined;
	/** 本机局域网地址（懒取：`network.lanAddresses()` 会枚举网卡，只在通配监听时用得上）。 */
	readonly lan?: () => readonly string[];
};

export function allowedHostsOf(options: AllowedHostsOptions): string[] {
	const port = options.port;
	const hosts = new Set<string>([`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`, `::1:${port}`]);
	const bound = options.boundHost.trim();
	if (isWildcardHost(bound)) {
		for (const address of options.lan?.() ?? []) hosts.add(`${address}:${port}`);
		const requested = options.requestedHost?.trim() ?? "";
		if (requested !== "") hosts.add(`${requested}:${port}`);
	} else if (bound !== "") {
		hosts.add(`${bound}:${port}`);
	}
	// 隧道/反代域名：监听地址推不出「外面用什么域名访问」，所以留一个显式口子
	// （逗号分隔，可带端口；不带端口时按当前端口补）。不加这个口子，以后挂个
	// cloudflared 之类就是全站 403 —— 而那时候没人会想到是这道闸。
	for (const raw of (options.allowList ?? "").split(",")) {
		const item = raw.trim().toLowerCase();
		if (item === "") continue;
		hosts.add(item.includes(":") ? item : `${item}:${port}`);
		// 不带端口的条目还要认「裸主机名」：隧道/反代转过来的 Host 常常不带端口
		// （https 走 443，浏览器与代理都会省掉默认端口）。
		if (!item.includes(":")) hosts.add(item);
	}
	return [...hosts];
}

/**
 * 自己这一份页面的 Origin：前端所有写请求都是同源发的。
 *
 * 每个 host 同时给出 http 与 https 两种：走隧道（cloudflared 之类）时页面是 https 的，
 * Origin 就是 `https://<登记域名>` —— 只认 http 的话，从隧道打开的前端一个写请求都过不去。
 * 默认端口会被浏览器省掉（https 的 443、http 的 80），所以这里把它们归一掉再比。
 */
export function selfOriginsOf(hosts: readonly string[]): string[] {
	const origins = new Set<string>();
	for (const host of hosts) {
		const https = host.endsWith(":443") ? host.slice(0, -":443".length) : host;
		const http = host.endsWith(":80") ? host.slice(0, -":80".length) : host;
		origins.add(`http://${http}`);
		origins.add(`https://${https}`);
	}
	return [...origins];
}

/**
 * 路径闸：`target` 是否在 `root` 里面（两者都要先 `resolve`/`normalize`）。
 *
 * 只看字符串前缀是**不够**的（父目录可能是符号链接），所以文件树那边还会 `realpath`
 * 再查一次；这里挡的是静态资源里的 `../..`。
 */
export function insideRoot(root: string, target: string): boolean {
	return target === root || target.startsWith(root.endsWith(sep) ? root : root + sep);
}
