/**
 * 我开口：把我的一句话投进频道。
 *
 * 我不是 agent（没有会话、没有提示词），所以它不能走 `say` 工具，需要一个宿主入口。
 * 语义与 agent 完全一致：同一套 @ 解析、同一套收件人规则、同一套投递 —— 所以这里
 * 只做「我是谁、名册是哪一份」，投递本身交给装配好的那一个 `flow`。
 */
import type { Context, Harness } from "../../core/runtime/index.ts";
import { labelsOf, readAllIdentities } from "../../core/documents/member/identity.ts";
import { DirectoryDoc, labelIn, type DirectoryState } from "../../core/channel/roster.ts";
import { mentionRosterOf } from "../../core/channel/mentions.ts";
import { ChannelDoc, OWNER, emptyChannelState, type Attachment } from "../../core/channel/types.ts";
import type { ChannelFlow } from "../../core/channel/post.ts";
import type { DeliverResult } from "../../core/flow/types.ts";

export type SpeakOptions = {
	readonly channelId: string;
	readonly text: string;
	/** 谁说这句话。缺省是我。 */
	readonly from?: string;
	readonly replyTo?: number;
	/** 唯一的非默认 kind：系统留痕。发言不传。 */
	readonly kind?: "note";
	/** 附件引用（图片会被读成内容块交给模型）。 */
	readonly attachments?: readonly Attachment[];
	/** 不按 @ 推算，直接叫醒这几个人（系统留痕叫人时用）。 */
	readonly wakeTo?: readonly string[];
};

export type SpeakDeps = {
	readonly harness: Harness;
	readonly agentRoots: readonly string[];
	/** 内存名册（落盘那份读不到时的兜底）。 */
	readonly directory: DirectoryState;
	readonly flow: ChannelFlow;
};

export function createSpeak(deps: SpeakDeps) {
	return async (
		options: SpeakOptions,
		context: Context,
	): Promise<{ readonly seq: number; readonly delivery: DeliverResult }> => {
		const state = (await deps.harness.snapshot(ChannelDoc, context)) ?? emptyChannelState();
		const channel = state.channels[options.channelId];
		if (channel === undefined) throw new Error(`频道不存在：${options.channelId}`);
		// 名册读**当下**那一份，不读装配期那份：`hire` 之后 `labels` 要等下一次 `rescan`
		// 才刷新，中间这个人会以 slug 出现在投递摘要与提示词里（`@shen-zhou`），
		// 看上去就像「我视角里没有这个人」。
		const directory = (await deps.harness.snapshot(DirectoryDoc, context)) ?? deps.directory;
		// 我的话也要过一遍名册：他自己写 `@我`（或者老消息里的 `@我`）时，
		// 不给名册就只能存成字面 token，界面画得出来、`recipientsOf` 却认不出人。
		const everyone = await readAllIdentities(deps.agentRoots);
		const roster = mentionRosterOf(
			everyone.map((identity) => ({ slug: identity.slug, name: identity.name })),
		);
		// 显示名以**当下的** `identity.md` 为准，名册里的 `labels` 只做兜底。
		const labels = { ...directory.labels, ...labelsOf(everyone) };
		const result = await deps.flow.publish(
			state,
			{
				channelId: options.channelId,
				from: options.from ?? OWNER,
				text: options.text,
				roster,
				at: Date.now(),
				...(options.replyTo === undefined ? {} : { replyTo: options.replyTo }),
				...(options.kind === undefined ? {} : { kind: options.kind }),
				...(options.attachments === undefined ? {} : { attachments: options.attachments }),
				...(options.wakeTo === undefined ? {} : { wakeTo: options.wakeTo }),
			},
			context,
			(slug) => labelIn({ ...directory, labels }, slug),
		);
		return { seq: result.message.seq, delivery: result.delivery };
	};
}
