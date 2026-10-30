/**
 * 七个工具共用的机械件：谁在说话、默认回哪个频道、怎么读状态、投递要什么。
 *
 * 这里只放「每条工具都会用到的那一句」，工具自己的做法留在各自的文件里。
 */
import { join } from "node:path";
import { BACKGROUND_CONTEXT, type Context, type Harness } from "../../runtime/index.ts";
import { readAllIdentities } from "../../agent/identity.ts";
import { readMemory, sectionsOf } from "../../agent/memory.ts";
import { redact } from "../../agent/secrets.ts";
import { resolveInOrUndefined } from "../../fsx.ts";
import { conversationFor, directoryWake, slugFor, wakeOf, type DirectoryState } from "../../agent/roster.ts";
import { type PostDeps } from "../post.ts";
import type { FinishTurn } from "../turn.ts";
import { mentionRosterOf, type MentionRoster } from "../store.ts";
import {
	ChannelDoc,
	OWNER,
	chatKind,
	deliveryTargets,
	emptyChannelState,
	fallbackChannelId,
	type ChannelState,
	type Message,
} from "../store.ts";
import { promptDirOf } from "../../md/prompt.ts";
import { assertTeamSlug } from "../../team/doc.ts";
import { readTeamMemory, teamMemorySections } from "../../team/memory.ts";

/** 工具运行所需的一切。全部由外壳在启动时装配，工具自己不读环境变量。 */
export type CoreToolDeps = {
	readonly harness: Harness;
	/**
	 * 工作区根。`agents/` 与 `skills/` 都在它下面。
	 *
	 * 为什么工具需要它：`npx skills add` 会把技能装到**当前目录**下，所以在哪儿跑
	 * 决定了装到哪儿。全员层就是工作区根下的 `skills/`。
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
	/** 一条消息落地之后的钩子。外壳用它接「团队记忆自动沉淀」。 */
	readonly afterPost?: (message: Message, channelId: string, context: Context) => Promise<void>;
	/** 按团队文件重建它的频道成员（幂等）。 */
	readonly syncTeam?: (team: string, context: Context) => Promise<void>;
	/** 一轮正常答完时把最终回答补进频道（`channel/turn.ts`）。 */
	readonly finishTurn?: FinishTurn;
};

/**
 * 工具的唯一出口：一段给模型读的自然语言。
 *
 * 也接受 `{ error }` —— `actionOf` / `defaultChannel` 这类「参数不合法」的结果直接
 * 丢进来就行，不用每个调用点再拆一次。
 */
export function text(value: string | { readonly error: string }) {
	return { output: [{ type: "text" as const, text: typeof value === "string" ? value : value.error }] };
}

/**
 * 读一个枚举型参数。
 *
 * 校验失败时要把合法值列出来 —— 模型看到「只有 list / read」才知道下一步该改什么，
 * 只回一句「参数不合法」它就只能乱试。
 */
export function actionOf(
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
export async function recallText(deps: CoreToolDeps, slug: string, team: string | undefined, keyword: string) {
	// 记忆是自由文本，密钥可能早就被写进去了。读的时候也要过一遍脱敏 ——
	// 渲染进提示词的那一路有出口，这一路是「它主动来翻」，同样不能把密钥交出去。
	const mask = (value: string) => redact(value, deps.workspaceRoot);
	if (team !== undefined && team !== "") {
		const target = team;
		try {
			assertTeamSlug(target);
		} catch (error) {
			return text(error instanceof Error ? error.message : String(error));
		}
		const source = await readTeamMemory(deps.teamsRoot, target);
		if (source === undefined) return text(`团队「${target}」还没有记忆。`);
		if (keyword === "") return text(mask(source));
		const sections = teamMemorySections(source).filter(
			(section) => section.heading.includes(keyword) || section.body.includes(keyword),
		);
		if (sections.length === 0) return text(`团队「${target}」的记忆里没有「${keyword}」。`);
		return text(mask(sections.map((section) => `## ${section.heading}\n${section.body}`).join("\n\n")));
	}

	const source = await readMemory(join(deps.agentsRoot, slug));
	if (source === undefined) return text("我还没记过任何东西。");
	if (keyword === "") return text(mask(source));
	const sections = sectionsOf(source).filter(
		(section) => section.heading.includes(keyword) || section.body.includes(keyword),
	);
	if (sections.length === 0) return text(`记忆里没有「${keyword}」。`);
	return text(mask(sections.map((section) => `## ${section.heading}\n${section.body}`).join("\n\n")));
}

/** 这个工具调用属于哪个 slug。名册里找不到就给一句明确的错误。 */
export async function selfOf(deps: CoreToolDeps, conversationId: number, context: Context): Promise<string | undefined> {
	const directory = await deps.directory(context);
	return slugFor(directory, conversationId);
}

/**
 * 「先知道自己是谁」：七个工具的第一句都是这件事，文案只在这里写一次。
 *
 * 查不到时返回一句能直接回给模型的话（工具不抛错：抛错它看到的是堆栈）。
 */
export async function selfOrError(
	deps: CoreToolDeps,
	conversationId: number,
	context: Context,
	hint = "你还不在名册里。",
): Promise<string | { readonly error: string }> {
	const slug = await selfOf(deps, conversationId, context);
	return slug ?? { error: hint };
}

/**
 * 「默认在哪儿说话」：刚被叫醒的那个频道 → 我是成员的群里最近活跃的那个 → 我和我的私聊。
 *
 * 第一条最重要：我在私聊里问我一句，我一开口就该回私聊，而不是群里。
 * 最后一级**不能直接拿 `mine[0]`**：那可能正是我和我的私聊，于是我在群里问的话被答进私聊。
 * 形态由 `fallbackChannelId` 按成员推导，不看 id 前缀。
 */
export async function defaultChannel(
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
		// 用 `reply`：私聊插话时默认就回私聊；手上那件活属于哪个频道由收尾去管（`task`）。
		const channel = state.channels[wake.reply.channelId];
		if (channel !== undefined && channel.members.includes(slug)) return { channelId: wake.reply.channelId };
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
export async function othersAwoken(
	deps: CoreToolDeps,
	state: ChannelState,
	conversationId: number,
	slug: string,
	context: Context,
): Promise<string[]> {
	const directory = await deps.directory(context);
	const wake = wakeOf(directory, conversationId);
	if (wake === undefined) return [];
	const channel = state.channels[wake.reply.channelId];
	if (channel === undefined) return [];
	const message = (state.messages[channel.id] ?? []).find((item) => item.seq === wake.reply.seq);
	// 找不到那条消息时保守一点：频道里只要还有别的 agent，就当有人接得住 ——
	// 宁可让一句无话不说的话被放过，也不要因为一次读不到而把他卡在第 1 条消息上。
	const candidates =
		message === undefined
			? channel.members.filter((member) => member !== OWNER)
			: deliveryTargets(channel, message);
	return candidates.filter((member) => member !== slug);
}

/** 当前名册：`@` 别名解析用。每次现读盘（`say` 不是热路径，且改 `identity.md` 要立刻生效）。 */
export async function mentionRoster(deps: CoreToolDeps): Promise<MentionRoster> {
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
export async function readState(deps: CoreToolDeps): Promise<ChannelState> {
	return (await deps.harness.snapshot(ChannelDoc, BACKGROUND_CONTEXT)) ?? emptyChannelState();
}

/** 组装一次投递的全部依赖（`say` 共用）。 */
export function postDeps(deps: CoreToolDeps, state: ChannelState, context: Context): PostDeps {
	// 唤醒依赖只有一份（`agent/roster.ts` 的 `directoryWake`）：投递、我说话、沉淀
	// 三条路共用同一套「会话在哪 / 记下被谁叫醒」。
	const wakeDeps = directoryWake({ harness: deps.harness });
	return {
		harness: deps.harness,
		state,
		// 回话规矩（`prompt/80-reply.md` 等）每轮现读：**agent 叫醒 agent 也要贴**。
		// 以前这里漏了它，于是成员 `say` 叫管理员时，管理员那条唤醒没有回话规矩 ——
		// 表现是「能回，但不知道要先把话说进频道」，日志里一行 warn 谁也没注意。
		promptDir: promptDirOf(deps.agentsRoot),
		conversationOf: (slug: string) => wakeDeps.conversationOf(slug, context),
		// 不给 `labelOf`：`post.ts` 的缺省就是恒等（显示名由 `deliver` 那一层自己算），
		// 传一个 `(slug) => slug` 只是把缺省重写一遍。
		rememberWake: (slug, wake) => wakeDeps.rememberWake(slug, wake, context),
		// 插话时要从上一次的记录里继承 `task`；一次投递里多个收件人共用一份名册快照。
		wakeOf: (() => {
			let snapshot: Promise<DirectoryState> | undefined;
			return async (slug: string) => {
				snapshot ??= deps.directory(BACKGROUND_CONTEXT);
				const directory = await snapshot;
				const id = conversationFor(directory, slug);
				return id === undefined ? undefined : wakeOf(directory, id);
			};
		})(),
		...(deps.finishTurn === undefined ? {} : { finishTurn: deps.finishTurn }),
	};
}

/** 一条 `say` 的上限。不是「存不下」，是「不该在频道里说这么多」。 */
export const SAY_LIMIT = 1_200;

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
export const MODEL_LIMIT = 8_000;

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
	return resolveInOrUndefined(root, path);
}

/** 一条消息的一行渲染（`chats` 用）。 */
export function renderLine(message: Message): string {
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
