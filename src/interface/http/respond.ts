/**
 * HTTP 的**原语**：发一份 JSON、发一个错误、读一份 JSON 正文。
 *
 * 这里不认识任何业务概念；反过来，业务 handler 只允许用这几个原语出口，
 * 别自己拼 `writeHead` —— 否则「失败统一是 `{error}` + 4xx/5xx」这条契约会在
 * 某个角落里悄悄破掉。
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { readBody, UploadTooLargeError } from "../../app/index.ts";
import { AppError, type AppErrorReason } from "../../app/errors.ts";

/** 写接口的 JSON 正文上限。正常消息几千字，1MB 已经宽得离谱。 */
const JSON_BODY_LIMIT = 1 << 20;

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
	options: { readonly requireJson?: boolean; readonly limit?: number } = {},
): Promise<T> {
	// 边读边数：先读完再比上限等于没有上限（一个 4GB 的请求先把内存吃光）。
	// 超限抛 `UploadTooLargeError`，由 `handle` 翻成 413。
	const bytes = await readBody(request, options.limit ?? JSON_BODY_LIMIT);
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
