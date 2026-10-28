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
import type { Conversation, Harness } from "../runtime/index.ts";
import { BACKGROUND_CONTEXT, type Context } from "../runtime/index.ts";
import {
	type Channel,
	type ChannelState,
	type Message,
	OWNER,
	personalId,
	recipientsOf,
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

/** 一个「叫了但没人会答」的收件人。拼成频道里的 `note` 用，老板才能看见系统做了什么。 */
export type DeliverIssue = {
	readonly slug: string;
	/** 「还没有会话」还是「投递抛错」。两者文案不同，不能糊成一句。 */
	readonly reason: "no-conversation" | "failed";
	/** 抛错时的简短原因。 */
	readonly detail?: string;
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
	/**
	 * 此刻手上还有活（有非后台任务在跑）的会话 id。
	 *
	 * 这类投递会**打断**对方正在干的事（`whenBusy: "steer"`），所以正文要多一句
	 * 「这是插话，不是新任务」—— 否则它答完这句就把活丢了。实测：老板在沈舟加音效
	 * 的中途私聊问「你是谁啊」，它答完就收工，再没回项目频道汇报。
	 */
	readonly busy?: ReadonlySet<number>;
	/**
	 * 有人没被叫醒时通报一声。不传就只听 stderr。
	 *
	 * 为什么需要这个：投递失败只写 stderr 的话，频道里空白一片，老板看到的
	 * 「我说了没人回」和「系统真挂了」长得一模一样 —— 那个「@CEO 不理我」的现象
	 * 就是这么排查了很多轮才定位到投递层的。
	 */
	readonly notify?: (issues: readonly DeliverIssue[]) => Promise<void> | void;
};

/** 这个频道是不是「我和老板的私聊」。`viewer` 缺省时只要求两边里有老板。 */
function isOwnerDm(channel: Channel, viewer: string | undefined): boolean {
	if (!channel.id.startsWith("dm:") || !channel.members.includes(OWNER)) return false;
	return viewer === undefined || channel.id === personalId(viewer);
}

/** 一条消息交给模型时的正文。纯函数，方便单测。 */
export function renderDelivery(options: {
	readonly channel: Channel;
	readonly message: Message;
	/** 收件人。用来从「还 @ 了」里剔掉自己——否则每个人都会看到「还 @ 了你」。 */
	readonly viewer?: string;
	readonly labelOf?: (slug: string) => string;
	/** 这句是插进一轮正在跑的工作里的。 */
	readonly interrupted?: boolean;
}): string {
	const label = options.labelOf ?? ((slug: string) => slug);
	const { channel, message } = options;
	const quoted =
		message.replyTo === undefined ? "" : `（回复 #${message.replyTo}）`;
	const others = message.mentions.filter(
		(slug) => slug !== message.from && slug !== options.viewer,
	);
	const also = others.length === 0 ? "" : `\n这条还 @ 了：${others.map(label).join("、")}`;
	// 「这条会叫醒谁、你是第几个」和「别人也在看」必须由代码注入：模型看不到投递名单，
	// 于是两个人被同时叫醒时各写一条重复甚至矛盾的回复，谁也不知道对方也在场。
	const woken = recipientsOf(channel, message).filter((slug) => slug !== OWNER);
	const line = [also];
	if (woken.length > 0) {
		const position =
			options.viewer === undefined ? "" : `（你在第 ${woken.indexOf(options.viewer) + 1 || 1} 位）`;
		line.push(`\n这条会叫醒：${woken.map(label).join("、")}${position}`);
		if (woken.length > 1) {
			line.push("\n别人也在看这条。动手前先说一句你接哪一块，别重复别人已经做的。");
		}
	}
	return [
		// 第一行必须带**频道 id**：模型以前只看到标题，于是它只能用 `say` 的缺省频道回话；
		// 一旦缺省频道猜错（例如猜成私聊），整段对话就跑到别的房间里去了。
		`【${channel.title}】#${message.seq}（频道 ${channel.id}）${quoted}`,
		`${label(message.from)}：${message.text}${line.join("")}`,
		...(isOwnerDm(channel, options.viewer)
			? ["（这是你和老板的私聊，只回这里，别去群里说）"]
			: []),
		`（回话用 say，channel 省略即回这个频道；要看完整历史用 read_channel）`,
		...(options.interrupted === true
			? [
					"（这是插话，不是新任务：答完这一句就回到你手上的活，别停。手上的活干完按规矩汇报，汇报完再管这件事。）",
				]
			: []),
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
	const issues: DeliverIssue[] = [];
	const label = options.labelOf ?? ((slug: string) => slug);
	const bodyOf = (viewer: string, interrupted: boolean): string =>
		renderDelivery({
			channel: options.channel,
			message: options.message,
			viewer,
			labelOf: label,
			interrupted,
		});

	for (const slug of options.targets) {
		try {
			const conversation = await options.conversationOf(slug);
			if (conversation === undefined) {
				skipped.push(slug);
				issues.push({ slug, reason: "no-conversation" });
				continue;
			}
			const digest = renderDigest(options.state, slug);
			const body = bodyOf(slug, options.busy?.has(Number(conversation.id)) === true);
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
			const detail = error instanceof Error ? error.message : String(error);
			process.stderr.write(
				`[投递失败] ${options.channel.id}#${options.message.seq} → ${slug}: ${detail}\n`,
			);
			failed.push(slug);
			issues.push({ slug, reason: "failed", detail });
		}
	}

	// 通报放在最后、一次说完：逐条写 note 会让频道多出一串系统消息。
	// 老板被 `recipientsOf` 选中是正常现象（他没有会话），所以那一条由调用方先滤掉。
	if (issues.length > 0 && options.notify !== undefined) {
		try {
			await options.notify(issues);
		} catch (error) {
			process.stderr.write(
				`[投递通报失败] ${options.channel.id}#${options.message.seq}: ${
					error instanceof Error ? error.message : String(error)
				}\n`,
			);
		}
	}

	return { delivered, failed, skipped };
}

/**
 * 哪些会话此刻手上有活。
 *
 * 用 `harness.inspect()`（只读、不写、不跑任务）取「活着的任务」，按会话聚合，
 * 排掉后台任务 —— 后台任务是代理自己的账本，不算「打断它正在干的事」。
 */
export async function liveConversations(
	harness: Harness,
	context: Context = BACKGROUND_CONTEXT,
): Promise<Set<number>> {
	const inspection = await harness.inspect(context);
	const busy = new Set<number>();
	for (const task of inspection.tasks) {
		if (task.record.background === true) continue;
		busy.add(Number(task.record.conversationId));
	}
	return busy;
}

function oneLine(text: string, max: number): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}
