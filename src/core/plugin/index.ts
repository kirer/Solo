/**
 * 插件：`<appRoot>/plugins/<slug>/` 一个文件夹 = 一个插件。
 *
 * 前后端各一半：
 * - `plugin.ts` 后端，`apply(api)` 里做六件事（工具 / 提示词 / 路由 / 听消息 / 分发策略 /
 *   系统动作）；
 * - `client.js` 前端，`apply(ui)` 里往插槽里注册组件。
 *
 * 前端那一半的宿主在 `ui/app/src/plugin/`，契约（`SlotName` / `ClientUi`）以那边为准；
 * 这里只负责「有哪些插件、它们各自的 URL 是什么」。
 */
export {
	installPluginFiles,
	listPluginSlugs,
	readPluginManifest,
	removePluginFolder,
	writePluginEnabled,
	writePluginGrants,
	PLUGIN_CLIENT,
	PLUGIN_MANIFEST,
	PLUGIN_SERVER,
	PLUGIN_SERVERS,
} from "./manifest.ts";
export type { ManifestRead, PluginFile, PluginManifest } from "./manifest.ts";
export {
	SYSTEM_ACTIONS,
	SYSTEM_ACTION_DETAILS,
	SYSTEM_ACTION_LABELS,
	activePermissions,
	isSystemAction,
	parsePermissions,
	pendingPermissions,
	stalePermissions,
	unknownPermissions,
} from "./permissions.ts";
export type { SystemAction } from "./permissions.ts";
export { MAX_COPY_TEXT, createSystemActions, resolveInside } from "./system.ts";
export type { SystemActInput, SystemActor, SystemAudit } from "./system.ts";
export { emptySinks, createPluginApi } from "./api.ts";
export type {
	PluginApi,
	PluginListener,
	PluginRequest,
	PluginRouteSpec,
	PluginSystem,
	PluginSystemAct,
	PluginToolSpec,
} from "./api.ts";
export type { FlowPolicy } from "../channel/types.ts";
export { emptyPluginHost, loadPlugins } from "./load.ts";
export type { LoadOptions, PluginHost, PluginSummary } from "./load.ts";
