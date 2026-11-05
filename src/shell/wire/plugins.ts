/**
 * 插件的一段装配：装 / 重装、听消息、分发策略、按频道给工作区。
 *
 * 加载本身在 `core/plugin/load.ts`；这里只负责「装哪一份、什么时候换」。三样东西
 * 都是**活引用**（函数 / getter）：重装之后，听消息的钩子、策略链、工具表看见的
 * 都是新那一批，不需要重启（ADR-026）。
 */
import type { Context, Harness } from "../../core/runtime/index.ts";
import { BACKGROUND_CONTEXT } from "../../core/runtime/index.ts";
import { ChannelDoc, OWNER, chatKind, type ChannelState, type FlowPolicy, type Message } from "../../core/channel/types.ts";
import { readIdentity } from "../../core/documents/person/identity.ts";
import { readTeam } from "../../core/documents/team/doc.ts";
import { teamWorkspace, workspaceOf, type Layout } from "../../core/layout.ts";
import { emptyPluginHost, loadPlugins, type PluginHost } from "../../core/plugin/index.ts";
import type { PluginScope } from "../../core/plugin/api.ts";

export type PluginWire = {
	host(): PluginHost;
	/** 首次装载（失败只记一条错误，不挡启动）。 */
	load(): Promise<void>;
	/** 重新装载：只换 host，工具与身份扩展由装配层重接。 */
	reload(): Promise<void>;
	/** 一条消息落盘并投递之后（插件听消息的唯一钩子）。 */
	afterPublish(message: Message, channelId: string, ctx: Context): Promise<void>;
	/** 插件注册的分发 / 收尾策略：活引用，重装之后下一次发布用新的。 */
	policies(): readonly FlowPolicy[];
};

export function createPluginWire(deps: {
	readonly harness: Harness;
	readonly layout: Layout;
}): PluginWire {
	let host = emptyPluginHost(deps.layout.pluginsRoot);
	const options = () => ({
		pluginsRoot: deps.layout.pluginsRoot,
		workspace: deps.layout.appRoot,
		logsRoot: deps.layout.logsRoot,
		scope: (channelId: string) => channelScope(deps.harness, deps.layout, channelId),
		log: (line: string) => console.log(`[plugin] ${line}`),
	});

	async function load(): Promise<void> {
		const next = await loadPlugins(options());
		host = next;
		for (const error of next.errors) console.warn(`[plugin] 没装上：${error}`);
	}

	return {
		host: () => host,
		load,
		reload: load,
		afterPublish: async (message, channelId) => {
			// 并发跑、全部 settled —— 一个插件抛错不该让别的插件不跑，也不该让投递变慢。
			await Promise.allSettled(host.messages.map(async (listener) => listener(message, channelId)));
		},
		policies: () => host.flow,
	};
}

/**
 * 插件问「这个频道的工作区在哪」。
 *
 * 只有两种频道有工作区：私聊是那个人的 `workspace/`，团队频道是团队的 `workspace/`。
 * 全员频道没有 —— 它不是谁的工作区。归档的频道也没有：它已经不在列表里了。
 */
async function channelScope(
	harness: Harness,
	layout: Layout,
	channelId: string,
): Promise<PluginScope | undefined> {
	const state = (await harness.snapshot(ChannelDoc, BACKGROUND_CONTEXT)) as ChannelState | undefined;
	const channel = state?.channels[channelId];
	if (channel === undefined || channel.archived === true) return undefined;
	if (chatKind(channel) === "dm") {
		const other = channel.members.find((slug) => slug !== OWNER);
		if (other === undefined) return undefined;
		const identity = await readIdentity(layout.agentRoots, other);
		if (identity === undefined) return undefined;
		return {
			kind: "dm" as const,
			title: channel.title,
			root: workspaceOf(identity.dir),
			label: identity.name ?? other,
		};
	}
	if (!channel.id.startsWith("team:")) return undefined;
	const team = channel.id.slice("team:".length);
	const doc = await readTeam(layout.teamsRoot, team);
	return {
		kind: "group" as const,
		title: channel.title,
		root: teamWorkspace(layout, team),
		label: doc?.name ?? channel.title,
	};
}
