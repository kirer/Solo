/**
 * 运行时防腐层：唯一允许导入 @earendil-works/pi-durable 的地方。
 *
 * 该库标注为 experimental，minor 版本间会有破坏性变更（见 ADR-001、ADR-002）。
 * 业务层（src/company）与界面层（src/tui）只能通过本模块间接使用它。
 */
export { BACKGROUND_CONTEXT, type Context } from "./registry.ts";
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
export { setupSignalHandlers } from "./signals.ts";
export { InboxDoc, type InboxItem, type InboxState } from "./inbox.ts";
export { UsageDoc, type UsageState } from "./usage.ts";
export { openCompany, type CompanyRuntime, type OpenCompanyOptions, type RuntimeReport } from "./open.ts";
export {
	hasFailed,
	inspect,
	recover,
	retryParked,
	waitForIdle,
	watchForFailure,
	type ParkedTask,
	type RecoveryResult,
	type SelfHealingOptions,
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
