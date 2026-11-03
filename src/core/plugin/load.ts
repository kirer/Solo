/**
 * 加载：扫 `plugins/`，一个目录一个插件，把四个动作收成一份 `PluginHost`。
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
import { createPluginApi, emptySinks, type PluginListener, type PluginRouteSpec, type PluginScope } from "./api.ts";
import { listPluginSlugs, readPluginManifest } from "./manifest.ts";

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
	};
};

export type PluginHost = {
	readonly pluginsRoot: string;
	readonly tools: readonly ToolRegistration[];
	/** 插件追加的提示词，按插件目录序。 */
	readonly prompt: readonly string[];
	readonly routes: readonly PluginRouteSpec[];
	readonly messages: readonly PluginListener[];
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
	/** 一行一个事件的出口（默认 `console.log`）。 */
	readonly log?: (line: string) => void;
};

export async function loadPlugins(options: LoadOptions): Promise<PluginHost> {
	const log = options.log ?? ((line: string) => console.log(line));
	const tools: ToolRegistration[] = [];
	const prompt: string[] = [];
	const routes: PluginRouteSpec[] = [];
	const messages: PluginListener[] = [];
	const plugins: PluginSummary[] = [];
	const errors: string[] = [];

	for (const slug of await listPluginSlugs(options.pluginsRoot)) {
		const read = await readPluginManifest(options.pluginsRoot, slug);
		if ("error" in read) {
			errors.push(read.error);
			plugins.push({ slug, name: slug, description: "", enabled: false, error: read.error });
			continue;
		}
		const manifest = read.manifest;
		if (!manifest.enabled) {
			plugins.push({
				slug,
				name: manifest.name,
				description: manifest.description,
				enabled: false,
				...(manifest.client === undefined ? {} : { client: true as const }),
			});
			continue;
		}

		const summary = {
			slug,
			name: manifest.name,
			description: manifest.description,
			enabled: true,
			...(manifest.client === undefined ? {} : { client: true as const }),
		};
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
			await (module.apply as (api: unknown) => unknown)(
				createPluginApi({
					slug,
					workspace: options.workspace,
					logsRoot: options.logsRoot,
					sinks,
					...(options.scope === undefined ? {} : { scope: options.scope }),
				}),
			);
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
		messages.push(...sinks.messages);
		for (const line of sinks.logs) log(`[plugin ${slug}] ${line}`);
		plugins.push({
			...summary,
			brings: {
				tools: sinks.tools.map((tool) => (tool as { name?: string }).name ?? "?"),
				prompt: sinks.prompt.length > 0,
				routes: sinks.routes.length,
				listens: sinks.messages.length > 0,
			},
		});
	}

	return { pluginsRoot: options.pluginsRoot, tools, prompt, routes, messages, plugins, errors };
}

/** 没有插件时的那一份：装配与测试都用它，别写 `undefined` 分支。 */
export function emptyPluginHost(pluginsRoot: string): PluginHost {
	return { pluginsRoot, tools: [], prompt: [], routes: [], messages: [], plugins: [], errors: [] };
}
