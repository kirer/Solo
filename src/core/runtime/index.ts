/**
 * 新核心的防腐层（世代 2）。
 *
 * 定位与 `src/runtime/` 相同：**唯一允许导入底层运行时库的地方**。
 * 与旧层的区别只有一条 —— 旧层不需要能力目录、执行环境注册表、看门狗恢复
 * 这些「公司特有」的东西，它们是业务层的错位，新层不转发它们。
 *
 * 这里只做两件事：
 * 1. 原样转发底层库的构造器与类型（业务层不能直接 import 底层库）；
 * 2. 提供「打开一个库 + 一个 harness」这一个动作，不预置任何公司概念。
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
	EntryRecord,
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
export { setupModels } from "../../runtime/models.ts";
