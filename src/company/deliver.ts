/**
 * `deliver()`：**唯一的跨 agent 投递原语**。
 *
 * 设计见 `docs/COMMS.md` §5.1。这一条是整个重构的核心：
 *
 * ```
 * 改前：delegate_to_role → submit → await submission.wait(180s) → 捞回复文本
 * 改后：postToChannel → deliver（投递 + 立刻返回）→ 对方自己写回频道
 * ```
 *
 * ── 三条硬约束 ──
 *
 * 1. **不等待回复**。`deliver()` 只保证「消息已进对方队列」，不返回对方的答案。
 *    答案通过频道异步回来。这是 CEO 能连发 N 条指令而不阻塞的唯一原因。
 *
 * 2. **投递失败不能让消息丢失**。消息已经落在 `ChannelDoc` 里（`postToChannel`
 *    先写再投）。投递失败只影响「对方什么时候看到」，不影响「能不能看到」——
 *    它下次醒来时的未读摘要会带上。
 *
 * 3. **每条投递都带未读摘要**。没被唤醒的人不会错过信息：下次因任何原因醒来，
 *    输入前缀里有「你有 N 条未读」。
 *
 * ── 投递回执（裁决 B4）──
 *
 * 约束 1（不等待）的代价是：「进了队列」不等于「被处理了」。队列里的东西可能被结算成
 * `unanswered`（模型不可用 / 被 abort / 会话重置），而 `deliver()` 当场看不到——
 * 生产库曾积了 69 条这样的静默死亡。所以投递结果有**第三态**：
 *
 * - `delivered`：已进队列（注意：**不代表已读**）
 * - `failed`：连队列都没进
 * - `unanswered`：进了队列但最终没被处理
 *
 * `unanswered` **不由这里填**：填它必须等 submission 结算，而等待正是这个函数存在的理由的
 * 反面。这里的职责只到「把 submissionId 记进消息的 `deliveredTo`」，判定与重投交给看门狗
 * （`watchdog.ts` 的 `redeliverUnanswered`）。类型上保留这一态，是为了让调用方
 * **不再假设「delivered 就是成功」**——编译器会逼着你看清有第三种结局。
 */
import {
	BACKGROUND_CONTEXT,
	type CompanyRuntime,
	type Context,
	type JsonValue,
} from "../runtime/index.ts";
import {
	digestFor,
	renderForModel,
	type Channel,
	type ChannelMessage,
	type ChannelState,
	type DeliveryReceipt,
	type UnreadDigest,
} from "../domain/channels.ts";
import { ChannelDoc } from "./channels-doc.ts";
import { labelOf, type Org } from "../domain/membership.ts";
import { buildOrg } from "./org-model.ts";
import { CompanyDoc, ReplyContextDoc } from "./docs.ts";
import { MemoryDoc, memoryActorFromOrg } from "./memory.ts";
import { renderMemoryBrief, type MemoryState } from "../domain/memory.ts";

/** 一次投递的结果。 */
export type DeliverOutcome = {
	/** 成功进入队列的会话。**不代表对方已读**，只代表队列收下了。 */
	readonly delivered: readonly number[];
	/** 投递失败的会话（消息仍在频道里，它们下次醒来会看到未读）。 */
	readonly failed: readonly number[];
	/**
	 * 进了队列、但最终没被处理的会话（submission 结算成 `unanswered`）。
	 *
	 * `deliver()` 自己不等待，所以这里**永远是空数组**；真正的值由看门狗延迟判定，
	 * 它照着消息上的 `deliveredTo` 反查 submission 状态（见 `watchdog.ts`）。
	 * 字段存在本身就是契约：调用方必须知道有第三种结局。
	 */
	readonly unanswered: readonly number[];
};

/** 投递选项。 */
export type DeliverOptions = {
	/** 频道。 */
	readonly channel: Channel;
	/** 刚追加的消息。 */
	readonly message: ChannelMessage;
	/** 要唤醒谁（`recipientsOf` 的结果）。 */
	readonly targets: readonly number[];
	/**
	 * 投递档位，默认 `steer`：本轮工具结束后并入。
	 *
	 * 刻意不用 `followUp`：那要等整轮答完，群里一条问题可能要等十几分钟才被看见。
	 *
	 * **不存在 `now` 档**。以前这里声明了 `urgency?: "steer" | "now"`，但实现是
	 * `options.urgency === "now" ? "steer" : "steer"`——两个分支一模一样，全仓也没有
	 * 一处传参。类型签名让人以为「紧急消息能插队」，实际从来没有。真要打断当前轮
	 * 是 `src/server/http.ts` 的 `interruptThenDeliver`（它会先 abort、再投），
	 * 那是有状态的破坏性操作，不适合藏在「投递」这个原语里。
	 */
	readonly urgency?: "steer";
	/**
	 * 第几次重投（0 / 缺省 = 首次投递）。
	 *
	 * 为什么要它：`requestId` 是底层的去重键，同一条消息重投时若还用原来的
	 * `ch:<channel>:<seq>:<target>`，`admitSubmission` 会**直接返回原来那个 submission**
	 * （甚至把 `unanswered` 报成 `done`）——看起来投了，其实一条新消息都没入队。
	 * 加上 `:rN` 后缀才能真的重投；次数由调用方（看门狗）控制，这里只负责拼进 key。
	 */
	readonly attempt?: number;
	/**
	 * 覆盖交给模型的正文（缺省用 `renderForModel` 渲染频道消息）。
	 *
	 * 用于「这条消息不是普通的频道发言」的场合：拍板结果（`app.decision`）要
	 * 说清「谁对什么拍了什么板」，处置结果还要说「暂搁 / 放弃」。渲染频道消息
	 * 得不出这些——它只知道有个人在某个频道说了句话。
	 */
	readonly body?: string;
	/**
	 * 覆盖落进会话流的条目标签（缺省 `app.channel` + 频道数据）。
	 *
	 * 界面靠 `kind` 区分「频道消息 / 拍板结果 / 处置结果」，靠 `data` 决定怎么画。
	 * 缺省时是频道消息的那套字段。
	 */
	readonly entry?: { readonly kind: string; readonly data: JsonValue };
	/**
	 * 覆盖 `requestId` 的基础部分（缺省 `ch:<channel>:<seq>`，之后自动接 `:<target>`）。
	 *
	 * 拍板结果的天然去重键是「哪一件待办」，而不是「哪一条频道消息」——同一个 key
	 * 只该投一次。重投后缀 `:rN` 仍然照常拼接。
	 */
	readonly requestKey?: string;
};

/**
 * 投递给一组会话。
 *
 * 逐条 try/catch：一条失败不影响其余（审计 B-02 的教训——原实现用
 * `for (...) await submit(...)`，第 k 条抛错会让 k+1..n 永久丢失）。
 */
export async function deliver(
	runtime: CompanyRuntime,
	options: DeliverOptions,
	context: Context = BACKGROUND_CONTEXT,
): Promise<DeliverOutcome> {
	const delivered: number[] = [];
	const failed: number[] = [];
	// 这次投递落下的回执（供写回消息上的 `deliveredTo`）。
	const receipts: DeliveryReceipt[] = [];

	const company = await runtime.harness.snapshot(CompanyDoc, context);
	const org = buildOrg(company);
	const channels = (await runtime.harness.snapshot(ChannelDoc, context)) ?? { channels: {}, nextSeq: 1 };
	// 记忆只读一次（每个目标都要用，但不能每个目标都读一遍库）。
	const memoryState = (await runtime.harness.snapshot(MemoryDoc, context)) as MemoryState | undefined;

	for (const target of options.targets) {
		try {
			const conversation = await runtime.harness.conversation(target as never, context);
			if (conversation === undefined) {
				failed.push(target);
				continue;
			}

			const body =
				options.body ?? renderForModel(options.channel, options.message, (id) => labelOf(org, id));
			const digest = digestFor(channels as ChannelState, target, 5);
			// #12 记忆简报：只给对方**最近 3 条 + 与本条消息最相关 2 条**。
			// 这里是唯一「必然经过」的注入点——每个被唤醒的 agent 都走这条路径。
			const actor = memoryActorFromOrg(org, target);
			const memory =
				actor === undefined || memoryState === undefined
					? ""
					: renderMemoryBrief(memoryState, {
							level: actor.level,
							owner: actor.owner,
							query: options.message.text,
						});
			const content = [body, renderDigest(digest), memory]
				.filter((part) => part !== "")
				.join("\n\n");

			const submission = await conversation.submit(
				{
					type: "input",
					content,
					// 请求标识由「频道 + 消息序号 + 目标」推导：同一条消息重复投递会被去重
					// （崩溃恢复是至少一次语义，见 ADR-006）。
					// 看门狗重投时带 `:rN` 后缀——去重是有意的，但重投必须真的再进一次队。
					requestId: requestIdOf(options, target),
					entry: options.entry ?? {
						kind: "app.channel",
						data: {
							channelId: options.channel.id,
							channelTitle: options.channel.title,
							seq: options.message.seq,
							from: options.message.from,
							fromLabel: options.message.fromLabel,
							kind: options.message.kind,
							text: options.message.text.slice(0, 400),
							mentions: [...options.message.mentions],
						},
					},
					whenBusy: "steer",
				},
				context,
			);
			// 记住「这个人是被哪条消息、在哪个频道叫醒的」。
			// 必须写在 submit 之后：先让模型看到消息，再让工具读到上下文；
			// 反过来会出现「上下文是新的、消息还没入队」的窗口。
			await recordReplyContext(runtime, target, options, context);
			// 回执：拿到 submissionId 才算「有据可查的投递」。
			// 没有它，日后就无法区分「队列还没轮到他」与「已被结算成 unanswered」。
			receipts.push({ conversationId: target, submissionId: Number(submission.id) });
			delivered.push(target);
		} catch (error) {
			// 投递失败不抛：消息已在频道里，对方下次醒来会看到未读摘要。
			// 但必须留痕，否则「消息发了没人理」和「消息没发出去」无法区分。
			process.stderr.write(
				`[投递失败] ${options.channel.id}#${options.message.seq} → 会话 ${target}: ${
					error instanceof Error ? error.message : String(error)
				}\n`,
			);
			failed.push(target);
		}
	}

	// 回执写回消息。失败不影响投递结果：消息已经进队了，回执只是「事后可查」的附加信息，
	// 记录失败最坏退化成老行为（看门狗看不到这条），不该让一条已投递的消息变成失败。
	if (receipts.length > 0) await recordDeliveredTo(runtime, options, receipts, context);

	// `unanswered` 恒为空：本函数不等待，判定由看门狗做（见文件头）。
	return { delivered, failed, unanswered: [] };
}

/** 拼 requestId：重投（`attempt > 0`）时加 `:rN` 后缀，绕开底层的同 key 去重。 */
function requestIdOf(options: DeliverOptions, target: number): string {
	const base = `${options.requestKey ?? `ch:${options.channel.id}:${options.message.seq}`}:${target}`;
	const attempt = options.attempt ?? 0;
	return attempt <= 0 ? base : `${base}:r${attempt + 1}`;
}

/**
 * 把「刚被谁在哪个频道叫醒」写进目标会话的 `ReplyContextDoc`。
 *
 * 为什么单独一个函数而不是内联：`deliver` 里已经有六件事（渲染正文、拼未读
 * 摘要、去重、entry、错误处理），再加一块就没人看得懂了。
 *
 * 失败不抛：回复上下文只是「发言默认频道」的优化，丢了最坏情况是退回
 * 按角色推断（旧行为），不该让整条投递失败。
 */
async function recordReplyContext(
	runtime: CompanyRuntime,
	target: number,
	options: DeliverOptions,
	context: Context,
): Promise<void> {
	try {
		await runtime.harness.commit(async (tx) => {
			const doc = await tx.doc(ReplyContextDoc, target as never);
			doc.channelId = options.channel.id;
			doc.seq = options.message.seq;
			doc.from = options.message.from;
			doc.fromLabel = options.message.fromLabel;
			doc.mentioned = options.message.mentions.includes(target);
			doc.at = options.message.at;
		}, context);
	} catch (error) {
		process.stderr.write(
			`[回复上下文写入失败] ${options.channel.id}#${options.message.seq} → 会话 ${target}: ${
				error instanceof Error ? error.message : String(error)
			}\n`,
		);
	}
}

/**
 * 把回执写回这条消息的 `deliveredTo`。
 *
 * 为什么不整频道替换：`ChannelDoc` 里一个群频道能到 50KB，整替换会把整个频道
 * 当一个 delta 写下去；而这里只改 `messages[k].deliveredTo` 一个键——chord 的
 * 数组 diff 是按下标逐元素的，实际落盘的只有那几个键。
 *
 * 找不到那条消息（被 800 条上限裁了 / 别人刚清了频道）就静默跳过：
 * 回执的价值随消息一起没了，没什么可补救的。
 *
 * 失败只写 stderr：消息已经进队，回执丢了不能让一条已投递的消息变成失败。
 */
async function recordDeliveredTo(
	runtime: CompanyRuntime,
	options: DeliverOptions,
	receipts: readonly DeliveryReceipt[],
	context: Context,
): Promise<void> {
	try {
		await runtime.harness.commit(async (tx) => {
			const doc = await tx.doc(ChannelDoc);
			const channel = (doc as ChannelState).channels[options.channel.id];
			if (channel === undefined) return;
			const message = channel.messages.find((entry) => entry.seq === options.message.seq);
			if (message === undefined) return;
			// 追加而非覆盖：看门狗重投时同一条消息会有多份回执，最新的那份才是当前有效的
			// submission；覆盖就丢掉了「重投过几次」这个事实。
			message.deliveredTo = [...(message.deliveredTo ?? []), ...receipts];
		}, context);
	} catch (error) {
		process.stderr.write(
			`[投递回执写入失败] ${options.channel.id}#${options.message.seq}: ${
				error instanceof Error ? error.message : String(error)
			}\n`,
		);
	}
}

/** 把未读摘要渲染成输入前缀。 */
export function renderDigest(digests: readonly UnreadDigest[]): string {
	if (digests.length === 0) return "";
	const lines = [`【你有 ${digests.reduce((sum, item) => sum + item.unread, 0)} 条未读】`];
	for (const item of digests) {
		const mark = item.mentions > 0 ? `（其中 ${item.mentions} 条 @你）` : "";
		lines.push(`- ${item.title}：${item.unread} 条${mark} — ${item.preview}`);
	}
	lines.push("（用 read_channel 看完整内容；@ 你的问题请尽快回复）");
	return lines.join("\n");
}

/** 给单个会话投一条「系统通知」（不经频道，直接进它的会话流）。 */
export async function notify(
	runtime: CompanyRuntime,
	conversationId: number,
	input: {
		readonly kind: string;
		readonly data: Record<string, unknown>;
		readonly text: string;
		readonly wake?: boolean;
	},
	context: Context = BACKGROUND_CONTEXT,
): Promise<boolean> {
	try {
		const conversation = await runtime.harness.conversation(conversationId as never, context);
		if (conversation === undefined) return false;

		if (input.wake === false) {
			// 纯记录：不进模型上下文，只进会话流（底层 isDisplayOnly 判定）
			await conversation.submit(
				{ type: "write", entry: { kind: input.kind, data: input.data as never } },
				context,
			);
			return true;
		}
		await conversation.submit(
			{
				type: "input",
				content: input.text,
				requestId: `notify:${input.kind}:${conversationId}:${Date.now()}`,
				entry: { kind: input.kind, data: input.data as never },
				whenBusy: "steer",
			},
			context,
		);
		return true;
	} catch (error) {
		process.stderr.write(
			`[通知失败] 会话 ${conversationId}: ${error instanceof Error ? error.message : String(error)}\n`,
		);
		return false;
	}
}

/** 组织（供调用方复用，避免重复读 CompanyDoc）。 */
export async function orgOf(runtime: CompanyRuntime, context: Context = BACKGROUND_CONTEXT): Promise<Org> {
	return buildOrg(await runtime.harness.snapshot(CompanyDoc, context));
}
