/**
 * flow 的端口：编排只认这些接口，不认具体实现。
 *
 * 默认实现在同目录的 `store.ts` / `runner.ts` / `defaults/router.ts`，装配层
 * （`shell/assemble.ts`）负责把真实的那一份接上。测试可以只喂假端口 —— 这正是
 * 把它们单独写出来的理由：`publish` 的顺序不依赖真实库、真实模型。
 *
 * 规矩：**策略只能提议**。`Router` 返回的是名单，写盘与入队永远由 core 做。
 */
import type { Context } from "../runtime/index.ts";
import type { Channel, ChannelState, Message } from "../channel/types.ts";
import type {
	ChannelSnapshot,
	DeliverResult,
	NoteInput,
	PublishInput,
	PublishResult,
	RecipientPlan,
	RouteDecision,
	RouteExistingInput,
	RouteFacts,
} from "./types.ts";

/** 后端主线的三个动作。Phase 1 只有前两个；`settle` 在 Phase 2 加进来。 */
export type Flow = {
	/** 新消息：落盘 → 算收件人 → 扇出入队 → 钩子。 */
	publish(input: PublishInput, ctx: Context): Promise<PublishResult>;
	/** 已有消息转交：校验 → 扇出入队（助理 `route` 工具用；不留新消息）。 */
	forward(input: RouteExistingInput, ctx: Context): Promise<DeliverResult>;
};

/** 消息落盘。publish / forward / settle 共用这一份读法。 */
export type MessageStore = {
	/** 读频道快照。频道不存在返回 `undefined`。 */
	read(channelId: string, ctx: Context): Promise<ChannelSnapshot | undefined>;
	/** 追加一条消息。频道不存在返回 `undefined`。 */
	append(
		input: PublishInput,
		ctx: Context,
	): Promise<{ readonly channel: Channel; readonly message: Message } | undefined>;
	/** 追一条系统留痕（不唤醒）。 */
	note(input: NoteInput, ctx: Context): Promise<void>;
};

/**
 * 一个路由策略：看事实，提议叫谁。
 *
 * 返回 `undefined` = 这一条我不决定，交给下一个；返回 `drop` = 明确不叫人。
 * 内置规则也是这个接口（`defaults/router.ts`），所以插件策略只是排在它前面。
 */
export type Router = {
	decide(facts: RouteFacts, ctx: Context): Promise<RouteDecision | undefined>;
};

/** 扇出需要的一切：这条消息、这份频道、叫谁、看到什么。 */
export type FanOutArgs = {
	/** 写之前读到的频道快照：未读摘要要按「这条消息之前」的样子算。 */
	readonly state: ChannelState;
	readonly channel: Channel;
	readonly message: Message;
	readonly plan: RecipientPlan;
	/** 转交的人（slug）。给了就在投递正文里写明。 */
	readonly routedBy?: string;
	readonly ctx: Context;
};

/** 把一份名单变成入队、唤醒记录、合并排队项、没产出留痕。 */
export type TurnRunner = {
	fanOut(args: FanOutArgs): Promise<DeliverResult>;
};

/** 一条消息落盘并投递之后。插件听消息只挂在这里。 */
export type PublishHooks = {
	afterPublish(message: Message, channelId: string, ctx: Context): Promise<void>;
};

/**
 * 串行闸。进程级一份，由装配层传进来 —— 不藏在模块单例里，
 * 否则「谁和谁在同一个闸里」只能靠读 import 才知道。
 */
export type FlowGates = {
	publish<T>(fn: () => Promise<T>): Promise<T>;
};

/** `createFlow` 的全部依赖。 */
export type FlowPorts = {
	readonly store: MessageStore;
	/** 按顺序问；第一个给出决定的生效。最后一个通常是内置规则。 */
	readonly routers: readonly Router[];
	readonly runner: TurnRunner;
	readonly hooks?: PublishHooks;
	readonly gate: FlowGates["publish"];
};
