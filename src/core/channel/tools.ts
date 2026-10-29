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
 * | `read_history` | 翻自己被压缩掉的历史对话（精确原话/路径找回） |
 * | `list_skills` / `read_skill` / `write_skill` | 技能（怎么做一件事的说明书） |
 * | `list_projects` / `read_project` / `write_project` | 项目（`projects/<slug>/README.md`） |
 * | `run` / `write_file` / `read_file` | 执行命令 / 写文件 / 读文件 |
 *
 * 每一个工具返回**自然语言**，不是结构化数据 —— 工具的输出是给模型读的。
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import {
	BACKGROUND_CONTEXT,
	Type,
	defineTool,
	type Context,
	type Cursor,
	type EntryRecord,
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
import { redact } from "../agent/secrets.ts";
import { listProjects, readProject, writeProject } from "../project/doc.ts";
import { createAgent, renderIdentityFile, renderOrgChart } from "../agent/create.ts";
import { conversationFor, slugFor, wakeOf, type DirectoryState } from "../agent/roster.ts";
import { postMessage, type PostDeps } from "./post.ts";
import { mentionRosterOf, resolveMention, type MentionRoster } from "./alias.ts";
import { markSpoken, spokenResult } from "./speech.ts";
import {
	ChannelDoc,
	OWNER,
	channelsOf,
	ensureChannel,
	fallbackChannelId,
	parseMentions,
	personalId,
	readMarkOf,
	recipientsOf,
	unreadCount,
	type Channel,
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

/** 历史条目里一条消息的收窄视图（结构上只用得到这几个字段）。 */
type HistoryBlock = { readonly type?: string; readonly text?: string };
type HistoryModel = {
	readonly content?: string | readonly HistoryBlock[];
	readonly timestamp?: unknown;
};

/** 只取正文块：思考块不是「说过的话」，工具调用参数是过程不是结论。 */
function historyText(model: HistoryModel | undefined): string {
	if (model === undefined) return "";
	if (typeof model.content === "string") return model.content.replace(/\s+/g, " ").trim();
	const parts: string[] = [];
	for (const block of model.content ?? []) {
		if (block.type === "text" && typeof block.text === "string") parts.push(block.text);
	}
	return parts.join(" ").replace(/\s+/g, " ").trim();
}

/** 相对时间。模型要判断「这件事是刚说的还是很久以前」，绝对时间戳帮不上忙。 */
function agoOf(timestamp: unknown, now: number): string {
	const at =
		typeof timestamp === "number" ? timestamp : typeof timestamp === "string" ? Date.parse(timestamp) : Number.NaN;
	if (!Number.isFinite(at)) return "时间未知";
	const minutes = Math.round((now - at) / 60_000);
	if (minutes < 1) return "刚刚";
	if (minutes < 60) return `${minutes} 分钟前`;
	const hours = Math.round(minutes / 60);
	if (hours < 24) return `${hours} 小时前`;
	const days = Math.round(hours / 24);
	if (days < 30) return `${days} 天前`;
	return new Date(at).toISOString().slice(0, 10);
}

/** 这个工具调用属于哪个 slug。名册里找不到就给一句明确的错误。 */
async function selfOf(deps: CoreToolDeps, conversationId: number, context: Context): Promise<string | undefined> {
	const directory = await deps.directory(context);
	return slugFor(directory, conversationId);
}

/**
 * 「默认在哪儿说话」：刚被叫醒的那个频道 → 我所在的非个人频道里最近活跃的那个 → 我的个人频道。
 *
 * 第一条最重要：老板在私聊里问我一句，我一开口就该回私聊，而不是群里。
 * 最后一级**不能直接拿 `mine[0]`**：那可能正是我和老板的私聊，于是老板在群里问的话被答进私聊。
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
	// 兜底：非个人频道优先，个人频道最后。
	return { channelId: fallbackChannelId(state, slug) };
}

/**
 * 这一轮除了我，还有哪些 agent 被**同一条**消息叫醒。
 *
 * 判据取自名册里的唤醒记录（`wakeOf`，由投递层在成功投递时写入），再用
 * `recipientsOf` 重算一次收件人 —— 和投递层用的是同一个纯函数，不会两处口径不一致。
 *
 * 老板不算：他不是一个会接着说话的 agent。
 */
async function othersAwoken(
	deps: CoreToolDeps,
	state: ChannelState,
	conversationId: number,
	slug: string,
	context: Context,
): Promise<string[]> {
	const directory = await deps.directory(context);
	const wake = wakeOf(directory, conversationId);
	if (wake === undefined) return [];
	const channel = state.channels[wake.channelId];
	if (channel === undefined) return [];
	const message = (state.messages[channel.id] ?? []).find((item) => item.seq === wake.seq);
	// 找不到那条消息时保守一点：频道里只要还有别的 agent，就当有人接得住 ——
	// 宁可让一句无话不说的话被放过，也不要因为一次读不到而把他卡在第 1 条消息上。
	const candidates =
		message === undefined
			? channel.members
			: recipientsOf(channel, message);
	return candidates.filter((member) => member !== slug && member !== OWNER);
}

/** 当前名册：`@` 别名解析用。每次现读盘（`say` 不是热路径，且改 `identity.md` 要立刻生效）。 */
async function mentionRoster(deps: CoreToolDeps): Promise<MentionRoster> {
	const all = await readAllIdentities(deps.agentsRoot);
	return mentionRosterOf(
		all.map((identity) => ({
			slug: identity.slug,
			name: identity.name,
			title: identity.title,
			manager: identity.manager,
		})),
	);
}

/**
 * 拿到（必要时建出）两个人之间的私聊频道。
 *
 * 为什么要有这条：实测「员工↔员工」的发言只有全部 agent 发言的 1.2%，而组织里明明
 * 有该对接的事（音效要问开发、平台要问负责人）。根因不是模型不想说，是**没有地方说** ——
 * `dm:owner-X` 的成员只有老板和 X，X 想找另一个同事只能跑去群里喊，而群里的喊话又会
 * 把不相干的人叫醒。所以给一条只装两个人的频道。
 *
 * 和老板的「私聊」不新建：老板的个人频道 `dm:owner-<slug>` 本来就是那条。
 * 频道 id 用排序后的 slug 拼接，所以 A 找 B 和 B 找 A 是同一条，不会长出两条平行对话。
 */
async function ensureDm(
	deps: CoreToolDeps,
	state: ChannelState,
	from: string,
	to: string,
	context: Context,
): Promise<string> {
	if (to === OWNER_SLUG) return personalId(from);
	if (from === OWNER_SLUG) return personalId(to);
	const id = `dm:${[from, to].sort().join("--")}`;
	if (state.channels[id] !== undefined) return id;
	const all = await readAllIdentities(deps.agentsRoot);
	const nameOf = (slug: string): string => all.find((identity) => identity.slug === slug)?.name ?? slug;
	await deps.harness.commit(async (tx) => {
		const doc = await tx.doc(ChannelDoc);
		const current = doc as ChannelState;
		if (current.channels[id] !== undefined) return;
		Object.assign(
			doc,
			ensureChannel(current, {
				id,
				title: `${nameOf(from)} · ${nameOf(to)}`,
				members: [from, to],
				// 两边互相唤醒：私聊里没有第三方，不存在「叫醒一堆人」的风险。
				wakeOnAll: [from, to],
				at: Date.now(),
			}),
		);
	}, context);
	return id;
}

/**
 * 读一份频道状态。
 *
 * **必须用 `BACKGROUND_CONTEXT` 读，不能用工具自己的 `ctx`。**
 *
 * 踩过这个坑，症状是「一条消息发两遍」：`say` 用工具 ctx 读快照，紧接着又用同一个
 * ctx 提交；提交一结束，那份读覆盖层就被释放了，而 `postMessage` 在提交**之后**还要读
 * `channel.members` 去算收件人 —— 于是抛 `Cannot use a settled overlay`。消息其实已经
 * 落库，模型看到报错以为没发出去，再发一次，频道里就出现两条一模一样的话。
 *
 * 用背景上下文读拿到的是已提交的数据；这几个工具都是「先读、再提交」，读的时候还没有
 * 本次写入，语义完全一样，但读到的对象不会随提交失效。
 */
async function readState(deps: CoreToolDeps): Promise<ChannelState> {
	return (await deps.harness.snapshot(ChannelDoc, BACKGROUND_CONTEXT)) ?? EMPTY_STATE;
}

/** 空状态常量：只读，不要改。 */
const EMPTY_STATE: ChannelState = { channels: {}, messages: {}, nextSeq: {}, readMarks: {} };

/** 建工具。返回一个扩展，装进所有 agent 的会话里。 */
export function createCoreTools(deps: CoreToolDeps) {
	const say = defineTool({
		name: "say",
		description:
			"在当前频道说话。不传 mention 就是一句普通发言（正文里写 @某人 才会叫醒他）；传 mention 就是提问或 @ 某人（会叫醒他）。用于汇报进度、说明结论、回应别人、提问。活干完了一定要汇报，并把上级写进 mention —— 没人知道你做完了，等于没做完。",
		parameters: Type.Object({
			text: Type.String({
				description:
					"要说的话。**像同事发消息：一两句，说结论** —— 不写小标题、不列清单、不总结你刚做了什么（`run` 的过程不用复述）。" +
					"这一轮没有新东西要说就写 `[PASS]`，系统不会发出去（但如果这一轮只有你被叫醒，PASS 会被拒绝）。",
			}),
			step: Type.Optional(
				Type.Boolean({
					description:
						"`true` = 这只是过程话（「我正在改」「找到原因了」），可以连着说几句，不算这一轮的结论；不传 = 结论，**一轮只认一句**，第二句会被拒。干活中途想让人知道进展就用这个。",
				}),
			),
			mention: Type.Optional(Type.String({ description: "@ 谁，写名字或 slug（`@老板` / `@CEO` / `@张三` / `@zhangsan` 都行，系统会解析成 slug）。**不要凭印象编 slug** —— 名字报错比 @ 错人好。带上会叫醒他，适合提问或需要别人拍板。不知道 @ 谁就写你上级的 slug。" })),
			channel: Type.Optional(Type.String({ description: "频道 id，省略则回刚被叫醒的那个频道。要发给不在这个频道的人（另一个频道里的同事，或你在私聊里想找人），用 `<频道 id>` 指定，或先问老板 —— 频道成员以外的人 @ 不到。" })),
			to: Type.Optional(Type.String({ description: "把这句话**私下**发给某个人（写名字或 slug）。系统会自动建出只有你们两人的私聊频道，别人看不到。要对接同事、找上级问一句细节、向老板单独汇报，都用这个 —— 不要为了找一个人去群里喊。" })),
			replyTo: Type.Optional(Type.Number({ description: "要引用回复的消息序号" })),
			kind: Type.Optional(
				Type.Union([Type.Literal("decision"), Type.Literal("report")], {
					description:
						"给这条消息打标签：decision = 拍了板（结论、约定、定了怎么做）；report = 交付了什么。标签是给人的线索（谁拍板、谁交付），不影响沉淀——项目频道里所有新消息都会被送去整理。普通发言不要传。",
				}),
			),
		}),
		execute: async (args, api, context) => sayUnlocked(args, api, context ?? BACKGROUND_CONTEXT),
	});

	const sayUnlocked = async (
		args: { text: string; mention?: string; channel?: string; to?: string; replyTo?: number; kind?: "decision" | "report"; step?: boolean },
		api: { conversationId: string | number },
		ctx: Context,
	): Promise<ReturnType<typeof text>> => {
			const slug = await selfOf(deps, Number(api.conversationId), ctx);
			if (slug === undefined) return text("你还不在名册里。先用 org 看看情况，或请上级重新登记你。");
				// 通信规则：非老板不得私聊（to），其余沟通走群聊；老板本人不受限。
				if (slug !== OWNER && args.to !== undefined && args.to.trim() !== "") {
					return text("仅老板可私聊；项目的事发本项目群，跨项目发公司群，其余沟通请勿私聊（去掉 to，改用 channel 或 @ 某人）。");
				}
			// 一条频道消息最多 1200 字。
			//
			// 线上见过 21,568 字的一条 `say` —— 那不是在说话，是把整个思考过程倒进频道。
			// 长内容有它的地方（项目文件、记忆、审查记录），频道里只放结论和路径。
			if (args.text.length > SAY_LIMIT) {
				return text(
					`太长了：${args.text.length} 字，一条消息最多 ${SAY_LIMIT} 字。频道里只放结论，` +
						"把过程或整份内容写进项目文件，再发一句结论加路径。",
				);
			}
			// 内心独白不是发言。
			//
			// 规矩里早写了「不用英文写内心独白」，但模型该写还是写（线上 46% 的发言是英文）。
			// 这一条必须由代码拦：贴出去的每一句都会出现在老板眼前，靠自觉等于没拦。
			const monologue = monologueOpener(args.text);
			if (monologue !== undefined) {
				return text(
					`这条没发出去：它以「${monologue}」开头，英文占多数 —— 那是你的思考，不是对别人说的话。` +
						"思考用 think；要对人说话就用中文写结论（谁、做了什么、结果、下一步）。重写一遍。",
				);
			}
			let state = await readState(deps);

			// 「这一轮我不说」—— 但不是随时都能不说。
			//
			// 独享一个频道的人 PASS 掉，等于老板问了一句什么都没收到：那不是安静，是断线。
			// 所以 PASS 只在「这一轮还有别的 agent 被同一条消息叫醒」时成立。
			if (isPass(args.text)) {
				const others = await othersAwoken(deps, state, Number(api.conversationId), slug, ctx);
				if (others.length === 0) {
					return text(
						"这一轮只有你被叫醒，没有别人接得住，所以不能 PASS。把结论写出来：" +
							"谁、做了什么、卡在哪、下一步。几十个字就够，不要写报告。",
					);
				}
				return text(`这一句不说了（这一轮还有 ${others.join("、")} 在）。`);
			}

			// 一轮只说一句结论。第二句要补的是过程，不是又一篇结论。
			//
			// ds-bot 靠「回合末只交一次结果」做到这件事（`turns.js:532`）；我们没有那个
			// 钩子，就在工具层拒第二次 —— 效果一样：模型没法在一轮里堆三段结论。
			const conversationId = Number(api.conversationId);
			if (args.step !== true) {
				const previous = spokenResult(conversationId);
				if (previous !== undefined) {
					const head = previous.length > 40 ? `${previous.slice(0, 40)}…` : previous;
					return text(
						`这一轮你已经说过结果了：「${head}」。\n` +
							"要让人知道进展就再发一次、带上 step: true（「正在改，几分钟」）；" +
							"要补新的结论，等别人说完再来 —— 一轮里堆两段结论就不是聊天了。",
					);
				}
			}

			const target = await defaultChannel(deps, state, slug, conversationId, args.channel, ctx);
			if ("error" in target) return text(target.error);
			const roster = await mentionRoster(deps);

			// 「私下发给某个人」：频道换成两人的私聊（必要时现建），@ 也自动补上。
			let channelId = target.channelId;
			let privateTo: string | undefined;
			if (args.to !== undefined && args.to.trim() !== "") {
				const typed = args.to.trim().replace(/^@/, "");
				const who = resolveMention(typed, roster) ?? typed;
				if (who !== OWNER_SLUG) {
					const all = await readAllIdentities(deps.agentsRoot);
					if (!all.some((identity) => identity.slug === who)) {
						const names = all.map((identity) => identity.slug).join("、");
						return text(`公司里没有「${typed}」。可以发给：${names}（或 owner 给老板）。`);
					}
				}
				if (who === slug) return text("不用私聊自己。");
				channelId = await ensureDm(deps, state, slug, who, ctx);
				privateTo = who;
				// 频道是刚刚建出来的：`postMessage` 用的是下面这份快照，不重新取就会「频道不存在」。
				state = await readState(deps);
			}
			const targetChannel = state.channels[channelId] ?? state.channels[target.channelId];

			// 带 mention：验证成员、补 @ 前缀、默认 kind=question。
			// `@老板` / `@CEO` 这类叫法要先解析成 slug，否则成员校验会直接报「没有这个人」。
			let messageText = args.text;
			let kind: string | undefined = args.kind;
			if (args.mention !== undefined && args.mention !== "") {
				const channel = targetChannel;
				const typed = args.mention.replace(/^@/, "");
				const who = resolveMention(typed, roster) ?? typed;
				if (channel === undefined || !channel.members.includes(who)) {
					const available = channel?.members.join("、") ?? "";
					return text(`「${channel?.title ?? target.channelId}」里没有「${typed}」。可以 @：${available}`);
				}
				messageText = parseMentions(args.text, roster).includes(who) ? args.text : `@${who} ${args.text}`;
				kind = args.kind ?? "question";
			}

			// 要老板拍板：仅两种情形把 owner 加进 mentions（**不改正文**）：
			//  1) 消息显式 @了老板（messageText 里的 @owner/@老板 已由 parseMentions 解析命中）；
			//  2) 消息是「决策」类（kind=decision），且**没有明确点别人**。
			// 旧逻辑还用「要不要/请确认/等你定」等关键词嗅探正文，会把普通 @同事 的协作消息
			// 误标「需要我」并塞进 owner —— 这一条关键词嗅探已在 #4 移除。
			//
			// `decision` 曾经无条件叫老板，于是「@知言 … 要不要做，你和老板定」这种
			// 内部结论也被塞进「N 件找你」。老板的原话：「明明他们 at 的别人，跟我有什么关系」。
			// 判据与「找你」列表一致：明确点了别人而没点老板的，就不是找老板的。
			const typedMentions = parseMentions(messageText, roster);
			const addressedOthers =
				targetChannel === undefined
					? []
					: typedMentions.filter(
							(slug) => slug !== OWNER && targetChannel.members.includes(slug),
						);
			const wakeOwner =
				kind === "decision" ? addressedOthers.length === 0 : typedMentions.includes(OWNER);
			// 私聊里对方一定被叫醒（wakeOnAll 已经兜住），但要确保 `mentions` 里有他 ——
			// 界面的「@ 我」红点、未读口径都读这个字段。
			const privateMention =
				privateTo !== undefined && privateTo !== OWNER && !parseMentions(messageText, roster).includes(privateTo)
					? [privateTo]
					: [];

			const result = await postMessage(
				postDeps(deps, state, ctx),
				{
					channelId,
					from: slug,
					text: messageText,
					at: Date.now(),
					...(args.replyTo === undefined ? {} : { replyTo: args.replyTo }),
					...(kind === undefined ? {} : { kind }),
					...(args.step === true ? { step: true } : {}),
					roster,
					...((() => {
						const extra = [...(wakeOwner ? [OWNER] : []), ...privateMention];
						return extra.length === 0 ? {} : { mention: extra };
					})()),
				},
				ctx,
			);
			// 并进上一条时不算「这一轮说过结论」（它本来就是过程话）。
			if (args.step !== true) markSpoken(conversationId, args.text);
			if (deps.afterPost !== undefined) await deps.afterPost(result.message, channelId, ctx);
			if (result.merged === true) {
				return text(
					`并进了「${result.channel.title}」#${result.message.seq}（30 秒内连着说的过程话算一段，没有重复叫人）。`,
				);
			}
			const woke = result.delivery.delivered;
			return text(
				`已发到「${result.channel.title}」#${result.message.seq}。${
					woke.length === 0 ? "没有人被唤醒（这只是一句话）。" : `已唤醒：${woke.join("、")}。`
				}`,
			);
		};

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
			const state = await readState(deps);

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
			manager: Type.Optional(Type.String({ description: "上级的 slug，必须是名册里已有的人；不确定就不传，缺省是你自己" })),
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
			const manager = args.manager ?? self ?? OWNER_SLUG;
			const known = new Set((await readAllIdentities(deps.agentsRoot)).map((item) => item.slug));
			known.add(OWNER_SLUG);
			if (!known.has(manager)) {
				return text(`没有这个上级：${manager}。现有 slug：${[...known].join("、")}。不传 manager 就是你自己（${self ?? OWNER_SLUG}）。`);
			}
			const identity = await createAgent({
				root: deps.agentsRoot,
				name: args.name,
				...(args.title === undefined ? {} : { title: args.title }),
				manager,
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
			doing: Type.Optional(
				Type.String({ description: "一句话现状（谁在做什么），显示在项目频道顶栏；不传 = 保留原值" }),
			),
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
					// 不传 doing 时 doc.ts 会沿用文件里已有的 —— 这里不替它编。
					...(args.doing === undefined ? {} : { doing: args.doing }),
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
			// 密钥不能靠模型自觉：它写下来的时候并不觉得那是泄密。落盘前先把真值换掉。
			const body = redact(args.text, deps.workspaceRoot);
			if (args.scope === "project") {
				const self = await readIdentity(deps.agentsRoot, slug);
				const project = args.project ?? self?.project;
				if (project === undefined) return text("我不在任何项目里。要记项目的事，先说清是哪个项目。");
				await appendProjectMemory(deps.projectsRoot, project, { text: body, by: slug });
				const confirmed = await confirmedBy(deps.harness, project, ctx);
				const tail = confirmed === 0 ? "" : `（已把 #${confirmed} 之前的结论标记为已沉淀）`;
				return text(`已记进项目「${project}」的记忆${tail}。下一条消息就会出现在这个项目的记忆目录里。`);
			}
			await appendMemory(join(deps.agentsRoot, slug), body, new Date(), "remember");
			return text("已记下。下一条消息的记忆目录里就会出现它。");
		},
	});

	/** 一行最多多少字、一次最多回多少字。与 `clip` 同一个理由：宁可多翻一次，不要一次塞爆上下文。 */
	const HISTORY_LINE = 400;
	const HISTORY_BUDGET = 8000;
	const HISTORY_PAGE = 64;
	const HISTORY_PAGES = 8;

	/**
	 * 翻自己的历史。
	 *
	 * 为什么必须有这个工具：上下文压缩是 pi-durable 的默认行为，压成 `pi.compaction`
	 * 条目之后，原文还在 storage 里，但**模型再也看不见了，也没任何办法读回**。
	 * 于是它只能凭记忆补路径、补数字、补原话 —— 看起来很像，可能是错的，而且
	 * 错得无法被发现。这把记忆能不能查询变成了可以查询。
	 *
	 * 分页走 `projector.ts` 那套 cursor：一次 64 条，从新往回扇。
	 */
	const readHistory = defineTool({
		name: "read_history",
		description: [
			"查你自己这个会话过去说过的话（上下文被压缩掉的部分也查得到）。",
			"上下文被压缩过之后，早先的原文不在眼里了。要写精确的路径、数字、原话，先用它查，不要凭记忆补。",
			"不给参数 = 最近 12 条；给 query 按关键词找；给 around=<行首的 #id> 从那条往前翻。",
		].join(""),
		parameters: Type.Object({
			query: Type.Optional(Type.String({ description: "关键词（不区分大小写）。给了就只留包含它的条目" })),
			around: Type.Optional(Type.Number({ description: "条目 id（输出里每行开头的 #号就是）。从这条往前取" })),
			limit: Type.Optional(Type.Number({ description: "最多几条，默认 12，上限 50" })),
		}),
		execute: async (args, api, context) => {
			const ctx = context ?? BACKGROUND_CONTEXT;
			const wanted = Math.min(Math.max(Math.trunc(args.limit ?? 12), 1), 50);
			const keyword = (args.query ?? "").trim().toLowerCase();
			const conversation = await deps.harness.conversation(Number(api.conversationId) as never, ctx);
			if (conversation === undefined) return text("这个会话还没有任何记录。");
			const now = Date.now();
			const found: { id: number; line: string }[] = [];
			let cursor: Cursor | undefined;
			let exhausted = false;
			let enough = false;
			// 多取一条：只有拿到「第 limit+1 条」才知道后面确实还有更早的。
			for (let index = 0; index < HISTORY_PAGES && found.length <= wanted; index += 1) {
				const page = await conversation.entries(
					{
						order: "descending",
						...(args.around === undefined ? {} : { maxEntryId: (args.around - 1) as never }),
					},
					HISTORY_PAGE,
					cursor,
					ctx,
				);
				if (page === undefined || page.items.length === 0) break;
				for (const entry of page.items as readonly EntryRecord[]) {
					if (entry.kind !== "pi.user" && entry.kind !== "pi.assistant" && entry.kind !== "pi.compaction") continue;
					const model = entry.model?.[0] as HistoryModel | undefined;
					const body = historyText(model);
					if (body === "") continue;
					const speaker = entry.kind === "pi.compaction" ? "[压缩摘要]" : entry.kind === "pi.user" ? "对方" : "你";
					const clipped = body.length > HISTORY_LINE ? `${body.slice(0, HISTORY_LINE)}…` : body;
					const line = `[#${entry.id} ${agoOf(model?.timestamp, now)}] ${speaker}: ${clipped}`;
					if (keyword !== "" && !line.toLowerCase().includes(keyword)) continue;
					found.push({ id: Number(entry.id), line });
					if (found.length > wanted) {
						// 够数了：这一页没扫完，也就不能断言「没有更早的了」。
						enough = true;
						break;
					}
				}
				if (enough || page.next === undefined) {
					exhausted = page.next === undefined && !enough;
					break;
				}
				cursor = page.next;
			}
			if (found.length === 0) return text("这个会话里没有匹配的记录。");
			// 新→旧累加，超预算就停：给的是「最近的一段」，不是「全部」——
			// 历史的价值在于能接着往前翻，不在于一次全拿出来。
			const lines: string[] = [];
			let used = 0;
			for (const item of found) {
				if (lines.length >= wanted || used + item.line.length + 1 > HISTORY_BUDGET) break;
				lines.push(item.line);
				used += item.line.length + 1;
			}
			const oldest = found[lines.length - 1];
			const more = found.length > lines.length || (lines.length >= wanted && !exhausted);
			const tail = more && oldest !== undefined ? `\n\n还有更早的，用 around=${oldest.id} 继续往前。` : "";
			return text(`${lines.join("\n")}${tail}`);
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
			"不要用 `sleep` 等别人：别人做完会在频道里说话并叫醒你，等消息来找你，别去追消息。",
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
			const result = await new Promise<{ stdout: string; stderr: string; code: number | null; tooMuch: boolean }>(
				(resolve) => {
					exec(command, { cwd, timeout: seconds * 1000, maxBuffer: 512 * 1024 }, (error, stdout, stderr) => {
						resolve({
							stdout: stdout.toString(),
							stderr: stderr.toString(),
							code: error === null ? 0 : error.code ?? -1,
							tooMuch: (error as { code?: string } | null)?.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER",
						});
					});
				},
			);

			const buffer = [
				`$ ${command}`,
				...(result.stdout.trim() === "" ? [] : [result.stdout.trim()]),
				...(result.stderr.trim() === "" ? [] : [`[stderr] ${result.stderr.trim()}`]),
				...(result.tooMuch ? ["（输出超过 512 KB，后面的被丢弃）"] : []),
				`(退出码 ${result.code})`,
			].join("\n");
			// 两处都要剪，但剪的尺度不同：
			// - 落进个人频道的那一条是给人看的，留头尾、中间省掉；
			// - 回给模型的是它继续干活要用的，给得宽一些，但**绝不能全量**：
			//   一次跑整个测试套件就能把 512 KB 塞进上下文，后面几轮全在付费读它。
			await logWork(deps, slug, clip(buffer, CHANNEL_LIMIT), ctx);
			return text(clip(buffer, MODEL_LIMIT));
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
			"不能写工作区以外的路径（`../` 会被拒绕）。",
			"用于写代码、配置、文档。写完文件存在了，不会自动起服务或跑测试。",
		].join(""),
		parameters: Type.Object({
			path: Type.String({ description: "文件路径（相对工作区根）" }),
			content: Type.String({ description: "文件内容" }),
		}),
		execute: async (args) => {
			const target = resolveInWorkspace(deps.workspaceRoot, args.path);
			if (target === undefined) return text(`路径在工作区之外：${args.path}`);
			// 同上：密钥一旦落进 identity.md / SKILL.md，就永久进了每一轮提示词的 system 段。
			const content = redact(args.content, deps.workspaceRoot);
			await mkdir(dirname(target), { recursive: true });
			await writeFile(target, content, "utf8");
			return text(`已写入 ${args.path}（${content.length} 字）`);
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
		description: [
			"读一个文件的内容（UTF-8，最多 8000 字）。路径相对于工作区根。",
			"不能读工作区以外的路径。",
		].join(""),
		parameters: Type.Object({
			path: Type.String({ description: "文件路径（相对工作区根）" }),
		}),
		execute: async (args) => {
			const target = resolveInWorkspace(deps.workspaceRoot, args.path);
			if (target === undefined) return text(`路径在工作区之外：${args.path}`);
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
		readHistory,
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

/**
 * 一条 `run` 输出落进个人频道的长度上限。
 *
 * 这个数字同时是「消息存多大」与「界面上一个折叠块展开有多长」。
 */
const CHANNEL_LIMIT = 3_000;

/** 一条 `say` 的上限。不是「存不下」，是「不该在频道里说这么多」。 */
const SAY_LIMIT = 1_200;

/**
 * 「这一轮我不说」。
 *
 * 抄自 ds-bot 的 `[PASS]`（`groups.js:81` 的 `isPass`）：那里「不说话」是合法结果，
 * 轮次照常往下走。**每轮必须产出一条消息，模型就会拿思维草稿去填空** —— 线上 46%
 * 的英文独白、大量「收到」都是这么来的。给一个合法的静音出口，那些消息才会消失。
 *
 * 空正文也算 PASS：模型直接不调 `say` 本来就已经是「这一轮不说话」了，两件事应当等价。
 */
export function isPass(text: string): boolean {
	if (text.trim() === "") return true;
	return /^\s*(?:[\[【(（]\s*pass\s*[\]】)）]|pass)\s*[.。!！]?\s*$/iu.test(text);
}

/** 「这是内心独白，不是发言」的开头。模型用英文自言自语时有固定套路，抓得住。 */
const MONOLOGUE_OPENERS = [
	"let me",
	"let's",
	"now i",
	"now let",
	"i'll",
	"i will",
	"i need to",
	"i should",
	"i can",
	"i have to",
	"i think",
	"okay,",
	"ok,",
	"then i",
	"first,",
	"next,",
	"hmm",
	"looking at",
	"so the",
];

/**
 * 判断一段 `say` 是不是模型在把「思考」当「发言」倒出来。
 *
 * 证据来自线上：agent 1136 条发言里 46% 是英文（苏澄 96%、温言 92%），长度中位数 195 字
 * 而老板是 15 字。老板的原话是「根本不像正常人之间沟通」。
 *
 * 判据必须两道一起过，单看哪一道都会误伤：
 * - **以第一人称计划开头**（`Let me…` / `Now I'll…` / `I need to…`）—— 中文正文里夹英文
 *   文件名、报错、代码不会这么开头，所以不会被打中；
 * - **而且英文占绝对多数**（按「英文字母 vs 汉字」算比例，不看字符总数：代码块里全是 ASCII）。
 *
 * 返回命中的开头（给模型看，让它知道被哪句话出卖了），不认识就返回 `undefined`。
 */
export function monologueOpener(text: string): string | undefined {
	const head = text.trimStart().slice(0, 40).toLowerCase();
	const opener = MONOLOGUE_OPENERS.find((candidate) => head.startsWith(candidate));
	if (opener === undefined) return undefined;
	let latin = 0;
	let han = 0;
	for (const char of text) {
		if (/[A-Za-z]/.test(char)) latin += 1;
		else if (/\p{Script=Han}/u.test(char)) han += 1;
	}
	// 英文占「英文字母 + 汉字」的 70% 以上才算独白；中文汇报里夹几个英文词不算。
	if (latin + han < 40) return undefined;
	return latin / (latin + han) >= 0.7 ? opener : undefined;
}

/** 回给模型的输出上限。比频道宽（它要继续干活），但远小于一次大测试的完整输出。 */
const MODEL_LIMIT = 8_000;

/**
 * 把长文本剪成「头 + 省略标记 + 尾」。
 *
 * 为什么留尾巴而不是只留头：被剪的几乎都是命令输出，而命令输出的重点在**结尾**
 * （测试摘要、报错栈、退出状态）。只留头会得到一段滚过去的日志和一个看不见的结论。
 */
export function clip(source: string, limit: number): string {
	if (source.length <= limit) return source;
	// 省略标记本身也占长度，所以先把它定下来再分头尾 —— 输出因此**不超过** `limit`，
	// 于是「已经剪过的文本再剪一次」原样返回（幂等）。否则每过一层就再塌一截。
	const marker = `\n…（原文 ${source.length} 字，中间省略）…\n`;
	const room = Math.max(limit - marker.length, 2);
	const head = Math.floor(room / 4);
	const tail = room - head;
	return `${source.slice(0, head)}${marker}${source.slice(source.length - tail)}`;
}

/**
 * 把一个「相对工作区根」的路径解成绝对路径，越界返回 `undefined`。
 *
 * 为什么拦：agent 有 `run`（shell），真想做坏事拦不住 —— 这里拦的不是恶意，是
 * **写错**。`../../agents/别人/identity.md` 这种路径通常是它对自己所在层级搞错了，
 * 默默写到别人文件夹里比报错更难查。另外静态文件服务本来就有同样的越界判断，
 * 两处规则一致，读代码的人不用猜「这里到底拦不拦」。
 */
export function resolveInWorkspace(root: string, path: string): string | undefined {
	const base = resolve(root);
	const target = resolve(base, path);
	if (target === base) return target;
	return target.startsWith(base + sep) ? target : undefined;
}

/**
 * 这条命令日志该不该落到频道里。
 *
 * 不该的情况只有一个但非常要紧：**老板的私聊**。`personalId(slug)` 在老板那里就是
 * `dm:owner-<slug>` —— 同一个频道。于是 `run` 每跑一条命令就往老板的对话里塞一行
 * `$ cd /Users/kirer/projects/...`，实测一个私聊里能堆到几百条，老板回复率因此掉到 1%
 * 量级（ADR-040 的审计数字）。投影管道那条闸（`keptProjections`）只拦投影，
 * 拦不住这里直接写的一条。
 *
 * 命令输出不丢：`run` 的返回里本来就有全文，agent 要看自己翻；老板要看用 `read_channel`。
 * 抽成纯函数是为了能被直接验 —— 这条规则错了的表现是「私聊又变成日志墙」，
 * 需要真模型跑到才看得出来。
 */
export function shouldLogWork(channel: Channel | undefined): boolean {
	if (channel === undefined) return false;
	return !(channel.id.startsWith("dm:") && channel.members.includes(OWNER));
}

/** 把执行结果记到个人频道（`kind:"work"`，不唤醒任何人）。老板的私聊除外。 */
async function logWork(deps: CoreToolDeps, slug: string, report: string, ctx: Context): Promise<void> {
	try {
		const state = await readState(deps);
		const channelId = personalId(slug);
		if (!shouldLogWork(state.channels[channelId])) return;
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
	// 附件要在历史里留下痕迹：不然补看历史的人不知道那条消息带过图，会以为对方在说空话。
	const files = (message.attachments ?? []).map((item) =>
		item.kind === "image" ? `[图片 ${item.name} · uploads/${item.id}]` : `[文件 ${item.name} · uploads/${item.id}]`,
	);
	const suffix = files.length === 0 ? "" : ` ${files.join(" ")}`;
	return `#${message.seq} ${time} ${message.from}${mentions}：${quoted}${message.text}${suffix}`;
}


