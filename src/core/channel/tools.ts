/**
 * 全部工具：**只有一套，人人都有。**
 *
 * 这里没有「管理层工具」「员工工具」「负责人工具」的分层。按岗位发工具包来实现
 * 「员工不能越级」，代价是：调一个岗位就要改代码重新部署，而「谁能做什么」
 * 本来该写在身份里。
 *
 * 十六个工具，按「做一件事」划分，不按「谁配用」划分：
 *
 * | 工具 | 用途 |
 * |---|---|
 * | `say` | 在频道说一句；带 `mention` 就是提问并叫醒对方 |
 * | `read_channel` | 不传频道=未读摘要+频道列表；传频道=读历史消息 |
 * | `org` | 我是谁、上级下属、全公司架构 |
 * | `hire` | 新建一个 agent（写文件夹） |
 * | `update_identity` | 改我自己或我下属的身份 |
 * | `remember` / `recall` | 写/读记忆；`scope=project` 切到项目记忆 |
 * | `list_skills` / `read_skill` / `write_skill` | 技能（怎么做一件事的说明书） |
 * | `list_projects` / `read_project` / `write_project` | 项目（`projects/<slug>/README.md`） |
 * | `run` / `write_file` / `read_file` | 执行命令 / 写文件 / 读文件 |
 *
 * 每一个工具返回**自然语言**，不是结构化数据 —— 工具的输出是给模型读的。
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
	BACKGROUND_CONTEXT,
	Type,
	defineTool,
	type Context,
	type Harness,
	type ToolRegistration,
} from "../runtime/index.ts";
import { OWNER_SLUG, readAllIdentities, readIdentity, reportsOf } from "../agent/identity.ts";
import {
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
	parseMentions,
	personalId,
	readMarkOf,
	unreadCount,
	type ChannelState,
	type Message,
} from "./state.ts";
import { renderDigest } from "./deliver.ts";
import { confirmedBy } from "../project/settle.ts";
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
	/**
	 * 一条消息落地之后的钩子。外壳用它接「项目记忆自动沉淀」。
	 *
	 * 为什么挂在工具层而不是频道层：沉淀要读 `agents/` 与 `projects/`，那是外壳的
	 * 视野；`channel/post.ts` 只认识频道文档，不该知道项目记忆存在。
	 */
	readonly afterPost?: (message: Message, channelId: string, context: Context) => Promise<void>;
	/**
	 * 按项目文件重建它的频道成员（幂等）。
	 *
	 * `write_project` 改了 `owner` 之后必须调一次：项目频道里的人是文档的投影，
	 * 不刷新的话，刚任命的负责人在项目频道里不存在，员工 @ 不到他。
	 */
	readonly syncProject?: (project: string, context: Context) => Promise<void>;
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
	// 一个人至少有他的个人频道（与老板的私聊）。外壳在开会话时就建好了，所以这里
	// 兜底也应该是它 —— 以前兜到同一个 id 但频道可能根本不存在，工具会报「频道不存在」。
	return { channelId: personalId(slug) };
}

/** 建工具。返回一个扩展，装进所有 agent 的会话里。 */
export function createCoreTools(deps: CoreToolDeps) {
	const say = defineTool({
		name: "say",
		description:
			"在当前频道说话。不传 mention 就是一句普通发言（正文里写 @某人 才会叫醒他）；传 mention 就是提问或 @ 某人（会叫醒他）。用于汇报进度、说明结论、回应别人、提问。",
		parameters: Type.Object({
			text: Type.String({ description: "要说的话" }),
			mention: Type.Optional(Type.String({ description: "@ 谁，写 slug（例如 zhiyan、林越）。带上会叫醒他，适合提问或需要别人拍板。不知道 @ 谁就写你上级的 slug。" })),
			channel: Type.Optional(Type.String({ description: "频道 id，省略则回刚被叫醒的那个频道" })),
			replyTo: Type.Optional(Type.Number({ description: "要引用回复的消息序号" })),
			kind: Type.Optional(
				Type.Union([Type.Literal("decision"), Type.Literal("report")], {
					description:
						"给这条消息打标签：decision = 拍了板（结论、约定、定了怎么做）；report = 交付了什么。只在项目频道里打标签才有意义——项目记忆靠这两个标签自动沉淀。普通发言不要传。",
				}),
			),
		}),
		execute: async (args, api, context) => {
			const ctx = context ?? BACKGROUND_CONTEXT;
			const slug = await selfOf(deps, Number(api.conversationId), ctx);
			if (slug === undefined) return text("你还不在名册里。先用 org 看看情况，或请上级重新登记你。");
			const state = (await deps.harness.snapshot(ChannelDoc, ctx)) ?? { channels: {}, messages: {}, nextSeq: {}, readMarks: {} };
			const target = await defaultChannel(deps, state, slug, Number(api.conversationId), args.channel, ctx);
			if ("error" in target) return text(target.error);

			// 带 mention：验证成员、补 @ 前缀、默认 kind=question
			let messageText = args.text;
			let kind: string | undefined = args.kind;
			if (args.mention !== undefined && args.mention !== "") {
				const channel = state.channels[target.channelId];
				const who = args.mention.replace(/^@/, "");
				if (channel === undefined || !channel.members.includes(who)) {
					const available = channel?.members.join("、") ?? "";
					return text(`「${channel?.title ?? target.channelId}」里没有「${who}」。可以 @：${available}`);
				}
				messageText = parseMentions(args.text).includes(who) ? args.text : `@${who} ${args.text}`;
				kind = args.kind ?? "question";
			}

			const result = await postMessage(
				postDeps(deps, state, ctx),
				{
					channelId: target.channelId,
					from: slug,
					text: messageText,
					at: Date.now(),
					...(args.replyTo === undefined ? {} : { replyTo: args.replyTo }),
					...(kind === undefined ? {} : { kind }),
				},
				ctx,
			);
			if (deps.afterPost !== undefined) await deps.afterPost(result.message, target.channelId, ctx);
			const woke = result.delivery.delivered;
			return text(
				`已发到「${result.channel.title}」#${result.message.seq}。${
					woke.length === 0 ? "没有人被唤醒（这只是一句话）。" : `已唤醒：${woke.join("、")}。`
				}`,
			);
		},
	});

	const readChannel = defineTool({
		name: "read_channel",
		description: "读频道。不传 channel 时显示摘要：你能看到哪些频道、各有多少未读。传 channel 时读那个频道的历史消息（自动标记已读）。",
		parameters: Type.Object({
			channel: Type.Optional(Type.String({ description: "频道 id。不传则显示未读摘要 + 频道列表" })),
			limit: Type.Optional(Type.Number({ description: "最多几条，默认 30，上限 100" })),
		}),
		execute: async (args, api, context) => {
			const ctx = context ?? BACKGROUND_CONTEXT;
			const slug = await selfOf(deps, Number(api.conversationId), ctx);
			if (slug === undefined) return text("你还不在名册里。");
			const state = (await deps.harness.snapshot(ChannelDoc, ctx)) ?? { channels: {}, messages: {}, nextSeq: {}, readMarks: {} };

			// 无 channel：返回未读摘要 + 频道列表（原 inbox + channels 合并）
			if (args.channel === undefined || args.channel === "") {
				const digest = renderDigest(state, slug, 20);
				const rows = channelsOf(state, slug).map((channel) => {
					const unread = unreadCount(state, channel.id, slug);
					return `- ${channel.id}「${channel.title}」${unread === 0 ? "" : ` ${unread} 条未读`}（${channel.members.length} 人）`;
				});
				const parts = [
					...(digest === "" ? [] : ["未读消息：", digest]),
					...(rows.length === 0 ? ["你不在任何频道里。"] : ["", "你的频道：", ...rows]),
				];
				return text(parts.join("\n"));
			}

			// 有 channel：读历史消息
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

	const org = defineTool({
		name: "org",
		description: "你是谁、你的上级和下属、全公司组织架构。从文件夹实时渲染，永远是最新的。",
		parameters: Type.Object({}),
		execute: async (_args, api, context) => {
			const ctx = context ?? BACKGROUND_CONTEXT;
			const slug = await selfOf(deps, Number(api.conversationId), ctx);
			const all = await readAllIdentities(deps.agentsRoot);
			const self = all.find((item) => item.slug === slug);
			const reports = reportsOf(all, slug ?? "");
			const personal = [
				`你是 ${self?.name ?? slug ?? "（未登记）"}（slug: ${slug ?? "?"}）${self?.title === undefined ? "" : `，岗位：${self.title}`}`,
				`直属上级：${self?.manager ?? "（无）"}`,
				reports.length === 0 ? "" : `直接下属：${reports.map((item) => `${item.name ?? item.slug}（${item.slug}）`).join("、")}`,
				slug === undefined ? "" : `你的目录：agents/${slug}/（identity.md、memory.md、skills/）`,
			].filter((line) => line !== "").join("\n");
			return text(`${personal}\n\n--- 全公司架构 ---\n${renderOrgChart(all, slug)}`);
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
			name: Type.String({
				description:
					"他的姓名，像真人一样：姓 + 名，两到三个字（例如 林越、沈舟、顾南雁）。不要用岗位当名字（「技术负责人」不是名字），也不要英文名或代号——公司里的人有名字，岗位写在 title 里。",
			}),
			title: Type.Optional(Type.String({ description: "岗位标签，纯展示用" })),
			manager: Type.Optional(Type.String({ description: "上级的 slug，缺省是你自己" })),
			project: Type.Optional(Type.String({ description: "所在项目 slug" })),
			body: Type.Optional(
				Type.String({
					description:
						"它的身份正文。四段：①你负责什么（一件有产出物的事）②你不做什么（明确排除）③你怎么汇报（向谁、什么情况必须停下来问、什么可以自己拍板）④做得好是什么样（验收标准）。",
				}),
			),
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
		].join(""),
		parameters: Type.Object({
			slug: Type.String({ description: "改谁" }),
			body: Type.Optional(Type.String({ description: "新的身份正文（整篇替换）" })),
			title: Type.Optional(Type.String({ description: "新的岗位标签" })),
			manager: Type.Optional(Type.String({ description: "新的上级 slug" })),
		}),
		execute: async (args) => {
			const target = (await readAllIdentities(deps.agentsRoot)).find((item) => item.slug === args.slug);
			if (target === undefined) return text(`没有这个人：${args.slug}`);

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
		execute: async (args, _api, context) => {
			const ctx = context ?? BACKGROUND_CONTEXT;
			try {
				const project = await writeProject(deps.projectsRoot, {
					slug: args.slug,
					body: args.body,
					...(args.name === undefined ? {} : { name: args.name }),
					...(args.owner === undefined ? {} : { owner: args.owner }),
					...(args.status === undefined ? {} : { status: args.status as never }),
				});
				// 负责人写进文件之后，项目频道要立刻把他拉进来：频道成员是文档的投影，
				// 文档改了投影不改，员工在项目里就 @ 不到刚任命的负责人。
				if (deps.syncProject !== undefined) await deps.syncProject(project.slug, ctx);
				const ownerNote =
					project.owner === undefined
						? "\n\n注意：这份项目还没有负责人（`owner`）。项目里出问题时没人能拍板 —— 现在就把负责人定下来。"
						: "";
				return text(`已写入项目「${project.name}」（${project.slug}），负责人：${project.owner ?? "（没人负责）"}。agents 里写 \`project: ${project.slug}\` 的人会看到这份说明。${ownerNote}`);
			} catch (error) {
				return text(`写不进去：${error instanceof Error ? error.message : String(error)}`);
			}
		},
	});

	const remember = defineTool({
		name: "remember",
		description: [
			"记一条经验。",
			"scope=personal（默认）写进你自己的记忆（agents/<我>/memory.md）；scope=project 写进所在项目的记忆（projects/<项目>/memory.md，带日期和你的名字）。",
			"写「下次遇到 X 该怎么做」这类可复用的判断，不要写流水账。",
		].join(""),
		parameters: Type.Object({
			text: Type.String({ description: "要记的东西。一句话说清一条，几条就调几次。" }),
			scope: Type.Optional(Type.String({ description: "personal（默认，自己的记忆）或 project（项目记忆）" })),
			project: Type.Optional(Type.String({ description: "项目 slug；scope=project 时用。默认是我所在的项目" })),
		}),
		execute: async (args, api, context) => {
			const ctx = context ?? BACKGROUND_CONTEXT;
			const slug = await selfOf(deps, Number(api.conversationId), ctx);
			if (slug === undefined) return text("你还不在名册里。");
			if (args.scope === "project") {
				const self = await readIdentity(deps.agentsRoot, slug);
				const project = args.project ?? self?.project;
				if (project === undefined) return text("我不在任何项目里。要记项目的事，先说清是哪个项目。");
				await appendProjectMemory(deps.projectsRoot, project, { text: args.text, by: slug });
				const confirmed = await confirmedBy(deps.harness, project, ctx);
				const tail = confirmed === 0 ? "" : `（已把 #${confirmed} 之前的结论标记为已沉淀）`;
				return text(`已记进项目「${project}」的记忆${tail}。下一条消息就会出现在这个项目的记忆目录里。`);
			}
			await appendMemory(join(deps.agentsRoot, slug), args.text);
			return text("已记下。下一条消息的记忆目录里就会出现它。");
		},
	});

	const recall = defineTool({
		name: "recall",
		description: [
			"翻记忆全文。scope=personal（默认）翻你自己的记忆；scope=project 翻项目记忆。",
			"可以只筛包含某个词的段落。",
		].join(""),
		parameters: Type.Object({
			scope: Type.Optional(Type.String({ description: "personal（默认，自己的记忆）或 project（项目记忆）" })),
			project: Type.Optional(Type.String({ description: "项目 slug；scope=project 时用。默认是我所在的项目" })),
			contains: Type.Optional(Type.String({ description: "只看包含这个词的段落" })),
		}),
		execute: async (args, api, context) => {
			const ctx = context ?? BACKGROUND_CONTEXT;
			const slug = await selfOf(deps, Number(api.conversationId), ctx);
			if (slug === undefined) return text("你还不在名册里。");

			if (args.scope === "project") {
				const self = await readIdentity(deps.agentsRoot, slug);
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
			}

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

	const run = defineTool({
		name: "run",
		description: [
			"执行一条 shell 命令，返回 stdout / stderr / 退出码。",
			"用于：写代码文件、起服务、跑测试、装依赖。",
			"命令以 & 结尾或以 nohup 开头时，后台运行并立即返回 PID（用于起服务）。",
			"执行过程会记录到你的个人频道（老板能看到你在做什么）。",
			"不确定能不能跑某条命令时，先看你的技能（`read_skill`）。",
		].join(""),
		parameters: Type.Object({
			command: Type.String({ description: "要执行的命令" }),
			cwd: Type.Optional(Type.String({ description: "工作目录，默认工作区根" })),
			timeout: Type.Optional(Type.Number({ description: "超时秒数，默认 60" })),
		}),
		execute: async (args, api, context) => {
			const ctx = context ?? BACKGROUND_CONTEXT;
			const slug = await selfOf(deps, Number(api.conversationId), ctx);
			if (slug === undefined) return text("你还不在名册里。");
			const cwd = args.cwd ?? deps.workspaceRoot;
			const seconds = Math.min(Math.max(args.timeout ?? 60, 1), 300);
			const command = args.command;

			// 后台命令：以 & 结尾或以 nohup 开头 → detached spawn，立即返回 PID。
			const isBackground = command.trim().endsWith("&") || /^\s*nohup\b/.test(command);

			if (isBackground) {
				const { spawn } = await import("node:child_process");
				const child = spawn(command.replace(/\s*&\s*$/, ""), {
					shell: true,
					cwd,
					detached: true,
					stdio: "ignore",
				});
				child.unref();
				const pid = child.pid ?? -1;
				const report = [`$ ${command}`, `(后台运行，PID ${pid}）`].join("\n");
				await logWork(deps, slug, report, ctx);
				return text(report);
			}

			// 前台命令：等它跑完。
			const { exec } = await import("node:child_process");
			const result = await new Promise<{ stdout: string; stderr: string; code: number | null }>((resolve) => {
				exec(command, { cwd, timeout: seconds * 1000, maxBuffer: 512 * 1024 }, (error, stdout, stderr) => {
					resolve({
						stdout: stdout.toString(),
						stderr: stderr.toString(),
						code: error === null ? 0 : error.code ?? -1,
					});
				});
			});

			const output = [
				`$ ${command}`,
				...(result.stdout.trim() === "" ? [] : [result.stdout.trim()]),
				...(result.stderr.trim() === "" ? [] : [`[stderr] ${result.stderr.trim()}`]),
				`(退出码 ${result.code})`,
			].join("\n");
			const report = output.length > 4000 ? `${output.slice(0, 4000)}\n…（输出已截断，完整结果用 read_file 看对应文件）` : output;
			await logWork(deps, slug, report, ctx);
			return text(report);
		},
	});

	/**
	 * 写一个文件。
	 *
	 * 与 `run` 写文件的差别：这个工具不经过 shell，路径可控、内容不经过转义。
	 * 适合写大段代码、配置、文档。
	 */
	const writeFileTool = defineTool({
		name: "write_file",
		description: [
			"把一段内容写进一个文件（UTF-8）。路径相对于工作区根。",
			"用于写代码、配置、文档。写完文件存在了，不会自动起服务或跑测试。",
		].join(""),
		parameters: Type.Object({
			path: Type.String({ description: "文件路径（相对工作区根）" }),
			content: Type.String({ description: "文件内容" }),
		}),
		execute: async (args) => {
			const target = join(deps.workspaceRoot, args.path);
			await mkdir(dirname(target), { recursive: true });
			await writeFile(target, args.content, "utf8");
			return text(`已写入 ${args.path}（${args.content.length} 字）`);
		},
	});

	/**
	 * 读一个文件。
	 *
	 * 与 `read_channel` / `recall` 的差别：读的是文件系统上的任意文件，
	 * 不是频道消息或记忆。用于查看代码、配置、输出。
	 */
	const readFileTool = defineTool({
		name: "read_file",
		description: "读一个文件的内容（UTF-8，最多 8000 字）。路径相对于工作区根。",
		parameters: Type.Object({
			path: Type.String({ description: "文件路径（相对工作区根）" }),
		}),
		execute: async (args) => {
			const target = join(deps.workspaceRoot, args.path);
			const source = await readFile(target, "utf8").catch(() => undefined);
			if (source === undefined) return text(`文件不存在：${args.path}`);
			const trimmed = source.length > 8000 ? `${source.slice(0, 8000)}\n…（已截断，共 ${source.length} 字）` : source;
			return text(trimmed);
		},
	});

	return [
		say,
		readChannel,
		org,
		hire,
		updateIdentity,
		remember,
		recall,
		listSkillsTool,
		readSkillTool,
		writeSkillTool,
		listProjectsTool,
		readProjectTool,
		writeProjectTool,
		run,
		writeFileTool,
		readFileTool,
	] as readonly ToolRegistration[];
}


/** 组装一次投递的全部依赖（`say` 共用）。 */
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

/** 把执行结果记到个人频道（`kind:"work"`，不唤醒任何人）。 */
async function logWork(deps: CoreToolDeps, slug: string, report: string, ctx: Context): Promise<void> {
	try {
		const state = (await deps.harness.snapshot(ChannelDoc, ctx)) ?? { channels: {}, messages: {}, nextSeq: {}, readMarks: {} };
		const channelId = personalId(slug);
		await postMessage(
			postDeps(deps, state, ctx),
			{ channelId, from: slug, text: report, at: Date.now(), kind: "work", wake: false },
			ctx,
		);
	} catch { /* 记录失败不影响返回结果 */ }
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


