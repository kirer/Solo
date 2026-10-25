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
import { readChannels, readOrg } from "../company/channels.ts";
import { readTasks } from "../company/tasks.ts";

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
	/** 我读过这条没有。 */
	readonly read: boolean;
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
	};
}

/** 单条消息视图。 */
function messageView(org: Org, channel: Channel, message: ChannelMessage, viewer: number): MessageView {
	const read = message.readBy.includes(viewer) || message.from === viewer;
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
		read,
	};
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
