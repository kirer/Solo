/**
 * 用例：插件。
 *
 * 只有三件事：列出来给界面、把它前端那份 JS 发出去、把插件自己注册的接口转给接口层。
 * 插件**怎么装**（扫目录、import、隔离）在 `plugin/load.ts`；这里只管「装完之后谁能看见」。
 *
 * 接口层不许 import `plugin/`（分层规则），所以插件路由在这里换成一份**只有形状**的
 * `AppPluginRoute`：接口层照着它造 `Route`，不认识 `PluginRouteSpec` 这个东西。
 */
import { join } from "node:path";
import { isSafeName } from "../core/naming.ts";
import {
	installPluginFiles,
	listPluginSlugs,
	readPluginManifest,
	removePluginFolder,
	writePluginEnabled,
	writePluginGrants,
	SYSTEM_ACTION_DETAILS,
	SYSTEM_ACTION_LABELS,
	pendingPermissions,
	type SystemAction,
} from "../core/plugin/index.ts";
import type { PluginFile } from "../core/plugin/index.ts";
import { readTextOrUndefined } from "../core/runtime/io.ts";
import type { JsonValue } from "../core/runtime/index.ts";
import type { ViewPlugin } from "../view/dto.ts";
import type { CoreServices } from "./types.ts";

/**
 * 插件路由收到的输入。与 `plugin/api.ts` 的 `PluginRequest` 是同一个形状。
 *
 * `body` 是 `unknown` 不是 `JsonValue`：接口层不许 import 运行时（分层规则），拿不到
 * 那个类型。它确实是 `JSON.parse` 的产物，转手时在下面那一处标成 `JsonValue`。
 */
export type PluginRouteInput = {
	readonly params: Readonly<Record<string, string>>;
	readonly query: Readonly<Record<string, string>>;
	readonly body?: unknown;
};

/** 一条「还要问人」的权限：动作名 + 两句人话（确认弹窗直接用，界面里不再写文案）。 */
export type PluginPermissionAsk = {
	readonly action: string;
	readonly label: string;
	readonly detail: string;
};

export type AppPluginRoute = {
	readonly method: "GET" | "POST";
	readonly pattern: string;
	run(input: PluginRouteInput): Promise<JsonValue>;
};

export function createPlugins(services: CoreServices) {
	const pluginsRoot = services.layout.pluginsRoot;

	/**
	 * 界面上看到的那份清单：**以磁盘为准**。
	 *
	 * 装 / 卸 / 开关改的都是下一次启动，界面要是只看「这次进程装成什么样」，
	 * 点完刷新就变回原样 —— 那是界面的谎话。所以名字、说明、开关、有没有前端入口
	 * 全从 `plugin.md` 与目录读；只有 `error`（这次装的时候炸在哪）来自装载那一份。
	 *
	 * 目录里有、这次没装的（新建的、关掉的、装失败的）也列出来 —— 它们正是人要知道的。
	 */
	const rows = async (): Promise<readonly ViewPlugin[]> => {
		const loaded = new Map((services.plugins.plugins).map((plugin) => [plugin.slug, plugin]));
		const slugs = [...new Set([...(await listPluginSlugs(pluginsRoot)), ...loaded.keys()])].sort();
		return Promise.all(
			slugs.map(async (slug) => {
				const read = await readPluginManifest(pluginsRoot, slug);
				const error = "error" in read ? read.error : loaded.get(slug)?.error;
				if ("error" in read) {
					return {
						slug,
						name: loaded.get(slug)?.name ?? slug,
						description: loaded.get(slug)?.description ?? "",
						enabled: false,
						...(error === undefined ? {} : { error }),
					};
				}
				const manifest = read.manifest;
				const brings = loaded.get(slug)?.brings;
				return {
					slug,
					name: manifest.name,
					description: manifest.description,
					enabled: manifest.enabled,
					...(manifest.client === undefined ? {} : { client: true as const }),
					...(manifest.permissions.length === 0
						? {}
						: {
								permissions: {
									declared: manifest.permissions,
									granted: manifest.granted,
									pending: manifest.pending,
								},
							}),
					...(brings === undefined ? {} : { brings }),
					...(error === undefined ? {} : { error }),
				};
			}),
		);
	};

	return {
		list: rows,

		/**
		 * 开关一个插件：写回它的 `plugin.md`，**当场重装**，不用重启（ADR-026）。
		 *
		 * 三个动作（开关 / 装 / 卸）之后都要 `reloadPlugins()`：文件是磁盘上的事实，
		 * 重装之后进程里这一份才跟上；否则界面写着生效了，模型那边一个工具都没多。
		 */
		async setEnabled(slug: string, enabled: boolean): Promise<readonly ViewPlugin[]> {
			if (!isSafeName(slug)) throw new Error(`插件名不合法：${slug}`);
			await writePluginEnabled(pluginsRoot, slug, enabled);
			await services.reloadPlugins();
			return rows();
		},

		/** 装一个插件：把选中的那个文件夹整份搬进 `plugins/<slug>/`，装完就跑。 */
		async install(slug: string, files: readonly PluginFile[]): Promise<readonly ViewPlugin[]> {
			await installPluginFiles(pluginsRoot, slug, files);
			await services.reloadPlugins();
			return rows();
		},

		/**
		 * 批一个插件的权限：`granted` 是**这次批准之后**它该有的完整名单。
		 *
		 * 批完当场重装 —— 不重装，插件手里那份 `active` 还是旧的（权限生效靠重装，
		 * 和工具 / 路由同一条路，ADR-026）。
		 */
		async grant(slug: string, granted: readonly string[]): Promise<readonly ViewPlugin[]> {
			if (!isSafeName(slug)) throw new Error(`插件名不合法：${slug}`);
			await writePluginGrants(pluginsRoot, slug, granted);
			await services.reloadPlugins();
			return rows();
		},

		/**
		 * 一个插件**还要问人**的那几条，连人话一起。
		 *
		 * 安装之后界面拿它弹一次确认：不确认的那几条，插件调了也只会抛错。
		 */
		async pending(slug: string): Promise<readonly PluginPermissionAsk[]> {
			if (!isSafeName(slug)) return [];
			const read = await readPluginManifest(pluginsRoot, slug);
			if ("error" in read) return [];
			const manifest = read.manifest;
			return pendingPermissions(manifest.permissions, manifest.granted).map((name) => ({
				action: name,
				label: SYSTEM_ACTION_LABELS[name as SystemAction] ?? name,
				detail: SYSTEM_ACTION_DETAILS[name as SystemAction] ?? "",
			}));
		},

		/** 这个宿主能不能真做系统动作（桌面壳才行）。界面按它决定要不要显示「批准」。 */
		canSystem: (): boolean => services.system !== undefined,

		/** 删掉一个插件，连同它的代码。**不可恢复**，界面负责二次确认。 */
		async remove(slug: string): Promise<readonly ViewPlugin[]> {
			await removePluginFolder(pluginsRoot, slug);
			await services.reloadPlugins();
			return rows();
		},

		/**
		 * 一个插件的前端入口。
		 *
		 * 只发**已装上的**插件声明过的那个文件：路径由插件目录 + 固定文件名拼出来，
		 * 名字先过 `isSafeName`，所以 `../` 走不出去。
		 */
		async clientScript(slug: string): Promise<string | undefined> {
			if (!isSafeName(slug)) return undefined;
			const plugin = services.plugins.plugins.find((item) => item.slug === slug);
			if (plugin === undefined || !plugin.enabled || plugin.client === undefined) return undefined;
			return readTextOrUndefined(join(pluginsRoot, slug, "client.js"));
		},

		routes(): readonly AppPluginRoute[] {
			return (services.plugins.routes).map((route) => ({
				method: route.method,
				pattern: route.pattern,
				run: (input) =>
					route.handle({
						method: route.method,
						params: input.params,
						query: input.query,
						// 从 `JSON.parse` 出来的值，按定义就是 JsonValue；类型在接口层手上是 unknown。
						...(input.body === undefined ? {} : { body: input.body as JsonValue }),
					}),
			}));
		},
	};
}

