/**
 * 频道的 HTTP 视图：给前端的频道列表 + 消息流 + 成员已读状态。
 *
 * 设计见 `docs/COMMS.md` §7。三条约定：
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
import { labelOf, canView, mentionable, ownerOfChannel, personOf, type Org } from "../domain/membership.ts";
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
	readonly mentions: readonly {
		readonly id: number;
		readonly label: string;
		readonly read: boolean;
		/**
		 * `@label` 在 `text` 里的起始下标（指向 `@`），算不出来给 `-1`。
		 *
		 * 为什么由后端给：前端以前自己在 Markdown 渲染出的 HTML 串上扫标签、
		 * 猜「哪些 @ 落在代码块里」，再按频道成员名去替换——那是第二套算法，
		 * 与 `parseMentions`（别名、长名优先、词边界）不一致就会出现
		 * 「后端说没 @ 到人、界面上却亮着」。偏移是唯一确定的位置。
		 */
		readonly offset: number;
	}[];
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
	/**
	 * 老板这条消息的受理回执（`app.ack`），一条回执 = 一个被唤醒的人。
	 *
	 * 为什么需要它：`app.ack` 落在**对方的会话流**里，频道视图原本看不到，老板发完
	 * 消息界面零反馈（ACCEPTANCE-dino 二.4）。这里把它按 `messageSeq` 挂回来。
	 *
	 * 不回显 `app.ack` 的 `text`——那只是本条消息的前 280 字，频道里已有全文。
	 * 字段缺省 = 这条消息没有回执（员工报告、系统消息、任务卡永远没有）。
	 */
	readonly acks?: readonly {
		/** 回执落库时刻。 */
		readonly at: number;
		/** 对方当时的计划：`立即处理` / `当前工具结束后处理`。 */
		readonly plan: string;
		/** 写回执时对方是否正忙。 */
		readonly busy: boolean;
		/** `busy` 为真时它手上的工具名。 */
		readonly busyWith: string | null;
		/** 回执发给了谁（对应 `ChannelView.members[].id`）。 */
		readonly conversationId: number;
	}[];
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
	/**
	 * 服务端生成这份视图的时刻（`Date.now()`）。
	 *
	 * 给前端做时钟校正用：任务耗时是「服务端时间戳 → 现在」，前端拿本地
	 * `Date.now()` 当「现在」，本机时钟偏快就会算出负数（界面显示「-3 分钟」）。
	 */
	readonly serverNow: number;
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
	const acks = await ackIndex(runtime, org, channel, page, context);

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
		messages: page.map((message) => {
			const view = messageView(org, channel, message, viewer);
			const own = acks.get(message.seq);
			return own === undefined ? view : { ...view, acks: own };
		}),
		hasMore,
		tasks: projectTasks,
		pending,
		serverNow: Date.now(),
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
		mentions: mentionViews(org, message),
		...(message.refs === undefined ? {} : { refs: message.refs }),
		...(quoted === undefined ? {} : { replyTo: quoted }),
		read,
	};
}

/**
 * 提及列表 + 每处在正文里的偏移。
 *
 * 同名提及在一段正文里出现多次时按顺序推进游标（第 n 个同名提及对第 n 处）；
 * 找不到给 `-1`，前端约定 `-1` 不高亮——宁可不亮，也不要高亮到错的位置。
 */
function mentionViews(org: Org, message: ChannelMessage): MessageView["mentions"] {
	const cursors = new Map<string, number>();
	return message.mentions.map((id) => {
		const label = labelOf(org, id);
		const needle = `@${label}`;
		const from = cursors.get(label) ?? 0;
		const offset = label === "" ? -1 : message.text.indexOf(needle, from);
		if (offset >= 0) cursors.set(label, offset + needle.length);
		return { id, label, read: message.readBy.includes(id), offset };
	});
}

/**
 * 装填「这条消息的回执」——`MessageView.acks` 的唯一来源。
 *
 * `app.ack` 是 `src/server/http.ts` 的 `writeAck` 写进**对方会话流**的 `write` 条目，
 * 里面带 `{ channelId, messageSeq, busy, busyWith, plan, at }`。频道视图里没有它，
 * 老板发完消息就零反馈（ACCEPTANCE-dino 二.4）。
 *
 * 三个实现取舍：
 *
 * 1. **不复用 `readFeed`**。`src/server/activity.ts` 的注释说「不要自己解析 entries，
 *    复用 readFeed」，但 `readFeed` 的 `buildItems` 没有 `app.ack` 分支（它被当
 *    default 留痕吃掉），拿不到 `messageSeq`；而且它一次扫最新 400 条，只为找几条
 *    回执太贵。所以这里直接 `conversation.entries(...)`，与 `org-view.ts` /
 *    `board.ts` 的既有写法一致。
 * 2. **只看最新 N 条老板消息**。`readChannelView` 被前端轮询，逐条消息 × 每个成员
 *    会话扫库在大频道上会很贵。回执的用途就是「刚发完等反馈」，20 条足够；更早的
 *    消息要翻页（翻页后重新装填）。
 * 3. **只扫「实际收到消息的人」+ 频道负责人**。`deliveredTo` 给了投递成功的会话
 *    （最准），`ownerOfChannel` 补上「没投递成功但写了回执」那一种（`writeAck` 的
 *    targets 与 `wakeTargets` 口径不完全一致）。不做全成员扇出。
 */
const ACK_SCAN_MESSAGES = 20;
const ACK_SCAN_ENTRIES = 60;

/** 一条受理回执的视图形状（`MessageView["acks"]` 的元素）。 */
type MessageAck = {
	readonly at: number;
	readonly plan: string;
	readonly busy: boolean;
	readonly busyWith: string | null;
	readonly conversationId: number;
};

/** `app.ack` 条目里我们真正要用到的字段（`entry.data` 是 JSON，只能窄断言）。 */
type AckData = {
	readonly channelId?: string;
	readonly messageSeq?: number;
	readonly busy?: boolean;
	readonly busyWith?: string | null;
	readonly plan?: string;
	readonly at?: number;
};

async function ackIndex(
	runtime: CompanyRuntime,
	org: Org,
	channel: Channel,
	page: readonly ChannelMessage[],
	context: Context,
): Promise<ReadonlyMap<number, readonly MessageAck[]>> {
	const index = new Map<number, MessageAck[]>();

	// 只有老板发言才有回执（`writeAck` 只在这个分支里被调）。
	const candidates = page.filter((message) => message.from === OWNER_ID).slice(-ACK_SCAN_MESSAGES);
	if (candidates.length === 0) return index;

	// 要扫哪些会话：投递回执里的目标 ∪ 频道负责人。
	const targets = new Set<number>();
	for (const message of candidates) {
		for (const receipt of message.deliveredTo ?? []) targets.add(receipt.conversationId);
	}
	const owner = ownerOfChannel(org, channel);
	if (owner !== undefined && owner !== OWNER_ID) targets.add(owner);
	if (targets.size === 0) return index;

	const wanted = new Set(candidates.map((message) => message.seq));
	for (const target of targets) {
		const conversation = await runtime.harness.conversation(target as never, context);
		if (conversation === undefined) continue;
		const result = await conversation.entries({ order: "descending" }, ACK_SCAN_ENTRIES, undefined, context);
		for (const entry of result.items) {
			if (entry.kind !== "app.ack") continue;
			const data = entry.data as AckData | undefined;
			if (data === undefined || data.channelId !== channel.id) continue;
			if (typeof data.messageSeq !== "number" || !wanted.has(data.messageSeq)) continue;
			const list: MessageAck[] = [...(index.get(data.messageSeq) ?? [])];
			// 同一个人对同一条消息只留最新一张回执（重发消息会写很多张）。
			// 扫的是 `descending`，所以先看到的更新；已有一张就跳过。
			if (list.some((ack) => ack.conversationId === target)) continue;
			list.push({
				at: typeof data.at === "number" ? data.at : 0,
				plan: data.plan ?? "",
				busy: data.busy === true,
				busyWith: data.busyWith ?? null,
				conversationId: target,
			});
			index.set(data.messageSeq, list);
		}
	}

	// 同一个人只留一张后就不需要再排了；跨人多张按 `at` 升序（谁先接的在前）。
	for (const [seq, list] of index) index.set(seq, [...list].sort((left, right) => left.at - right.at));
	return index;
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
