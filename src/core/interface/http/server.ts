/**
 * HTTP 的**原语**：发一份 JSON、发一个错误、读一份 JSON 正文、发一个静态文件。
 *
 * 这里不认识任何业务概念（频道、记忆、文件树都不在这），所以它不会被业务改动牵连。
 * 反过来，业务 handler 只允许用这四个原语出口，别自己拼 `writeHead` —— 否则
 * 「失败统一是 `{error}` + 4xx/5xx」这条契约会在某个角落里悄悄破掉。
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname, join, normalize } from "node:path";
import { readBody, UploadTooLargeError } from "../../app/body.ts";
import { AppError, type AppErrorReason } from "../../app/errors.ts";
import { insideRoot } from "./guard.ts";
import {
	bodyFor,
	compressible,
	etagFor,
	loadAsset,
	matchesEtag,
	negotiateEncoding,
	notModifiedSince,
	type AssetEntry,
} from "./static-assets.ts";

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
