/**
 * 频道层的投递门面：把「一次投递要的接线」接成 `core/flow`，对外只留两个动作。
 *
 * 真正的编排在 `core/flow/publish.ts`（读一个函数就懂主线：落盘 → 算人 → 扇出 →
 * 钩子）。这一层只做两件 channel 才知道的事：
 *
 * 1. 把本次调用读到的**频道快照**交给 store（提交之后仍可读，见 `tools/context.ts`
 *    的 `readState`：用工具自己的 ctx 读会在提交后失效）；
 * 2. 把插件策略接在默认规则前后（分发前、收尾后），闸门取进程级共享的那一份。
 *
 * 依赖方向：`channel/post.ts → flow`，`flow` 不 import 这个文件。
 */
import type { Conversation, Context, Harness } from "../runtime/index.ts";
import type { ChannelState, FlowPolicy, Message } from "./types.ts";
import type { WakeRecord } from "./turn/record.ts";
import type { TextCatalog } from "../md/catalog.ts";
import { createFlow } from "../flow/index.ts";
import { createMessageStore } from "../flow/store.ts";
import { defaultRouter } from "../flow/defaults/router.ts";
import { defaultSettler } from "../flow/defaults/settle.ts";
import { policyRouter, policySettler } from "../flow/policies.ts";
import { createTurnRunner, type DeliverOptions } from "../flow/runner.ts";
import { sharedGates } from "../flow/gates.ts";
import type { Flow, FlowGates } from "../flow/ports.ts";
import type { DeliverResult, PublishInput, PublishResult, RouteExistingInput } from "../flow/types.ts";

export type ChannelFlowDeps = {
	readonly harness: Harness;
	readonly conversationOf: (slug: string, ctx: Context) => Promise<Conversation | undefined>;
	readonly labelOf?: (slug: string) => string;
	readonly rememberWake?: (slug: string, wake: WakeRecord, ctx: Context) => Promise<void>;
	/** 原子唤醒：wake 与入队同一个 commit（ADR-076）。 */
	readonly wakeTogether?: DeliverOptions["wakeTogether"];
	/** 读上一次的唤醒记录：忙的时候要在它上面保留 `task`（私聊插话不覆盖任务频道）。 */
	readonly wakeOf?: (slug: string, ctx: Context) => Promise<WakeRecord | undefined>;
	/** 频道 id → 标题（收尾/插话文案里说清「回哪儿」）。 */
	readonly titleOf?: (channelId: string) => string | undefined;
	/** 附件根目录。给了模型就能真的看见消息里的图片。 */
	readonly uploadsRoot?: string;
	/** 提示词模板目录（`<workspace>/prompt`）。投递要用它贴「怎么回话」那两段。 */
	readonly promptDir?: string;
	/** 机械文案目录（`text/`）。投递头、留痕、摘要行从这里取。 */
	readonly text?: TextCatalog;
	/** 一条公开消息落盘并投递之后（插件听消息）。缺省不调。 */
	readonly afterPublish?: (message: Message, channelId: string, context: Context) => Promise<void>;
	/** 投递串行闸。缺省 = 进程级一份（ADR-073）。 */
	readonly gate?: FlowGates["publish"];
	/** 插件注册的分发 / 收尾策略（活引用：重装之后下一次发布用新的）。 */
	readonly policies?: () => readonly FlowPolicy[];
};

/**
 * 投递的两个动作。`state` 是**这次调用读到的**频道快照 —— 调用方读（工具、我说话），
 * 门面负责把它交给 flow；不在这里读盘，是因为提交之后再读同一份覆盖层会炸。
 *
 * `labelOf` 只有宿主入口会换（它要拿当下的 `identity.md` 显示名）；工具不给。
 */
export type ChannelFlow = {
	publish(
		state: ChannelState,
		input: PublishInput,
		ctx: Context,
		labelOf?: (slug: string) => string,
	): Promise<PublishResult>;
	forward(state: ChannelState, input: RouteExistingInput, ctx: Context): Promise<DeliverResult>;
};

/**
 * 把这一次调用的依赖接成 flow。对象很薄，每次现造；没有隐藏的第二份状态。
 *
 * 闸门默认取进程级共享的那一份（`flow/gates.ts`）：同一个进程里所有 agent 的 `say`
 * 是**并发**的，而它们都往同一个 `ChannelDoc` 上 commit —— 各建一把锁等于没串。
 */
function flowOf(
	deps: ChannelFlowDeps,
	state: ChannelState,
	ctx: Context,
	labelOf?: (slug: string) => string,
): Flow {
	const gates = sharedGates();
	const policies = deps.policies;
	const naming = labelOf ?? deps.labelOf;
	const rememberWake = deps.rememberWake;
	const wakeOf = deps.wakeOf;
	return createFlow({
		store: createMessageStore({ harness: deps.harness, state }),
		routers: [...(policies === undefined ? [] : [policyRouter(policies)]), defaultRouter()],
		runner: createTurnRunner({
			harness: deps.harness,
			conversationOf: (slug) => deps.conversationOf(slug, ctx),
			...(naming === undefined ? {} : { labelOf: naming }),
			...(rememberWake === undefined ? {} : { rememberWake: (slug, wake) => rememberWake(slug, wake, ctx) }),
			...(deps.wakeTogether === undefined ? {} : { wakeTogether: deps.wakeTogether }),
			...(wakeOf === undefined ? {} : { wakeOf: (slug) => wakeOf(slug, ctx) }),
			...(deps.uploadsRoot === undefined ? {} : { uploadsRoot: deps.uploadsRoot }),
			...(deps.promptDir === undefined ? {} : { promptDir: deps.promptDir }),
			...(deps.text === undefined ? {} : { text: deps.text }),
		}),
		settler: policies === undefined ? defaultSettler() : policySettler(policies, defaultSettler()),
		...(deps.afterPublish === undefined ? {} : { hooks: { afterPublish: deps.afterPublish } }),
		gate: deps.gate === undefined ? gates : { ...gates, publish: deps.gate },
	});
}

export function createChannelFlow(deps: ChannelFlowDeps): ChannelFlow {
	return {
		publish: (state, input, ctx, labelOf) => flowOf(deps, state, ctx, labelOf).publish(input, ctx),
		forward: (state, input, ctx) => flowOf(deps, state, ctx).forward(input, ctx),
	};
}
