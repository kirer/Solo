/**
 * 防腐层。
 *
 * **唯一允许导入底层运行时库（pi-durable / pi-ai / chord）的地方**。
 * 业务层不许直接 import 底层库，边界检查会拦。
 *
 * 这里只做两件事：
 * 1. 原样转发底层库的构造器与类型；
 * 2. 提供「打开一个库 + 一个 harness」这一个动作，不预置任何公司概念。
 *
 * 刻意不转发的：执行环境注册表、看门狗恢复、能力目录 —— 那些是业务层的错位。
 */
export {
	BACKGROUND_CONTEXT,
	awaitWithContext,
	type Context,
} from "@earendil-works/chord/context";

export {
	configure,
	createRegistry,
	defineDoc,
	defineEntry,
	defineExtension,
	defineTask,
	defineTool,
	hook,
	LiveDoc,
	section,
	type Extension,
	type Registry,
	type ToolRegistration,
} from "@earendil-works/pi-durable";

export type {
	Agent,
	AgentChange,
	Conversation,
	ConversationCreateOptions,
	CommitPublication,
	EntryRecord,
	Cursor,
	Harness,
	HarnessOptions,
	PromptInput,
	PromptSection,
	SubmissionDraft,
	UserInput,
} from "@earendil-works/pi-durable";

/** 会话条目标载荷的类型（底层要求严格 JSON）。 */
export type { JsonValue } from "@earendil-works/chord";
/** 文档根的类型（底层要求是 JSON 对象，不是任意 JSON 值）。 */
export type { JsonObject } from "@earendil-works/pi-durable";

export { Type } from "@earendil-works/pi-ai";
export { openCore, type CoreRuntime, type OpenCoreOptions } from "./open.ts";
export { setupModels, type ModelSetup, type ModelRef } from "./models.ts";
