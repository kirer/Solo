/**
 * `core/flow`：把「一条消息的一生」收在一处。
 *
 * 对外只有三个动作：
 *
 * ```
 * publish(input)    新消息：落盘 → 算人 → 扇出入队 → 钩子
 * forward(existing) 已有消息转交：校验 → 扇出入队（助理 route 工具用）
 * settle(event)     一轮结算：done 补发 / unanswered 留痕
 * ```
 *
 * 实现分散在：
 * - `publish.ts` / `forward.ts` / `settle.ts` —— 编排，读这三个就懂主线；
 * - `runner.ts` —— 投递机械（合并队列、写 wake、submit、等结算）；
 * - `store.ts` —— 落盘（唯一实现在 `channel/write.ts`）；
 * - `defaults/router.ts` / `policies.ts` / `validate.ts` —— 「叫醒谁」；
 * - `defaults/settle.ts` —— 「补不补、补到哪儿」；
 * - `gates.ts` —— 进程级的两把串行闸；
 * - `ports.ts` / `types.ts` —— 依赖与数据形状。
 *
 * 依赖方向：`flow → channel/{types,mentions,rules,write,delivery,queue,...}`。
 * `channel/post.ts` 是频道的投递门面（`createChannelFlow`），它调 `flow`；`flow` 不调它。
 */
import type { Flow, FlowPorts } from "./ports.ts";
import { createForward } from "./forward.ts";
import { createPublish } from "./publish.ts";
import { createSettle } from "./settle.ts";

export function createFlow(ports: FlowPorts): Flow {
	// 两个动作互相需要：补发走 `publish`，没答上来的留痕走 `settle`。用一个中转把
	// 「先有谁」这条死结解开；真正调用时两个都已经装好了。
	let publish: Flow["publish"] | undefined;
	const settle = createSettle({
		store: ports.store,
		settler: ports.settler,
		publish: (input, ctx) => {
			if (publish === undefined) throw new Error("flow 尚未组装完成");
			return publish(input, ctx);
		},
		...(ports.roster === undefined ? {} : { roster: ports.roster }),
		gate: ports.gate.repost,
	});
	publish = createPublish({ ...ports, settle });
	return { publish, forward: createForward({ ...ports, settle }), settle };
}

export type {
	FanOutArgs,
	Flow,
	FlowGates,
	FlowPorts,
	MessageStore,
	PublishHooks,
	Router,
	Settler,
	TurnRunner,
} from "./ports.ts";
export type {
	AnswerEntry,
	ChannelSnapshot,
	DeliverIssue,
	DeliverResult,
	EntryReader,
	FinishTurn,
	FinishTurnInfo,
	NoteInput,
	PublishInput,
	PublishResult,
	RecipientPlan,
	RouteDecision,
	RouteExistingInput,
	RouteFacts,
	SettleDecision,
	SettleFacts,
	SettleResult,
	Settlement,
} from "./types.ts";
export { routeFactsOf } from "./defaults/router.ts";
export { answerEntry, defaultSettler, finalTextOf, saidLast, spokeAfterWake, turnTarget } from "./defaults/settle.ts";
export { resolvePlan } from "./policies.ts";
export { validatePlan } from "./validate.ts";
