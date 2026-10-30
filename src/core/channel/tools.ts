/**
 * 全部工具：**只有一套，人人都有。**
 *
 * 这里没有「管理层工具」「员工工具」「团队管理员工具」的分层。按岗位发工具包来实现
 * 「员工不能越级」，代价是：调一个岗位就要改代码重新部署，而「谁能做什么」
 * 本来该写在身份里。
 *
 * 七个工具，按「做一件事」划分，不按「谁配用」划分。同一件事的几种做法用一个
 * 工具的 `action` 枚举，而**不是**几个近义的工具名 —— 名字越多，模型选错的概率越高。
 *
 * | 工具 | 用途 |
 * |---|---|
 * | `say` | 在频道说一句；带 `mention` 就是提问并叫醒对方 |
 * | `chats` | `list` 列我在的会话和未读；`read` 读历史消息 |
 * | `read_history` | `scope=channel` 翻自己的对话（含压缩掉的）；`scope=memory` 翻记忆 |
 * | `remember` | 记一条经验（个人 / 团队） |
 * | `hire` | 新建一个 agent（写文件夹） |
 * | `run` | 执行命令 |
 * | `file` | `read` / `write` 工作区里的一个文件 |
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
import { OWNER_SLUG, readAllIdentities, readIdentity } from "../agent/identity.ts";
import { appendMemory, readMemory, sectionsOf } from "../agent/memory.ts";
import { redact } from "../agent/secrets.ts";
import { createAgent } from "../agent/create.ts";
import { conversationFor, slugFor, wakeOf, type DirectoryState } from "../agent/roster.ts";
import { postMessage, type PostDeps } from "./post.ts";
import { mentionRosterOf, resolveMention, type MentionRoster } from "./store.ts";
import {
	ChannelDoc,
	OWNER,
	channelsOf,
	chatKind,
	fallbackChannelId,
	markRead,
	parseMentions,
	recipientsOf,
	unreadCount,
	type ChannelState,
	type Message,
} from "./store.ts";
import { renderDigest } from "./post.ts";
import { promptDirOf } from "../prompt.ts";
import { oneLine } from "../oneline.ts";
import { confirmedBy } from "../team/settle.ts";
import {
	appendTeamMemory,
	teamMemorySections,
	readTeamMemory,
} from "../team/memory.ts";

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
	/** `workspace/teams`。 */
	readonly teamsRoot: string;
	/** 读名册（slug ↔ 会话）。 */
	readonly directory: (context: Context) => Promise<DirectoryState>;
	/** 落一次名册变更。 */
	readonly saveDirectory: (change: (state: DirectoryState) => DirectoryState, context: Context) => Promise<void>;
	/** 为某个 slug 建会话并绑定。缺省表示不支持热建（测试里可以不提供）。 */
	readonly openAgent?: (slug: string, context: Context) => Promise<number>;
	/**
	 * 一条消息落地之后的钩子。外壳用它接「团队记忆自动沉淀」。
	 *
	 * 为什么挂在工具层而不是频道层：沉淀要读 `agents/` 与 `teams/`，那是外壳的
	 * 视野；`channel/post.ts` 只认识频道文档，不该知道团队记忆存在。
	 */
	readonly afterPost?: (message: Message, channelId: string, context: Context) => Promise<void>;
	/**
	 * 按团队文件重建它的频道成员（幂等）。
	 *
	 * `write_team` 改了 `lead` 之后必须调一次：团队频道里的人是文档的投影，
	 * 不刷新的话，刚任命的团队管理员在团队频道里不存在，员工 @ 不到他。
	 */
	readonly syncTeam?: (team: string, context: Context) => Promise<void>;
};

/**
 * 工具的唯一出口：一段给模型读的自然语言。
 *
 * 也接受 `{ error }` —— `actionOf` / `defaultChannel` 这类「参数不合法」的结果直接
 * 丢进来就行，不用每个调用点再拆一次。
 */
function text(value: string | { readonly error: string }) {
	return { output: [{ type: "text" as const, text: typeof value === "string" ? value : value.error }] };
}

/**
 * 读一个枚举型参数。
 *
 * 校验失败时要把合法值列出来 —— 模型看到「只有 list / read」才知道下一步该改什么，
 * 只回一句「参数不合法」它就只能乱试。
 */
function actionOf(
	value: string | undefined,
	allowed: readonly string[],
	fallback: string,
	label = "action",
): string | { error: string } {
	if (value === undefined || value.trim() === "") return fallback;
	if (allowed.includes(value)) return value;
	return { error: `${label} 只有 ${allowed.join(" / ")}，没有「${value}」。` };
}

/**
 * 翻记忆全文（ADR-084 合并进来的那一半）。
 *
 * `team` 为空 = 翻自己的记忆，否则翻那个团队的记忆；`keyword` 为空 = 全文。
 */
async function recallText(deps: CoreToolDeps, slug: string, team: string | undefined, keyword: string) {
	if (team !== undefined && team !== "") {
		const target = team;
		const source = await readTeamMemory(deps.teamsRoot, target);
		if (source === undefined) return text(`团队「${target}」还没有记忆。`);
		if (keyword === "") return text(source);
		const sections = teamMemorySections(source).filter(
			(section) => section.heading.includes(keyword) || section.body.includes(keyword),
		);
		if (sections.length === 0) return text(`团队「${target}」的记忆里没有「${keyword}」。`);
		return text(sections.map((section) => `## ${section.heading}\n${section.body}`).join("\n\n"));
	}

	const source = await readMemory(join(deps.agentsRoot, slug));
	if (source === undefined) return text("我还没记过任何东西。");
	if (keyword === "") return text(source);
	const sections = sectionsOf(source).filter(
		(section) => section.heading.includes(keyword) || section.body.includes(keyword),
	);
	if (sections.length === 0) return text(`记忆里没有「${keyword}」。`);
	return text(sections.map((section) => `## ${section.heading}\n${section.body}`).join("\n\n"));
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
 * 「先知道自己是谁」：七个工具的第一句都是这件事，文案只在这里写一次。
 *
 * 查不到时返回一句能直接回给模型的话（工具不抛错：抛错它看到的是堆栈）。
 */
async function selfOrError(
	deps: CoreToolDeps,
	conversationId: number,
	context: Context,
	hint = "你还不在名册里。",
): Promise<string | { readonly error: string }> {
	const slug = await selfOf(deps, conversationId, context);
	return slug ?? { error: hint };
}

/**

/**
 * 「默认在哪儿说话」：刚被叫醒的那个频道 → 我是成员的群里最近活跃的那个 → 我和我的私聊。
 *
 * 第一条最重要：我在私聊里问我一句，我一开口就该回私聊，而不是群里。
 * 最后一级**不能直接拿 `mine[0]`**：那可能正是我和我的私聊，于是我在群里问的话被答进私聊。
 * 形态由 `fallbackChannelId` 按成员推导，不看 id 前缀。
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
	// 兜底：群聊优先。
	//
	// **落到私聊就拒绝**：没有唤醒记录 = 不知道这一轮是从哪儿被叫来的；此时把话写进
	// 我和我的私聊，问的人在原频道就什么都看不到（ADR-037 修过的老 bug）。宁可报一个
	// 看得见的错，也不静默放进私聊。
	const fallback = fallbackChannelId(state, slug);
	const target = state.channels[fallback];
	if (target === undefined || chatKind(target) === "dm") {
		return { error: "这一轮没有唤醒记录，不知道该回哪个频道。请显式给 channel（`chats` 能列出你在的频道）。" };
	}
	return { channelId: fallback };
}

/**
 * 这一轮除了我，还有哪些 agent 被**同一条**消息叫醒。
 *
 * 判据取自名册里的唤醒记录（`wakeOf`，由投递层在成功投递时写入），再用
 * `recipientsOf` 重算一次收件人 —— 和投递层用的是同一个纯函数，不会两处口径不一致。
 *
 * 我不算：他不是一个会接着说话的 agent。
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
			"在频道里说话：汇报结论、回应别人、提问。不带 mention 是一句普通发言（正文里写 @某人 才叫醒他）；带 mention 就一定会叫醒他。活干完必须汇报，并把上级写进 mention —— 没人知道你做完了，等于没做完。",
		parameters: Type.Object({
			text: Type.String({
				description:
					"要说的话。像成员发消息：一两句，说结论，不写小标题、不列清单、不复述过程。" +
					"这一轮没有新东西就说 `[PASS]`（这一轮只有你被叫醒时会被拒）。",
			}),
			step: Type.Optional(
				Type.Boolean({
					description:
						"`true` = 过程话（「正在改」「找到原因了」），可以连说几句，不算结论；不传 = 结论，一轮只认一句，第二句会被拒。",
				}),
			),
			mention: Type.Optional(Type.String({ description: "@ 谁，写名字或 slug（`@我` / `@CEO` / `@张三`）。不要凭印象编 slug；不知道 @ 谁就写上级。带上会叫醒他，适合提问或要别人拍板。" })),
			channel: Type.Optional(Type.String({ description: "频道 id，省略 = 我刚被叫醒的那个频道。不在那个频道里的人 @ 不到。" })),
			replyTo: Type.Optional(Type.Number({ description: "要引用回复的消息序号" })),
			kind: Type.Optional(
				Type.Union([Type.Literal("decision"), Type.Literal("report")], {
					description:
						"给这条消息打标签：decision = 拍了板（结论、定了怎么做）；report = 交付了什么。普通发言不要传。",
				}),
			),
		}),
		execute: async (args, api, context) => sayUnlocked(args, api, context ?? BACKGROUND_CONTEXT),
	});

	const sayUnlocked = async (
		args: { text: string; mention?: string; channel?: string; replyTo?: number; kind?: "decision" | "report"; step?: boolean },
		api: { conversationId: string | number },
		ctx: Context,
	): Promise<ReturnType<typeof text>> => {
			const slug = await selfOrError(deps, Number(api.conversationId), ctx, "你还不在名册里。先用 me 看看情况，或请上级重新登记你。");
			if (typeof slug !== "string") return text(slug);
			// 没有「私下发给谁」这个参数：私聊只能我开，agent 只能在已有的频道里说话。
			// 也不需要专门硬拦 ——「非成员发不进去」已经重定了这条边界。
			// 一条频道消息最多 1200 字。
			//
			// 线上见过 21,568 字的一条 `say` —— 那不是在说话，是把整个思考过程倒进频道。
			// 长内容有它的地方（团队文件、记忆、审查记录），频道里只放结论和路径。
			if (args.text.length > SAY_LIMIT) {
				return text(
					`太长了：${args.text.length} 字，一条消息最多 ${SAY_LIMIT} 字。频道里只放结论，` +
						"把过程或整份内容写进团队文件，再发一句结论加路径。",
				);
			}
			// 内心独白不是发言。
			//
			// 规矩里早写了「不用英文写内心独白」，但模型该写还是写（线上 46% 的发言是英文）。
			// 这一条必须由代码拦：贴出去的每一句都会出现在我眼前，靠自觉等于没拦。
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
			// 独享一个频道的人 PASS 掉，等于我问了一句什么都没收到：那不是安静，是断线。
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

			const conversationId = Number(api.conversationId);
			const target = await defaultChannel(deps, state, slug, conversationId, args.channel, ctx);
			if ("error" in target) return text(target);
			const roster = await mentionRoster(deps);
			const channelId = target.channelId;
			const targetChannel = state.channels[channelId];

			// 带 mention：验证成员、补 @ 前缀、默认 kind=question。
			// `@我` / `@CEO` 这类叫法要先解析成 slug，否则成员校验会直接报「没有这个人」。
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

			// 要我拍板：仅两种情形把 owner 加进 mentions（**不改正文**）：
			//  1) 消息显式 @了我（messageText 里的 @owner/@我 已由 parseMentions 解析命中）；
			//  2) 消息是「决策」类（kind=decision），且**没有明确点别人**。
			// 旧逻辑还用「要不要/请确认/等你定」等关键词嗅探正文，会把普通 @成员 的协作消息
			// 误标「需要我」并塞进 owner —— 这一条关键词嗅探已在 #4 移除。
			//
			// `decision` 曾经无条件叫我，于是「@知言 … 要不要做，你和我定」这种
			// 内部结论也被塞进「N 件找你」。我的原话：「明明他们 at 的别人，跟我有什么关系」。
			// 判据与「找你」列表一致：明确点了别人而没点我的，就不是找我的。
			const typedMentions = parseMentions(messageText, roster);
			const addressedOthers =
				targetChannel === undefined
					? []
					: typedMentions.filter(
							(slug) => slug !== OWNER && targetChannel.members.includes(slug),
						);
			const wakeOwner =
				kind === "decision" ? addressedOthers.length === 0 : typedMentions.includes(OWNER);

			const result = await postMessage(
				postDeps(deps, state, ctx),
				{
					channelId,
					from: slug,
					text: messageText,
					at: Date.now(),
					...(args.replyTo === undefined ? {} : { replyTo: args.replyTo }),
					...(kind === undefined ? {} : { kind }),
					roster,
					...((() => {
						const extra = wakeOwner ? [OWNER] : [];
						return extra.length === 0 ? {} : { mention: extra };
					})()),
				},
				ctx,
			);
			if (deps.afterPost !== undefined) await deps.afterPost(result.message, channelId, ctx);
			const woke = result.delivery.delivered;
			return text(
				`已发到「${result.channel.title}」#${result.message.seq}。${
					woke.length === 0 ? "没有人被唤醒（这只是一句话）。" : `已唤醒：${woke.join("、")}。`
				}`,
			);
		};

	/**
	 * 会话：列出来，或者读其中一个的历史。
	 *
	 * 两个分支（不传 channel = 摘要，传 = 读历史）合成一个工具的理由：仍是一件事，
	 * 看会话；所以留一个工具，用一个 `action` 区分。
	 */
	const chats = defineTool({
		name: "chats",
		description:
			"看会话。`action=list`（默认）列我在的会话：标题、群聊还是私聊、未读数、最后一条；`action=read` 读某个频道的历史消息（读完标已读）。想知道别人说了什么、翻上次的结论，都用它。",
		parameters: Type.Object({
			action: Type.Optional(Type.String({ description: "list（默认）列会话 / read 读消息" })),
			channel: Type.Optional(Type.String({ description: "频道 id。read 时省略 = 刚叫醒我的那个频道" })),
			since: Type.Optional(Type.Number({ description: "只要这个序号之后的消息（read）" })),
			limit: Type.Optional(Type.Number({ description: "最多几条，默认 30，上限 100" })),
		}),
		execute: async (args, api, context) => {
			const ctx = context ?? BACKGROUND_CONTEXT;
			const action = actionOf(args.action, ["list", "read"], "list");
			if (typeof action !== "string") return text(action);
			const slug = await selfOrError(deps, Number(api.conversationId), ctx, "你还不在名册里。");
			if (typeof slug !== "string") return text(slug);
			const state = await readState(deps);

			if (action === "list") {
				const digest = renderDigest(state, slug, 20);
				const rows = channelsOf(state, slug).map((channel) => {
					const unread = unreadCount(state, channel.id, slug);
					const list = state.messages[channel.id] ?? [];
					const last = list[list.length - 1];
					const preview =
						last === undefined ? "（还没有消息）" : `${last.from}: ${oneLine(last.text, 60)}`;
					return [
						`- ${channel.id}「${channel.title}」${chatKind(channel) === "dm" ? "私聊" : "群聊"}` +
							`${unread === 0 ? "" : ` · ${unread} 条未读`}（${channel.members.length} 人）`,
						`  ${preview}`,
					].join("\n");
				});
				const parts = [
					...(digest === "" ? [] : ["未读消息：", digest]),
					...(rows.length === 0 ? ["你不在任何频道里。"] : ["", "你的频道：", ...rows]),
				];
				return text(parts.join("\n"));
			}

			const target = await defaultChannel(deps, state, slug, Number(api.conversationId), args.channel, ctx);
			if ("error" in target) return text(target);
			const channel = state.channels[target.channelId];
			if (channel === undefined) return text("没有这个频道。");
			const limit = Math.min(Math.max(args.limit ?? 30, 1), 100);
			const list = state.messages[channel.id] ?? [];
			const pool =
				args.since === undefined ? list : list.filter((message) => message.seq > (args.since as number));
			const shown = pool.slice(Math.max(0, pool.length - limit));
			if (shown.length === 0) {
				return text(
					args.since === undefined
						? `「${channel.title}」里还没有消息。`
						: `「${channel.title}」在 #${args.since} 之后没有新消息。`,
				);
			}
			const last = shown[shown.length - 1];
			const lines = shown.map((message) => renderLine(message));
			if (last !== undefined) {
				await deps.harness.commit(async (tx) => {
					const doc = (await tx.doc(ChannelDoc)) as ChannelState;
					// 走 `markRead` 而不是直接写 `readMarks`：它会**把 seq 夹到频道真实上界**。
					// 直接写的话，一条越界的请求就能声明「以后全已读」，红点从此再也不出现。
					const marked = markRead(doc, slug, channel.id, last.seq);
					if (marked !== doc) doc.readMarks = marked.readMarks;
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
			team: Type.Optional(Type.String({ description: "所在团队 slug" })),
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
				...(args.team === undefined ? {} : { team: args.team }),
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

	const remember = defineTool({
		name: "remember",
		description: [
			"记一条经验。",
			"scope=personal（默认）写进你自己的记忆（agents/<我>/memory.md）；scope=team 写进所在团队的记忆（teams/<团队>/memory.md，带日期和你的名字）。",
			"写「下次遇到 X 该怎么做」这类可复用的判断，不要写流水账。",
		].join(""),
		parameters: Type.Object({
			text: Type.String({ description: "要记的东西。一句话说清一条，几条就调几次。" }),
			scope: Type.Optional(Type.String({ description: "personal（默认，自己的记忆）或 team（团队记忆）" })),
			team: Type.Optional(Type.String({ description: "团队 slug；scope=team 时用。默认是我所在的团队" })),
		}),
		execute: async (args, api, context) => {
			const ctx = context ?? BACKGROUND_CONTEXT;
			const slug = await selfOrError(deps, Number(api.conversationId), ctx, "你还不在名册里。");
			if (typeof slug !== "string") return text(slug);
			// 密钥不能靠模型自觉：它写下来的时候并不觉得那是泄密。落盘前先把真值换掉。
			const body = redact(args.text, deps.workspaceRoot);
			if (args.scope === "team") {
				const self = await readIdentity(deps.agentsRoot, slug);
				const team = args.team ?? self?.team;
				if (team === undefined) return text("我不在任何团队里。要记团队的事，先说清是哪个团队。");
				await appendTeamMemory(deps.teamsRoot, team, { text: body, by: slug });
				const confirmed = await confirmedBy(deps.harness, team, ctx);
				const tail = confirmed === 0 ? "" : `（已把 #${confirmed} 之前的结论标记为已沉淀）`;
				return text(`已记进团队「${team}」的记忆${tail}。下一条消息就会出现在这个团队的记忆目录里。`);
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
	 * 翻过去的话：对话历史，或者记忆。
	 *
	 * 为什么必须有对话那一半：上下文压缩是 pi-durable 的默认行为，压成 `pi.compaction`
	 * 条目之后，原文还在 storage 里，但**模型再也看不见了，也没任何办法读回**。
	 * 于是它只能凭记忆补路径、补数字、补原话 —— 看起来很像，可能是错的，而且
	 * 错得无法被发现。这把记忆能不能查询变成了可以查询。
	 *
	 * 分页从新往回扇：一次 64 条。记忆那一半见 `recallText`。
	 */
	const readHistory = defineTool({
		name: "read_history",
		description: [
			"翻过去的话。`scope=channel`（默认）查我自己这个会话的历史（上下文被压缩掉的部分也查得到）；",
			"被压缩过之后要写精确的路径、数字、原话，先用它查，不要凭记忆补。",
			"`scope=memory`（或 personal / team 简写）翻记忆全文，可以只筛包含某个词的段落。",
		].join(""),
		parameters: Type.Object({
			scope: Type.Optional(
				Type.String({ description: "channel（默认，对话历史）/ memory（我的记忆）/ team（团队记忆；也可以先写 memory 再给 team）" }),
			),
			query: Type.Optional(Type.String({ description: "关键词（不区分大小写），只留包含它的条目 / 段落" })),
			team: Type.Optional(Type.String({ description: "团队 slug，默认是我所在的团队（scope=team / memory 且要看团队时用）" })),
			around: Type.Optional(Type.Number({ description: "条目 id（每行开头的 #号）。从这条往前翻（只看对话历史）" })),
			limit: Type.Optional(Type.Number({ description: "最多几条，默认 12，上限 50（只看对话历史）" })),
		}),
		execute: async (args, api, context) => {
			const ctx = context ?? BACKGROUND_CONTEXT;
			const wanted = actionOf(args.scope, ["channel", "memory", "personal", "team"], "channel", "scope");
			if (typeof wanted !== "string") return text(wanted);

			// 记忆那一半：入参是「谁的记忆 / 哪个团队 / 只留含某词的段落」。
			if (wanted !== "channel") {
				const slug = await selfOrError(deps, Number(api.conversationId), ctx, "你还不在名册里。");
				if (typeof slug !== "string") return text(slug);
				const keyword = (args.query ?? "").trim();
				if (wanted === "team") return recallText(deps, slug, args.team, keyword);
				if (wanted === "personal") return recallText(deps, slug, undefined, keyword);
				// scope=memory：给了 team 就看团队，否则看自己。
				return recallText(deps, slug, args.team, keyword);
			}

			const limit = Math.min(Math.max(Math.trunc(args.limit ?? 12), 1), 50);
			const keyword = (args.query ?? "").trim().toLowerCase();
			const conversation = await deps.harness.conversation(Number(api.conversationId) as never, ctx);
			if (conversation === undefined) return text("这个会话还没有任何记录。");
			const now = Date.now();
			const found: { id: number; line: string }[] = [];
			let cursor: Cursor | undefined;
			let exhausted = false;
			let enough = false;
			// 多取一条：只有拿到「第 limit+1 条」才知道后面确实还有更早的。
			for (let index = 0; index < HISTORY_PAGES && found.length <= limit; index += 1) {
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
					if (found.length > limit) {
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
				if (lines.length >= limit || used + item.line.length + 1 > HISTORY_BUDGET) break;
				lines.push(item.line);
				used += item.line.length + 1;
			}
			const oldest = found[lines.length - 1];
			const more = found.length > lines.length || (lines.length >= limit && !exhausted);
			const tail = more && oldest !== undefined ? `\n\n还有更早的，用 around=${oldest.id} 继续往前。` : "";
			return text(`${lines.join("\n")}${tail}`);
		},
	});

	const run = defineTool({
		name: "run",
		description: [
			"执行一条 shell 命令，返回 stdout / stderr / 退出码。装依赖、跑测试、起服务、拼装工具链用它。",
			"以 `&` 结尾或以 `nohup` 开头 = 后台跑，立即返回 PID；不要用 `sleep` 等人 —— 别人做完会叫你。",
			"不确定某件事该怎么做，先用 `skills` 看你有没有那门手艺。",
		].join(""),
		parameters: Type.Object({
			command: Type.String({ description: "要执行的命令" }),
			cwd: Type.Optional(Type.String({ description: "工作目录，默认工作区根" })),
			timeout: Type.Optional(Type.Number({ description: "超时秒数，默认 60" })),
		}),
		execute: async (args, api, context) => {
			const ctx = context ?? BACKGROUND_CONTEXT;
			const slug = await selfOrError(deps, Number(api.conversationId), ctx, "你还不在名册里。");
			if (typeof slug !== "string") return text(slug);
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
				return text([`$ ${command}`, `(后台运行，PID ${pid}）`].join("\n"));
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
			// 剪的尺度：回给模型的是它继续干活要用的，给得宽一些，但**绝不能全量** ——
			// 一次跑整个测试套件就能把 512 KB 塞进上下文，后面几轮全在付费读它。
			return text(clip(buffer, MODEL_LIMIT));
		},
	});

	/**
	 * 工作区里的一个文件：读，或者写。
	 *
	 * 与 `run` 的差别：不经过 shell，路径可控、内容不经过转义。
	 */
	const file = defineTool({
		name: "file",
		description: [
			"工作区里的一个文件。`action=read`（默认）读它；`action=write` 写它（大段代码、配置、文档走这个，不经过 shell 转义）。",
			"路径相对工作区根，`../` 会被拒；读写不了工作区以外的东西。",
		].join(""),
		parameters: Type.Object({
			action: Type.Optional(Type.String({ description: "read（默认）/ write" })),
			path: Type.String({ description: "文件路径（相对工作区根）" }),
			content: Type.Optional(Type.String({ description: "write 必填：文件内容" })),
			offset: Type.Optional(Type.Number({ description: "read 从第几行开始（1 起），默认 1" })),
			limit: Type.Optional(Type.Number({ description: "read 最多几行，默认 400" })),
		}),
		execute: async (args) => {
			const action = actionOf(args.action, ["read", "write"], "read");
			if (typeof action !== "string") return text(action);
			const target = resolveInWorkspace(deps.workspaceRoot, args.path);
			if (target === undefined) return text(`路径在工作区之外：${args.path}`);

			if (action === "write") {
				if (args.content === undefined) return text("write 要带 content（写什么）。只想读文件用 action=read。");
				// 密钥一旦落进 identity.md / SKILL.md，就永久进了每一轮提示词的 system 段。
				const content = redact(args.content, deps.workspaceRoot);
				await mkdir(dirname(target), { recursive: true });
				await writeFile(target, content, "utf8");
				return text(`已写入 ${args.path}（${content.length} 字）`);
			}

			const source = await readFile(target, "utf8").catch(() => undefined);
			if (source === undefined) return text(`文件不存在：${args.path}`);
			const rows = source.split("\n");
			const offset = Math.max(Math.trunc(args.offset ?? 1), 1);
			const limit = Math.min(Math.max(Math.trunc(args.limit ?? 400), 1), 800);
			const shown = rows.slice(offset - 1, offset - 1 + limit);
			const head = shown.join("\n");
			// 行的尺度和字的尺度都要管：一行十万字的压缩包也是合法的。
			const clipped = head.length > 8000 ? `${head.slice(0, 8000)}\n…（已截断）` : head;
			const last = offset - 1 + shown.length;
			if (last >= rows.length && clipped.length === head.length) return text(clipped);
			const more = last < rows.length ? `，还有，用 offset=${last + 1} 继续` : "";
			return text(`${clipped}\n（共 ${rows.length} 行、${source.length} 字；这里从第 ${offset} 行起${more}）`);
		},
	});

	return [
		say,
		chats,
		readHistory,
		remember,
		hire,
		run,
		file,
	] as readonly ToolRegistration[];
}

/** 组装一次投递的全部依赖（`say` 共用）。 */
function postDeps(deps: CoreToolDeps, state: ChannelState, context: Context): PostDeps {
	return {
		harness: deps.harness,
		state,
		// 回话规矩（`prompt/80-reply.md` 等）每轮现读：**agent 叫醒 agent 也要贴**。
		// 以前这里漏了它，于是成员 `say` 叫管理员时，管理员那条唤醒没有回话规矩 ——
		// 表现是「能回，但不知道要先把话说进频道」，日志里一行 warn 谁也没注意。
		promptDir: promptDirOf(deps.agentsRoot),
		conversationOf: (slug: string) => conversationOf(deps, slug, context),
		// 不给 `labelOf`：`post.ts` 的缺省就是恒等（显示名由 `deliver` 那一层自己算），
		// 传一个 `(slug) => slug` 只是把缺省重写一遍。
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
 * 而我是 15 字。我的原话是「根本不像正常人之间沟通」。
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
 * slug → 会话句柄。名册里没有、或者会话已被删除时返回 undefined（不抛）。
 *
 * 找不到人不是错误：我就是没有会话的，刚 hire 的人也可能还没开。
 */
async function conversationOf(deps: CoreToolDeps, slug: string, context: Context) {
	const directory = await deps.directory(context);
	const id = conversationFor(directory, slug);
	if (id === undefined) return undefined;
	return deps.harness.conversation(id as never, context);
}

/** 一条消息的一行渲染（`chats` 用）。 */
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

