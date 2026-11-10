/**
 * 静态资源：压缩 + 条件请求 + SPA 回退。
 *
 * **为什么需要这一层**（不是"优化"，是原本的两个真缺陷）：
 * - ① `serve` 以前完全不压缩。`ui/` 首屏是 480 KB / 23 个文件，走隧道
 *   （比如 Cloudflare Tunnel）时这段字节是**原样跨境传输**的：边缘能替你压
 *   「浏览器 ← 边缘」，压不了「边缘 ← 源站」。gzip 后 147 KB、brotli 后 124 KB。
 * - ② 以前只会发 `Cache-Control: no-cache` 且**没有任何 ETag / Last-Modified**，
 *   浏览器的每次条件请求都只能拿到 `200` 全量响应 —— 等于每次全量重传 480 KB。
 *
 * 现在：内容哈希做 ETag（按编码区分）+ Last-Modified + `Vary: Accept-Encoding`，
 * 命中条件直接 `304`，正文 0 字节。
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { promisify } from "node:util";
import { brotliCompress, constants as zlibConstants, gzip } from "node:zlib";
import { extname, join, normalize, sep } from "node:path";
import { fail } from "./respond.ts";

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
	// WebAssembly.instantiateStreaming 只在 MIME 是 application/wasm 时肯直接编译；
	// 缺这一条会退成 ArrayBuffer 那一版，慢一截还多一份内存。
	".wasm": "application/wasm",
	// 第三方声明（设置 → 关于）就是 markdown 原文，按纯文本发，直链点开能直接看。
	".md": "text/markdown; charset=utf-8",
};

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
function compressible(contentType: string): boolean {
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
function negotiateEncoding(header: string | undefined): StaticEncoding {
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
async function loadAsset(target: string): Promise<AssetEntry | undefined> {
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
function etagFor(entry: AssetEntry, encoding: StaticEncoding): string {
	if (encoding === "identity") return entry.etag;
	return `${entry.etag.slice(0, -1)}-${encoding}"`;
}

/** 取（必要时生成）压缩后的正文。压缩失败时退回 identity，不让请求 500。 */
async function bodyFor(
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
function matchesEtag(header: string | undefined, etag: string): boolean {
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
function notModifiedSince(header: string | undefined, lastModified: string): boolean {
	if (header === undefined) return false;
	const since = Date.parse(header);
	const modified = Date.parse(lastModified);
	if (Number.isNaN(since) || Number.isNaN(modified)) return false;
	// HTTP 日期精度是秒，毫秒差异不能让缓存永远命中不了。
	return Math.floor(modified / 1000) <= Math.floor(since / 1000);
}

export function insideRoot(root: string, target: string): boolean {
	return target === root || target.startsWith(root.endsWith(sep) ? root : root + sep);
}
