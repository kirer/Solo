/**
 * 发消息：落库 + 唤醒，成对完成。
 *
 * 这是新核心里唯一「写频道」的入口。落库与唤醒必须在同一个地方做，否则会出现
 * 两种静默失败：
 *
 * - **存了没叫**（消息在，人不知道）——踩过一次：`say` 不解析正文里的
 *   `@`，CPO 用 `say` 发了「@CEO 团队已建好」，CEO 从来没被唤醒，团队静默停摆。
 * - **叫了没存**（人醒来看不到东西）——不会报错，只会让 agent 反复「你说什么？」。
 *
 * 所以 `postMessage` 里三件事固定这个顺序：解析 @ → 写文档 → 唤醒收件人。
 */
import type { Conversation, Harness } from "../runtime/index.ts";
import { BACKGROUND_CONTEXT, type Context } from "../runtime/index.ts";
import {
	ChannelDoc,
	OWNER,
	appendMessage,
	botHopsSinceOwner,
	chatKind,
	channelsOf,
	parseMentions,
	recipientsOf,
	relayLimit,
	tail,
	unreadCount,
	type Attachment,
	type Channel,
	type ChannelState,
	type Message,
} from "./store.ts";
import { loadTemplates, type PromptTemplate } from "../prompt.ts";
import { createFsx } from "../fsx.ts";
import { renderSlots, toolSlots, type SlotValue } from "../text.ts";
import { oneLine } from "../oneline.ts";
import { planAttachments } from "./files.ts";
import { wake } from "./wake.ts";
import { EMPTY_ROSTER, type MentionRoster } from "./store.ts";
import { renderUnanswered } from "./unanswered.ts";
import { createSerialGate } from "../runtime/io.ts";

type PostResult = {
	readonly channel: Channel;
	readonly message: Message;
	/** 没唤醒任何人时是空数组。 */
	readonly delivery: DeliverResult;
};

type PostInput = {
	readonly channelId: string;
	readonly from: string;
	readonly text: string;
	readonly at: number;
	readonly kind?: string;
	readonly replyTo?: number;
	/** 名册：给了就按名册把 `@我` / `@CEO` 落库成规范 slug。 */
	readonly roster?: MentionRoster;
	/** 正文里没写、但要记进 `mentions` 的 slug（`decision` 自动补 `owner` 走这条）。 */
	readonly mention?: readonly string[];
	/** 不想唤醒任何人（比如系统留痕）。缺省会唤醒。 */
	readonly wake?: false;
	/** 附件引用。必须在这里给（不是事后补），否则投递时还不知道有图，模型就看不见。 */
	readonly attachments?: readonly Attachment[];
};

export type PostDeps = {
	readonly harness: Harness;
	readonly state: ChannelState;
	readonly conversationOf: (slug: string) => Promise<Conversation | undefined>;
	readonly labelOf?: (slug: string) => string;
	readonly rememberWake?: (slug: string, wake: WakeRecord) => Promise<void>;
	/** 附件根目录。给了模型就能真的看见消息里的图片。 */
	readonly uploadsRoot?: string;
	/** 提示词模板目录（`<workspace>/prompt`）。投递要用它贴「怎么回话」那两段。 */
	readonly promptDir?: string;
};

/**
 * 追一条系统留痕到频道。`note` 不唤醒、不计未读（见 `Message.kind`），所以这里不碰
 * 投递层，否则「系统说一下没人被叫醒」会反过来叫醒人。
 *
 * 只要求 `harness`（不需要完整的 `PostDeps`）：沉淀失败时的留痕也走这里。
 * 频道不存在就什么都不写 —— 没有地方给人看，别造一个孤儿消息。
 */
export async function appendNote(
	deps: { readonly harness: Harness },
	channelId: string,
	text: string,
	at: number,
	context: Context,
): Promise<void> {
	await deps.harness.commit(async (tx) => {
		const doc = (await tx.doc(ChannelDoc)) as ChannelState;
		if (doc.channels[channelId] === undefined) return;
		const next = appendMessage(doc, channelId, { from: OWNER, text, at, kind: "note" });
		const list = doc.messages[channelId];
		if (list === undefined) doc.messages[channelId] = [next.message];
		else (list as Message[]).push(next.message);
		doc.nextSeq[channelId] = next.message.seq + 1;
	}, context);
}

/** 投递没成时给我留一句话。分开列，不糊成一句：两种原因的处置完全不同。 */
function renderIssues(seq: number, issues: readonly DeliverIssue[], labelOf: (slug: string) => string): string {
	return issues
		.map((issue) =>
			issue.reason === "failed"
				? `#${seq} 叫了 @${labelOf(issue.slug)}，投递失败：${issue.detail ?? "未知原因"}。`
				: `#${seq} 叫了 @${labelOf(issue.slug)}，但它还没有会话（还没被打开过）—— 这条不会有人答。`,
		)
		.join("\n");
}

/**
 * 频道写入的串行闸。
 *
 * 为什么需要：同一个进程里所有 agent 的 `say` 是**并发**的，而它们都往同一个
 * `ChannelDoc` 上 commit。实测撞出过这个：两个 `say` 同时进来，其中一个 commit 拿到
 * 已被释放的读覆盖层，报 `Cannot use a settled overlay` —— 而那条消息**已经写进去了**，
 * 于是模型看到报错就重试，频道里出现两条一模一样的「在。」。
 *
 * 串行化的代价是频道写入排队（毫秒级，一次 commit），换来的是「一次调用 = 一条消息」
 * 这条最基本的保证。
 */
const serialized = createSerialGate();

/**
 * 写一条消息并唤醒该唤醒的人。
 *
 * 文档写入用 `commit` + 路径式追加（推一条 + 改两个数字），**不整频道替换**：
 * 一个群频道可以有 800 条消息，整值替换会让每条消息重写整个频道（实测
 * 49.6KB/条 vs 141 字节）。
 */
export async function postMessage(
	deps: PostDeps,
	input: PostInput,
	context: Context = BACKGROUND_CONTEXT,
): Promise<PostResult> {
	return serialized(() => postMessageUnlocked(deps, input, context));
}

async function postMessageUnlocked(deps: PostDeps, input: PostInput, context: Context): Promise<PostResult> {
	const channel = deps.state.channels[input.channelId];
	if (channel === undefined) throw new Error(`频道不存在：${input.channelId}`);

	let created: Message | undefined;
	let cappedLimit = 0;
	// 接力上限：这条落库前先数一下 agent 已经自动接了几棒。
	// 判在 appendMessage **之前**：之后这条自己也会被算进去（第 3 棒就会被误拦）。
	const hops = botHopsSinceOwner(deps.state, input.channelId);
	const limit = relayLimit(channel);
	// 显式 @ 当场突破上限：上限是为了拦「A 回 B、B 又回 A」的自动接力，
	// 不是为了拦住一个想清楚要叫谁的人。上面那条 note 就是这么告诉模型的，
	// 文案和代码必须一致，否则它会以为自己能 @ 人而其实叫不醒。
	const addressed = [...parseMentions(input.text), ...parseMentions(input.text, input.roster ?? EMPTY_ROSTER)].some(
		(slug) => slug !== input.from && channel.members.includes(slug),
	);
	// 提交之前先把「后面还要读到的东西」抄成纯数据：提交一关，读覆盖层就释放了，
	// 而成员列表、wakeOnAll、各人未读都要在提交之后才用得上（见下面的注释）。
	const channelMeta: Channel = {
		...channel,
		members: [...channel.members],
		wakeOnAll: [...channel.wakeOnAll],
	};
	const digests = new Map<string, string>();
	for (const slug of channelMeta.members) {
		if (slug === OWNER) continue;
		digests.set(slug, renderDigest(deps.state, slug));
	}
	const capped =
		input.wake !== false &&
		input.from !== OWNER &&
		input.kind !== "note" &&
		!addressed &&
		hops >= limit;
	if (capped) cappedLimit = limit;
	await deps.harness.commit(async (tx) => {
		const doc = await tx.doc(ChannelDoc);
		const state = doc as ChannelState;
		// 序号以**消息本身**为准，不以 `nextSeq` 为准。
		//
		// 实测（2026-10-29）：`nextSeq["company"]` 是 19 而频道里已经有 36 条消息，于是新消息
		// 拿到了 #20 —— 和一条旧消息撞号。撞号的后果不是「多一条」，是序列唯一的假设塌了：
		// 前端按 seq 去重、按 `[data-seq=N]` 定位、补历史时按 seq 合并，全都指向错的那条，
		// 症状就是「刷新以后少了几句」。这类不一致只能在这里兜（唯一写入口），
		// 让它自愈，而不是要求所有调用方都保证 `nextSeq` 正确。
		const highestSeq = (doc.messages[input.channelId] ?? []).reduce((max, item) => (item.seq > max ? item.seq : max), 0);
		if ((doc.nextSeq[input.channelId] ?? 1) <= highestSeq) doc.nextSeq[input.channelId] = highestSeq + 1;
		// appendMessage 返回的是新 state；这里只要它算好的 message，写入按路径原地做。
		const next = appendMessage(state, input.channelId, {
			from: input.from,
			text: input.text,
			at: input.at,
			...(input.kind === undefined ? {} : { kind: input.kind }),
			...(input.replyTo === undefined ? {} : { replyTo: input.replyTo }),
			...(input.roster === undefined ? {} : { roster: input.roster }),
			...(input.mention === undefined ? {} : { mention: input.mention }),
			...(input.attachments === undefined ? {} : { attachments: input.attachments }),
		});
		// **只有一个元素被追加**，所以必须让文档层看见「数组长了一格」而不是「这个键换了个
		// 新数组」。两者写下去的消息一样，代价差三个数量级：
		//
		//   原地 push → `["p",["messages",频道],N,0,[消息]]`，约等于消息本身大小；
		//   整值替换 → `["s",["messages",频道],[…整个频道历史]]`，**每条消息重写全部历史**。
		//
		// 实测（`test/core/channel-write.test.ts`）：200 字的消息，append 320 字节、
		// 整值替换 582 字节且随历史线性变长。一个 189 条消息的频道因此涨到 27 MB。
		//
		// 注意 `push` 必须作用在**文档代理给出的那个数组**上：`doc.messages[id] ??=` 之后
		// 再 push 本地变量不算数（那不是代理，提交时不会有任何 op，消息静默消失）。
		doc.messages[input.channelId] ??= [];
		(doc.messages[input.channelId] as Message[]).push(next.message);
		state.nextSeq[input.channelId] = next.message.seq + 1;
		// 接力到上限：**只落消息、不投递**，再留一条 note 说清楚为什么没人被叫醒。
		// 不投递就是暂停：消息已经在频道里任何人随时能读到，「继续」不需要按钮 ——
		// 我一发言 `botHopsSinceOwner` 自动归零。
		// 但**连着记就不记了**：上限一旦触发，之后每条 agent 消息都会被拦，
		// 每拦一条写一条 note 结果就是频道里几百行「接力到上限」—— 实测一个私聊里
		// 197 条消息有 150 多条是这个。人对同一条告警看第二遍就没有新信息了。
		// 所以只在「上一条不是这条 note」时补一次，等于把连续拦截合并成一条。
		// 判据是「我上次说话之后已经报过警没有」，不是「上一条是不是 note」：
		// 每条被拦的消息本身也会落库，所以上一条永远是那条消息，不是 note。
		// 用 `doc` 里的活数组，不能用 `deps.state` 的旧快照 —— 快照里没有刚追加的 note。
		const trail = (doc.messages[input.channelId] as Message[] | undefined) ?? [];
		// note 也是 `from: OWNER`，所以不能只按 from 找 —— 要不它会把自己当成「我刚说过话」。
		const lastOwnerAt = trail.findLastIndex((item) => item.from === OWNER && item.kind !== "note");
		const alreadyNoted = trail
			.slice(lastOwnerAt + 1)
			.some((item) => item.kind === "note" && item.text.startsWith("接力到上限（"));
		if (capped && !alreadyNoted) {
			const noted = appendMessage(state, input.channelId, {
				from: OWNER,
				text: `接力到上限（${cappedLimit} 次）：这条只记下，没人被叫醒。我说一句，或者自己 @ 人，就能接着走。`,
				at: input.at,
				kind: "note",
			});
			(doc.messages[input.channelId] as Message[]).push(noted.message);
			state.nextSeq[input.channelId] = noted.message.seq + 1;
		}
		// 抄成纯对象再交出去：`next.message` 是这次事务里的代理，事务一关就不能再读
		// （`Cannot use a settled overlay`），而收件人计算、投递、返回给工具都要用它。
		created = JSON.parse(JSON.stringify(next.message)) as Message;
	}, context);

	const message = created as Message;

	const liveChannel = channelMeta;
	if (input.wake === false || input.kind === "note") {
		return { channel: liveChannel, message, delivery: { delivered: [], failed: [], skipped: [] } };
	}
	if (capped) return { channel: liveChannel, message, delivery: { delivered: [], failed: [], skipped: [] } };

	// 我没有会话：它是「人」，不是 agent。`deliver` 会把它算进 skipped。
	const targets = recipientsOf(liveChannel, message).filter((slug) => slug !== OWNER);
	if (targets.length === 0) {
		return { channel: liveChannel, message, delivery: { delivered: [], failed: [], skipped: [] } };
	}
	// 谁手上还有活：投递会打断他，正文要说明「这是插话，不是新任务」。
	// 取不到就当没人忙 —— 宁可少一句话，也不能让每次投递都失败。
	const busy = await liveConversations(deps.harness, context).catch(() => new Set<number>());
	const labelOf = deps.labelOf ?? ((slug: string) => slug);
	const delivery = await deliver(
		{
			// 摘要用**写之前**的 state：这条新消息已经在正文里了，再算进未读数会重复。
			digests,
			channel: liveChannel,
			message,
			targets,
			busy,
			// 合并唤醒（也负责我插队）：同一个会话最多留一个「还没开始」的排队项。
			// 谁连发几条（我三句、agent 的过程话与追问）都只排一个唤醒，最后一条取代
			// 前面没开始的那些 —— 消息都在频道里，少的只是重复唤醒。
			// 这里只撤 `queued`，正在跑的那一轮不碰（撤它会连新消息一起吞掉，实测过）。
			coalesceQueue: (conversationId, keepRequestId) =>
				coalesceQueue(deps.harness, conversationId, keepRequestId, context),
			conversationOf: deps.conversationOf,
			...(deps.labelOf === undefined ? {} : { labelOf: deps.labelOf }),
			...(deps.rememberWake === undefined ? {} : { rememberWake: deps.rememberWake }),
			...(deps.uploadsRoot === undefined ? {} : { uploadsRoot: deps.uploadsRoot }),
			...(deps.promptDir === undefined ? {} : { promptDir: deps.promptDir }),
			// 这一轮他一个字都没产出（最常见的是模型引用失效）：留一行，别让频道里
			// 只剩一条占位「开始处理…」。等待在后台，不占投递这条线。
			noteUnanswered: async ({ label, seq, reason }) => {
				await appendNote(deps, liveChannel.id, renderUnanswered(seq, label, reason), Date.now(), BACKGROUND_CONTEXT);
			},
			// 没人被叫醒就说一句：只写 stderr 的话，频道里一片空白，
			// 我看到的「我说了没人理」和「系统挂了」长得一模一样。
			notify: async (issues) => {
				await appendNote(deps, liveChannel.id, renderIssues(message.seq, issues, labelOf), Date.now(), context);
			},
		},
		context,
	);
	return { channel: liveChannel, message, delivery };
}

// ── 投递（原 `deliver.ts`）───────────────────────────────────────────────
// 并进这里的原因：「写一条消息」和「把它交给该看的人」是一次写入的两半：收件人由
// 消息本身算出来（`recipientsOf`），投递正文又由这条消息拼出来。分成两个文件时，
// 两边各自 import 同一批 state 函数，中间只隔一个 `post()` 的返回值。

/**
 * 投递：把一条频道消息推到被唤醒者的**下一次请求**里。
 *
 * 这是新核心里唯一的跨 agent 原语，只有一条硬约束：
 *
 * **不等待回复。** 消息已经落在频道文档里了，投递只负责「叫醒」。答案从频道
 * 异步回来，发送方不等。不回执、不看门狗、不重投 —— 那些都是「不等待」的代价，
 * 等真出现「投了但没人醒」再补。现在只守两条：
 *
 * 1. 一条投递失败不影响其余（逐条 try/catch）。
 * 2. 投递失败不丢消息 —— 消息在文档里，对方下次醒来会看到未读摘要。
 */


/** 记忆里「刚被谁在哪个频道叫醒」。工具用它决定「默认在哪儿回话」。 */
export type WakeRecord = {
	readonly channelId: string;
	readonly seq: number;
	readonly from: string;
	readonly at: number;
};

export type DeliverResult = {
	/** 真的进了队列的 slug。不代表已读。 */
	readonly delivered: string[];
	/** 连队列都没进的 slug（消息仍在频道里）。 */
	readonly failed: string[];
	/** 没有会话、或就是我本人，跳过的 slug。 */
	readonly skipped: string[];
	/**
	 * 这次合并唤醒的账：谁本来已经有一条「还没开始」的排队项，被这一条取代了。
	 *
	 * 消息一条都没删（都在频道里），少掉的只是**重复的唤醒**。
	 */
	readonly merged?: readonly { readonly slug: string; readonly count: number }[];
};

/** 一个「叫了但没人会答」的收件人。拼成频道里的 `note` 用，我才能看见系统做了什么。 */
export type DeliverIssue = {
	readonly slug: string;
	/** 「还没有会话」还是「投递抛错」。两者文案不同，不能糊成一句。 */
	readonly reason: "no-conversation" | "failed";
	/** 抛错时的简短原因。 */
	readonly detail?: string;
};

type DeliverOptions = {
	/**
	 * 每个人各自的未读摘要，**在调用方提交之前**就算好。
	 *
	 * 不在这里算，是因为这些摘要要读整个频道文档，而投递发生在写入提交之后 ——
	 * 那时候读快照可能已经被释放（chord 报 `Cannot use a settled overlay`），
	 * 而且这个错抛在**写入之后**：消息已经进频道，工具却对外报失败，模型重发一次，
	 * 频道里出现两条一模一样的回复。摘要本来就该是「这条消息之前」的样子，
	 * 提前算既对又安全。
	 */
	readonly digests: ReadonlyMap<string, string>;
	readonly channel: Channel;
	readonly message: Message;
	/** 要唤醒谁（`recipientsOf` 的结果）。 */
	readonly targets: readonly string[];
	/** slug → 会话。返回 undefined 表示这个人没有会话（比如我）。 */
	readonly conversationOf: (slug: string) => Promise<Conversation | undefined>;
	/** 显示名字。缺省用 slug。 */
	readonly labelOf?: (slug: string) => string;
	/** 记住「被谁叫醒」。缺省不记。 */
	readonly rememberWake?: (slug: string, wake: WakeRecord) => Promise<void>;
	/**
	 * 此刻手上还有活（有非后台任务在跑）的会话 id。
	 *
	 * 这类投递会**打断**对方正在干的事（`whenBusy: "steer"`），所以正文要多一句
	 * 「这是插话，不是新任务」—— 否则它答完这句就把活丢了。实测：我在沈舟加音效
	 * 的中途私聊问「你是谁啊」，它答完就收工，再没回团队频道汇报。
	 */
	readonly busy?: ReadonlySet<number>;
	/**
	 * 有人没被叫醒时通报一声。不传就只听 stderr。
	 *
	 * 为什么需要这个：投递失败只写 stderr 的话，频道里空白一片，我看到的
	 * 「我说了没人回」和「系统真挂了」长得一模一样 —— 那个「@CEO 不理我」的现象
	 * 就是这么排查了很多轮才定位到投递层的。
	 */
	readonly notify?: (issues: readonly DeliverIssue[]) => Promise<void> | void;
	/**
	 * 提示词模板目录（`<workspace>/prompt`）。给了才贴「怎么回话」那两段。
	 *
	 * 为什么不传工作区根：这一层只该知道「模板在哪」，不该知道工作区长什么样。
	 * 每轮现读一次（不缓存）—— 缓存一进投递层，改模板就要重启。
	 */
	readonly promptDir?: string;
	/**
	 * 附件根目录（`<workspace>/uploads`）。
	 *
	 * 给了就把消息里的图片读成内容块直接交给模型（它真的看得见图），其它文件给出
	 * `file` 的路径。不给就退化成正文里一行「[图片] x.png」—— 那是旧行为。
	 */
	readonly uploadsRoot?: string;
	/**
	 * 合并唤醒：撤掉这个会话里「还没开始」的排队项，让新的一条取代它们。
	 * 返回合并了几条（0 = 没合并）。不传就不合并。
	 *
	 * 所有发言都走这一条：我插队（撤掉排在他前面的待办）与「同一个人连发只排一个
	 * 唤醒」是同一件事 —— 都是「这个会话最多留一个未开始的排队项」。
	 */
	readonly coalesceQueue?: (conversationId: number, keepRequestId: string) => Promise<number>;
	/**
	 * 这一轮什么都没产出时留一句话。
	 *
	 * 不传就什么都不写（投递仍然不等回复）。传了就在后台等这次提交结算，
	 * 结算为 `unanswered` 时回调 —— 频道里至少有人能看出「他回答了没」。
	 */
	readonly noteUnanswered?: (info: {
		readonly slug: string;
		readonly label: string;
		readonly seq: number;
		readonly reason: string | undefined;
	}) => Promise<void>;
};

/** 这个频道是不是「我和某个人的私聊」。形态按成员推，不看 id 前缀。 */
function isOwnerDm(channel: Channel, viewer: string | undefined): boolean {
	if (chatKind(channel) !== "dm") return false;
	return viewer === undefined || channel.members.includes(viewer);
}

/**
 * 每轮贴在投递正文末尾的「怎么回话」。
 *
 * 为什么不写进系统提示词：静态规矩在长上下文里会被稀释，而这一段贴着生成点，
 * 每轮重申一次。ds-bot 就是这么干的（`groups.js:102` 的 `ROOM_REPLY`），实测比
 * 把规矩放在系统提示里有效一个量级。
 *
 * **正文在 `prompt/80-reply.md`，这里只填两个条件句**（契约 §4 第 4 条：整句插槽只许
 * 出现在 delivery 段）。模板由 `deliver()` 每轮现读一次当参数传进来 —— 这一层保持纯函数，
 * 单测照样能跑，而「改模板下一条生效」不丢。
 */
export function renderReplyRules(options: {
	readonly woken: readonly string[];
	readonly viewer?: string | undefined;
	readonly labelOf?: ((slug: string) => string) | undefined;
	/** 这个频道里除自己和我之外的成员。有他们才提「成员的事在群里说」。 */
	readonly colleagues?: readonly string[] | undefined;
	/** `prompt/80-reply.md` 的正文。空串 = 没有模板（整段不贴）。 */
	readonly template: string;
}): string {
	if (options.template.trim() === "") return "";
	const others = options.woken.filter((slug) => slug !== options.viewer);
	const label = options.labelOf ?? ((slug: string) => slug);
	const colleagues = (options.colleagues ?? []).filter((slug) => slug !== options.viewer);
	// 模板里 `{{tool:say}}` 那个名字（模板没写就退回字面 `say`：工具名在这一层只有这一处）。
	const say = toolSlots(options.template)["tool:say"] ?? "say";

	// 两个条件句都必须有值：模板里它们是**整行**，留空会渲染成「（未设置）」占一行。
	const slots: Record<string, SlotValue> = {
		// `{{tool:say}}` 这类：按名字自解释（投递层没有注册表，见 `text.ts` 的 `toolSlots`）。
		...toolSlots(options.template),
		"reply.alone":
			others.length === 0
				? // 「必须回」不够：模型会理解成「在会话里答一句也算回」（实测 3/3 都不调 say）。
					// 它必须知道**回的动作是发一条频道消息**，而且要先发再收工。工具名从模板的
					// `{{tool:say}}` 取，模板那边有 seed 侧的对表检查（名字写错会红）。
					`（这一轮只有你被叫醒：必须回，回的就是结果 —— 用 ${say} 把它发到这个频道，不要在会话里答完就算。）`
				: `（没有新东西就不说：只把 text 写成 \`[PASS]\`，这条不会发出去 —— 这一轮还有 ${others
						.map((slug) => label(slug))
						.join("、")} 在。）`,
		"reply.colleagues":
			colleagues.length === 0
				? "（这个频道里只有你和我：不用为找一个人绕道。）"
				: `（成员的事就在这个频道说：要问 ${colleagues.map(label).join("、")} 就 @ 他，他会收到、也看得到上下文。不要为了找一个人去私聊 —— 成员之间的私聊系统不允许。）`,
	};
	return renderSlots(options.template, slots).text.trim();
}

/** 一条消息交给模型时的正文。纯函数，方便单测。 */
export function renderDelivery(options: {
	readonly channel: Channel;
	readonly message: Message;
	/** 收件人。用来从「还 @ 了」里剔掉自己——否则每个人都会看到「还 @ 了你」。 */
	readonly viewer?: string | undefined;
	readonly labelOf?: ((slug: string) => string) | undefined;
	/** 这句是插进一轮正在跑的工作里的。 */
	readonly interrupted?: boolean;
	/** 附件说明（`planAttachments` 的 `lines`）。没有附件时为空。 */
	readonly attachmentLines?: readonly string[];
	/** `prompt/80-reply.md` 的正文。空串 = 整段不贴。 */
	readonly replyTemplate: string;
	/** `prompt/90-interrupted.md` 的正文。空串 = 插话那两句不贴。 */
	readonly interruptedTemplate: string;
}): string {
	const label = options.labelOf ?? ((slug: string) => slug);
	const { channel, message } = options;
	const quoted =
		message.replyTo === undefined ? "" : `（回复 #${message.replyTo}）`;
	const others = message.mentions.filter(
		(slug) => slug !== message.from && slug !== options.viewer,
	);
	const also = others.length === 0 ? "" : `\n这条还 @ 了：${others.map(label).join("、")}`;
	// 「这条会叫醒谁、你是第几个」和「别人也在看」必须由代码注入：模型看不到投递名单，
	// 于是两个人被同时叫醒时各写一条重复甚至矛盾的回复，谁也不知道对方也在场。
	const woken = recipientsOf(channel, message).filter((slug) => slug !== OWNER);
	const line = [also];
	if (woken.length > 0) {
		const position =
			options.viewer === undefined ? "" : `（你在第 ${woken.indexOf(options.viewer) + 1 || 1} 位）`;
		line.push(`\n这条会叫醒：${woken.map(label).join("、")}${position}`);
		if (woken.length > 1) {
			line.push("\n别人也在看这条。动手前先说一句你接哪一块，别重复别人已经做的。");
		}
	}
	return [
		// 第一行必须带**频道 id**：模型以前只看到标题，于是它只能用 `say` 的缺省频道回话；
		// 一旦缺省频道猜错（例如猜成私聊），整段对话就跑到别的房间里去了。
		`【${channel.title}】#${message.seq}（频道 ${channel.id}）${quoted}`,
		`${label(message.from)}：${message.text}${line.join("")}`,
		...(isOwnerDm(channel, options.viewer)
			? ["（这是你和我的私聊，只回这里，别去群里说）"]
			: []),
		...(options.attachmentLines === undefined || options.attachmentLines.length === 0
			? []
			: ["", "附件：", ...options.attachmentLines]),
		// 「怎么回话」每轮贴在最后：它比系统提示词里的同一句规矩有效得多。
		renderReplyRules({
			template: options.replyTemplate,
			woken,
			viewer: options.viewer,
			labelOf: label,
			// 只在群聊里说「成员的事在群里说」：私聊里没有第三方，提了反而让它去找人。
			colleagues:
				chatKind(channel) === "dm"
					? []
					: channel.members.filter((slug) => slug !== OWNER && slug !== options.viewer),
		}),
		...(options.interrupted === true && options.interruptedTemplate.trim() !== ""
			? [renderSlots(options.interruptedTemplate, toolSlots(options.interruptedTemplate)).text.trim()]
			: []),
	].join("\n");
}

/** delivery 段的三份模板：每轮回话规矩、插话那一句、沉淀指令。 */
export type DeliveryPrompt = {
	readonly reply: string;
	readonly interrupted: string;
	readonly settle: string;
};

/**
 * 读 delivery 段的模板（`80-reply.md` / `90-interrupted.md` / `95-settle.md`）。
 *
 * 缺哪段就空串（调用方整段不贴）：模板是 workspace 里的活文件，可能被改成任意样子，
 * 读不到不该让投递失败 —— 但也不能静默：读不到就 warn 一次。
 */
export async function deliveryPrompt(promptDir: string | undefined): Promise<DeliveryPrompt> {
	if (promptDir === undefined) {
		console.warn("[core] 投递没拿到模板目录（prompt/）：回话规矩不会贴");
		return { reply: "", interrupted: "", settle: "" };
	}
	// `promptDir` 本身就是模板目录，所以段目录是 `.`（不是默认的 `prompt`，那会变成 prompt/prompt）。
	const templates = await loadTemplates(createFsx(promptDir), ".");
	const delivery: readonly PromptTemplate[] = templates.filter((template) => template.use === "delivery");
	const bodyOf = (segment: string): string => delivery.find((item) => item.segment === segment)?.body ?? "";
	const prompt = { reply: bodyOf("reply"), interrupted: bodyOf("interrupted"), settle: bodyOf("settle") };
	if (prompt.reply === "") console.warn(`[core] ${promptDir} 里没有回话模板（80-reply.md）：这一段不会贴`);
	return prompt;
}

/** 未读摘要：这个人所有频道里还有多少没看。纯函数。 */
export function renderDigest(state: ChannelState, slug: string, limit = 5): string {
	const rows: string[] = [];
	let total = 0;
	for (const channel of channelsOf(state, slug)) {
		const unread = unreadCount(state, channel.id, slug);
		if (unread === 0) continue;
		total += unread;
		const last = tail(state, channel.id, 1)[0];
		const preview = last === undefined ? "" : ` — ${oneLine(last.text, 60)}`;
		rows.push(`- ${channel.title}：${unread} 条${preview}`);
		if (rows.length >= limit) break;
	}
	if (rows.length === 0) return "";
	// 「未读摘要」写得太像任务，模型会把它当成要回的东西 —— 实测一次积压 39 条时，
	// 它答的是摘要里的旧问题，而不是刚投进来的这一条。所以这里明说它是背景。
	return [
		`【背景：别的频道里还有 ${total} 条没看】`,
		...rows,
		"（这不是要你现在回的。要用 chats(action=read) 看；先答上面那条。）",
	].join("\n");
}

/**
 * 逐条投递。
 *
 * `requestId` 由「频道 + seq + slug」拼成：同一条消息重复投递会被底层去重，
 * 这是崩溃恢复下的至少一次语义想要的。
 */
export async function deliver(
	options: DeliverOptions,
	context: Context = BACKGROUND_CONTEXT,
): Promise<DeliverResult> {
	const delivered: string[] = [];
	const failed: string[] = [];
	const skipped: string[] = [];
	const mergedList: { slug: string; count: number }[] = [];
	const issues: DeliverIssue[] = [];
	const label = options.labelOf ?? ((slug: string) => slug);
	// 回话规矩每轮现读一次（不缓存：改模板要能下一条生效）。所有收件人共用同一份。
	const prompt = await deliveryPrompt(options.promptDir);
	// 附件只读一次：所有收件人拿到的是同一份图片内容块。
	const plan = await planAttachments(options.uploadsRoot, options.message.attachments);
	const bodyOf = (viewer: string, interrupted: boolean): string =>
		renderDelivery({
			channel: options.channel,
			message: options.message,
			viewer,
			labelOf: label,
			interrupted,
			attachmentLines: plan.lines,
			replyTemplate: prompt.reply,
			interruptedTemplate: prompt.interrupted,
		});

	for (const slug of options.targets) {
		const conversation = await options.conversationOf(slug).catch(() => undefined);
		if (conversation === undefined) {
			skipped.push(slug);
			issues.push({ slug, reason: "no-conversation" });
			continue;
		}
		const digest = options.digests.get(slug) ?? "";
		const requestId = requestIdOf(options.channel.id, options.message, slug);
		const base = bodyOf(slug, options.busy?.has(Number(conversation.id)) === true);
		const result = await wake(
			{
				conversationOf: async (target) => (target === slug ? conversation : options.conversationOf(target)),
				coalesceQueue: options.coalesceQueue,
				noteUnanswered:
					options.noteUnanswered === undefined
						? undefined
						: async (note) => {
								await options.noteUnanswered?.({ slug: note.slug, label: note.label, seq: note.seq, reason: note.reason });
							},
				rememberWake: options.rememberWake,
			},
			{
				slug,
				requestId,
				coalesce: true,
				whenBusy: "steer",
				busy: options.busy?.has(Number(conversation.id)) === true,
				bodyOf: (merged) => {
					// 合并唤醒：告诉它「更早的几条还在频道里，先看一遍」。
					const body =
						merged === 0
							? base
							: `${base}\n\n（合并唤醒：把 ${merged} 条还没开始处理的消息并成了这一条 —— 更早的那几条内容都还在频道里，先 chats(action=read) 看一遍再答，别只答最新这条。）`;
					const text = digest === "" ? body : `${body}\n\n${digest}`;
					// 有图就发内容块：文字在前，图片在后（多数模型要求首块是文本）。
					return plan.images.length === 0 ? text : [{ type: "text", text }, ...plan.images];
				},
				entry: {
					kind: "core.channel",
					data: {
						channelId: options.channel.id,
						channelTitle: options.channel.title,
						seq: options.message.seq,
						from: options.message.from,
						text: options.message.text.slice(0, 400),
						mentions: [...options.message.mentions],
					},
				},
				wakeRecord: {
					channelId: options.channel.id,
					seq: options.message.seq,
					from: options.message.from,
					at: options.message.at,
				},
				note: { channelId: options.channel.id, seq: options.message.seq, label: label(slug) },
			},
			context,
		);

		if (result.status === "delivered") {
			if (result.merged > 0) mergedList.push({ slug, count: result.merged });
			delivered.push(slug);
		} else if (result.status === "failed") {
			process.stderr.write(
				`[投递失败] ${options.channel.id}#${options.message.seq} → ${slug}: ${result.detail}\n`,
			);
			failed.push(slug);
			issues.push({ slug, reason: "failed", detail: result.detail });
		} else {
			skipped.push(slug);
			issues.push({ slug, reason: "no-conversation" });
		}
	}

	// 通报放在最后、一次说完：逐条写 note 会让频道多出一串系统消息。
	// 我被 `recipientsOf` 选中是正常现象（他没有会话），所以那一条由调用方先滤掉。
	if (issues.length > 0 && options.notify !== undefined) {
		try {
			await options.notify(issues);
		} catch (error) {
			process.stderr.write(
				`[投递通报失败] ${options.channel.id}#${options.message.seq}: ${
					error instanceof Error ? error.message : String(error)
				}\n`,
			);
		}
	}

	return { delivered, failed, skipped, ...(mergedList.length === 0 ? {} : { merged: mergedList }) };
}

/** 幂等键：频道 + seq + slug。同一条消息重复投递只醒一次（至少一次语义）。 */
function requestIdOf(channelId: string, message: Message, slug: string): string {
	return `ch:${message.from === "owner" ? "owner:" : ""}${channelId}:${message.seq}:${slug}`;
}

/**
 * 同一个会话里「还没开始」的排队项 —— 可以被这一条合并唤醒的那些。
 *
 * 三条约束（知言 2026-10-30 定）：
 * 1. **同一会话最多保留一个未开始的排队项**：所以每次投递前先把旧的撤掉；
 * 2. **正在跑的那条不算**：只认 `status: "queued"`，`placed` 已经开始了，它不会被撤；
 * 3. **消息一条都不删**：撤的只是唤醒，那几条消息还在频道里，醒来读一遍就看到。
 *
 * 我连发的几条**也合并**（2026-10-30 我定）：他连说三句时，对方醒来读一遍频道就能
 * 把三句一起答；排三个唤醒只会让它跑三趟、还各答一遍。消息一条都不删，所以「三句都看到」
 * 不受影响。这里同时是**唯一**一份「谁该让路」的判据 —— 旧代码里我插队另有一个
 * `choresAheadOf`（跳过我自己的排期），两套口径迟早分叉，已合并到这里。
 */
export function queuedAhead(
	submissions: readonly {
		readonly id: number | bigint | string;
		readonly conversationId: number | bigint | string;
		readonly status: string;
		readonly requestId?: string | undefined;
	}[],
	conversationId: number,
	keepRequestId?: string,
	max = 8,
): (number | bigint | string)[] {
	const out: (number | bigint | string)[] = [];
	for (const submission of submissions) {
		if (Number(submission.conversationId) !== conversationId) continue;
		if (submission.status !== "queued") continue;
		if (keepRequestId !== undefined && submission.requestId === keepRequestId) continue;
		out.push(submission.id);
		if (out.length >= max) break;
	}
	return out;
}

/**
 * 合并唤醒的执行器（也负责我插队）：撤掉这个会话里还没开始的排队项，返回撤了几条。
 *
 * 我发消息时走的也是这里 —— 以前另有一条 `clearQueueAhead`，两个函数会去撤同一批
 * 排队项（第二次白跑一趟），现在只有这一条路。
 *
 * 撤不掉（已经在跑、或者竞态里被别人取走）就跳过 —— 多叫醒一次只是慢，
 * 而「以为撤掉了其实没撤」会让人以为消息丢了。
 */
export async function coalesceQueue(
	harness: Harness,
	conversationId: number,
	keepRequestId: string,
	context: Context = BACKGROUND_CONTEXT,
): Promise<number> {
	const inspection = await harness.inspect(context);
	const pending = queuedAhead(inspection.submissions, conversationId, keepRequestId);
	let merged = 0;
	for (const id of pending) {
		try {
			await harness.abortSubmission(
				id as Parameters<Harness["abortSubmission"]>[0],
				context,
				conversationId as Parameters<Harness["abortSubmission"]>[2],
			);
			merged += 1;
		} catch {
			// 撤不掉就算了：那一条照样会被答，只是多一次唤醒。
		}
	}
	return merged;
}

/**
 * 哪些会话此刻手上有活。
 *
 * 用 `harness.inspect()`（只读、不写、不跑任务）取「活着的任务」，按会话聚合，
 * 排掉后台任务 —— 后台任务是代理自己的账本，不算「打断它正在干的事」。
 */
export async function liveConversations(
	harness: Harness,
	context: Context = BACKGROUND_CONTEXT,
): Promise<Set<number>> {
	const inspection = await harness.inspect(context);
	const busy = new Set<number>();
	for (const task of inspection.tasks) {
		if (task.record.background === true) continue;
		busy.add(Number(task.record.conversationId));
	}
	return busy;
}
