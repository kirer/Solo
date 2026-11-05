/**
 * 发消息的旧入口：现在只是 `core/flow` 的一层薄壳。
 *
 * 真正的编排在 `core/flow/publish.ts`（读一个函数就懂主线：落盘 → 算人 → 扇出 →
 * 钩子）。这里保留 `postMessage` / `deliverExisting` 两个名字，是因为工具、收尾、
 * 外壳与测试都按这两个入口调用；把调用点一次全换掉只会让 diff 盖住行为变化。
 *
 * 两件事仍然留在这里：
 * 1. `PostDeps` —— 本次调用用的频道快照与接线；
 * 2. 进程级的发布串行闸 —— 旧调用点没有显式注入闸门时的默认值（ADR-073）。
 *    新代码可以经 `gate` 传一份自己的；装配层在 Phase 4 接管它。
 *
 * 依赖方向：`channel/post.ts → flow`，`flow` 不 import 这个文件。
 */
import type { Conversation, Harness } from "../runtime/index.ts";
import { BACKGROUND_CONTEXT, type Context } from "../runtime/index.ts";
import type { ChannelState, Message } from "./types.ts";
import type { WakeRecord } from "./turn/record.ts";
import { createSerialGate } from "../runtime/io.ts";
import type { TextCatalog } from "../md/catalog.ts";
import { createFlow } from "../flow/index.ts";
import { createMessageStore } from "../flow/store.ts";
import { defaultRouter } from "../flow/defaults/router.ts";
import { createTurnRunner, type DeliverOptions } from "../flow/runner.ts";
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
};

/**
 * 频道写入的串行闸。
 *
 * 为什么需要：同一个进程里所有 agent 的 `say` 是**并发**的，而它们都往同一个
 * `ChannelDoc` 上 commit。实测撞出过这个：两个 `say` 同时进来，其中一个 commit 拿到
 * 已被释放的读覆盖层，报 `Cannot use a settled overlay` —— 而那条消息**已经写进去了**，
 * 于是模型看到报错就重试，频道里出现两条一模一样的「在。」。
 *
 * 串行化的代价是频道写入排队（毫秒级，一次 commit），换来的是「一次调用 = 一条消息」
 * 这条最基本的保证。
 */
const serialized = createSerialGate();

/** 把这一次调用的依赖接成 flow。对象很薄，每次现造；没有隐藏的第二份状态。 */
function flowOf(deps: PostDeps): Flow {
	return createFlow({
		store: createMessageStore(deps),
		routers: [defaultRouter()],
		runner: createTurnRunner(deps),
		...(deps.afterPublish === undefined ? {} : { hooks: { afterPublish: deps.afterPublish } }),
		gate: deps.gate ?? serialized,
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
