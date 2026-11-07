/**
 * 插件的一段装配：装 / 重装、听消息、分发策略、按频道给工作区。
 *
 * 加载本身在 `core/plugin/load.ts`；这里只负责「装哪一份、什么时候换」。三样东西
 * 都是**活引用**（函数 / getter）：重装之后，听消息的钩子、策略链、工具表看见的
 * 都是新那一批，不需要重启（ADR-026）。
 */
import type { Context, Harness } from "../../core/runtime/index.ts";
import { BACKGROUND_CONTEXT } from "../../core/runtime/index.ts";
import {
	ChannelDoc,
	OWNER,
	chatKind,
	teamOfChannel,
	type ChannelState,
	type FlowPolicy,
	type Message,
} from "../../core/channel/types.ts";
import { readIdentity } from "../../core/documents/member/identity.ts";
import { readTeam } from "../../core/documents/team/doc.ts";
import { teamWorkspace, workspaceOf, type Layout } from "../../core/layout.ts";
import { emptyPluginHost, loadPlugins, type PluginHost } from "../../core/plugin/index.ts";
import type { PluginChannel, PluginScope } from "../../core/plugin/api.ts";
import { coreToolNames } from "../../core/channel/tools/index.ts";
import type { FlowReport } from "../../core/flow/ports.ts";

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
	/** 以我的身份发言。装配层晚绑到 `speak` 上（它在这之后才造出来）。 */
	readonly post?: (input: { readonly channelId: string; readonly text: string }) => Promise<void>;
	/** 运行中出错的出口（装配层接到 diag）。不给就只留 console。 */
	readonly report?: FlowReport;
}): PluginWire {
	let host = emptyPluginHost(deps.layout.pluginsRoot);
	const options = () => ({
		pluginsRoot: deps.layout.pluginsRoot,
		workspace: deps.layout.appRoot,
		logsRoot: deps.layout.logsRoot,
		scope: (channelId: string) => channelScope(deps.harness, deps.layout, channelId),
		channels: () => channelList(deps.harness),
		...(deps.post === undefined ? {} : { post: deps.post }),
		// 插件不能和核心工具重名：重名等于把 `say` 换成了别人写的同名函数。
		reservedTools: coreToolNames(),
		log: (line: string) => console.log(line),
		onError: (line: string) => {
			if (deps.report === undefined) console.warn(`[plugin] ${line}`);
			else deps.report("plugin", line);
		},
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
			// 并发跑。单条的抛错已经在装载时包成了日志（`load.ts`），这里不会互相拖垮。
			await Promise.all(host.messages.map(async (listener) => listener(message, channelId)));
		},
		policies: () => host.flow,
	};
}

/** 插件要认频道时看到的那一份：只有 id / 标题 / 私聊还是群聊 / 成员。按 id 排，稳定。 */
async function channelList(harness: Harness): Promise<readonly PluginChannel[]> {
	const state = (await harness.snapshot(ChannelDoc, BACKGROUND_CONTEXT)) as ChannelState | undefined;
	if (state === undefined) return [];
	return Object.values(state.channels)
		.filter((channel) => channel.archived !== true)
		.map((channel) => ({
			id: channel.id,
			title: channel.title,
			kind: chatKind(channel),
			members: [...channel.members],
		}))
		.sort((left, right) => left.id.localeCompare(right.id));
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
	const team = teamOfChannel(channel.id);
	if (team === undefined) return undefined;
	const doc = await readTeam(layout.teamsRoot, team);
	return {
		kind: "group" as const,
		title: channel.title,
		root: teamWorkspace(layout, team),
		label: doc?.name ?? channel.title,
	};
}
