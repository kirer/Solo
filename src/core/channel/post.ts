/**
 * 发消息的旧入口：现在只是 `core/flow` 的一层薄壳。
 *
 * 真正的编排在 `core/flow/publish.ts`（读一个函数就懂主线：落盘 → 算人 → 扇出 →
 * 钩子）。这里保留 `postMessage` / `deliverExisting` 两个名字，是因为工具、收尾、
 * 外壳与测试都按这两个入口调用；把调用点一次全换掉只会让 diff 盖住行为变化。
 *
 * 两件事仍然留在这里：
 * 1. `PostDeps` —— 本次调用用的频道快照与接线；
 * 2. 旧调用点没有显式注入闸门时的默认值（`flow/gates.ts` 的进程级共享闸，ADR-073）。
 *    新代码可以经 `gate` 传一份自己的；装配层在 Phase 4 接管它。
 *
 * 依赖方向：`channel/post.ts → flow`，`flow` 不 import 这个文件。
 */
import type { Conversation, Harness } from "../runtime/index.ts";
import { BACKGROUND_CONTEXT, type Context } from "../runtime/index.ts";
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

export type PostInput = PublishInput;
export type PostResult = PublishResult;

export type PostDeps = {
	readonly harness: Harness;
	/** 本次调用的频道快照（提交之后仍可读的纯数据）。 */
	readonly state: ChannelState;
	readonly conversationOf: (slug: string) => Promise<Conversation | undefined>;
	readonly labelOf?: (slug: string) => string;
	readonly rememberWake?: (slug: string, wake: WakeRecord) => Promise<void>;
	/** 原子唤醒：wake 与入队同一个 commit（ADR-076）。 */
	readonly wakeTogether?: DeliverOptions["wakeTogether"];
	/** 读上一次的唤醒记录：忙的时候要在它上面保留 `task`（私聊插话不覆盖任务频道）。 */
	readonly wakeOf?: (slug: string) => Promise<WakeRecord | undefined>;
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
	/** 投递串行闸。缺省 = 进程级一份（旧行为）。 */
	readonly gate?: FlowGates["publish"];
	/** 插件注册的分发 / 收尾策略（活引用：重装之后下一次发布用新的）。 */
	readonly policies?: () => readonly FlowPolicy[];
};

/**
 * 把这一次调用的依赖接成 flow。对象很薄，每次现造；没有隐藏的第二份状态。
 *
 * 闸门默认取进程级共享的那一份（`flow/gates.ts`）：同一个进程里所有 agent 的 `say`
 * 是**并发**的，而它们都往同一个 `ChannelDoc` 上 commit —— 各建一把锁等于没串。
 */
function flowOf(deps: PostDeps): Flow {
	const gates = sharedGates();
	const policies = deps.policies;
	return createFlow({
		store: createMessageStore(deps),
		routers: [...(policies === undefined ? [] : [policyRouter(policies)]), defaultRouter()],
		runner: createTurnRunner(deps),
		settler: policies === undefined ? defaultSettler() : policySettler(policies, defaultSettler()),
		...(deps.afterPublish === undefined ? {} : { hooks: { afterPublish: deps.afterPublish } }),
		gate: deps.gate === undefined ? gates : { ...gates, publish: deps.gate },
	});
}

/**
 * 写一条消息并唤醒该唤醒的人。
 *
 * 文档写入用 `commit` + 路径式追加（推一条 + 改两个数字），**不整频道替换**：
 * 一个群频道可以有 800 条消息，整值替换会让每条消息重写整个频道（实测
 * 49.6KB/条 vs 141 字节）。
 */
export async function postMessage(
	deps: PostDeps,
	input: PostInput,
	context: Context = BACKGROUND_CONTEXT,
): Promise<PostResult> {
	return flowOf(deps).publish(input, context);
}

/**
 * 把一条**已经落在频道里**的消息再交给几个人看 —— 助理的后台分发（ADR-063）。
 *
 * 和 `postMessage` 的投递走同一条 `flow.forward`：不写第二条消息，频道里也就没有
 * 「助理把这条转给了谁」这种可见的痕。收件人看到的仍是原文，只是多一句是谁转的。
 *
 * 调用方给的 `deps.state` 必须是**当下的**频道快照（工具用 `readState` 读）。
 */
export async function deliverExisting(
	deps: PostDeps,
	input: RouteExistingInput,
	context: Context = BACKGROUND_CONTEXT,
): Promise<DeliverResult> {
	return flowOf(deps).forward(input, context);
}
