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
 * 插件目录里可以被前端取走的**静态资源**。
 *
 * 白名单而不是「读目录里有什么」：插件目录里还躺着 `plugin.js`、`plugin.md`、密钥之类，
 * 一律不该有 HTTP 通道。要发新东西就往这里加一行。
 *
 * 名字带版本号：换版本就是换 URL，浏览器缓存不可能把旧 wasm 配给新 JS。
 */
export const PLUGIN_ASSETS = ["webrtcaec3.js"] as const;


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
			// 先问清楚「是不是出厂那份」，再动手删 —— 删完就问不出来了。
			// 这一问决定两件事：账本记不记（决定会不会被播种补回）、日志里怎么描述。
			const shipped = (await services.seededPlugins?.isShipped(slug)) === true;
			await removePluginFolder(pluginsRoot, slug);
			// 记一笔「用户删的」：不然下次启动播种会当成意外丢失、原样补回来，
			// 界面上的「删除」又变成假的。只有走过这里的才算，手删目录的不算。
			if (shipped) await services.seededPlugins?.markRemoved(slug);
			// 留一笔：删插件是不可恢复的动作，事后要能回答「什么时候、删了什么、还能不能装回来」。
			// 之前这里一句日志都没有 —— 老板删掉悬浮球之后，翻遍日志也找不着痕迹。
			services.diag.recordFlow(
				"plugin",
				shipped
					? `删掉了出厂插件「${slug}」（可以在插件页装回来）`
					: `删掉了自己装的插件「${slug}」（出厂没有这份，装不回来了）`,
			);
			await services.reloadPlugins();
			return rows();
		},

		/** 用户删掉的出厂插件：界面上「装回来」能挑这些。没有账本时是空的。 */
		async removed(): Promise<readonly string[]> {
			return (await services.seededPlugins?.removed()) ?? [];
		},

		/** 把删掉的出厂插件装回来（用出厂那份）。装上了就重新加载。 */
		async restore(slug: string): Promise<readonly ViewPlugin[]> {
			if ((await services.seededPlugins?.restore(slug)) !== true) return rows();
			services.diag.recordFlow("plugin", `把删掉的出厂插件「${slug}」装回来了（用出厂那份）`);
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

		/**
		 * 插件的**前端资源**（目前只有 AEC3 的 wasm）。
		 *
		 * 为什么需要它：插件的前端入口只发 `client.js` 一个文件（见上一条），
		 * 而 AEC3 是 JS + 166KB wasm 两件套。把 wasm base64 藏进 JS 也能跑，
		 * 但那是每次都传 477KB、且换版本只能连 JS 一起换；单独一条路由只付一次，
		 * 还能让浏览器缓存。
		 *
		 * **文件名是白名单，不是拼出来的**：`PLUGIN_ASSETS` 里没有的名字一律当不存在。
		 * 加上 `isSafeName(slug)`，`../` 从两边都走不出去。
		 *
		 * 版本在文件名里（`webrtcaec3-0.3.0.wasm`），所以升级换了文件名就换了 URL，
		 * 浏览器不会拿旧 wasm 配新 JS —— 这比「靠 ETag 重新验」更硬：验证码都没机会跑。
		 */
		/**
		 * 插件能发的前端资源**文件名**；不在白名单、或者这个插件没有前端，就是 `undefined`。
		 *
		 * 只回名字不回内容：文件在 `ui/web/`（构建时从 `node_modules` 拷过去），
		 * 真发送走静态资源那一套。放这儿是为了让「谁能发什么」集中在一处 ——
		 * 白名单外的一律到不了磁盘，`../` 也穿不出去。
		 */
		async clientAsset(slug: string, asset: string): Promise<string | undefined> {
			if (!isSafeName(slug)) return undefined;
			const known = PLUGIN_ASSETS.find((item) => item === asset);
			if (known === undefined) return undefined;
			const plugin = services.plugins.plugins.find((item) => item.slug === slug);
			if (plugin === undefined || !plugin.enabled || plugin.client === undefined) return undefined;
			return known;
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

