/**
 * 频道：folder 版。
 *
 * 与旧核心（`src/company/channels.ts` + `src/domain/channels.ts`）的区别只有三条，
 * 但每条都改变形状：
 *
 * 1. **成员就是 `@slug`**。旧核心用数字 `conversationId`，因为它是数据库主键；
 *    新核心里 slug 才是稳定标识（`agents/<slug>/`），会话 id 会随重建而变。
 * 2. **没有「公司群 / 领导层 / 项目群 / 私聊 / 工作记录」这套预置频道**。频道是
 *    文档里的一条记录，谁需要谁建；`@所有人` 不是频道，是不 @ 任何人的时候的默认行为。
 * 3. **一条 `log:` 频道都没有**（旧核心为此写了 90 行保证逻辑，最后整段删掉）。
 *
 * 规则都放在这个文件里，且都是纯函数 —— 它们决定「谁是唤醒对象」，是整套系统里
 * 最容易写错、也最需要单测的一段。
 */
import { defineDoc, type JsonValue } from "../../runtime/index.ts";

/** 一条频道消息。 */
export type Message = {
	/** 频道内自增序号，从 1 开始。全系统唯一的消息锚点（引用回复存的就是它）。 */
	seq: number;
	/** 发件人的 slug。老板是 `owner`。 */
	from: string;
	at: number;
	/** 正文。`@slug` 在里面，解析结果另存 `mentions`。 */
	text: string;
	/** 正文里解析出的 `@slug`，去重、按出现顺序。 */
	mentions: string[];
	/** 引用的那条消息的 seq。 */
	replyTo?: number;
	/**
	 * 消息类别。`chat` 是普通发言；`note` 是系统写的留痕（不唤醒任何人、不计入未读）；
	 * 其余是给界面用的语义标签（`task` / `report` / `decision`）。
	 */
	kind: string;
};

/** 一个频道。 */
export type Channel = {
	/** 频道 id：`general` / `proj:alpha` / `dm:owner-cto` 之类，由建频道的人自己起。 */
	id: string;
	title: string;
	/** 成员 slug 列表。老板用 `owner`。 */
	members: string[];
	/**
	 * 这个频道里「不 @ 也会被唤醒」的成员。私聊把双方都放进去，
	 * 群聊一般是空数组（老板发言时特例，见 `recipientsOf`）。
	 */
	wakeOnAll: string[];
	createdAt: number;
	archived?: true;
};

export type ChannelState = {
	channels: Record<string, Channel>;
	messages: Record<string, Message[]>;
	/** 每个频道的下一个 seq。分开存是为了「只 append 一条消息」时不用重写整个数组。 */
	nextSeq: Record<string, number>;
	/** `slug → 频道 id → 已读到的 seq`。只记自己读过的位置。 */
	readMarks: Record<string, Record<string, number>>;
};

export const ChannelDoc = defineDoc<ChannelState>({
	kind: "core.channels",
	version: 1,
	scope: "session",
	initial: () => ({ channels: {}, messages: {}, nextSeq: {}, readMarks: {} }),
	// 消息是只增的；总量超过 4096 条时压一次基线（与旧核心同一量级）。
	checkpointWhen: (value) =>
		Object.values(value.messages).reduce((sum, list) => sum + list.length, 0) >= 4096,
});

/** 老板的 slug。不是 agent，但出现在成员表里。 */
export const OWNER = "owner";

/** 私聊频道的命名规则。双方 slug 排序后拼接，保证 `a-b` 与 `b-a` 是同一个频道。 */
export function dmId(a: string, b: string): string {
	const [left, right] = [a, b].sort();
	return `dm:${left}-${right}`;
}

/** 项目频道的命名规则。 */
export function projectId(project: string): string {
	return `proj:${project}`;
}

/**
 * 从正文里解析 `@slug`。slug 允许字母、数字、中文、`-`、`_`。
 *
 * 前面不能紧跟字母数字或 `._-`：否则 `hi@example.com` 会被解析成 `@example`，
 * 一个从来不存在的 agent 就凭空多了一条唤醒记录。这个 lookbehind 是唯一
 * 让邮箱不被误认的办法 —— 事后过滤「看起来像邮箱的」只会漏。
 */
const MENTION = /(?<![\p{L}\p{N}._-])@([\p{L}\p{N}_-]+)/gu;

export function parseMentions(text: string): string[] {
	const out: string[] = [];
	for (const match of text.matchAll(MENTION)) {
		const slug = match[1];
		if (slug !== undefined && !out.includes(slug)) out.push(slug);
	}
	return out;
}

/**
 * 谁会被这条消息唤醒。
 *
 * 四条规则，按顺序（后写的不会覆盖先写的，只做并集，最后减去发件人自己）：
 * 1. 明确 `@` 到的人 —— 只有频道成员里的才算（防止 `@` 一个不在这个房间的人
 *    凭空拿到别人房间的上下文）。
 * 2. 老板发言且**没有 @ 任何人**时，频道里的第一个非老板成员。这条是为了让
 *    「老板随口说一句」不至于没人接 —— 旧核心把它写成「老板发言默认叫醒负责人」，
 *    这里只依赖成员顺序，不依赖岗位。
 * 3. `wakeOnAll` 里的成员（私聊双方）。
 * 4. 发件人自己永远不唤醒（它正在说话，不需要再被叫一次）。
 *
 * 注意 `@所有人`：如果正文里出现 `@owner`，老板会被列为目标。但老板没有会话，
 * 投递层会跳过它（见 `deliver.ts`）。
 */
export function recipientsOf(channel: Channel, message: Message): string[] {
	const targets = new Set<string>();
	const members = new Set(channel.members);

	for (const slug of message.mentions) {
		if (members.has(slug)) targets.add(slug);
	}
	if (message.from === OWNER && message.mentions.length === 0) {
		const first = channel.members.find((slug) => slug !== OWNER);
		if (first !== undefined) targets.add(first);
	}
	for (const slug of channel.wakeOnAll) {
		if (members.has(slug)) targets.add(slug);
	}
	targets.delete(message.from);
	return [...targets];
}

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
		if (message.seq > mark && message.from !== slug && message.kind !== "note") count += 1;
	}
	return count;
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
 */
export function appendMessage(
	state: ChannelState,
	channelId: string,
	input: { readonly from: string; readonly text: string; readonly at: number; readonly kind?: string; readonly replyTo?: number },
): { readonly state: ChannelState; readonly message: Message } {
	const channel = state.channels[channelId];
	if (channel === undefined) throw new Error(`频道不存在：${channelId}`);

	const seq = state.nextSeq[channelId] ?? 1;
	const mentions = parseMentions(input.text);
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

/** 建频道；已存在时原样返回（幂等）。 */
export function ensureChannel(
	state: ChannelState,
	input: { readonly id: string; readonly title: string; readonly members: string[]; readonly wakeOnAll?: string[]; readonly at: number },
): ChannelState {
	if (state.channels[input.id] !== undefined) return state;
	const channel: Channel = {
		id: input.id,
		title: input.title,
		members: [...new Set(input.members)],
		wakeOnAll: [...new Set(input.wakeOnAll ?? [])],
		createdAt: input.at,
	};
	return { ...state, channels: { ...state.channels, [input.id]: channel } };
}

/** 把某个 slug 在某个频道的已读位置推到 `seq`。回退不生效（已读不会变未读）。 */
export function markRead(state: ChannelState, slug: string, channelId: string, seq: number): ChannelState {
	const current = readMarkOf(state, slug, channelId);
	if (seq <= current) return state;
	return {
		...state,
		readMarks: { ...state.readMarks, [slug]: { ...(state.readMarks[slug] ?? {}), [channelId]: seq } },
	};
}

/** 频道里最近 `limit` 条消息（老的在前）。 */
export function tail(state: ChannelState, channelId: string, limit: number): Message[] {
	const list = state.messages[channelId] ?? [];
	return list.slice(Math.max(0, list.length - limit));
}

/** 供界面用的 JSON 投影。`JsonValue` 要求严格 JSON，这里显式收窄。 */
export function toJson(value: unknown): JsonValue {
	return JSON.parse(JSON.stringify(value)) as JsonValue;
}
