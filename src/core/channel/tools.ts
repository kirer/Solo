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
 * | `remember` / `recall` | 记忆 |
 * | `list_skills` / `read_skill` / `write_skill` | 技能（怎么做一件事的说明书） |
 * | `list_projects` / `read_project` / `write_project` | 项目（`projects/<slug>/README.md`） |
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
import {
	listCompanySkills,
	listSkills,
	readSkill,
	type SkillRoots,
	writeCompanySkill,
	writeSkill,
} from "../agent/skills.ts";
import { appendMemory, readMemory, sectionsOf } from "../agent/memory.ts";
import { listProjects, readProject, writeProject } from "../project/doc.ts";
import { createAgent, renderIdentityFile, renderOrgChart } from "../agent/create.ts";
import { conversationFor, slugFor, wakeOf, type DirectoryState } from "../agent/roster.ts";
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
import {
	appendProjectMemory,
	projectMemorySections,
	readProjectMemory,
} from "../project/memory.ts";

/** 工具运行所需的一切。全部由外壳在启动时装配，工具自己不读环境变量。 */
export type CoreToolDeps = {
	readonly harness: Harness;
	/**
	 * 工作区根。`agents/` 与 `skills/` 都在它下面。
	 *
	 * 为什么工具需要它：`npx skills add` 会把技能装到**当前目录**下，所以在哪儿跑
	 * 决定了装到哪儿。公司层就是工作区根下的 `skills/`。
	 */
	readonly workspaceRoot: string;
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

/** 技能的两级根目录。工具里每次都从 deps 现算，避免多存一份会漂的副本。 */
function skillRoots(deps: CoreToolDeps): SkillRoots {
	return { workspace: deps.workspaceRoot, agents: deps.agentsRoot };
}

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
			const reports = reportsOf(all, slug);
			return text(
				[
					`你是 ${self?.name ?? slug}（slug: ${slug}）${self?.title === undefined ? "" : `，岗位：${self.title}`}`,
					`直属上级：${self?.manager ?? "（无）"}`,
					reports.length === 0 ? "" : `直接下属：${reports.map((item) => `${item.name ?? item.slug}（${item.slug}）`).join("、")}`,
					`你的目录：agents/${slug}/（identity.md、memory.md、skills/）`,
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

	/**
	 * 我会哪些技能。
	 *
	 * 技能正文不进提示词，所以 agent 需要先「翻目录」再「读全文」。这两个动作分开，
	 * 是为了让它能在一屏之内比较五门手艺该用哪一门，而不是把五篇正文全吞下去。
	 */
	const listSkillsTool = defineTool({
		name: "list_skills",
		description: "列出我能用的全部技能（名字 + 一句描述 + 公司教的还是我自己写的）。要看正文用 read_skill。",
		parameters: Type.Object({}),
		execute: async (_args, api, context) => {
			const ctx = context ?? BACKGROUND_CONTEXT;
			const slug = await selfOf(deps, Number(api.conversationId), ctx);
			if (slug === undefined) return text("你还不在名册里。");
			const skills = await listSkills(skillRoots(deps), slug);
			if (skills.length === 0) return text("我还没有技能。");
			return text(
				skills
					.map((skill) => `- ${skill.name}（${skill.scope === "company" ? "公司" : "我自己"}）：${skill.description}`)
					.join("\n"),
			);
		},
	});

	const readSkillTool = defineTool({
		name: "read_skill",
		description: [
			"读一门技能的正文。公司层的在 skills/<名字>/SKILL.md，我自己的在 agents/<我>/skills/<名字>/SKILL.md。",
			"提示词里只有技能的名字和一句描述；要做那件事之前，先读它的正文。",
		].join(""),
		parameters: Type.Object({
			name: Type.String({ description: "技能名（list_skills 里看到的那个）" }),
		}),
		execute: async (args, api, context) => {
			const ctx = context ?? BACKGROUND_CONTEXT;
			const slug = await selfOf(deps, Number(api.conversationId), ctx);
			if (slug === undefined) return text("你还不在名册里。");
			const skill = await readSkill(skillRoots(deps), slug, args.name);
			if (skill === undefined) {
				const all = await listSkills(skillRoots(deps), slug);
				const names = all.map((item) => item.name).join("、");
				return text(`没有叫「${args.name}」的技能。我有的：${names === "" ? "（一个都没有）" : names}。`);
			}
			const where = skill.scope === "company" ? "公司层" : "我自己的";
			return text(`# 技能：${skill.name}（${where}）\n\n${skill.body}`);
		},
	});

	const writeSkillTool = defineTool({
		name: "write_skill",
		description: [
			"写一门技能（整篇替换 SKILL.md）。",
			"`scope=personal`（默认）写进我自己的目录，只有我看得见；`scope=company` 写进公司层，所有人立刻看得见。",
			"技能是「怎么做一件事」的说明书：步骤、判据、踩过的坑。写具体，别写口号。",
			"写完下一条消息就生效 —— 不用重启。",
		].join(""),
		parameters: Type.Object({
			name: Type.String({ description: "技能名，会当目录名用（不能含斜杠）" }),
			description: Type.String({
				description: "一句话说清「做什么 + 什么时候用」。这行会常驻提示词，要能当路由依据。",
			}),
			body: Type.String({ description: "正文：步骤、判据、样例。写给下一次的你自己看。" }),
			scope: Type.Optional(
				Type.String({ description: "personal（默认，只我看得见）或 company（全公司都看得见）" }),
			),
		}),
		execute: async (args, api, context) => {
			const ctx = context ?? BACKGROUND_CONTEXT;
			const slug = await selfOf(deps, Number(api.conversationId), ctx);
			if (slug === undefined) return text("你还不在名册里。");
			const company = args.scope === "company";
			try {
				const written = company
					? await writeCompanySkill(deps.workspaceRoot, args)
					: await writeSkill(skillRoots(deps), slug, args);
				const where = company ? `skills/${written.name}/SKILL.md（全公司）` : `agents/${slug}/skills/${written.name}/SKILL.md`;
				return text(`已写入技能「${written.name}」：${where}。下一条消息就生效。`);
			} catch (error) {
				return text(`写不进去：${error instanceof Error ? error.message : String(error)}`);
			}
		},
	});

	/**
	 * 去外面的技能市场找现成的。
	 *
	 * 这里面**没有代码逻辑**，只有两条命令：`npx skills find` 搜、`npx skills add` 装。
	 * 生态是公开的（skills.sh / GitHub），所以「技能从哪来」不需要我们自己造一个市场 ——
	 * 我们只需要让它能调用、把装好的东西收进 skills/ 目录，然后照自己的话重写一遍。
	 */
	const findSkillTool = defineTool({
		name: "find_skill",
		description: [
			"去开放技能市场（skills.sh / GitHub）搜或装现成的技能。",
			"`action=find` 搜关键词；`action=add` 按 package 名安装（例如 `anthropics/skills@pdf`）。",
			"装完之后**不要直接用**：读一遍、按我们公司的话重写成自己的（`write_skill`），别人的说明书不可能知道我们的规矩。",
		].join(""),
		parameters: Type.Object({
			action: Type.String({ description: "find 或 add" }),
			query: Type.String({ description: "find 时是关键词；add 时是 package 名" }),
		}),
		execute: async (args, api, context) => {
			const ctx = context ?? BACKGROUND_CONTEXT;
			const slug = await selfOf(deps, Number(api.conversationId), ctx);
			if (slug === undefined) return text("你还不在名册里。");
			const { execFile } = await import("node:child_process");
			const { promisify } = await import("node:util");
			const run = promisify(execFile);
			const command = args.action === "add" ? ["skills", "add", args.query, "--yes"] : ["skills", "find", args.query];
			try {
				// 在**工作区**里跑：`npx skills add` 会把技能装到当前目录下的 skills/，
				// 正好就是公司层。装之前把 cwd 设成工作区根，个人层的事让它自己拷。
				const { stdout, stderr } = await run("npx", command, {
					cwd: deps.workspaceRoot,
					timeout: 120_000,
					maxBuffer: 4 * 1024 * 1024,
					env: { ...process.env, CI: "1" },
				});
				const output = `${stdout}\n${stderr}`.trim();
				return text(output === "" ? "命令跑完了，没有输出。" : output.slice(0, 8_000));
			} catch (error) {
				const detail = error instanceof Error ? error.message : String(error);
				return text(`跑不动（可能是没网，或者 npx 不可用）：${detail.slice(0, 2_000)}`);
			}
		},
	});

	/**
	 * 项目：`projects/<slug>/README.md`。
	 *
	 * 项目不是代码里的一个实体，就是一份文档。代码只负责读写它、按它算成员。
	 * 「什么时候该立项」「项目该有谁」是判断，写在技能里。
	 */
	const listProjectsTool = defineTool({
		name: "list_projects",
		description: "列出全部项目（slug、名字、负责人、状态、一句摘要）。",
		parameters: Type.Object({}),
		execute: async () => {
			const projects = await listProjects(deps.projectsRoot);
			if (projects.length === 0) return text("还没有项目。");
			return text(
				projects
					.map((project) => {
						const head = project.body.split("\n").find((line) => line.trim() !== "") ?? "";
						return `- ${project.slug}（${project.name}）· ${project.status} · 负责人：${project.owner ?? "（没人负责）"}\n  ${head}`;
					})
					.join("\n"),
			);
		},
	});

	const readProjectTool = defineTool({
		name: "read_project",
		description: "读一个项目的完整说明（目标、验收标准、边界、进展）。",
		parameters: Type.Object({ slug: Type.String({ description: "项目 slug" }) }),
		execute: async (args) => {
			const project = await readProject(deps.projectsRoot, args.slug);
			if (project === undefined) return text(`没有这个项目：${args.slug}`);
			return text(`# ${project.name}（${project.slug}）\n状态：${project.status}\n负责人：${project.owner ?? "（没人负责）"}\n\n${project.body}`);
		},
	});

	const writeProjectTool = defineTool({
		name: "write_project",
		description: [
			"写一个项目（整篇替换 projects/<slug>/README.md，不存在就建）。",
			"写清楚：目标、验收标准、什么不做、现在进展到哪。",
			"写完下一条消息生效 —— 项目成员的提示词里会自动出现这份说明。",
		].join(""),
		parameters: Type.Object({
			slug: Type.String({ description: "项目 slug（会当目录名用）" }),
			name: Type.Optional(Type.String({ description: "显示名" })),
			owner: Type.Optional(Type.String({ description: "负责人的 slug" })),
			status: Type.Optional(Type.String({ description: "active / paused / done / archived" })),
			body: Type.String({ description: "正文：目标、验收标准、边界、进展" }),
		}),
		execute: async (args) => {
			try {
				const project = await writeProject(deps.projectsRoot, {
					slug: args.slug,
					body: args.body,
					...(args.name === undefined ? {} : { name: args.name }),
					...(args.owner === undefined ? {} : { owner: args.owner }),
					...(args.status === undefined ? {} : { status: args.status as never }),
				});
				return text(`已写入项目「${project.name}」（${project.slug}）。agents 里写 \`project: ${project.slug}\` 的人会看到这份说明。`);
			} catch (error) {
				return text(`写不进去：${error instanceof Error ? error.message : String(error)}`);
			}
		},
	});

	const remember = defineTool({
		name: "remember",
		description: [
			"把一条经验写进我自己的记忆（agents/<我>/memory.md 追加一小节）。",
			"写「下次遇到 X 该怎么做」这类可复用的判断，不要写流水账。",
			"提示词里只有目录；写下来之后你自己也得 recall 才看得到全文。",
		].join(""),
		parameters: Type.Object({
			text: Type.String({ description: "要记的东西。一句话说清一条，几条就调几次。" }),
		}),
		execute: async (args, api, context) => {
			const ctx = context ?? BACKGROUND_CONTEXT;
			const slug = await selfOf(deps, Number(api.conversationId), ctx);
			if (slug === undefined) return text("你还不在名册里。");
			await appendMemory(join(deps.agentsRoot, slug), args.text);
			return text("已记下。下一条消息的记忆目录里就会出现它。");
		},
	});

	const recall = defineTool({
		name: "recall",
		description: "翻我自己的记忆全文，可以只筛包含某个词的段落。",
		parameters: Type.Object({
			contains: Type.Optional(Type.String({ description: "只看包含这个词的段落" })),
		}),
		execute: async (args, api, context) => {
			const ctx = context ?? BACKGROUND_CONTEXT;
			const slug = await selfOf(deps, Number(api.conversationId), ctx);
			if (slug === undefined) return text("你还不在名册里。");
			const source = await readMemory(join(deps.agentsRoot, slug));
			if (source === undefined) return text("我还没记过任何东西。");
			if (args.contains === undefined || args.contains === "") return text(source);
			const sections = sectionsOf(source).filter(
				(section) => section.heading.includes(args.contains as string) || section.body.includes(args.contains as string),
			);
			if (sections.length === 0) return text(`记忆里没有「${args.contains}」。`);
			return text(sections.map((section) => `## ${section.heading}\n${section.body}`).join("\n\n"));
		},
	});

	/**
	 * 项目记忆：`projects/<slug>/memory.md`。
	 *
	 * 与个人记忆的区别只有归属：个人记忆是「我学到什么」，项目记忆是「这个摊子上发生过
	 * 什么」。为什么必须分开：项目换人很正常，事实只写在某个人的记忆里，人一走就带走了。
	 *
	 * 写权限按**归属**判，不按职位判：只有 `identity.md` 里写着 `project: <slug>` 的人
	 * 能写。全公司都能读 —— 记忆是资产，藏起来只会重复踩坑。
	 */
	const rememberProjectTool = defineTool({
		name: "remember_project",
		description: [
			"把一条经验写进所在项目的记忆（projects/<项目>/memory.md，追加一小节，带日期和你的名字）。",
			"写项目级的判断：这个项目的坑、约定、走过的弯路。个人的事用 remember。",
			"只有这个项目里的人能写。",
		].join(""),
		parameters: Type.Object({
			text: Type.String({ description: "要记的东西。一句话说清一条。" }),
			project: Type.Optional(Type.String({ description: "项目 slug；默认是我所在的项目" })),
		}),
		execute: async (args, api, context) => {
			const ctx = context ?? BACKGROUND_CONTEXT;
			const slug = await selfOf(deps, Number(api.conversationId), ctx);
			if (slug === undefined) return text("你还不在名册里。");
			const self = await readIdentity(deps.agentsRoot, slug);
			const project = args.project ?? self?.project;
			if (project === undefined) return text("我不在任何项目里。要记项目的事，先说清是哪个项目。");
			// 写权限按归属：不在这个项目里就不许写（读是全公司都能读）。
			if (self?.project !== project) {
				return text(`我不在项目 \`${project}\` 里，写不了它的记忆。我的项目是 ${self?.project ?? "（没有）"}。`);
			}
			await appendProjectMemory(deps.projectsRoot, project, { text: args.text, by: slug });
			return text(`已记进项目「${project}」的记忆。下一条消息就会出现在这个项目的记忆目录里。`);
		},
	});

	const readProjectMemoryTool = defineTool({
		name: "read_project_memory",
		description: [
			"读某个项目的记忆全文（全公司都能读）。可以只筛包含某个词的段落。",
			"换手接一个项目之前先读它 —— 坑都写在这里。",
		].join(""),
		parameters: Type.Object({
			project: Type.Optional(Type.String({ description: "项目 slug；默认是我所在的项目" })),
			contains: Type.Optional(Type.String({ description: "只看包含这个词的段落" })),
		}),
		execute: async (args, api, context) => {
			const ctx = context ?? BACKGROUND_CONTEXT;
			const slug = await selfOf(deps, Number(api.conversationId), ctx);
			const self = slug === undefined ? undefined : await readIdentity(deps.agentsRoot, slug);
			const project = args.project ?? self?.project;
			if (project === undefined) return text("我不在任何项目里。要看项目记忆，请说是哪个项目。");
			const source = await readProjectMemory(deps.projectsRoot, project);
			if (source === undefined) return text(`项目「${project}」还没有记忆。`);
			if (args.contains === undefined || args.contains === "") return text(source);
			const sections = projectMemorySections(source).filter(
				(section) => section.heading.includes(args.contains as string) || section.body.includes(args.contains as string),
			);
			if (sections.length === 0) return text(`项目「${project}」的记忆里没有「${args.contains}」。`);
			return text(sections.map((section) => `## ${section.heading}\n${section.body}`).join("\n\n"));
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
		rememberProjectTool,
		readProjectMemoryTool,
		listSkillsTool,
		readSkillTool,
		writeSkillTool,
		findSkillTool,
		listProjectsTool,
		readProjectTool,
		writeProjectTool,
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

