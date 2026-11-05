/**
 * `core/flow`：把「一条消息的一生」收在一处。
 *
 * 对外只有三个动作（Phase 1 是前两个）：
 *
 * ```
 * publish(input)    新消息：落盘 → 算人 → 扇出入队 → 钩子
 * forward(existing) 已有消息转交：校验 → 扇出入队（助理 route 工具用）
 * ```
 *
 * 实现分散在：
 * - `publish.ts` / `forward.ts` —— 编排，读这两个就懂主线；
 * - `runner.ts` —— 投递机械（合并队列、写 wake、submit、等结算）；
 * - `store.ts` —— 落盘（唯一实现在 `channel/write.ts`）；
 * - `defaults/router.ts` / `policies.ts` / `validate.ts` —— 「叫醒谁」；
 * - `ports.ts` / `types.ts` —— 依赖与数据形状。
 *
 * 依赖方向：`flow → channel/{types,mentions,rules,write,delivery,queue,...}`。
 * `channel/post.ts` 是旧调用点留下的薄壳，它调 `flow`；`flow` 不调它。
 */
import type { Flow, FlowPorts } from "./ports.ts";
import { createForward } from "./forward.ts";
import { createPublish } from "./publish.ts";

export function createFlow(ports: FlowPorts): Flow {
	return { publish: createPublish(ports), forward: createForward(ports) };
}

export type {
	FanOutArgs,
	Flow,
	FlowGates,
	FlowPorts,
	MessageStore,
	PublishHooks,
	Router,
	TurnRunner,
} from "./ports.ts";
export type {
	ChannelSnapshot,
	DeliverIssue,
	DeliverResult,
	NoteInput,
	PublishInput,
	PublishResult,
	RecipientPlan,
	RouteDecision,
	RouteExistingInput,
	RouteFacts,
} from "./types.ts";
export { routeFactsOf } from "./defaults/router.ts";
export { resolvePlan } from "./policies.ts";
export { validatePlan } from "./validate.ts";
