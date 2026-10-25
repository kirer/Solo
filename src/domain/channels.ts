/**
 * 频道：通信的容器（纯数据 + 纯函数，无 IO）。
 *
 * 设计见 `docs/design/COMMS-REFACTOR.md` §2.1。三条硬约束：
 *
 * 1. **集中存储**：一个 session 级文档装全部频道。一条公司群消息只存一份，
 *    而不是往 15 个会话里各写一份（那样存储与已读状态都无法维护）。
 * 2. **广播存储 + 定向唤醒**：写进频道 ≠ 唤醒所有人。唤醒规则在
 *    `recipientsOf()` 里，是纯函数，可单测。15 人公司群每条消息唤醒 15 个
 *    agent 会让成本瞬间爆炸。
 * 3. **消息有上限**：每个频道只保留最近 `MAX_MESSAGES_PER_CHANNEL` 条。
 *    聊天是流水，不是档案；要留档的结论进 AuditDoc / TaskDoc。
 *
 * 这个文件不 import 任何运行时库：它要能在没有数据库的情况下被测试。
 */

/** 频道类型。 */
export const CHANNEL_KINDS = ["company", "leadership", "project", "dm", "log"] as const;
export type ChannelKind = (typeof CHANNEL_KINDS)[number];

/** 成员在组织里的层级（决定唤醒与权限，不决定显示名）。 */
export const MEMBER_ROLES = ["owner", "ceo", "management", "leader", "staff"] as const;
export type MemberRole = (typeof MEMBER_ROLES)[number];

/** 老板的会话标识恒为 0：系统里没有独立的老板会话。 */
export const OWNER_ID = 0;

/** 一条消息的种类。 */
export const MESSAGE_KINDS = [
	/** 普通聊天。 */
	"chat",
	/** 任务创建 / 状态变更。 */
	"task",
	/** 完成、阻塞、退回的回报。 */
	"report",
	/** 提问（通常带 @）。 */
	"question",
	/** 拍板结果。 */
	"decision",
	/** 系统通知（看门狗、迁移、自愈）。 */
	"system",
	/** 老板消息的受理回执。 */
	"ack",
] as const;
export type MessageKind = (typeof MESSAGE_KINDS)[number];

/** 每个频道保留的消息上限。 */
export const MAX_MESSAGES_PER_CHANNEL = 800;

/** 一条频道消息。 */
export type ChannelMessage = {
	/** 频道内单调递增；同时也是「已读到哪」的游标。 */
	seq: number;
	at: number;
	/** 发送方会话标识；`OWNER_ID` 表示老板。 */
	from: number;
	fromLabel: string;
	kind: MessageKind;
	text: string;
	/** 被 @ 的会话标识（去重、按传入顺序）。 */
	mentions: number[];
	/** 被 @ 的人里谁已经读过 —— 界面上的灰点/绿点靠它。 */
	readBy: number[];
	/** 关联标识：任务、待办、项目。 */
	refs?: {
		taskId?: string;
		pendingKey?: string;
		projectSlug?: string;
	};
};

/** 一个频道成员。 */
export type Member = {
	conversationId: number;
	role: MemberRole;
	joinedAt: number;
	/** 已读到第几条。未读数由它推导，不单独存（避免两个真相源）。 */
	lastReadSeq: number;
	/**
	 * 频道里没有 @ 他的消息是否也唤醒他。
	 *
	 * 默认 false：群是广播存储，不是广播唤醒。老板恒为 true（他要看全部）。
	 * 项目负责人对自己的项目群可以开 true（他要统筹）。
	 */
	wakeOnAll?: boolean;
};

/** 一个频道。 */
export type Channel = {
	id: string;
	kind: ChannelKind;
	title: string;
	project?: string;
	/** key = String(conversationId)。 */
	members: Record<string, Member>;
	createdAt: number;
	archived?: boolean;
	messages: ChannelMessage[];
	/** 频道内最后一条消息的 seq；空频道为 0。 */
	lastSeq: number;
};

/**
 * 频道文档。
 *
 * 字段刻意**不用 `readonly` / `Readonly<Record>`**：底层的 `JsonObject` 约束
 * 要求可变结构（`Readonly<Record<string, Channel>>` 不满足 `JsonValue`）。
 * 不可变性由「每次返回新对象」的纯函数保证，不由类型修饰符保证。
 */
export type ChannelState = {
	channels: Record<string, Channel>;
	/** 全局单调序号：跨频道排序与游标用，保证「先发生的一定更小」。 */
	nextSeq: number;
};

/** 空文档。 */
export function emptyChannelState(): ChannelState {
	return { channels: {}, nextSeq: 1 };
}

// ── 频道标识 ────────────────────────────────────────────────────────────────

/** 公司大群。 */
export const COMPANY_CHANNEL = "company";
/** 领导层群。 */
export const LEADERSHIP_CHANNEL = "leadership";

/** 项目群标识。 */
export function projectChannelId(slug: string): string {
	return `proj:${slug}`;
}

/** 老板与某人的私聊标识。 */
export function dmChannelId(conversationId: number): string {
	return `dm:${conversationId}`;
}

/** 个人工作记录频道标识。 */
export function logChannelId(conversationId: number): string {
	return `log:${conversationId}`;
}

/** 解析频道标识；不合法返回 undefined。 */
export function parseChannelId(id: string): { readonly kind: ChannelKind; readonly key?: string } | undefined {
	if (id === COMPANY_CHANNEL) return { kind: "company" };
	if (id === LEADERSHIP_CHANNEL) return { kind: "leadership" };
	const colon = id.indexOf(":");
	if (colon <= 0) return undefined;
	const prefix = id.slice(0, colon);
	const key = id.slice(colon + 1);
	if (key === "") return undefined;
	if (prefix === "proj") return { kind: "project", key };
	if (prefix === "dm") return { kind: "dm", key };
	if (prefix === "log") return { kind: "log", key };
	return undefined;
}

// ── 成员 ────────────────────────────────────────────────────────────────────

/** 建一个成员。 */
export function member(conversationId: number, role: MemberRole, now: number, wakeOnAll = false): Member {
	return {
		conversationId,
		role,
		joinedAt: now,
		lastReadSeq: 0,
		...(wakeOnAll ? { wakeOnAll: true } : {}),
	};
}

/** 这个频道有没有这个人。 */
export function hasMember(channel: Channel, conversationId: number): boolean {
	return channel.members[String(conversationId)] !== undefined;
}

/** 频道成员列表（按加入顺序稳定）。 */
export function membersOf(channel: Channel): readonly Member[] {
	return Object.values(channel.members).sort((a, b) => a.joinedAt - b.joinedAt || a.conversationId - b.conversationId);
}

/** 加人（幂等：已在里面就返回原频道）。 */
export function addMember(channel: Channel, next: Member): Channel {
	if (hasMember(channel, next.conversationId)) return channel;
	return { ...channel, members: { ...channel.members, [String(next.conversationId)]: next } };
}

/** 移除成员（老板不可移除）。 */
export function removeMember(channel: Channel, conversationId: number): Channel {
	if (conversationId === OWNER_ID) return channel;
	const { [String(conversationId)]: _removed, ...rest } = channel.members;
	return { ...channel, members: rest };
}

// ── 未读与已读 ──────────────────────────────────────────────────────────────

/** 某人在这个频道里读到哪了。 */
export function lastReadSeqOf(channel: Channel, conversationId: number): number {
	return channel.members[String(conversationId)]?.lastReadSeq ?? 0;
}

/** 某人未读的消息（不含自己发的）。 */
export function unreadOf(channel: Channel, conversationId: number): readonly ChannelMessage[] {
	const read = lastReadSeqOf(channel, conversationId);
	return channel.messages.filter((message) => message.seq > read && message.from !== conversationId);
}

/** 某人未读的 @（真正在等他的）。 */
export function unreadMentionsOf(channel: Channel, conversationId: number): readonly ChannelMessage[] {
	const read = lastReadSeqOf(channel, conversationId);
	return channel.messages.filter(
		(message) => message.seq > read && message.mentions.includes(conversationId) && message.from !== conversationId,
	);
}

/** 把某人的读位置推到 seq（只能前进，不能后退）。 */
export function advanceRead(channel: Channel, conversationId: number, seq: number): Channel {
	const current = channel.members[String(conversationId)];
	if (current === undefined) return channel;
	if (seq <= current.lastReadSeq) return channel;
	const next: Member = { ...current, lastReadSeq: seq };
	return { ...channel, members: { ...channel.members, [String(conversationId)]: next } };
}

/**
 * 把某人的读位置推到频道最新（进入频道 / 显式已读时用）。
 *
 * 注意不推到「最后一条」而是推到 `lastSeq`：并发追加时 `messages.at(-1)`
 * 可能落后于 `lastSeq`（消息被裁剪过），用 `lastSeq` 才不会反复标记未读。
 */
export function markRead(channel: Channel, conversationId: number): Channel {
	return advanceRead(channel, conversationId, channel.lastSeq);
}

/** 标记「某人已读了这条消息的 @」（灰点变绿点）。 */
export function markMentionRead(channel: Channel, seq: number, conversationId: number): Channel {
	const index = channel.messages.findIndex((message) => message.seq === seq);
	if (index < 0) return channel;
	const message = channel.messages[index];
	if (message === undefined) return channel;
	if (!message.mentions.includes(conversationId)) return channel;
	if (message.readBy.includes(conversationId)) return channel;
	const updated: ChannelMessage = { ...message, readBy: [...message.readBy, conversationId] };
	const messages = [...channel.messages];
	messages[index] = updated;
	return { ...channel, messages };
}

// ── 追加消息 ────────────────────────────────────────────────────────────────

/** 追加消息的输入。 */
export type AppendInput = {
	readonly from: number;
	readonly fromLabel: string;
	readonly kind: MessageKind;
	readonly text: string;
	readonly mentions?: readonly number[];
	readonly refs?: ChannelMessage["refs"];
	readonly at?: number;
};

/**
 * 追加一条消息。
 *
 * - `seq` 取自文档级 `nextSeq`，保证跨频道单调（这样「哪件事先发生」永远可判）
 * - `mentions` 去重、剔除发送方自己（自己 @ 自己没有意义）
 * - `readBy` 初始为空：**所有被 @ 的人都是未读**，包括发送方（发送方自己不算被 @）
 * - 超过上限时裁掉最旧的（聊天是流水，不是档案）
 */
export function appendMessage(
	state: ChannelState,
	channelId: string,
	input: AppendInput,
): { readonly state: ChannelState; readonly message: ChannelMessage } {
	const channel = state.channels[channelId];
	if (channel === undefined) throw new Error(`频道不存在：${channelId}`);

	const seq = state.nextSeq;
	const mentions = [...new Set(input.mentions ?? [])].filter((id) => id !== input.from);
	const message: ChannelMessage = {
		seq,
		at: input.at ?? Date.now(),
		from: input.from,
		fromLabel: input.fromLabel,
		kind: input.kind,
		text: input.text,
		mentions,
		readBy: [],
		...(input.refs === undefined ? {} : { refs: input.refs }),
	};

	const messages = [...channel.messages, message];
	// 裁剪：只保留最近 MAX_MESSAGES_PER_CHANNEL 条
	const kept = messages.length > MAX_MESSAGES_PER_CHANNEL ? messages.slice(-MAX_MESSAGES_PER_CHANNEL) : messages;

	const nextChannel: Channel = { ...channel, messages: kept, lastSeq: seq };
	return {
		state: {
			nextSeq: seq + 1,
			channels: { ...state.channels, [channelId]: nextChannel },
		},
		message,
	};
}

/** 建一个频道（已存在则返回原状态）。 */
export function createChannel(
	state: ChannelState,
	input: {
		readonly id: string;
		readonly kind: ChannelKind;
		readonly title: string;
		readonly project?: string;
		readonly members?: readonly Member[];
		readonly at?: number;
	},
): ChannelState {
	if (state.channels[input.id] !== undefined) return state;
	const members: Record<string, Member> = {};
	for (const entry of input.members ?? []) members[String(entry.conversationId)] = entry;
	const channel: Channel = {
		id: input.id,
		kind: input.kind,
		title: input.title,
		...(input.project === undefined ? {} : { project: input.project }),
		members,
		createdAt: input.at ?? Date.now(),
		messages: [],
		lastSeq: 0,
	};
	return { ...state, channels: { ...state.channels, [input.id]: channel } };
}

// ── 唤醒策略（整套设计的关键） ──────────────────────────────────────────────

/**
 * 一条新消息该唤醒谁。
 *
 * 规则（COMMS-REFACTOR §3）：
 * 1. 被 @ 的人 —— 立即唤醒（最高优先级）
 * 2. 老板发言但没 @ —— 唤醒该频道的 owner：
 *    - company / leadership → CEO
 *    - proj:x → 该项目负责人
 *    - dm:x / log:x → 对方
 * 3. agent 发言且没 @ —— **不唤醒任何人**（只进频道）
 * 4. 成员的 `wakeOnAll` 为 true —— 也唤醒（项目负责人统筹自己的项目群）
 *
 * 注意 `task` / `report` / `question` 这类结构化消息**总是**唤醒 @ 的人，
 * 即使发送方是 agent。这正是「员工提问必须有人回」的结构保证。
 *
 * @param ownerOf 返回某频道的「负责人会话」（company → CEO，proj:x → 项目负责人）
 */
export function recipientsOf(
	channel: Channel,
	message: ChannelMessage,
	ownerOf?: (channel: Channel) => number | undefined,
): readonly number[] {
	const targets = new Set<number>(message.mentions);

	// 老板发言没 @：唤醒频道 owner
	if (message.from === OWNER_ID && message.mentions.length === 0 && ownerOf !== undefined) {
		const owner = ownerOf(channel);
		if (owner !== undefined && owner !== OWNER_ID) targets.add(owner);
	}

	// wakeOnAll 的成员
	for (const entry of Object.values(channel.members)) {
		if (entry.wakeOnAll === true && entry.conversationId !== message.from) targets.add(entry.conversationId);
	}

	// 不唤醒发送方自己
	targets.delete(message.from);
	return [...targets];
}

// ── 未读摘要（喂给 agent 的输入前缀） ───────────────────────────────────────

/** 一条未读摘要。 */
export type UnreadDigest = {
	readonly channelId: string;
	readonly title: string;
	readonly unread: number;
	/** 其中有多少条是 @ 我的（真正在等我）。 */
	readonly mentions: number;
	/** 最近一条的正文（截断）。 */
	readonly preview: string;
};

/**
 * 给某人生成「你有 N 条未读」摘要。
 *
 * 这是「没被唤醒的人不会错过信息」的机制：下次它因任何原因醒来，
 * 输入前缀自动带这段摘要，让它知道该去哪个频道看。
 *
 * 只列 `mentions > 0` 或 `unread > 0` 的频道，按「有 @ 的优先、其次按未读数」排序。
 */
export function digestFor(state: ChannelState, conversationId: number, limit = 5): readonly UnreadDigest[] {
	const digests: UnreadDigest[] = [];
	for (const channel of Object.values(state.channels)) {
		if (channel.archived === true) continue;
		if (!hasMember(channel, conversationId)) continue;
		const unread = unreadOf(channel, conversationId);
		if (unread.length === 0) continue;
		const mentions = unread.filter((message) => message.mentions.includes(conversationId)).length;
		const last = unread[unread.length - 1];
		digests.push({
			channelId: channel.id,
			title: channel.title,
			unread: unread.length,
			mentions,
			preview: last === undefined ? "" : oneLine(last.text),
		});
	}
	digests.sort((left, right) => right.mentions - left.mentions || right.unread - left.unread);
	return digests.slice(0, limit);
}

/** 压成一行，供摘要使用。 */
export function oneLine(text: string, max = 60): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length <= max ? flat : `${flat.slice(0, max)}…`;
}

/**
 * 渲染喂给模型的紧凑消息。
 *
 * 刻意**不塞完整历史**：群里闲聊几十条全进上下文会爆。给一段带频道与 seq 的
 * 摘要，需要上下文时模型自己用 `read_channel` 拉。
 */
export function renderForModel(
	channel: Channel,
	message: ChannelMessage,
	labelOf: (conversationId: number) => string,
): string {
	const mentionText =
		message.mentions.length === 0 ? "" : ` · @${message.mentions.map(labelOf).join("、")}`;
	const ref =
		message.refs?.taskId === undefined
			? ""
			: `\n（任务 ${message.refs.taskId}，用 task_list 看详情）`;
	return [
		`【${channel.title} · ${message.fromLabel}${mentionText}】`,
		message.text,
		`（频道消息 #${message.seq}，用 read_channel 看上下文）${ref}`,
	].join("\n");
}
