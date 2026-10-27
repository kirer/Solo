/**
 * 运行时防腐层：唯一允许导入 @earendil-works/pi-durable 的地方。
 *
 * 该库标注为 experimental，minor 版本间会有破坏性变更（见 ADR-001、ADR-002）。
 * 业务层（src/company）与界面层（src/tui）只能通过本模块间接使用它。
 */
export { awaitWithContext, BACKGROUND_CONTEXT, type Context } from "./registry.ts";
export { createEnvironmentRegistry, type EnvironmentRegistry, type CwdResolver } from "./env.ts";
export {
	delegationRequestId,
	escalationId,
	messageRequestId,
	ownerDecisionRequestId,
	projectSlug,
	reportRequestId,
} from "./ids.ts";
export {
	createLocalGatewayProvider,
	LOCAL_GATEWAY,
	probeLocalGateway,
	setupModels,
	type ModelSetup,
} from "./models.ts";
export {
	CodingTools,
	createBashTool,
	createEditTool,
	createReadTool,
	createWriteTool,
} from "./capabilities.ts";
export { setupSignalHandlers, onShutdown } from "./signals.ts";
export { InboxDoc, type InboxItem, type InboxState } from "./inbox.ts";
export { UsageDoc, type UsageState } from "./usage.ts";
export { openCompany, type CompanyRuntime, type OpenCompanyOptions, type RuntimeReport } from "./open.ts";
export {
	GENERATION_OVERDUE_MS,
	hasFailed,
	inspect,
	inspectLiveness,
	inspectLivenessFrom,
	isConversationBusy,
	recover,
	retryParked,
	TOOL_OVERDUE_MS,
	waitForIdle,
	watchForFailure,
	type Liveness,
	type LivenessOptions,
	type ParkedTask,
	type RecoveryOptions,
	type RecoveryResult,
	type SelfHealingOptions,
	type StuckReason,
	type TaskLiveness,
} from "./recover.ts";
export {
	configure,
	createRegistry,
	defineDoc,
	defineEntry,
	defineExtension,
	defineTask,
	defineTool,
	hook,
	installAll,
	installedNames,
	PLACEHOLDER_EXTENSION,
	section,
	Type,
	wrapSection,
	wrapTool,
	type Extension,
	type Registry,
	type Task,
	type TaskDefinition,
	type TaskRuntime,
} from "./registry.ts";

export * from "./instance-lock.ts";

// 工具搜索：延迟工具按需加载（见 ADR-032）
export type { ToolRegistration } from "./registry.ts";

// 会话条目的 data 载荷类型（chord 的 JSON 值）。业务层写 `entry.data` 时需要它：
// 直接 import @earendil-works/chord 会越界（ADR-001），所以在这里转出去。
export type { JsonValue } from "@earendil-works/chord";
