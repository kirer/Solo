/**
 * SSE 的**编解码**：事件 → 字节。
 *
 * 单独一个文件是因为它是唯一能单测的部分：这里全是纯函数，没有 socket、没有定时器。
 * 「有没有断线」「游标推到哪」在 `hub.ts`，那部分必须连着真连接才能测。
 *
 * 格式（`text/event-stream`）就四条规矩，别自己发明：
 * - 一段以空行结尾；
 * - `event:` 事件名、`data:` 一行 JSON（多行 data 会被浏览器拼成换行，我们不这么干）；
 * - 没有事件名的 `:` 开头行是注释（保活 ping）；
 * - `retry:` 告诉浏览器重连间隔。
 */
import type { ViewMessage, ViewOrg } from "../../view/dto.ts";

/** 保活间隔：中间代理通常 30–60s 掐空闲连接，15s 足够稳。 */
export const KEEP_ALIVE_MS = 15_000;

/** 浏览器重连间隔（毫秒）。 */
export const RETRY_MS = 1500;

/**
 * 组织流只有 `org` 一个事件（整份快照，不是增量）；频道流只有 `create` 一个事件。
 * 过程投影的 `draft` / `done` 已随 ADR-081 删掉 —— 别把它们加回来。
 */
export type SseEvent =
	| { readonly type: "org"; readonly org: ViewOrg }
	| { readonly type: "create"; readonly message: ViewMessage };

/** SSE 响应的头。`no-transform` 是给中间代理看的：别压缩、别攒包。 */
export function sseHeaders(): Record<string, string> {
	return {
		"Content-Type": "text/event-stream; charset=utf-8",
		"Cache-Control": "no-cache, no-transform",
		Connection: "keep-alive",
		"X-Accel-Buffering": "no",
	};
}

/** 连上先发一次：告诉浏览器断线后 1.5 秒重连。 */
export function retryFrame(): string {
	return `retry: ${RETRY_MS}\n\n`;
}

/** 保活注释行。浏览器会忽略它，但 TCP 上的空闲计时器不会。 */
export function keepAliveFrame(): string {
	return ": ping\n\n";
}

/** 把一个事件编成一段 SSE 字节。 */
export function encodeEvent(event: SseEvent): string {
	const payload = event.type === "org" ? event.org : event.message;
	return `event: ${event.type}\ndata: ${JSON.stringify(payload)}\n\n`;
}
