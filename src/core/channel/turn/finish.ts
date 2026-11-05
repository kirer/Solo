/**
 * 收尾的旧入口：现在只是 `core/flow` 的一层薄壳。
 *
 * 判断（取正文、`saidLast`、`turnTarget`、同文判据）在
 * `flow/defaults/settle.ts`；读答案、补发在 `flow/settle.ts`。这里保留
 * `createTurnFinisher` 这个名字，是因为 `wiring.ts` 与测试按它接线 —— 它把
 * `TurnDeps` 拼成一个 flow，再取 `settle`。
 *
 * 补发就是一次正常的 `publish`：落盘、算人、扇出、插件钩子走的是同一条主线；
 * `repost` 闸与 `publish` 闸都是进程级共享的（`flow/gates.ts`）。
 */
import type { Conversation, Harness } from "../../runtime/index.ts";
import type { MentionRoster } from "../mentions.ts";
import type { ChannelFlowDeps } from "../post.ts";
import type { FlowPolicy } from "../types.ts";
import type { WakeRecord } from "./record.ts";
import { createFlow } from "../../flow/index.ts";
import { createMessageStore } from "../../flow/store.ts";
import { createTurnRunner } from "../../flow/runner.ts";
import { defaultRouter } from "../../flow/defaults/router.ts";
import { defaultSettler } from "../../flow/defaults/settle.ts";
import { policyRouter, policySettler } from "../../flow/policies.ts";
import { sharedGates } from "../../flow/gates.ts";
import type { FinishTurn } from "../../flow/types.ts";

export type { EntryReader, FinishTurn, FinishTurnInfo } from "../../flow/types.ts";

export type TurnDeps = {
	readonly harness: Harness;
	readonly promptDir?: string | undefined;
	readonly text?: ChannelFlowDeps["text"];
	/** 名册：补发时 `@我` 要存成 `owner`，不能存字面 token（见 `ownerSpeak` 同一段说明）。 */
	readonly roster?: () => Promise<MentionRoster>;
	readonly conversationOf: (slug: string) => Promise<Conversation | undefined>;
	readonly rememberWake?: (slug: string, wake: WakeRecord) => Promise<void>;
	/** 原子唤醒：补发叫醒别人时，wake 与入队同一个 commit（ADR-076）。 */
	readonly wakeTogether?: ChannelFlowDeps["wakeTogether"];
	readonly labelOf?: ChannelFlowDeps["labelOf"];
	readonly wakeOf?: (slug: string) => Promise<WakeRecord | undefined>;
	/** 补发也是一条公开消息：插件听消息要跟着走到这里（Phase 1 起）。 */
	readonly afterPublish?: ChannelFlowDeps["afterPublish"];
	/** 插件注册的分发 / 收尾策略：补发也走同一条链。 */
	readonly policies?: () => readonly FlowPolicy[];
};

/**
 * 造一个收尾器。投递、我说话两条路共用同一份 —— 收尾的行为只写一次。
 */
export function createTurnFinisher(deps: TurnDeps): FinishTurn {
	const policies = deps.policies;
	const flow = createFlow({
		store: createMessageStore({ harness: deps.harness }),
		// 插件策略排在默认规则前面；收尾策略替换默认，弃权/抛错再回退（ADR-080）。
		routers: [...(policies === undefined ? [] : [policyRouter(policies)]), defaultRouter()],
		runner: createTurnRunner({
			harness: deps.harness,
			conversationOf: deps.conversationOf,
			...(deps.labelOf === undefined ? {} : { labelOf: deps.labelOf }),
			...(deps.rememberWake === undefined ? {} : { rememberWake: deps.rememberWake }),
			...(deps.wakeTogether === undefined ? {} : { wakeTogether: deps.wakeTogether }),
			...(deps.wakeOf === undefined ? {} : { wakeOf: deps.wakeOf }),
			...(deps.promptDir === undefined ? {} : { promptDir: deps.promptDir }),
			...(deps.text === undefined ? {} : { text: deps.text }),
		}),
		settler: policies === undefined ? defaultSettler() : policySettler(policies, defaultSettler()),
		...(deps.roster === undefined ? {} : { roster: deps.roster }),
		...(deps.afterPublish === undefined ? {} : { hooks: { afterPublish: deps.afterPublish } }),
		gate: sharedGates(),
	});
	return (info, context) =>
		flow.settle(
			{
				kind: "done",
				slug: info.slug,
				answer: info.answer,
				wake: info.wake,
				entries: info.conversation,
			},
			context,
		);
}
