/**
 * 全部工具：**只有一套，人人都有。**
 *
 * 这里没有「管理层工具」「员工工具」「负责人工具」的分层。旧核心用「工具包不同」
 * 来实现「员工不能越级」（ADR-004），代价是：CEO 有 25 个工具、员工只有 6 个，
 * 想调一个人就得改代码重新部署；而「谁能做什么」本来该写在身份里。
 *
 * 因此新核心的能力只有十来个，按「做一件事」划分，不按「谁配用」划分：
 *
 * | 工具 | 用途 |
 * |---|---|
 * | `say` | 在频道说一句（不主动叫醒） |
 * | `ask` | 在频道提问并 @ 某人（叫醒） |
 * | `read_channel` | 读频道历史（标记已读） |
 * | `inbox` | 我还有多少没读 |
 * | `channels` | 我能看到哪些房间 |
 * | `whoami` | 我是谁、我的上级、我的下属、我的目录 |
 * | `org_chart` | 全公司现在长什么样 |
 * | `hire` | 新建一个 agent（写文件夹） |
 * | `update_identity` | 改我自己或我下属的身份 |
 * | `set_capabilities` | 改一个 agent 的能力清单 |
 * | `remember` / `recall` | 记忆 |
 *
 * 每一个工具返回**自然语言**，不是结构化数据 —— 工具的输出是给模型读的。
 */
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
	BACKGROUND_CONTEXT,
	Type,
	defineExtension,
	defineTool,
	type Context,
	type Harness,
	type ToolRegistration,
} from "../runtime/index.ts";
import { OWNER_SLUG, chainUp, readAllIdentities, readIdentity, reportsOf } from "../agent/identity.ts";
import { CAPABILITIES_FILE, readCapabilities } from "../agent/runtime.ts";
import { createAgent, renderIdentityFile, renderOrgChart } from "../company/org.ts";
import { conversationFor, slugFor, wakeOf, type DirectoryState } from "../company/directory.ts";
import { postMessage, type PostDeps } from "./post.ts";
import {
	ChannelDoc,
	channelsOf,
	dmId,
	readMarkOf,
	unreadCount,
	type ChannelState,
	type Message,
} from "./state.ts";
import { renderDigest } from "./deliver.ts";

/** 工具运行所需的一切。全部由外壳在启动时装配，工具自己不读环境变量。 */
export type CoreToolDeps = {
	readonly harness: Harness;
	/** `workspace/agents`。 */
	readonly agentsRoot: string;
	/** `workspace/projects`。 */
	readonly projectsRoot: string;
	/** 读名册（slug ↔ 会话）。 */
	readonly directory: (context: Context) => Promise<DirectoryState>;
	/** 落一次名册变更。 */
	readonly saveDirectory: (change: (state: DirectoryState) => DirectoryState, context: Context) => Promise<void>;
	/** 为某个 slug 建会话并绑定。缺省表示不支持热建（测试里可以不提供）。 */
	readonly openAgent?: (slug: string, context: Context) => Promise<number>;
};

function text(value: string) {
	return { output: [{ type: "text" as const, text: value }] };
}

/** 这个工具调用属于哪个 slug。名册里找不到就给一句明确的错误。 */
async function selfOf(deps: CoreToolDeps, conversationId: number, context: Context): Promise<string | undefined> {
	const directory = await deps.directory(context);
	return slugFor(directory, conversationId);
}

/**
 * 「默认在哪儿说话」：刚被叫醒的那个频道 → 任意一个我所在的频道 → 与老板的私聊。
 *
 * 第一条最重要：老板在私聊里问我一句，我一开口就该回私聊，而不是群里。
 */
async function defaultChannel(
	deps: CoreToolDeps,
	state: ChannelState,
	slug: string,
	conversationId: number,
	explicit: string | undefined,
	context: Context,
): Promise<{ channelId: string } | { error: string }> {
	if (explicit !== undefined && explicit !== "") {
		const channel = state.channels[explicit];
		if (channel === undefined) return { error: `没有这个频道：${explicit}` };
		if (!channel.members.includes(slug)) return { error: `你不在「${channel.title}」里。` };
		return { channelId: explicit };
	}
	const directory = await deps.directory(context);
	const wake = wakeOf(directory, conversationId);
	if (wake !== undefined) {
		const channel = state.channels[wake.channelId];
		if (channel !== undefined && channel.members.includes(slug)) return { channelId: wake.channelId };
	}
	const mine = channelsOf(state, slug);
	const first = mine[0];
	if (first !== undefined) return { channelId: first.id };
	return { channelId: dmId(OWNER_SLUG, slug) };
}

/** 建工具。返回一个扩展，装进所有 agent 的会话里。 */
export function createCoreTools(deps: CoreToolDeps) {
	const say = defineTool({
		name: "say",
		description:
			"在当前频道说一句话。不主动叫醒任何人（正文里写 @某人 才会叫醒他）。用于汇报进度、说明结论、回应别人。",
		parameters: Type.Object({
			text: Type.String({ description: "要说的话" }),
			channel: Type.Optional(Type.String({ description: "频道 id，省略则回刚被叫醒的那个频道" })),
			replyTo: Type.Optional(Type.Number({ description: "要引用回复的消息序号" })),
		}),
		execute: async (args, api, context) => {
			const ctx = context ?? BACKGROUND_CONTEXT;
			const slug = await selfOf(deps, Number(api.conversationId), ctx);
			if (slug === undefined) return text("你还不在名册里。先用 whoami 看看情况，或请上级重新登记你。");
			const state = (await deps.harness.snapshot(ChannelDoc, ctx)) ?? { channels: {}, messages: {}, nextSeq: {}, readMarks: {} };
			const target = await defaultChannel(deps, state, slug, Number(api.conversationId), args.channel, ctx);
			if ("error" in target) return text(target.error);

			const result = await postMessage(
				postDeps(deps, state, ctx),
				{
					channelId: target.channelId,
					from: slug,
					text: args.text,
					at: Date.now(),
					...(args.replyTo === undefined ? {} : { replyTo: args.replyTo }),
				},
				ctx,
			);
			const woke = result.delivery.delivered;
			return text(
				`已发到「${result.channel.title}」#${result.message.seq}。${
					woke.length === 0 ? "没有人被唤醒（这只是一句话）。" : `已唤醒：${woke.join("、")}。`
				}`,
			);
		},
	});

	const ask = defineTool({
		name: "ask",
		description:
			"在当前频道提问并唤醒某人。用于：不清楚需求、需要别人拍板、要别人提供信息。不确定就问，别猜。",
		parameters: Type.Object({
			text: Type.String({ description: "问题，包含必要背景" }),
			mention: Type.String({ description: "@ 谁，写 slug（例如 cto、林越）。不知道写谁就用上级的 slug。" }),
			channel: Type.Optional(Type.String({ description: "频道 id" })),
		}),
		execute: async (args, api, context) => {
			const ctx = context ?? BACKGROUND_CONTEXT;
			const slug = await selfOf(deps, Number(api.conversationId), ctx);
			if (slug === undefined) return text("你还不在名册里。");
			const state = (await deps.harness.snapshot(ChannelDoc, ctx)) ?? { channels: {}, messages: {}, nextSeq: {}, readMarks: {} };
			const target = await defaultChannel(deps, state, slug, Number(api.conversationId), args.channel, ctx);
			if ("error" in target) return text(target.error);
			const channel = state.channels[target.channelId];
			const who = args.mention.replace(/^@/, "");
			if (channel === undefined || !channel.members.includes(who)) {
				const available = channel?.members.join("、") ?? "";
				return text(`「${channel?.title ?? target.channelId}」里没有「${who}」。可以 @：${available}`);
			}
			const result = await postMessage(
				postDeps(deps, state, ctx),
				{ channelId: target.channelId, from: slug, text: `@${who} ${args.text}`, at: Date.now(), kind: "question" },
				ctx,
			);
			return text(
				`已问 ${who}（「${result.channel.title}」#${result.message.seq}）。对方已被唤醒。你可以继续做别的，不要在这里等。`,
			);
		},
	});

	const readChannel = defineTool({
		name: "read_channel",
		description: "读一个频道的历史消息。投递给你的只有一条消息 + 未读摘要，需要完整上下文时用这个。读到会自动标记已读。",
		parameters: Type.Object({
			channel: Type.Optional(Type.String({ description: "频道 id" })),
			limit: Type.Optional(Type.Number({ description: "最多几条，默认 30，上限 100" })),
		}),
		execute: async (args, api, context) => {
			const ctx = context ?? BACKGROUND_CONTEXT;
			const slug = await selfOf(deps, Number(api.conversationId), ctx);
			if (slug === undefined) return text("你还不在名册里。");
			const state = (await deps.harness.snapshot(ChannelDoc, ctx)) ?? { channels: {}, messages: {}, nextSeq: {}, readMarks: {} };
			const target = await defaultChannel(deps, state, slug, Number(api.conversationId), args.channel, ctx);
			if ("error" in target) return text(target.error);
			const channel = state.channels[target.channelId];
			if (channel === undefined) return text("没有这个频道。");
			const limit = Math.min(Math.max(args.limit ?? 30, 1), 100);
			const list = state.messages[channel.id] ?? [];
			const shown = list.slice(Math.max(0, list.length - limit));
			if (shown.length === 0) return text(`「${channel.title}」里还没有消息。`);
			const last = shown[shown.length - 1];
			const lines = shown.map((message) => renderLine(message));
			if (last !== undefined) {
				await deps.harness.commit(async (tx) => {
					const doc = (await tx.doc(ChannelDoc)) as ChannelState;
					const mark = readMarkOf(doc, slug, channel.id);
					if (last.seq > mark) {
						doc.readMarks[slug] = { ...(doc.readMarks[slug] ?? {}), [channel.id]: last.seq };
					}
				}, ctx);
			}
			return text(
				[
					`「${channel.title}」最近 ${shown.length} 条（共 ${list.length} 条）：`,
					...lines,
					"",
					`（已标记到 #${last?.seq ?? 0} 为已读）`,
				].join("\n"),
			);
		},
	});

	const inbox = defineTool({
		name: "inbox",
		description: "我有多少没读的消息，按频道汇总。",
		parameters: Type.Object({}),
		execute: async (_args, api, context) => {
			const ctx = context ?? BACKGROUND_CONTEXT;
			const slug = await selfOf(deps, Number(api.conversationId), ctx);
			if (slug === undefined) return text("你还不在名册里。");
			const state = (await deps.harness.snapshot(ChannelDoc, ctx)) ?? { channels: {}, messages: {}, nextSeq: {}, readMarks: {} };
			const digest = renderDigest(state, slug, 20);
			return text(digest === "" ? "没有未读消息。" : digest);
		},
	});

	const listChannels = defineTool({
		name: "channels",
		description: "我能看到哪些频道，各自有多少未读。",
		parameters: Type.Object({}),
		execute: async (_args, api, context) => {
			const ctx = context ?? BACKGROUND_CONTEXT;
			const slug = await selfOf(deps, Number(api.conversationId), ctx);
			if (slug === undefined) return text("你还不在名册里。");
			const state = (await deps.harness.snapshot(ChannelDoc, ctx)) ?? { channels: {}, messages: {}, nextSeq: {}, readMarks: {} };
			const rows = channelsOf(state, slug).map((channel) => {
				const unread = unreadCount(state, channel.id, slug);
				return `- ${channel.id}「${channel.title}」${unread === 0 ? "" : ` ${unread} 条未读`}（${channel.members.length} 人）`;
			});
			return text(rows.length === 0 ? "你不在任何频道里。" : rows.join("\n"));
		},
	});

	const whoami = defineTool({
		name: "whoami",
		description: "我是谁：我的 slug、岗位、上级、下属、我的目录、我的能力清单。",
		parameters: Type.Object({}),
		execute: async (_args, api, context) => {
			const ctx = context ?? BACKGROUND_CONTEXT;
			const slug = await selfOf(deps, Number(api.conversationId), ctx);
			if (slug === undefined) return text("你还不在名册里。");
			const all = await readAllIdentities(deps.agentsRoot);
			const self = all.find((item) => item.slug === slug);
			const capabilities = await readCapabilities(deps.agentsRoot, slug);
			const reports = reportsOf(all, slug);
			return text(
				[
					`你是 ${self?.name ?? slug}（slug: ${slug}）${self?.title === undefined ? "" : `，岗位：${self.title}`}`,
					`直属上级：${self?.manager ?? "（无）"}`,
					reports.length === 0 ? "" : `直接下属：${reports.map((item) => `${item.name ?? item.slug}（${item.slug}）`).join("、")}`,
					`你的目录：agents/${slug}/（identity.md、capabilities、memory/）`,
					`能力：${capabilities.length === 0 ? "（capabilities 文件为空 —— 但你仍然拥有全部基础工具）" : capabilities.join("、")}`,
				]
					.filter((line) => line !== "")
					.join("\n"),
			);
		},
	});

	const orgChart = defineTool({
		name: "org_chart",
		description: "公司现在的组织架构（谁向谁汇报）。这是从文件夹实时渲染的，永远是最新的。",
		parameters: Type.Object({}),
		execute: async (_args, api, context) => {
			const ctx = context ?? BACKGROUND_CONTEXT;
			const slug = await selfOf(deps, Number(api.conversationId), ctx);
			const all = await readAllIdentities(deps.agentsRoot);
			return text(renderOrgChart(all, slug));
		},
	});

	const hire = defineTool({
		name: "hire",
		description: [
			"新建一个 agent（在 agents/ 下建一个文件夹并写 identity.md）。",
			"写什么身份由你决定：它的职责、它向谁汇报、它的边界。",
			"建完它立刻存在（下一条消息就能 @ 它），但需要外壳给它开会话才会真正醒来。",
		].join(""),
		parameters: Type.Object({
			name: Type.String({ description: "显示名，例如 林越 或 技术负责人" }),
			title: Type.Optional(Type.String({ description: "岗位标签，纯展示用" })),
			manager: Type.Optional(Type.String({ description: "上级的 slug，缺省是你自己" })),
			project: Type.Optional(Type.String({ description: "所在项目 slug" })),
			body: Type.Optional(Type.String({ description: "它的身份正文：职责、边界、工作方式。写具体一点。" })),
		}),
		execute: async (args, api, context) => {
			const ctx = context ?? BACKGROUND_CONTEXT;
			const self = await selfOf(deps, Number(api.conversationId), ctx);
			const identity = await createAgent({
				root: deps.agentsRoot,
				name: args.name,
				...(args.title === undefined ? {} : { title: args.title }),
				manager: args.manager ?? self ?? OWNER_SLUG,
				...(args.project === undefined ? {} : { project: args.project }),
				...(args.body === undefined ? {} : { body: args.body }),
			});
			if (deps.openAgent !== undefined) {
				const id = await deps.openAgent(identity.slug, ctx);
				await deps.saveDirectory((value) => ({
					...value,
					slugToConversation: { ...value.slugToConversation, [identity.slug]: id },
					conversationToSlug: { ...value.conversationToSlug, [String(id)]: identity.slug },
				}), ctx);
				return text(`已新建 ${identity.name}（slug: ${identity.slug}），会话 ${id} 已就绪。它的身份在 agents/${identity.slug}/identity.md。`);
			}
			return text(`已新建 ${identity.name}（slug: ${identity.slug}）。身份在 agents/${identity.slug}/identity.md，重启或外壳扫描后它会开会话。`);
		},
	});

	const updateIdentity = defineTool({
		name: "update_identity",
		description: [
			"改一个 agent 的 identity.md（正文或头部字段）。",
			"改完下一条消息就生效 —— 不需要重启、不需要重新部署。",
			"你可以改自己，也可以改你的直接下属。改别人的上级等于重组架构，请确认你真的要这么做。",
		].join(""),
		parameters: Type.Object({
			slug: Type.String({ description: "改谁" }),
			body: Type.Optional(Type.String({ description: "新的身份正文（整篇替换）" })),
			title: Type.Optional(Type.String({ description: "新的岗位标签" })),
			manager: Type.Optional(Type.String({ description: "新的上级 slug" })),
		}),
		execute: async (args, api, context) => {
			const ctx = context ?? BACKGROUND_CONTEXT;
			const self = await selfOf(deps, Number(api.conversationId), ctx);
			const all = await readAllIdentities(deps.agentsRoot);
			const target = all.find((item) => item.slug === args.slug);
			if (target === undefined) return text(`没有这个人：${args.slug}`);
			const isSelf = args.slug === self;
			const isReport = reportsOf(all, self ?? "").some((item) => item.slug === args.slug);
			if (!isSelf && !isReport) return text(`你只能改自己和自己的直接下属。${args.slug} 不是你的人。`);

			const header = {
				name: target.name,
				title: args.title ?? target.title,
				manager: args.manager ?? target.manager,
				project: target.project,
			};
			const body = args.body ?? target.body;
			await writeFile(join(target.dir, "identity.md"), renderIdentityFile(header as never, body), "utf8");
			return text(`已改 ${target.name ?? target.slug} 的身份。下一条消息它就按新身份工作。`);
		},
	});

	const setCapabilities = defineTool({
		name: "set_capabilities",
		description:
			"改一个 agent 的 capabilities 文件（一行一个工具名，# 注释）。注意：基础工具人人都有，这个文件是给「额外能力」用的索引。",
		parameters: Type.Object({
			slug: Type.String({ description: "改谁" }),
			names: Type.Array(Type.String(), { description: "工具名列表；空数组表示清空" }),
		}),
		execute: async (args, api, context) => {
			const ctx = context ?? BACKGROUND_CONTEXT;
			const self = await selfOf(deps, Number(api.conversationId), ctx);
			const all = await readAllIdentities(deps.agentsRoot);
			const target = all.find((item) => item.slug === args.slug);
			if (target === undefined) return text(`没有这个人：${args.slug}`);
			const isSelf = args.slug === self;
			const isReport = reportsOf(all, self ?? "").some((item) => item.slug === args.slug);
			if (!isSelf && !isReport) return text(`你只能改自己和自己的直接下属。`);
			await writeFile(join(target.dir, CAPABILITIES_FILE), `${args.names.join("\n")}\n`, "utf8");
			return text(`已把 ${target.name ?? target.slug} 的能力清单写成：${args.names.length === 0 ? "（空）" : args.names.join("、")}。`);
		},
	});

	const remember = defineTool({
   	name: "remember",
		description: "把一条经验写进我自己的记忆（agents/<我>/memory.md 追加一段）。",
		parameters: Type.Object({
			text: Type.String({ description: "要记的东西。写「下次遇到 X 该怎么做」，不要写流水账。" }),
		}),
		execute: async (args, api, context) => {
			const ctx = context ?? BACKGROUND_CONTEXT;
			const slug = await selfOf(deps, Number(api.conversationId), ctx);
			if (slug === undefined) return text("你还不在名册里。");
			const path = join(deps.agentsRoot, slug, "memory.md");
			let existing = "";
			try {
				existing = await readFile(path, "utf8");
			} catch {
				existing = `# ${slug} 的记忆\n`;
			}
			const stamp = new Date().toISOString().slice(0, 10);
			await writeFile(path, `${existing.trimEnd()}\n\n## ${stamp}\n${args.text.trim()}\n`, "utf8");
			return text("已记下。");
		},
	});

	const recall = defineTool({
		name: "recall",
		description: "翻我自己的记忆（agents/<我>/memory.md）。",
		parameters: Type.Object({
			contains: Type.Optional(Type.String({ description: "只看包含这个词的段落" })),
		}),
		execute: async (args, api, context) => {
			const ctx = context ?? BACKGROUND_CONTEXT;
			const slug = await selfOf(deps, Number(api.conversationId), ctx);
			if (slug === undefined) return text("你还不在名册里。");
			let source: string;
			try {
				source = await readFile(join(deps.agentsRoot, slug, "memory.md"), "utf8");
			} catch {
				return text("我还没记过任何东西。");
			}
			if (args.contains === undefined || args.contains === "") return text(source);
			const sections = source.split(/\n(?=## )/u).filter((part) => part.includes(args.contains as string));
			return text(sections.length === 0 ? `记忆里没有「${args.contains}」。` : sections.join("\n\n"));
		},
	});

	return [
		say,
		ask,
		readChannel,
		inbox,
		listChannels,
		whoami,
		orgChart,
		hire,
		updateIdentity,
		setCapabilities,
		remember,
		recall,
	] as readonly ToolRegistration[];
}

/** 组装一次投递的全部依赖（`say` / `ask` 共用）。 */
function postDeps(deps: CoreToolDeps, state: ChannelState, context: Context): PostDeps {
	return {
		harness: deps.harness,
		state,
		conversationOf: (slug: string) => conversationOf(deps, slug, context),
		labelOf: (slug: string) => slug,
		rememberWake: async (slug: string, wake) => {
			const directory = await deps.directory(context);
			const id = conversationFor(directory, slug);
			if (id === undefined) return;
			await deps.saveDirectory(
				(value) => ({ ...value, wake: { ...value.wake, [String(id)]: { ...wake } } }),
				context,
			);
		},
	};
}

/**
 * slug → 会话句柄。名册里没有、或者会话已被删除时返回 undefined（不抛）。
 *
 * 找不到人不是错误：老板就是没有会话的，刚 hire 的人也可能还没开。
 */
async function conversationOf(deps: CoreToolDeps, slug: string, context: Context) {
	const directory = await deps.directory(context);
	const id = conversationFor(directory, slug);
	if (id === undefined) return undefined;
	return deps.harness.conversation(id as never, context);
}

/** 一条消息的一行渲染（`read_channel` 用）。 */
function renderLine(message: Message): string {
	const time = new Date(message.at).toISOString().slice(11, 16);
	const mentions = message.mentions.length === 0 ? "" : ` @${message.mentions.join("、")}`;
	const quoted = message.replyTo === undefined ? "" : `（回复 #${message.replyTo}）`;
	return `#${message.seq} ${time} ${message.from}${mentions}：${quoted}${message.text}`;
}

/** 把上面全部工具装成一个扩展。 */
export function coreToolsExtension(deps: CoreToolDeps) {
	return defineExtension({ name: "core-tools", tools: createCoreTools(deps) });
}

