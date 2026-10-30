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
import type { ServerResponse } from "node:http";
import { OWNER_SLUG } from "../../app/index.ts";
import { messageView, orgView } from "../../app/read.ts";
import type { ChannelSnapshot, Snapshots } from "../../app/snapshot.ts";
import type { CoreServices } from "../../app/types.ts";
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

// ── 订阅中心（原 `hub.ts`）───────────────────────────────────────────────
// 并进这里的原因：它和 SSE 编码是一件事的两半 —— hub 管「谁订了哪个频道」，sse 管
// 「怎么把一条事件写成字节」；拆开时两边各自维护一份频道→订阅者的表。

/**
 * SSE 的连接与推送：谁连着、推到第几条、什么时候推。
 *
 * 编码在 `sse.ts`（纯函数、可单测），这里只管**有状态**的那一半：连接集合、去抖定时器、
 * 「这个频道已经推到第几条」。这一半必须连着真连接才能验，所以它和纯逻辑分开。
 *
 * 两条流各有各的事件：
 * - `org`：整份组织快照，任何文档提交都推（去抖 120ms）；
 * - `create`：一条消息，只推给订阅了那个频道的连接，且只推游标之后的增量。
 *
 * 游标只有**一份**，按频道记：所有连着的人在同一时刻收到的增量是同一批，所以
 * 「推到哪了」是频道的事实，不是连接的事实。按连接记的那一版要维护
 * `WeakMap<连接, Map<频道, seq>>`，还要配一个「补历史和增量重叠几条」的常数
 * （`seek` 加 4、过滤时再减 4），两个东西互相抵消，等于绕一圈回到「推 seq 之后的」。
 */

/** 推送去抖（毫秒）：一次提交可能连带几次改动。 */
const PUSH_DEBOUNCE_MS = 120;

/** 一次最多推多少条：首屏补齐，以及增量积压时的上界。更早的靠 `/api/channels/:id?before=`。 */
const PAGE = 60;

export function createStreamHub(shell: CoreServices, snapshots: Snapshots) {
	const orgClients = new Set<ServerResponse>();
	// T-016：按频道的 SSE 连接（channelId → 连接集合）。消息增量只推给订阅了该频道的浏览器。
	const channelClients = new Map<string, Set<ServerResponse>>();
	/** `频道 → 已经推到第几条`（`?since=` 与增量都读它）。 */
	const pushed = new Map<string, number>();
	let timer: NodeJS.Timeout | undefined;

	/** 写给一组连接；写失败（已断）的顺手摘掉。 */
	function broadcast(clients: Set<ServerResponse>, payload: string): void {
		for (const client of [...clients]) {
			try {
				client.write(payload);
			} catch {
				clients.delete(client);
			}
		}
	}

	/**
	 * 把 `> since` 的消息推给这个频道的所有连接（`create` 事件）。
	 * 前端按 seq 幂等 upsert：新 seq 插入、已有 seq 覆盖。
	 */
	function pushChannel(id: string, snap: ChannelSnapshot, since: number): void {
		const clients = channelClients.get(id);
		if (clients === undefined || clients.size === 0) return;
		const channel = snap.channels.channels[id];
		if (channel === undefined) return;
		const fresh = (snap.channels.messages[id] ?? []).filter((message) => message.seq > since);
		if (fresh.length === 0) return;
		const tail = fresh.slice(Math.max(0, fresh.length - PAGE));
		const payload = tail
			.map((message) =>
				encodeEvent({
					type: "create",
					message: messageView(snap.channels, channel, message, snap.directory, OWNER_SLUG),
				}),
			)
			.join("");
		broadcast(clients, payload);
		pushed.set(id, tail[tail.length - 1]!.seq);
	}

	/** 一次 flush：读一次快照，org 推整份、每个活跃频道推增量。 */
	async function flush(): Promise<void> {
		if (orgClients.size === 0 && channelClients.size === 0) return;
		let snap: ChannelSnapshot;
		try {
			// 有 org 订阅者就读全量（顺带带上 teams），否则只读频道那半边。
			snap = orgClients.size > 0 ? await snapshots.snapshot() : await snapshots.channelSnapshot();
		} catch {
			return;
		}
		if (orgClients.size > 0) {
			broadcast(orgClients, encodeEvent({ type: "org", org: orgView(snap.identities, snap.directory) }));
		}
		for (const id of [...channelClients.keys()]) pushChannel(id, snap, pushed.get(id) ?? 0);
	}

	/** 排一次推送（去抖，全局一个定时器）。 */
	function schedule(): void {
		if (orgClients.size === 0 && channelClients.size === 0) return;
		if (timer !== undefined) return;
		timer = setTimeout(() => {
			timer = undefined;
			void flush();
		}, PUSH_DEBOUNCE_MS);
	}

	/**
	 * 连接建立时给**这一条**连接补齐。
	 *
	 * 只写它一个：游标是频道共享的，别人的增量不能因为「又来一个人」而重推一遍。
	 * 带 `?since=N` 就只补 N 之后的（前端已经有的不重发）；没带就补最后一屏。
	 */
	async function prime(response: ServerResponse, id: string, since?: number): Promise<void> {
		let snap: ChannelSnapshot;
		try {
			snap = await snapshots.channelSnapshot();
		} catch {
			return;
		}
		const channel = snap.channels.channels[id];
		if (channel === undefined) return;
		const list = snap.channels.messages[id] ?? [];
		const newest = list.at(-1)?.seq ?? 0;
		// 带 `?since=N` 就只补 N 之后的；没带就补最后一屏（按**条数**算，不按 seq 算：
		// seq 会有空洞，用 `newest - PAGE` 推出来的窗口大小会漂）。
		const fresh = (since === undefined ? list : list.filter((message) => message.seq > since)).slice(-PAGE);
		if (fresh.length > 0) {
			try {
				response.write(
					fresh
						.map((message) =>
							encodeEvent({
								type: "create",
								message: messageView(snap.channels, channel, message, snap.directory, OWNER_SLUG),
							}),
						)
						.join(""),
				);
			} catch {
				return;
			}
		}
		// 没有别人连着的时候，这条连接就是全部：游标可以直接抬到最新。
		// 还有别人连着时不抬 —— 中间那些增量还没推给他们，抬了就把它们漏掉。
		if ((channelClients.get(id)?.size ?? 0) <= 1) pushed.set(id, Math.max(pushed.get(id) ?? 0, newest));
	}

	/** 开一条 SSE：头 + retry 帧 + 保活 + 断开清理（两条流共用的那一半）。 */
	function openStream(response: ServerResponse, clients: Set<ServerResponse>): void {
		response.writeHead(200, sseHeaders());
		response.write(retryFrame());
		clients.add(response);
		const keepAlive = setInterval(() => {
			try {
				response.write(keepAliveFrame());
			} catch {
				clearInterval(keepAlive);
				clients.delete(response);
			}
		}, KEEP_ALIVE_MS);
		response.on("close", () => {
			clearInterval(keepAlive);
			clients.delete(response);
		});
	}

	function streamChannel(response: ServerResponse, id: string, since?: number): void {
		let clients = channelClients.get(id);
		if (clients === undefined) {
			clients = new Set<ServerResponse>();
			channelClients.set(id, clients);
		}
		openStream(response, clients);
		// 连接建立即推补齐（首屏全量；带 since 时只补增量）。
		void prime(response, id, since);
		response.on("close", () => {
			if (clients.size === 0) channelClients.delete(id);
		});
	}

	function streamOrg(response: ServerResponse): void {
		openStream(response, orgClients);
		void flush();
	}

	/**
	 * 订阅提交。任何文档提交都推一次：新消息、新 agent、改名，界面都会跟着变。
	 */
	function start(): () => void {
		return shell.harness.subscribeCommits(() => schedule());
	}

	/** 收摊：停定时器、断所有连接。 */
	function close(): void {
		if (timer !== undefined) clearTimeout(timer);
		timer = undefined;
		for (const clients of [orgClients, ...channelClients.values()]) {
			for (const client of clients) {
				try {
					client.end();
				} catch {
					/* 已断 */
				}
			}
			clients.clear();
		}
		channelClients.clear();
		pushed.clear();
	}

	return { streamOrg, streamChannel, start, close };
}

export type StreamHub = ReturnType<typeof createStreamHub>;
