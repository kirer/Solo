/**
 * 防腐层。
 *
 * **唯一允许导入底层运行时库（pi-durable / pi-ai / chord）的地方**。
 * 业务层不许直接 import 底层库，边界检查会拦。
 *
 * 这里只做两件事：
 * 1. 原样转发底层库的构造器与类型（**只转发真有人从这里拿的** —— 没人用的转发会让人
 *    以为「这里能拿到」，于是下一次改动又多一条隐式依赖）；
 * 2. 提供「打开一个库 + 一个 harness」这一个动作，不预置任何组织概念。
 *
 * 刻意不转发的：执行环境注册表、看门狗恢复、能力目录 —— 那些是业务层的错位。
 */
export { BACKGROUND_CONTEXT, type Context } from "@earendil-works/chord/context";

export {
	createRegistry,
	defineDoc,
	defineExtension,
	defineTool,
	GenerationTask,
	hook,
	LiveDoc,
	ToolTask,
	type Extension,
	type HookRegistration,
	type Registry,
	type ToolRegistration,
} from "@earendil-works/pi-durable";

export type { Conversation, Cursor, EntryRecord, Harness, InputEntry, PromptSection, UserInput } from "@earendil-works/pi-durable";

/**
 * 会话的 live 状态（`run` / `generation` / `tools`）。
 *
 * 界面要的「在想 / 在做」只有这一个出处：`run` 在就是忙，`generation` 在就是想，
 * `tools` 里有 running 的调用就是在做。**不落库、不猜消息**。
 */
export type { LiveState } from "@earendil-works/pi-durable";

/** 会话条目标载荷的类型（底层要求严格 JSON）。 */
export type { JsonValue } from "@earendil-works/chord";
/** 文档根的类型（底层要求是 JSON 对象，不是任意 JSON 值）。 */
export type { JsonObject } from "@earendil-works/pi-durable";

import { arr, bool, num, obj, opt, str } from "@earendil-works/pi-schema";

/**
 * 工具参数 schema 的构造器。
 *
 * 1.5.0 起 `pi-ai` 不再转发 TypeBox，`pi-durable` 用 `pi-schema` 校验工具参数。
 * 这里保留原来的 `Type.*` 名字，工具定义与插件 API 不用跟着改；只映射我们用到的六个。
 * `obj` 默认是闭合对象（多传的参数会被拒），这正是工具参数想要的。
 */
export const Type = {
	Object: obj,
	String: str,
	Number: num,
	Boolean: bool,
	Array: arr,
	Optional: opt,
} as const;

export type { Models } from "@earendil-works/pi-ai";
export { openCore, type RuntimeReport } from "./open.ts";
export { setupModels, syncModels, setAgentModel, compactionSettings } from "./models.ts";
