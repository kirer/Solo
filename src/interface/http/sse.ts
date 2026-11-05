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
import { messageView, orgView } from "../../app/project.ts";
import type { ChannelSnapshot, Snapshots } from "../../app/snapshot.ts";
import type { CoreServices } from "../../app/types.ts";
import type { Read } from "../../app/read.ts";
import { slimTurn } from "../../app/trace.ts";
import type { ViewMessage, ViewOrg, ViewTurn } from "../../view/dto.ts";

/** 保活间隔：中间代理通常 30–60s 掐空闲连接，15s 足够稳。 */
export const KEEP_ALIVE_MS = 15_000;

/** 浏览器重连间隔（毫秒）。 */
export const RETRY_MS = 1500;

/**
 * 组织流只有 `org` 一个事件（整份快照，不是增量）；频道流有 `create`（一条消息）
 * 与 `trace`（正在跑的那一轮的完整快照）。
 *
 * 过程投影的 `draft` / `done` 已随 ADR-081 删掉 —— 别把它们加回来；`trace` 不是它们：
 * 它推的是会话条目派生出的**整轮快照**，不按字推（C-007）。
 */
export type SseEvent =
	| { readonly type: "org"; readonly org: ViewOrg }
	| { readonly type: "create"; readonly message: ViewMessage }
	| { readonly type: "trace"; readonly turn: ViewTurn };

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
	const payload = event.type === "org" ? event.org : event.type === "trace" ? event.turn : event.message;
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

/**
 * 「有人在做活」时的补推间隔（毫秒）。
 *
 * 提交总线只在**文档落盘**时响。可「在跑 / 在想」写在会话的 live 文档里、而且
 * 模型思考的那几十秒根本不落盘 —— 于是界面会停在「还在跑」「没回话」，头像也不亮圈。
 * 真出过：一轮已经交付了，进度行还挂着「在跑」；人明明在跑，头像一动不动。
 * 所以忙的时候按秒补一次，闲下来立刻停（闲着还每秒读一遍快照是纯浪费）。
 */
const PULSE_MS = 1_000;

/** 一次提交之后补推多少跳（2 分钟）：够覆盖一整轮，又不会让闲着的页面一直读盘。 */
const PULSE_BUDGET = 120;

/** 组织快照里界面真的会画的那几格：没变就别推（否则每秒一次全量重渲染）。 */
/**
 * 频道投影的指纹：**只装结构字段**（标题、成员、唤醒表、归档），不装 unread / preview。
 *
 * 为什么要它：解散团队、开除人、往团队里加人，改的都是频道文档、不一定改到名册 ——
 * 只看名册的话这些事不会触发一次 org 推送，界面右栏就停在旧样子上（实测）。
 * 反过来，把未读塞进来会让每来一条消息都推一次全量组织。
 */
function channelSignature(channels: ChannelSnapshot["channels"]): string {
	const rows = Object.values(channels.channels)
		.map((channel) =>
			[
				channel.id,
				channel.title,
				channel.archived === true ? "1" : "0",
				[...channel.members].sort().join(","),
				[...channel.wakeOnAll].sort().join(","),
			].join("\u0001"),
		)
		.sort();
	return `ch:${String(rows.length)}|${rows.join("\u0002")}`;
}

function orgSignature(org: ViewOrg): string {
	const rows = org.people.map((actor) => {
		const activity =
			actor.activity === undefined ? "" : `${actor.activity.state}\u0001${String(actor.activity.since)}`;
		const failure =
			actor.lastFailure === undefined
				? ""
				: `${actor.lastFailure.reason}\u0001${actor.lastFailure.text}\u0001${actor.lastFailure.detail ?? ""}`;
		return `${actor.slug}\u0001${actor.label}\u0001${actor.title ?? ""}\u0001${actor.assistant === true ? "1" : ""}\u0001${activity}\u0001${failure}`;
	});
	// 前缀不能省：一个空的 org 拼出来也是空串，会和「还没推过」撞成同一个指纹。
	return `org:${String(rows.length)}|${rows.join("\u0002")}`;
}

/** 一次最多推多少条：首屏补齐，以及增量积压时的上界。更早的靠 `/api/channels/:id?before=`。 */
const PAGE = 60;

export function createStreamHub(shell: CoreServices, snapshots: Snapshots, read?: Read) {
	const orgClients = new Set<ServerResponse>();
	// T-016：按频道的 SSE 连接（channelId → 连接集合）。消息增量只推给订阅了该频道的浏览器。
	const channelClients = new Map<string, Set<ServerResponse>>();
	/** `频道 → 已经推到第几条`（`?since=` 与增量都读它）。 */
	const pushed = new Map<string, number>();
	/** `频道 → 上一次推出去的轨迹指纹`：步骤没变就不重推。 */
	const traceSig = new Map<string, string>();
	/** `频道 → 上一次还在跑的那些轮`：用来在结算时补最后一帧 `done`。 */
	const traceOpen = new Map<string, ViewTurn[]>();
	/** 上次推出去的组织快照指纹：没变就不推。 */
	let orgSig = "";
	/** 上一份组织快照里有没有人 `activity`（补推只看它和 `traceOpen`）。 */
	let activity = false;
	/** 补推定时器与剩余跳数（见 `wakePulse`）。 */
	let pulse: NodeJS.Timeout | undefined;
	let budget = 0;
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

	/**
	 * 推正在跑的那一轮（`trace` 事件）。
	 *
	 * 三条规矩：
	 * 1. **只在步骤变了时推**（指纹比对）—— 一次提交会连带好几次推送；
	 * 2. 结算时补最后一帧 `done`，之后不再推（前端自己收尾）；
	 * 3. 没有 `read`（测试装配）就整个跳过。
	 */
	async function pushTrace(id: string): Promise<void> {
		const clients = channelClients.get(id);
		if (read === undefined || clients === undefined || clients.size === 0) return;
		let turns: ViewTurn[];
		try {
			// 私聊推的是**这个人的**跨频道轮次：他在团队频道里干活，私聊页也要实时看得到。
			const person = await read.personOfChannel(id);
			({ turns } =
				person === undefined
					? await read.readTurns(id, 0, Number.MAX_SAFE_INTEGER, true)
					: await read.readPersonTurns(person, 0, Number.MAX_SAFE_INTEGER, true));
		} catch {
			return;
		}
		const running = turns.filter((turn) => turn.status === "running");
		const before = traceOpen.get(id) ?? [];
		const ended = turns.filter(
			(turn) =>
				turn.status !== "running" &&
				before.some((previous) => previous.seq === turn.seq && previous.slug === turn.slug),
		);
		const outgoing = [...running, ...ended];
		if (outgoing.length === 0) {
			traceSig.delete(id);
			traceOpen.delete(id);
			return;
		}
		const signature = outgoing
			.map((turn) => `${String(turn.seq)}:${turn.slug}:${turn.status}:${String(turn.stepCount)}:${String(turn.steps?.length ?? 0)}`)
			.join("|");
		if (traceSig.get(id) === signature) return;
		traceSig.set(id, signature);
		traceOpen.set(id, running);
		broadcast(clients, outgoing.map((turn) => encodeEvent({ type: "trace", turn: slimTurn(turn) })).join(""));
	}

	/** 上一次推出去的频道投影指纹（解散团队、加人这类没有消息的变化靠它触发）。 */
	let channelSig = "";

	/**
	 * 推一份组织快照：指纹没变就不推；返回「此刻有没有人在做活」。
	 *
	 * `channels` 有就一起算进指纹。`flush` 手上有快照，补推只有组织快照 ——
	 * 补推不看频道是故意的：频道投影只在有提交时才会变，而提交一定会走 `flush`。
	 */
	function pushOrg(org: ViewOrg, channels?: ChannelSnapshot["channels"]): boolean {
		activity = org.people.some((actor) => actor.activity !== undefined);
		if (channels !== undefined) channelSig = channelSignature(channels);
		const signature = `${orgSignature(org)}|${channelSig}`;
		if (signature !== orgSig) {
			orgSig = signature;
			broadcast(orgClients, encodeEvent({ type: "org", org }));
		}
		return activity;
	}

	/**
	 * 补推：**有事发生之后的两分钟里**按秒看一眼状态，之后自己停。
	 *
	 * 为什么不看「此刻忙不忙」再决定开不开：一轮是怎么开始的 —— 一条消息提交、然后
	 * 模型开始想。提交那一刻 `activity` 还没写进去，忙态要等我跳过去时才有；等它出现
	 * 再开表，第一跳可能已经是几十秒后。所以触发点是**提交**和**新连接**，不是忙态。
	 *
	 * 为什么要自己停：闲着还每秒读一遍快照是纯浪费。两分钟够覆盖绝大多数一轮；
	 * 真在跑（`activity` 或 `running`）就每跳把预算重置，长活也不会断。
	 */
	function wakePulse(): void {
		budget = PULSE_BUDGET;
		if (pulse !== undefined) return;
		pulse = setInterval(() => {
			void pulseNow();
		}, PULSE_MS);
		pulse.unref?.();
	}

	function stopPulse(): void {
		if (pulse === undefined) return;
		clearInterval(pulse);
		pulse = undefined;
	}

	/** 补推一跳：只读状态，指纹没变就什么都不发。 */
	async function pulseNow(): Promise<void> {
		if (orgClients.size > 0 && read !== undefined) {
			try {
				pushOrg(await read.readOrg());
			} catch {
				/* 读不到就当这一跳没发生 */
			}
		}
		for (const id of [...channelClients.keys()]) await pushTrace(id);
		const running = [...traceOpen.values()].some((turns) => turns.length > 0);
		budget = activity || running ? PULSE_BUDGET : budget - 1;
		if (budget <= 0) stopPulse();
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
			// 有 `read` 时走它：`readOrg` 会补上每个人此刻的 `activity`（在想 / 在做）。
			// 没有 `read`（测试装配）就退回纯投影 —— 少一个字段，不会错。
			const org = read === undefined ? orgView(snap.identities, "Solo", snap.assistants) : await read.readOrg();
			pushOrg(org, snap.channels);
		}
		for (const id of [...channelClients.keys()]) {
			pushChannel(id, snap, pushed.get(id) ?? 0);
			await pushTrace(id);
		}
	}

	/** 排一次推送（去抖，全局一个定时器）。 */
	function schedule(): void {
		if (orgClients.size === 0 && channelClients.size === 0) return;
		// 一次提交 = 一件事正在发生：接下来两分钟按秒补推（见 `wakePulse`）。
		wakePulse();
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
		// 连上就补推一阵：进来的时候可能已经有人在跑了，提交是几秒前的事。
		wakePulse();
		// 连接建立即推补齐（首屏全量；带 since 时只补增量）。
		void prime(response, id, since);
		response.on("close", () => {
			if (clients.size === 0) {
				channelClients.delete(id);
				traceSig.delete(id);
				traceOpen.delete(id);
			}
		});
	}

	function streamOrg(response: ServerResponse): void {
		// 新来的人手里什么都没有：把指纹清掉，让下一次 flush 一定推一份给他
		// （按指纹去重是给「推送」用的，不是给「首屏」用的）。
		orgSig = "";
		openStream(response, orgClients);
		response.on("close", () => {
			if (orgClients.size === 0) orgSig = "";
		});
		void flush();
	}

	/**
	 * 订阅提交。任何文档提交都推一次：新消息、新 agent、改名，界面都会跟着变。
	 */
	function start(): () => void {
		// 1.5.0：subscribeCommits 换成同步观察者，detach 取代返回的取消函数。
		const observation = shell.harness.observeCommits({
			advance: () => schedule(),
			end: () => undefined,
		});
		return () => observation.detach();
	}

	/** 收摊：停定时器、断所有连接。 */
	function close(): void {
		if (timer !== undefined) clearTimeout(timer);
		timer = undefined;
		if (pulse !== undefined) clearInterval(pulse);
		pulse = undefined;
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
		traceSig.clear();
		traceOpen.clear();
	}

	return { streamOrg, streamChannel, start, close };
}

export type StreamHub = ReturnType<typeof createStreamHub>;
