/**
 * 频道状态的读写规则：未读、兜底频道、追加消息、成员投影。
 *
 * 全部是纯函数：`post.ts` 负责把结果落进文档，这里只负责算。
 */
import type { Attachment, Channel, ChannelState, Message } from "./types.ts";
import { OWNER, chatKind, dmId } from "./types.ts";
import { EMPTY_ROSTER, parseMentions, resolveMention, type MentionRoster } from "./mentions.ts";

/** 某个 slug 在一个频道里读到了哪里。0 表示一条没读。 */
export function readMarkOf(state: ChannelState, slug: string, channelId: string): number {
	return state.readMarks[slug]?.[channelId] ?? 0;
}

/** 一个频道里，对某个 slug 来说未读的消息条数。自己发的不算未读。 */
export function unreadCount(state: ChannelState, channelId: string, slug: string): number {
	const mark = readMarkOf(state, slug, channelId);
	const list = state.messages[channelId] ?? [];
	let count = 0;
	for (const message of list) {
		if (message.seq > mark && message.from !== slug && message.kind !== "note" && message.kind !== "work") count += 1;
	}
	return count;
}

/**
 * 没被叫醒、也没指定频道时，最后一级兜底在哪儿说话。
 *
 * **只在群聊里找**：私聊是一对一的地方，不是兜底去处 —— 否则我在群里问的一句话会被
 * 答进我和某个人的私聊（实测 2598 条噪音灌进了我的私聊）。顺序是「我是成员的群里最近
 * 活跃的那个」→ 一个群都没有才回落到我和他的私聊。
 *
 * 不新建任何频道：说话只发生在已经存在的频道里，建频道是装配和我的事。
 */
export function fallbackChannelId(state: ChannelState, slug: string): string {
	let best = dmId(OWNER, slug);
	let bestAt = Number.NEGATIVE_INFINITY;
	for (const channel of channelsOf(state, slug)) {
		if (chatKind(channel) !== "group") continue;
		const list = state.messages[channel.id] ?? [];
		const at = list.length === 0 ? channel.createdAt : list[list.length - 1]!.at;
		if (at > bestAt) {
			best = channel.id;
			bestAt = at;
		}
	}
	return best;
}

/** 某个 slug 能看到的频道（成员表里包含它，且没归档）。 */
export function channelsOf(state: ChannelState, slug: string): Channel[] {
	return Object.values(state.channels)
		.filter((channel) => channel.archived !== true && channel.members.includes(slug))
		.sort((a, b) => a.createdAt - b.createdAt);
}

/**
 * 追加一条消息，返回新的 state 与落地的消息。
 *
 * 纯函数：seq 分配、mentions 解析、readMarks 都没动（发件人自己的已读位置由
 * 调用方决定 —— 「发完自己就算读过」是 UI 的语义，不是频道的语义）。
 *
 * **返回的 `state` 只用来算，不要直接写回文档。** 它带着一整份新的消息数组，
 * 写回文档就是「整值替换该频道全部历史」（一条消息重写整条时间线，见
 * `post.ts` 里那段实测数字）。真正的落地走 `postMessage`：它只拿这里的
 * `message`，然后往文档代理给出的那个数组上 push 一个元素。
 */
export function appendMessage(
	state: ChannelState,
	channelId: string,
	input: {
		readonly from: string;
		readonly text: string;
		readonly at: number;
		readonly kind?: string;
		readonly replyTo?: number;
		/** 名册：给了就按名册解析 `@`（`@我` → `owner`），不给就保留字面 token。 */
		readonly roster?: MentionRoster;
		/** 正文里没写、但要额外记进 `mentions` 的 slug（例如 `decision` 自动补 `owner`）。 */
		readonly mention?: readonly string[];
		/** 附件引用（本体在磁盘上）。空数组按「没有附件」处理。 */
		readonly attachments?: readonly Attachment[];
	},
): { readonly state: ChannelState; readonly message: Message } {
	const channel = state.channels[channelId];
	if (channel === undefined) throw new Error(`频道不存在：${channelId}`);

	const seq = state.nextSeq[channelId] ?? 1;
	const mentions = parseMentions(input.text, input.roster);
	// 代码补的 @（`decision` 自动叫我）不改正文，只进 mentions —— 正文是模型的嘴，
	// 不该被系统塞字；而「提醒谁」是系统的责任。
	for (const raw of input.mention ?? []) {
		const slug = resolveMention(raw, input.roster ?? EMPTY_ROSTER);
		if (slug !== undefined && !mentions.includes(slug)) mentions.push(slug);
	}
	// 引用一条消息 = 等同于 @ 它的作者：回复本身就带有「我是在跟你说」的语义。
	const replyTo = input.replyTo;
	const quotedFrom =
		replyTo === undefined
			? undefined
			: (state.messages[channelId] ?? []).find((item) => item.seq === replyTo)?.from;
	const mentionList =
		quotedFrom === undefined || quotedFrom === input.from || mentions.includes(quotedFrom)
			? mentions
			: [...mentions, quotedFrom];

	const message: Message = {
		seq,
		from: input.from,
		at: input.at,
		text: input.text,
		mentions: mentionList,
		kind: input.kind ?? "chat",
		...(replyTo === undefined ? {} : { replyTo }),
		...(input.attachments === undefined || input.attachments.length === 0
			? {}
			: {
					// 逐字段重建、顺序照抄类型声明：文档要求**字节确定**（ADR-005）。同一个附件
					// 换个 key 顺序写进去，就是另一份字节，会让提示词与文档校验都出现假差异。
					attachments: input.attachments.map((item) => ({
						id: item.id,
						name: item.name,
						kind: item.kind,
						bytes: item.bytes,
					})),
				}),
	};

	return {
		state: {
			...state,
			messages: { ...state.messages, [channelId]: [...(state.messages[channelId] ?? []), message] },
			nextSeq: { ...state.nextSeq, [channelId]: seq + 1 },
		},
		message,
	};
}

/**
 * 一次频道「投影」：拿事实算出成员表，再按三种意图落到文档上。
 *
 * - `create`：不存在才建；已存在原样返回（幂等）。
 * - `merge`：建，或者只把缺的人补进去（幂等）。全员频道用它 —— 成员只会增加，
 *   不会因为某次扫描没读到人就把谁踢出去。
 * - `replace`：成员表**整体替换**为这次算出来的结果（团队频道用它，成员是团队文件
 *   的投影，人走了就该消失，不能留幽灵成员）。
 */
export type ChannelProjection = {
	readonly id: string;
	readonly title: string;
	readonly members: readonly string[];
	readonly wakeOnAll?: readonly string[];
	readonly at: number;
	readonly mode: "create" | "merge" | "replace";
};

function sameList(a: readonly string[], b: readonly string[]): boolean {
	return a.length === b.length && a.every((item, index) => item === b[index]);
}

/** 成员 / 唤醒表的**唯一**写入点。三种意图只在这里落地。 */
export function projectChannel(state: ChannelState, input: ChannelProjection): ChannelState {
	const existing = state.channels[input.id];
	const members = [...new Set(input.members)];
	const wakeOnAll = [...new Set(input.wakeOnAll ?? [])];

	if (existing === undefined) {
		const channel: Channel = { id: input.id, title: input.title, members, wakeOnAll, createdAt: input.at };
		return { ...state, channels: { ...state.channels, [input.id]: channel } };
	}
	if (input.mode === "create") return state;

	if (input.mode === "merge") {
		const missing = members.filter((slug) => !existing.members.includes(slug));
		if (missing.length === 0) return state;
		return {
			...state,
			channels: { ...state.channels, [input.id]: { ...existing, members: [...existing.members, ...missing] } },
		};
	}

	// replace：成员表、唤醒表、标题都以上面这次投影为准；`createdAt` 是历史，保留。
	if (existing.title === input.title && sameList(existing.members, members) && sameList(existing.wakeOnAll, wakeOnAll)) {
		return state;
	}
	return {
		...state,
		channels: {
			...state.channels,
			[input.id]: { ...existing, title: input.title, members, wakeOnAll },
		},
	};
}

/** 建频道；已存在时原样返回（幂等）。`projectChannel` 的 `create` 意图。 @internal 仅测试 */
export function ensureChannel(
	state: ChannelState,
	input: { readonly id: string; readonly title: string; readonly members: string[]; readonly wakeOnAll?: string[]; readonly at: number },
): ChannelState {
	return projectChannel(state, { ...input, members: input.members, mode: "create" });
}

/**
 * 建频道，或者把缺的人补进去（幂等）。`projectChannel` 的 `merge` 意图。
 *
 * 与 `ensureChannel` 的区别：后者见到已存在的频道就直接返回，于是「团队管理员后来才
 * 定下来」「新招的人进了团队」都不会反映到成员表里 —— 那些人明明在团队里却收不到团队
 * 频道的话。这里两个动作合成一个，调用点不用自己判「建还是补」。
 */
export function upsertChannel(
	state: ChannelState,
	input: { readonly id: string; readonly title: string; readonly members: string[]; readonly wakeOnAll?: string[]; readonly at: number },
): ChannelState {
	return projectChannel(state, { ...input, members: input.members, mode: "merge" });
}

/**
 * 把某个 slug 在某个频道的已读位置推到 `seq`。回退不生效（已读不会变未读）。
 *
 * `seq` 会**夹到频道真实上界**：已读标记是「读到第几条」，写进一个比历史还大的数字
 * 等于声明「以后所有消息都已读」，未读数从此永远 0 —— 一条越界的请求就能让我
 * 再也看不见红点。路由层已经夹过一次，这里是第二道（唯一写入口自己兜底）。
 */
export function markRead(state: ChannelState, slug: string, channelId: string, seq: number): ChannelState {
	const current = readMarkOf(state, slug, channelId);
	const list = state.messages[channelId] ?? [];
	const lastSeq = list.length === 0 ? 0 : (list[list.length - 1]?.seq ?? 0);
	const wanted = Math.min(Math.max(Math.floor(seq), 0), lastSeq);
	if (!Number.isFinite(seq) || wanted <= current) return state;
	return {
		...state,
		readMarks: { ...state.readMarks, [slug]: { ...(state.readMarks[slug] ?? {}), [channelId]: wanted } },
	};
}

/** 频道里最近 `limit` 条消息（老的在前）。 */
export function tail(state: ChannelState, channelId: string, limit: number): Message[] {
	const list = state.messages[channelId] ?? [];
	return list.slice(Math.max(0, list.length - limit));
}
