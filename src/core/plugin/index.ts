/**
 * 插件：`<appRoot>/plugins/<slug>/` 一个文件夹 = 一个插件。
 *
 * 前后端各一半：
 * - `plugin.ts` 后端，`apply(api)` 里做四件事（工具 / 提示词 / 路由 / 听消息）；
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
	PLUGIN_CLIENT,
	PLUGIN_MANIFEST,
	PLUGIN_SERVER,
	PLUGIN_SERVERS,
} from "./manifest.ts";
export type { ManifestRead, PluginFile, PluginManifest } from "./manifest.ts";
export { emptySinks, createPluginApi } from "./api.ts";
export type { PluginApi, PluginListener, PluginRequest, PluginRouteSpec, PluginToolSpec } from "./api.ts";
export { emptyPluginHost, loadPlugins } from "./load.ts";
export type { LoadOptions, PluginHost, PluginSummary } from "./load.ts";
