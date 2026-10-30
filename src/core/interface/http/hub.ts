/**
 * SSE 的连接与推送：谁连着、推到第几条、什么时候推。
 *
 * 编码在 `sse.ts`（纯函数、可单测），这里只管**有状态**的那一半：连接集合、去抖定时器、
 * 每个连接在每个频道上的游标。这一半必须连着真连接才能验，所以它和纯逻辑分开。
 *
 * 两条流各有各的事件：
 * - `org`：整份组织快照，任何文档提交都推（去抖 120ms）；
 * - `create`：一条消息，只推给订阅了那个频道的连接，且只推游标之后的增量。
 */
import type { ServerResponse } from "node:http";
import { OWNER_SLUG } from "../../app/index.ts";
import { messageView, orgView } from "../../view/index.ts";
import type { Snapshots } from "../../app/snapshot.ts";
import type { CoreServices } from "../../app/types.ts";
import { encodeEvent, keepAliveFrame, KEEP_ALIVE_MS, retryFrame, sseHeaders } from "./sse.ts";

/** 推送去抖（毫秒）：一次提交可能连带几次改动。 */
const PUSH_DEBOUNCE_MS = 120;

/**
 * 每条消息推的时候多回看几条。
 *
 * 补历史与增量会重叠，前端按 `seq` 幂等 upsert，重叠几条换来的是「漏一条」的概率更低。
 */
const RECENT_RESEND = 4;

/** 首屏一次推多少条历史。 */
const FIRST_PAGE = 60;

export function createStreamHub(shell: CoreServices, snapshots: Snapshots) {
	const orgClients = new Set<ServerResponse>();
	let orgTimer: NodeJS.Timeout | undefined;

	// T-016：按频道的 SSE 连接（channelId → 连接集合）。消息增量只推给订阅了该频道的浏览器。
	const channelClients = new Map<string, Set<ServerResponse>>();
	const channelTimers = new Map<string, NodeJS.Timeout>();
	// 每个 SSE 连接在每个频道上「已经推到第几条」。
	//
	// 原来的做法是每次提交都把**最后 60 条**重推一遍。实测：一次运行 15 秒里推了 1620 条
	// create 事件、51,359 个 DOM 节点被加进去又删掉、浏览器最长一次卡 2.7 秒。
	// 增量就该是增量：只推比这个游标新的，外加最后几条。
	const channelSeqs = new WeakMap<ServerResponse, Map<string, number>>();
	function cursorOf(client: ServerResponse, id: string): number | undefined {
		return channelSeqs.get(client)?.get(id);
	}
	function setCursorOf(client: ServerResponse, id: string, seq: number): void {
		let map = channelSeqs.get(client);
		if (map === undefined) {
			map = new Map();
			channelSeqs.set(client, map);
		}
		map.set(id, seq);
	}

	/** 向所有 SSE 连接推一份新快照（去抖）。 */
	function scheduleOrg(): void {
		if (orgClients.size === 0) return;
		if (orgTimer !== undefined) return;
		orgTimer = setTimeout(() => {
			orgTimer = undefined;
			void pushOrg();
		}, PUSH_DEBOUNCE_MS);
	}

	async function pushOrg(): Promise<void> {
		if (orgClients.size === 0) return;
		let payload: string;
		try {
			const { identities, directory } = await snapshots.snapshot();
			payload = encodeEvent({ type: "org", org: orgView(identities, directory) });
		} catch {
			return;
		}
		for (const client of [...orgClients]) {
			try {
				client.write(payload);
			} catch {
				orgClients.delete(client);
			}
		}
	}

	/**
	 * 向某个频道的所有 SSE 连接推一次该频道消息尾巴的增量（`create` 事件）。
	 * 前端按 seq 幂等 upsert：新 seq 插入、已有 seq 覆盖。
	 * 只推「当前有连接的频道」，避免无谓扫描；连接建立时也会立即调一次做全量补齐。
	 */
	async function pushChannel(id: string): Promise<void> {
		const clients = channelClients.get(id);
		if (clients === undefined || clients.size === 0) return;
		let views: { seq: number; line: string }[];
		try {
			const { directory, channels } = await snapshots.channelSnapshot();
			const channel = channels.channels[id];
			if (channel === undefined) return;
			const list = channels.messages[id] ?? [];
			const tail = list.slice(Math.max(0, list.length - FIRST_PAGE));
			views = tail.map((message) => {
				const view = messageView(channels, channel, message, directory, OWNER_SLUG);
				return { seq: message.seq, line: encodeEvent({ type: "create", message: view }) };
			});
		} catch {
			return;
		}
		const newest = views.length > 0 ? views[views.length - 1]!.seq : 0;
		for (const client of [...clients]) {
			// 没有游标 = 刚连上来，给全量（更早靠 `/api/channels/:id?before=`，这 60 条只是首屏）。
			const since = cursorOf(client, id);
			const wanted = since === undefined ? views : views.filter((view) => view.seq > since - RECENT_RESEND);
			if (wanted.length === 0) continue;
			try {
				client.write(wanted.map((view) => view.line).join(""));
				setCursorOf(client, id, newest);
			} catch {
				clients.delete(client);
			}
		}
	}

	/** 按频道去抖推增量。 */
	function scheduleChannel(id: string): void {
		if (channelClients.get(id)?.size === 0) return;
		const existing = channelTimers.get(id);
		if (existing !== undefined) return;
		const timer = setTimeout(() => {
			channelTimers.delete(id);
			void pushChannel(id);
		}, PUSH_DEBOUNCE_MS);
		channelTimers.set(id, timer);
	}

	/** 一条连接推到这个频道的第几条（`?since=` 用）。 */
	function seek(id: string, response: ServerResponse, since: number): void {
		// 客户端说「我已经有到 N 了」：把游标设到 N，`pushChannel` 就只推 N 之后的。
		//
		// 不设的话，刷新页面会再收一遍最近 60 条历史 —— 那 60 条里有 20 来条比已加载窗口
		// 更早，前端只能把它们追加到列表**末尾**，于是一刷新频道就变成
		// 「最新的在上面、更早的在最下面」的乱序（实测 60 行里 20 行错位）。
		setCursorOf(response, id, since + RECENT_RESEND);
	}

	function streamChannel(response: ServerResponse, id: string, since?: number): void {
		response.writeHead(200, sseHeaders());
		response.write(retryFrame());
		let clients = channelClients.get(id);
		if (clients === undefined) {
			clients = new Set<ServerResponse>();
			channelClients.set(id, clients);
		}
		clients.add(response);
		if (since !== undefined) seek(id, response, since);
		// 连接建立即推补齐（首屏全量；带 since 时只补增量）。
		void pushChannel(id);
		const keepAlive = setInterval(() => {
			try {
				response.write(keepAliveFrame());
			} catch {
				clearInterval(keepAlive);
				clients?.delete(response);
			}
		}, KEEP_ALIVE_MS);
		response.on("close", () => {
			clearInterval(keepAlive);
			clients?.delete(response);
			if (clients !== undefined && clients.size === 0) channelClients.delete(id);
		});
	}

	function streamOrg(response: ServerResponse): void {
		response.writeHead(200, sseHeaders());
		response.write(retryFrame());
		orgClients.add(response);
		void pushOrg();
		const keepAlive = setInterval(() => {
			try {
				response.write(keepAliveFrame());
			} catch {
				clearInterval(keepAlive);
				orgClients.delete(response);
			}
		}, KEEP_ALIVE_MS);
		response.on("close", () => {
			clearInterval(keepAlive);
			orgClients.delete(response);
		});
	}

	/**
	 * 订阅提交。任何文档提交都推一次：新消息、新 agent、改名，界面都会跟着变。
	 */
	function start(): () => void {
		return shell.harness.subscribeCommits(() => {
			scheduleOrg();
			// 任何提交都可能带来新消息，对活跃频道排增量。
			for (const id of channelClients.keys()) scheduleChannel(id);
		});
	}

	/** 收摊：停定时器、断所有连接。 */
	function close(): void {
		if (orgTimer !== undefined) clearTimeout(orgTimer);
		orgTimer = undefined;
		for (const client of orgClients) {
			try {
				client.end();
			} catch {
				/* 已断 */
			}
		}
		orgClients.clear();
		for (const set of channelClients.values()) {
			for (const client of set) {
				try {
					client.end();
				} catch {
					/* 已断 */
				}
			}
		}
		channelClients.clear();
		for (const timer of channelTimers.values()) clearTimeout(timer);
		channelTimers.clear();
	}

	return { streamOrg, streamChannel, scheduleOrg, scheduleChannel, start, close };
}

export type StreamHub = ReturnType<typeof createStreamHub>;
