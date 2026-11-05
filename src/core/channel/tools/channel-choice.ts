/**
 * 「这一轮在哪儿说」与「这一轮还有谁在说」：两个都靠唤醒记录判。
 */
import type { Context } from "../../runtime/index.ts";
import { wakeOf } from "../roster.ts";
import { OWNER, chatKind, type ChannelState } from "../types.ts";
import { deliveryTargets } from "../mentions.ts";
import { fallbackChannelId, speakerBefore } from "../rules.ts";
import type { CoreToolDeps } from "./context.ts";
import { fill } from "../../documents/base/catalog.ts";

/**
 * 「默认在哪儿说话」：刚被叫醒的那个频道 → 我是成员的群里最近活跃的那个 → 我和我的私聊。
 *
 * 第一条最重要：我在私聊里问我一句，我一开口就该回私聊，而不是群里。
 * 最后一级**不能直接拿 `mine[0]`**：那可能正是我和我的私聊，于是我在群里问的话被答进私聊。
 * 形态由 `fallbackChannelId` 按成员推导，不看 id 前缀。
 */
export async function defaultChannel(
	deps: CoreToolDeps,
	state: ChannelState,
	slug: string,
	conversationId: number,
	explicit: string | undefined,
	context: Context,
): Promise<{ channelId: string } | { error: string }> {
	if (explicit !== undefined && explicit !== "") {
		const channel = state.channels[explicit];
		if (channel !== undefined) {
			if (!channel.members.includes(slug)) {
				return { error: fill(deps.text, "channel.not-member", { title: channel.title }) };
			}
			return { channelId: explicit };
		}
		// 频道名也认。提示词里给的是**标题**（「群『QQ农场』」），不是 id —— 只认 id 的话，
		// 模型想发到团队频道时手上根本没有可写的东西，于是省略 channel 落回唤醒的私聊，
		// 一条派活就躺在私聊里，团队一个字都收不到（真实事故：40 条私聊指挥）。
		// 只在自己所在的频道里按**全等**找，不做模糊匹配；重名就让它显式给 id。
		const named = Object.values(state.channels)
			.filter((candidate) => candidate.title === explicit && candidate.members.includes(slug))
			.map((candidate) => candidate.id)
			.sort();
		const only = named[0];
		if (named.length === 1 && only !== undefined) return { channelId: only };
		if (named.length > 1) {
			return { error: fill(deps.text, "channel.ambiguous", { name: explicit, ids: named.join("、") }) };
		}
		const mine = Object.values(state.channels)
			.filter((candidate) => candidate.members.includes(slug))
			.map((candidate) => `${candidate.id}「${candidate.title}」`)
			.sort();
		return { error: fill(deps.text, "channel.missing", { name: explicit, channels: mine.join("、") }) };
	}
	const directory = await deps.directory(context);
	const wake = wakeOf(directory, conversationId);
	if (wake !== undefined) {
		// 用 `reply`：私聊插话时默认就回私聊；手上那件活属于哪个频道由收尾去管（`task`）。
		const channel = state.channels[wake.reply.channelId];
		if (channel !== undefined && channel.members.includes(slug)) return { channelId: wake.reply.channelId };
	}
	// 兜底：群聊优先。
	//
	// **落到私聊就拒绝**：没有唤醒记录 = 不知道这一轮是从哪儿被叫来的；此时把话写进
	// 我和我的私聊，问的人在原频道就什么都看不到（ADR-037 修过的老 bug）。宁可报一个
	// 看得见的错，也不静默放进私聊。
	const fallback = fallbackChannelId(state, slug);
	const target = state.channels[fallback];
	if (target === undefined || chatKind(target) === "dm") {
		return { error: fill(deps.text, "channel.no-wake") };
	}
	return { channelId: fallback };
}

/**
 * 这一轮除了我，还有哪些 agent 被**同一条**消息叫醒。
 *
 * 判据取自名册里的唤醒记录（`wakeOf`，由投递层在成功投递时写入），再用
 * `recipientsOf` 重算一次收件人 —— 和投递层用的是同一个纯函数，不会两处口径不一致。
 *
 * 我不算：他不是一个会接着说话的 agent。
 */
export async function othersAwoken(
	deps: CoreToolDeps,
	state: ChannelState,
	conversationId: number,
	slug: string,
	context: Context,
): Promise<string[]> {
	const directory = await deps.directory(context);
	const wake = wakeOf(directory, conversationId);
	if (wake === undefined) return [];
	const channel = state.channels[wake.reply.channelId];
	if (channel === undefined) return [];
	const message = (state.messages[channel.id] ?? []).find((item) => item.seq === wake.reply.seq);
	// 找不到那条消息时保守一点：频道里只要还有别的 agent，就当有人接得住 ——
	// 宁可让一句无话不说的话被放过，也不要因为一次读不到而把他卡在第 1 条消息上。
	const candidates =
		message === undefined
			? channel.members.filter((member) => member !== OWNER)
			: deliveryTargets(channel, message, speakerBefore(state, channel.id, message.seq));
	return candidates.filter((member) => member !== slug);
}
