/**
 * `deliver()`：**唯一的跨 agent 投递原语**。
 *
 * 设计见 `docs/design/COMMS-REFACTOR.md` §5.1。这一条是整个重构的核心：
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
 */
import {
	BACKGROUND_CONTEXT,
	type CompanyRuntime,
	type Context,
} from "../runtime/index.ts";
import {
	digestFor,
	renderForModel,
	type Channel,
	type ChannelMessage,
	type ChannelState,
	type UnreadDigest,
} from "../domain/channels.ts";
import { ChannelDoc } from "./channels-doc.ts";
import { labelOf, type Org } from "../domain/membership.ts";
import { buildOrg } from "./org-model.ts";
import { CompanyDoc } from "./docs.ts";

/** 一次投递的结果。 */
export type DeliverOutcome = {
	/** 成功进入队列的会话。 */
	readonly delivered: readonly number[];
	/** 投递失败的会话（消息仍在频道里，它们下次醒来会看到未读）。 */
	readonly failed: readonly number[];
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

	const company = await runtime.harness.snapshot(CompanyDoc, context);
	const org = buildOrg(company);
	const channels = (await runtime.harness.snapshot(ChannelDoc, context)) ?? { channels: {}, nextSeq: 1 };

	for (const target of options.targets) {
		try {
			const conversation = await runtime.harness.conversation(target as never, context);
			if (conversation === undefined) {
				failed.push(target);
				continue;
			}

			const body = renderForModel(options.channel, options.message, (id) => labelOf(org, id));
			const digest = digestFor(channels as ChannelState, target, 5);
			const content = [body, renderDigest(digest)].filter((part) => part !== "").join("\n\n");

			await conversation.submit(
				{
					type: "input",
					content,
					// 请求标识由「频道 + 消息序号 + 目标」推导：同一条消息重复投递会被去重
					// （崩溃恢复是至少一次语义，见 ADR-006）
					requestId: `ch:${options.channel.id}:${options.message.seq}:${target}`,
					entry: {
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

	return { delivered, failed };
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
