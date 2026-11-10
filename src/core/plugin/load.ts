/**
 * 加载：扫 `plugins/`，一个目录一个插件，把五个动作收成一份 `PluginHost`。
 *
 * **隔离是这一层唯一真正的逻辑**：清单坏了、入口 import 炸了、`apply` 抛了，都只变成
 * 这个插件的一条错误 —— 其它插件照常装，服务照常起。理由是插件由我（或者 agent）自己
 * 写进工作区，出错是常态；一个手滑的插件把整个组织带下线，比「这个插件没装上」糟得多。
 *
 * 加载顺序 = 目录名码点序（`listDirSorted`），不依赖文件系统给谁先。提示词段顺序因此
 * 也是确定的 —— 逐字节确定性是提示词缓存的底线（ADR-005）。
 */
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { ToolRegistration } from "../runtime/index.ts";
import { mtimeOrUndefined } from "../runtime/io.ts";
import type { FlowPolicy, Message } from "../channel/types.ts";
import {
	createPluginApi,
	emptySinks,
	type PluginChannel,
	type PluginListener,
	type PluginRouteSpec,
	type PluginScope,
} from "./api.ts";
import { listPluginSlugs, readPluginManifest } from "./manifest.ts";
import { activePermissions, unknownPermissions, type SystemAction } from "./permissions.ts";
import { createSystemActions, type SystemActor } from "./system.ts";

/** 界面上看得见的一条插件。`client` 是浏览器要去 import 的 URL。 */
export type PluginSummary = {
	readonly slug: string;
	readonly name: string;
	readonly description: string;
	readonly enabled: boolean;
	/**
	 * 有没有前端入口（`client.js`）。
	 *
	 * 只给布尔、不给 URL：地址由前端自己按 slug 拼（`/api/plugins/<slug>/client.js`），
	 * 两边各写一份完整 URL 一定会漂，而「服务端发不发这个文件」只有前端一个消费者。
	 */
	readonly client?: true;
	/**
	 * 系统动作的账：要了哪些、批了哪些、还差哪些。
	 *
	 * **`pending` 非空 = 那几条现在不能用**（默认全不给）。界面上「待确认」就是读它，
	 * 别在别处再算一遍。
	 */
	readonly permissions?: {
		readonly declared: readonly string[];
		readonly granted: readonly string[];
		readonly pending: readonly string[];
	};
	/** 这个插件没装上的原因（清单坏 / import 失败 / apply 抛错）。 */
	readonly error?: string;
	/**
	 * 它到底带来了什么。界面上「这个插件是干什么的」直接读这一份 ——
	 * 插件的能力是代码里的注册，不是 `plugin.md` 里的自述，别让人猜。
	 */
	readonly brings?: {
		readonly tools: readonly string[];
		readonly prompt: boolean;
		readonly routes: number;
		readonly listens: boolean;
		/** 注册了几条分发 / 收尾策略。 */
		readonly policies: number;
	};
};

export type PluginHost = {
	readonly pluginsRoot: string;
	readonly tools: readonly ToolRegistration[];
	/** 插件追加的提示词，按插件目录序。 */
	readonly prompt: readonly string[];
	readonly routes: readonly PluginRouteSpec[];
	readonly messages: readonly PluginListener[];
	/** 插件注册的分发 / 收尾策略，按插件目录序。装配层把它接进 flow。 */
	readonly flow: readonly FlowPolicy[];
	readonly plugins: readonly PluginSummary[];
	readonly errors: readonly string[];
};

export type LoadOptions = {
	/** `<appRoot>/plugins`（绝对路径）。不存在 = 没有插件。 */
	readonly pluginsRoot: string;
	readonly workspace: string;
	/** `<userRoot>/logs`（绝对路径）。审计日志在这里，插件按 token 算账要读它。 */
	readonly logsRoot: string;
	/** 这个频道的工作区（插件 `api.scope` 的实现）。不给就只有「没有」。 */
	readonly scope?: (channelId: string) => Promise<PluginScope | undefined>;
	/** 频道清单（插件 `api.channels` 的实现）。不给就是空表。 */
	readonly channels?: () => Promise<readonly PluginChannel[]>;
	/** 以我的身份发言（插件 `api.post` 的实现）。不给就抛错。 */
	readonly post?: (input: { readonly channelId: string; readonly text: string }) => Promise<void>;
	/**
	 * 系统动作真正动手的那两个函数（桌面壳接 Electron 的 `shell` / `clipboard`）。
	 * 不给 = 所有系统动作都抛「这个宿主不支持」—— 网页版后端就是这一种。
	 */
	readonly system?: SystemActor;
	/**
	 * 已经有人用的工具名（核心那八个）。插件注册同名工具 = 整个插件不装，
	 * 不是「后者覆盖前者」—— 同名工具被静默替换，模型完全看不出来。
	 */
	readonly reservedTools?: readonly string[];
	/** 一行一个事件的出口（默认 `console.log`）。 */
	readonly log?: (line: string) => void;
	/** 运行中出错（目前只有听消息抛错）的出口；不给就并进 `log`。 */
	readonly onError?: (line: string) => void;
};

export async function loadPlugins(options: LoadOptions): Promise<PluginHost> {
	const log = options.log ?? ((line: string) => console.log(line));
	const failed = options.onError ?? log;
	const tools: ToolRegistration[] = [];
	const prompt: string[] = [];
	const routes: PluginRouteSpec[] = [];
	const messages: PluginListener[] = [];
	const flow: FlowPolicy[] = [];
	const plugins: PluginSummary[] = [];
	const errors: string[] = [];
	/** 工具名 → 谁先用（核心 / 插件 slug）。插件之间也不能重名。 */
	const claimed = new Map<string, string>();
	for (const name of options.reservedTools ?? []) claimed.set(name, "核心");

	for (const slug of await listPluginSlugs(options.pluginsRoot)) {
		const read = await readPluginManifest(options.pluginsRoot, slug);
		if ("error" in read) {
			errors.push(read.error);
			plugins.push({ slug, name: slug, description: "", enabled: false, error: read.error });
			continue;
		}
		const manifest = read.manifest;
		const permissionSummary = {
			declared: manifest.permissions,
			granted: manifest.granted,
			pending: manifest.pending,
		};
		if (!manifest.enabled) {
			plugins.push({
				slug,
				name: manifest.name,
				description: manifest.description,
				enabled: false,
				...(manifest.client === undefined ? {} : { client: true as const }),
				...(manifest.permissions.length === 0 ? {} : { permissions: permissionSummary }),
			});
			continue;
		}

		const summary = {
			slug,
			name: manifest.name,
			description: manifest.description,
			enabled: true,
			...(manifest.client === undefined ? {} : { client: true as const }),
			...(manifest.permissions.length === 0 ? {} : { permissions: permissionSummary }),
		};
		// 权限名要先核：写错了（`system.revealFile`）当场报，不能静默变成「没有这个权限」。
		const unknown = unknownPermissions(manifest.permissions);
		if (unknown.length > 0) {
			const reason = `${slug}：plugin.md 里有宿主不认识的权限 ${unknown.join("、")}`;
			errors.push(reason);
			plugins.push({ ...summary, error: reason });
			continue;
		}

		if (manifest.server === undefined) {
			plugins.push(summary);
			continue;
		}

		const sinks = emptySinks();
		try {
			// `?v=` 是按 mtime 变的：改了 `plugin.ts` 再装一次才真的读到新代码，
			// 否则命中的是 import 缓存里那份旧的（重装看起来「没反应」）。
			const entry = join(manifest.dir, manifest.server);
			const stamp = (await mtimeOrUndefined(entry)) ?? 0;
			const module = (await import(`${pathToFileURL(entry).href}?v=${stamp}`)) as {
				apply?: unknown;
			};
			if (typeof module.apply !== "function") {
				throw new Error(`${manifest.server} 里没有 export function apply(api)`);
			}
			// 生效的那几条 = 清单里声明了 **且** 人批过的。没批的一律不给（默认全不给）。
			const active: readonly SystemAction[] = activePermissions(manifest.permissions, manifest.granted);
			const system =
				options.system === undefined
					? undefined
					: createSystemActions({
							plugin: slug,
							active,
							scope: options.scope ?? (async () => undefined),
							actor: options.system,
							auditFile: join(options.logsRoot, "tools.jsonl"),
						});
			await (module.apply as (api: unknown) => unknown)(
				createPluginApi({
					slug,
					workspace: options.workspace,
					logsRoot: options.logsRoot,
					sinks,
					...(system === undefined ? {} : { system }),
					...(options.scope === undefined ? {} : { scope: options.scope }),
					...(options.channels === undefined ? {} : { channels: options.channels }),
					...(options.post === undefined ? {} : { post: options.post }),
				}),
			);
			// 工具名先全部核一遍，全过才登记：装一半的插件不占用名字，也不进注册表。
			const names: string[] = [];
			for (const tool of sinks.tools) {
				const name = (tool as { name?: string }).name;
				if (name === undefined || name === "") continue;
				if (names.includes(name)) throw new Error(`工具名 ${name} 在同一个插件里注册了两次`);
				const owner = claimed.get(name);
				if (owner !== undefined) {
					throw new Error(
						owner === "核心" ? `工具名 ${name} 和核心工具重名` : `工具名 ${name} 和插件「${owner}」重名`,
					);
				}
				names.push(name);
			}
			for (const name of names) claimed.set(name, slug);
		} catch (error) {
			const reason = `${slug}：${error instanceof Error ? error.message : String(error)}`;
			errors.push(reason);
			plugins.push({ ...summary, error: reason });
			for (const line of sinks.logs) log(`[plugin ${slug}] ${line}`);
			continue;
		}

		tools.push(...sinks.tools);
		prompt.push(...sinks.prompt);
		routes.push(...sinks.routes);
		// 听消息的钩子也做隔离：一个插件抛错只丢它自己这一条，别的照跑，投递不回滚。
		messages.push(
			...sinks.messages.map((listener) => async (message: Message, channelId: string): Promise<void> => {
				try {
					await listener(message, channelId);
				} catch (error) {
					failed(`[plugin ${slug}] 听消息失败：${error instanceof Error ? error.message : String(error)}`);
				}
			}),
		);
		flow.push(...sinks.flow);
		for (const line of sinks.logs) log(`[plugin ${slug}] ${line}`);
		plugins.push({
			...summary,
			brings: {
				tools: sinks.tools.map((tool) => (tool as { name?: string }).name ?? "?"),
				prompt: sinks.prompt.length > 0,
				routes: sinks.routes.length,
				listens: sinks.messages.length > 0,
				policies: sinks.flow.length,
			},
		});
	}

	return { pluginsRoot: options.pluginsRoot, tools, prompt, routes, messages, flow, plugins, errors };
}

/** 没有插件时的那一份：装配与测试都用它，别写 `undefined` 分支。 */
export function emptyPluginHost(pluginsRoot: string): PluginHost {
	return { pluginsRoot, tools: [], prompt: [], routes: [], messages: [], flow: [], plugins: [], errors: [] };
}
