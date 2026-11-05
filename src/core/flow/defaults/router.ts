/**
 * 内置路由规则：今天 `recipientsOf` + `deliveryTargets` 的那一套，原样搬进来。
 *
 * 它只做两件事：把「谁会被叫醒」算成事实（`defaultTargets`），以及把这份事实
 * 当成一个策略返回。插件策略排在它前面时，可以加人、减人、或者整份替换；
 * 没插件的那些调用点，走的就是这里，行为与重整之前逐字节相同。
 *
 * 判据本身仍留在 `channel/mentions.ts`（`@` 的语义）与 `channel/rules.ts`
 * （`speakerBefore`）—— 这里只负责把两者拼成一次决定，不重写规则。
 */
import { chatKind, type Channel, type ChannelState, type Message } from "../../channel/types.ts";
import { deliveryTargets } from "../../channel/mentions.ts";
import { speakerBefore } from "../../channel/rules.ts";
import type { Router } from "../ports.ts";
import type { RouteFacts } from "../types.ts";

/** 把一条刚落盘的消息翻译成路由事实。 */
export function routeFactsOf(state: ChannelState, channel: Channel, message: Message): RouteFacts {
	const lastSpeaker = speakerBefore(state, channel.id, message.seq);
	const defaultTargets = deliveryTargets(channel, message, lastSpeaker);
	return {
		message: {
			seq: message.seq,
			from: message.from,
			text: message.text,
			kind: message.kind === "note" ? "note" : "chat",
			mentions: [...message.mentions],
			...(message.replyTo === undefined ? {} : { replyTo: message.replyTo }),
		},
		channel: {
			id: channel.id,
			kind: chatKind(channel),
			members: [...channel.members],
			wakeOnAll: [...channel.wakeOnAll],
		},
		...(lastSpeaker === undefined ? {} : { lastSpeaker }),
		defaultTargets,
	};
}

/** 内置策略：不干预时，就按事实里的名单叫。 */
export function defaultRouter(): Router {
	return {
		async decide(facts) {
			return { kind: "targets", targets: facts.defaultTargets, reason: "default" };
		},
	};
}
