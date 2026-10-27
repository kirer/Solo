/**
 * 投递：把一条频道消息推到被唤醒者的**下一次请求**里。
 *
 * 这是新核心里唯一的跨 agent 原语，只有一条硬约束：
 *
 * **不等待回复。** 消息已经落在频道文档里了，投递只负责「叫醒」。答案从频道
 * 异步回来，发送方不等。不回执、不看门狗、不重投 —— 那些都是「不等待」的代价，
 * 等真出现「投了但没人醒」再补。现在只守两条：
 *
 * 1. 一条投递失败不影响其余（逐条 try/catch）。
 * 2. 投递失败不丢消息 —— 消息在文档里，对方下次醒来会看到未读摘要。
 */
import type { Conversation } from "../runtime/index.ts";
import { BACKGROUND_CONTEXT, type Context } from "../runtime/index.ts";
import {
	type Channel,
	type ChannelState,
	type Message,
	unreadCount,
	channelsOf,
	tail,
} from "./state.ts";

/** 记忆里「刚被谁在哪个频道叫醒」。工具用它决定「默认在哪儿回话」。 */
export type WakeRecord = {
	readonly channelId: string;
	readonly seq: number;
	readonly from: string;
	readonly at: number;
};

export type DeliverResult = {
	/** 真的进了队列的 slug。不代表已读。 */
	readonly delivered: string[];
	/** 连队列都没进的 slug（消息仍在频道里）。 */
	readonly failed: string[];
	/** 没有会话、或就是老板本人，跳过的 slug。 */
	readonly skipped: string[];
};

export type DeliverOptions = {
	readonly state: ChannelState;
	readonly channel: Channel;
	readonly message: Message;
	/** 要唤醒谁（`recipientsOf` 的结果）。 */
	readonly targets: readonly string[];
	/** slug → 会话。返回 undefined 表示这个人没有会话（比如老板）。 */
	readonly conversationOf: (slug: string) => Promise<Conversation | undefined>;
	/** 显示名字。缺省用 slug。 */
	readonly labelOf?: (slug: string) => string;
	/** 记住「被谁叫醒」。缺省不记。 */
	readonly rememberWake?: (slug: string, wake: WakeRecord) => Promise<void>;
};

/** 一条消息交给模型时的正文。纯函数，方便单测。 */
export function renderDelivery(options: {
	readonly channel: Channel;
	readonly message: Message;
	/** 收件人。用来从「还 @ 了」里剔掉自己——否则每个人都会看到「还 @ 了你」。 */
	readonly viewer?: string;
	readonly labelOf?: (slug: string) => string;
}): string {
	const label = options.labelOf ?? ((slug: string) => slug);
	const { channel, message } = options;
	const quoted =
		message.replyTo === undefined ? "" : `（回复 #${message.replyTo}）`;
	const others = message.mentions.filter(
		(slug) => slug !== message.from && slug !== options.viewer,
	);
	const also = others.length === 0 ? "" : `\n这条还 @ 了：${others.map(label).join("、")}`;
	return [
		`【${channel.title}】#${message.seq}${quoted}`,
		`${label(message.from)}：${message.text}${also}`,
		`（回话用 say，channel 省略即回这个频道；要看完整历史用 read_channel）`,
	].join("\n");
}

/** 未读摘要：这个人所有频道里还有多少没看。纯函数。 */
export function renderDigest(state: ChannelState, slug: string, limit = 5): string {
	const rows: string[] = [];
	let total = 0;
	for (const channel of channelsOf(state, slug)) {
		const unread = unreadCount(state, channel.id, slug);
		if (unread === 0) continue;
		total += unread;
		const last = tail(state, channel.id, 1)[0];
		const preview = last === undefined ? "" : ` — ${oneLine(last.text, 60)}`;
		rows.push(`- ${channel.title}：${unread} 条${preview}`);
		if (rows.length >= limit) break;
	}
	if (rows.length === 0) return "";
	return [`【你有 ${total} 条未读】`, ...rows, "（用 read_channel 看内容）"].join("\n");
}

/**
 * 逐条投递。
 *
 * `requestId` 由「频道 + seq + slug」拼成：同一条消息重复投递会被底层去重，
 * 这是崩溃恢复下的至少一次语义想要的。
 */
export async function deliver(
	options: DeliverOptions,
	context: Context = BACKGROUND_CONTEXT,
): Promise<DeliverResult> {
	const delivered: string[] = [];
	const failed: string[] = [];
	const skipped: string[] = [];
	const label = options.labelOf ?? ((slug: string) => slug);
	const bodyOf = (viewer: string): string =>
		renderDelivery({ channel: options.channel, message: options.message, viewer, labelOf: label });

	for (const slug of options.targets) {
		try {
			const conversation = await options.conversationOf(slug);
			if (conversation === undefined) {
				skipped.push(slug);
				continue;
			}
			const digest = renderDigest(options.state, slug);
			const body = bodyOf(slug);
			const content = digest === "" ? body : `${body}\n\n${digest}`;
			// 先记「它在哪个频道被叫醒」，再提交。
			//
			// 反过来的话有竞态：`submit` 一入队对方就可能已经跑起来，而它此刻查不到
			// wake，只能退到「我最早的那个频道」—— 那往往是个人频道，于是**答在私聊里、
			// 问的人在原频道什么都看不到**（`core:live` 12 项里 9 项因此超时，实测抓到）。
			if (options.rememberWake !== undefined) {
				await options.rememberWake(slug, {
					channelId: options.channel.id,
					seq: options.message.seq,
					from: options.message.from,
					at: options.message.at,
				});
			}
			await conversation.submit(
				{
					type: "input",
					content,
					requestId: `ch:${options.channel.id}:${options.message.seq}:${slug}`,
					entry: {
						kind: "core.channel",
						data: {
							channelId: options.channel.id,
							channelTitle: options.channel.title,
							seq: options.message.seq,
							from: options.message.from,
							text: options.message.text.slice(0, 400),
							mentions: [...options.message.mentions],
						},
					},
					// 本轮工具结束后并入：群里的一条问题不该等整轮答完。
					whenBusy: "steer",
				},
				context,
			);
			delivered.push(slug);
		} catch (error) {
			// 不抛：消息已在频道里，对方下次醒来会看到未读摘要。
			process.stderr.write(
				`[投递失败] ${options.channel.id}#${options.message.seq} → ${slug}: ${
					error instanceof Error ? error.message : String(error)
				}\n`,
			);
			failed.push(slug);
		}
	}

	return { delivered, failed, skipped };
}

function oneLine(text: string, max: number): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}
