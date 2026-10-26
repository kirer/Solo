/**
 * 频道的 HTTP 视图：给前端的频道列表 + 消息流 + 成员已读状态。
 *
 * 设计见 `docs/design/COMMS-REFACTOR.md` §7。三条约定：
 *
 * 1. **一次给全**：频道列表带未读数、最后一条预览，前端不用再逐个请求。
 * 2. **已读状态由后端算**：`readBy` 是持久化事实，界面只渲染。让前端自己比对
 *    会两边不一致（ADR-027 的教训）。
 * 3. **消息分页**：默认给最近 N 条，更早的用 `before` 游标拉。
 */
import { BACKGROUND_CONTEXT, type CompanyRuntime, type Context } from "../runtime/index.ts";
import {
	digestFor,
	hasMember,
	previewLine,
	unreadOf,
	type Channel,
	type ChannelMessage,
	type ChannelState,
	type MemberRole,
} from "../domain/channels.ts";
import { labelOf, canView, mentionable, personOf, type Org } from "../domain/membership.ts";
import { isTerminal, type TaskEntry } from "../domain/tasks.ts";
import { OWNER_ID } from "../domain/channels.ts";
import { readChannels, readOrg } from "../company/channels.ts";
import { readTasks } from "../company/tasks.ts";
import { canDisposePending, decisionOwnerOfItem, listPending, type PendingItem } from "../company/escalation.ts";

/** 频道列表项。 */
export type ChannelListItem = {
	readonly id: string;
	readonly kind: Channel["kind"];
	readonly title: string;
	readonly project?: string;
	/** 未读条数（不含自己发的）。 */
	readonly unread: number;
	/** 其中 @ 我的条数。 */
	readonly mentions: number;
	/** 最后一条的预览。 */
	readonly preview: string;
	readonly lastAt: number;
	readonly lastSeq: number;
	/** 成员数。 */
	readonly memberCount: number;
	/** 这个频道里未完成的任务数（项目群才有意义）。 */
	readonly openTasks: number;
};

/** 一条消息的视图。 */
export type MessageView = {
	readonly seq: number;
	readonly at: number;
	readonly from: number;
	readonly fromLabel: string;
	readonly kind: ChannelMessage["kind"];
	readonly text: string;
	readonly mentions: readonly { readonly id: number; readonly label: string; readonly read: boolean }[];
	readonly refs?: ChannelMessage["refs"];
	/**
	 * 这条在回复哪一条（需求 #7）。只给 `seq` / 发送方 / 一行摘要。
	 *
	 * 摘要在这里现算、随视图下发，而不是让前端拿 `seq` 回原消息里找：
	 * 被引用的那条可能已经被 800 条上限裁掉，或者早于当前分页（`before` 游标），
	 * 前端手里根本没有它。查不到就不给这个字段，界面显示「回复了一条更早的消息」。
	 */
	readonly replyTo?: {
		readonly seq: number;
		readonly from: number;
		readonly fromLabel: string;
		readonly excerpt: string;
	};
	/** 我读过这条没有。 */
	readonly read: boolean;
};

/**
 * 一条「等老板拍板」的事项，随频道详情下发。
 *
 * 为什么放进频道视图而不是只留在 `/api/org` 与 `/api/feed/:id`：右侧对话面板删掉之后，
 * 频道是老板**唯一**能回话的地方。待办不跟着频道走，老板就只能看不能答
 * （组织图上的红点会一直亮着，却点不到任何可输入的入口）。
 */
export type ChannelPending = {
	readonly key: string;
	readonly question: string;
	/** 谁在问（显示名）。 */
	readonly from: string;
	readonly askedAt: number;
	/** 是不是处置类（暂搁 / 放弃）。 */
	readonly disposition: boolean;
	/** 结构化选项；没有就为空数组（界面自行降级成自由输入）。 */
	readonly options: readonly { readonly id: string; readonly label: string; readonly recommended: boolean }[];
	/** 老板能不能驳回 / 标记已解决。口径只在 `canDisposePending` 一处定义。 */
	readonly canDispose: boolean;
	/** 来源说明（Defect B 要求 4）。 */
	readonly trace?: { readonly declaredTopic?: string; readonly ceoReviewed?: boolean; readonly note: string };
};

/** 频道详情。 */
export type ChannelView = {
	readonly channel: Omit<ChannelListItem, "unread" | "mentions" | "preview" | "openTasks">;
	readonly members: readonly {
		readonly id: number;
		readonly label: string;
		readonly role: MemberRole;
		readonly unread: number;
	}[];
	readonly messages: readonly MessageView[];
	/** 还有更早的消息（用 before 游标继续拉）。 */
	readonly hasMore: boolean;
	readonly tasks: readonly TaskEntry[];
	/**
	 * 这个频道里等老板拍板的事（含 `refs.pendingKey` 指向本频道消息的条目）。
	 * 非老板视角恒为空：待办归属是「老板这一级」，别人的视角答不了。
	 */
	readonly pending: readonly ChannelPending[];
};

/** 读频道列表（老板视角：全部频道）。 */
export async function listChannels(
	runtime: CompanyRuntime,
	context: Context = BACKGROUND_CONTEXT,
): Promise<readonly ChannelListItem[]> {
	const { org } = await readOrg(runtime, context);
	const channels = await readChannels(runtime, context);
	const tasks = await readTasks(runtime, context);

	const items: ChannelListItem[] = [];
	for (const channel of Object.values(channels.channels)) {
		if (channel.archived === true) continue;
		// 老板能看全部；这里固定按老板视角（0）
		if (!canView(org, 0, channel)) continue;
		// 未读必须按**读位置**算（`lastReadSeq`），不能拿 lastSeq 减消息条数糊。
		// 旧写法 `seq > channel.lastSeq - channel.messages.length` 恒等于「全部消息」，
		// 所以列表徽章永远清不掉——打开频道后下一次轮询又变回原值。
		const unread = unreadOfChannel(channels, channel.id, 0);
		const mentions = channel.messages.filter(
			(message) => message.mentions.includes(0) && message.from !== 0 && !message.readBy.includes(0),
		).length;
		const last = channel.messages.at(-1);
		const openTasks = Object.values(tasks.tasks).filter(
			(task) => task.channelId === channel.id && !isTerminal(task.status),
		).length;
		items.push({
			id: channel.id,
			kind: channel.kind,
			title: channel.title,
			...(channel.project === undefined ? {} : { project: channel.project }),
			unread,
			mentions,
			preview: last === undefined ? "" : previewLine(last.text, 80),
			// 空频道给 0：界面显示「—」而不是「60 分钟前」（createdAt 是启动时刻，没有意义）
			lastAt: last?.at ?? 0,
			lastSeq: channel.lastSeq,
			memberCount: Object.keys(channel.members).length,
			openTasks,
		});
	}

	// 排序：先按频道类型的固定次序（公司 → 领导层 → 项目 → 私聊 → 记录），
	// 同类型里「有 @ 的在前，然后按最后消息时间倒序」。
	// 固定类型次序很重要：用户找「公司大群」永远在最上面，不会因为别人说了句话就跳走。
	//
	// `log` 保留在表里只为老库（已归档的频道不会进这个列表）：`kind` 是持久化
	// 枚举，删掉会让旧数据反序列化时缺键。
	const kindRank: Record<Channel["kind"], number> = {
		company: 0,
		leadership: 1,
		project: 2,
		dm: 3,
		log: 4,
	};
	items.sort(
		(left, right) =>
			kindRank[left.kind] - kindRank[right.kind] ||
			right.mentions - left.mentions ||
			right.lastAt - left.lastAt,
	);
	return items;
}

/** 读频道详情。 */
export async function readChannelView(
	runtime: CompanyRuntime,
	channelId: string,
	options: { readonly limit?: number; readonly before?: number; readonly viewer?: number } = {},
	context: Context = BACKGROUND_CONTEXT,
): Promise<ChannelView | undefined> {
	const { org } = await readOrg(runtime, context);
	const channels = await readChannels(runtime, context);
	const channel = channels.channels[channelId];
	if (channel === undefined) return undefined;
	const viewer = options.viewer ?? 0;
	if (!canView(org, viewer, channel)) return undefined;

	const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
	const all = channel.messages.filter((message) => options.before === undefined || message.seq < options.before);
	const page = all.slice(-limit);
	const hasMore = all.length > page.length;

	const tasks = await readTasks(runtime, context);
	const projectTasks = Object.values(tasks.tasks)
		.filter((task) => task.channelId === channel.id)
		.sort((left, right) => left.createdAt - right.createdAt);
	const pending = viewer === OWNER_ID ? await ownerPendingForChannel(runtime, channel, context) : [];

	return {
		channel: {
			id: channel.id,
			kind: channel.kind,
			title: channel.title,
			...(channel.project === undefined ? {} : { project: channel.project }),
			lastAt: channel.messages.at(-1)?.at ?? 0,
			lastSeq: channel.lastSeq,
			memberCount: Object.keys(channel.members).length,
		},
		members: Object.values(channel.members)
			.sort((left, right) => left.joinedAt - right.joinedAt)
			.map((member) => ({
				id: member.conversationId,
				label: labelOf(org, member.conversationId),
				role: member.role,
				// 统一走 domain 的 `unreadOf`（唯一真相源），不要在这里再写一遍公式。
				unread: unreadOf(channel, member.conversationId).length,
			})),
		messages: page.map((message) => messageView(org, channel, message, viewer)),
		hasMore,
		tasks: projectTasks,
		pending,
	};
}

/**
 * 筛出「该在这个频道里显示给老板」的待办。
 *
 * 两条来源：
 * 1. **归属老板的**（`forYou` 口径，与 org-view 完全一致）——回答入口在哪个频道都行，
 *    但只有在**有上下文**的频道里出现才不会让老板对着一条无头无尾的问题做决定；
 *    所以这类只在「老板自己发过话 / 有人说过话」的频道里给，具体做法是：
 *    公司群 + 提问方所在的私聊。
 * 2. **被本频道消息引用过的**（`refs.pendingKey`）——问题本身就是在这个频道里提出来的，
 *    回到它被问的地方去答最自然。
 *
 * 刻意不做的两件事：
 * - 不去重「同一条待办出现在两个频道」：私聊里问的问题同时出现在公司群反而会制造两个
 *   答复入口，而两处都只是提交同一份 key，谁先答谁生效，看起来像「答了没反应」。
 *   所以只按第 2 条（引用关系）+ 提问方私聊两处给。
 * - 不在这里算权限：`canDispose` 直接调 `canDisposePending(item, "owner")`，
 *   真正的拦截在 disposePending 里。
 */
async function ownerPendingForChannel(
	runtime: CompanyRuntime,
	channel: Channel,
	context: Context,
): Promise<readonly ChannelPending[]> {
	const items = await listPending(runtime, context);
	if (items.length === 0) return [];

	// 本频道消息引用过的 key（问题就地提出来的地方）。
	const referenced = new Set<string>();
	for (const message of channel.messages) {
		const key = message.refs?.pendingKey;
		if (typeof key === "string" && key !== "") referenced.add(key);
	}

	const mine = items.filter((item) => {
		if (!isOwnerPending(item)) return false;
		if (referenced.has(item.key)) return true;
		// 其余按「提问方的私聊」归位：老板要知道是谁在问、在什么上下文里问。
		if (channel.kind !== "dm") return false;
		return dmPeer(channel.id) === item.fromConversationId;
	});

	return mine.map((item) => ({
		key: item.key,
		question: item.question,
		from: item.from,
		askedAt: item.askedAt,
		disposition: item.disposition !== undefined,
		options: (item.disposition?.options ?? []).map((option) => ({
			id: option.id,
			label: option.label,
			recommended: option.recommended === true,
		})),
		canDispose: canDisposePending(item, "owner"),
		...(item.trace === undefined ? {} : { trace: item.trace }),
	}));
}

/**
 * 这条待办是不是「老板这一级」的。
 *
 * 口径必须与 `src/server/org-view.ts` 的 `forYou` 逐字一致，否则会出现
 * 「组织图上有红点、频道里却找不到」的错位。那里写的是：
 * `decisionOwner === "owner" || (item.disposition !== undefined && decisionOwner === "ceo")`
 * ——第二条是 ADR-026 决策 1 的例外（审计 D-02）：系统里没有独立的老板会话，
 * 老板亲自派活写成的 from 就是 CEO，处置待办的 decisionOwner 因此是 ceo。
 */
function isOwnerPending(item: PendingItem): boolean {
	const owner = decisionOwnerOfItem(item);
	return owner === "owner" || (item.disposition !== undefined && owner === "ceo");
}

/** 从 `dm:<id>` 取对方会话标识；不是私聊频道就返回 null。 */
function dmPeer(channelId: string): number | null {
	if (!channelId.startsWith("dm:")) return null;
	const id = Number(channelId.slice("dm:".length));
	return Number.isFinite(id) ? id : null;
}

/** 单条消息视图。 */
function messageView(org: Org, channel: Channel, message: ChannelMessage, viewer: number): MessageView {
	const read = message.readBy.includes(viewer) || message.from === viewer;
	const quoted = resolveQuoted(channel, message);
	return {
		seq: message.seq,
		at: message.at,
		from: message.from,
		fromLabel: message.fromLabel,
		kind: message.kind,
		text: message.text,
		mentions: message.mentions.map((id) => ({
			id,
			label: labelOf(org, id),
			read: message.readBy.includes(id),
		})),
		...(message.refs === undefined ? {} : { refs: message.refs }),
		...(quoted === undefined ? {} : { replyTo: quoted }),
		read,
	};
}

/** 把 `replyTo` 的 seq 解析成一行可直接渲染的摘要。 */
const QUOTE_EXCERPT = 60;
function resolveQuoted(channel: Channel, message: ChannelMessage): MessageView["replyTo"] | undefined {
	const target =
		message.replyTo === undefined ? undefined : channel.messages.find((item) => item.seq === message.replyTo);
	if (target === undefined) return undefined;
	const flat = target.text.replace(/\s+/g, " ").trim();
	const excerpt = flat.length > QUOTE_EXCERPT ? `${flat.slice(0, QUOTE_EXCERPT)}…` : flat;
	return { seq: target.seq, from: target.from, fromLabel: target.fromLabel, excerpt };
}

/** 老板侧的未读总览（顶栏徽章）。 */
export async function unreadSummary(
	runtime: CompanyRuntime,
	context: Context = BACKGROUND_CONTEXT,
): Promise<{ readonly channels: number; readonly mentions: number; readonly total: number }> {
	// 顶栏徽章只关心两件事：@ 我的总条数、有未读的频道数。
	// 以前这里多读一次 `CompanyDoc`（`const { org } = await readOrg(...)` 之后
	// `void org;`）——白读一次全量组织快照，每次推送都发生。
	const channels = await readChannels(runtime, context);
	const digests = digestFor(channels, 0, 50);
	let total = 0;
	let mentions = 0;
	let withUnread = 0;
	for (const item of digests) {
		total += item.unread;
		mentions += item.mentions;
		if (item.unread > 0) withUnread += 1;
	}
	return { channels: withUnread, mentions, total };
}

/** 某人能 @ 的人（前端 @ 选择器用）。 */
export async function mentionCandidates(
	runtime: CompanyRuntime,
	channelId: string,
	viewer: number,
	context: Context = BACKGROUND_CONTEXT,
): Promise<readonly { readonly id: number; readonly label: string; readonly role: MemberRole }[]> {
	const { org } = await readOrg(runtime, context);
	const channels = await readChannels(runtime, context);
	const channel = channels.channels[channelId];
	if (channel === undefined) return [];
	// **走 `mentionable`**：它是「谁能被 @」的唯一真相源，会过滤掉已归档的人
	// 和看不到这个频道的人。以前这里自己过滤（只排除自己 + `personOf` 存在），
	// 于是候选人里会出现已离职的员工——老板 @ 了他，消息投给一个不会回话的会话。
	return mentionable(org, viewer, channel).flatMap((person) => {
		const member = channel.members[String(person.conversationId)];
		if (member === undefined) return [];
		return [{ id: person.conversationId, label: person.label, role: member.role }];
	});
}

/** 频道里的任务（项目看板用）。 */
export async function channelTasks(
	runtime: CompanyRuntime,
	channelId: string,
	context: Context = BACKGROUND_CONTEXT,
): Promise<readonly TaskEntry[]> {
	const tasks = await readTasks(runtime, context);
	return Object.values(tasks.tasks)
		.filter((task) => task.channelId === channelId)
		.sort((left, right) => left.createdAt - right.createdAt);
}

/**
 * 供 server 复用：从 ChannelState 取某人未读。
 *
 * 只是 `domain/channels.ts` 的 `unreadOf` 的取频道包装——**不要再写第二套公式**。
 * 历史上这里和 `listChannels` 各自发明过一份（一份拿 `lastSeq - messages.length`
 * 当已读位置，恒等于「全部消息」，列表徽章永远清不掉）。
 */
export function unreadOfChannel(state: ChannelState, channelId: string, conversationId: number): number {
	const channel = state.channels[channelId];
	if (channel === undefined || !hasMember(channel, conversationId)) return 0;
	return unreadOf(channel, conversationId).length;
}
