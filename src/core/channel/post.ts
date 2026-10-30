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
	deliveryTargets,
	type Attachment,
	type Channel,
	type ChannelState,
	type Message,
} from "./store.ts";
import {
	deliveryPrompt,
	digestNotice,
	digestRows,
	mergedNotice,
	renderDelivery,
	type DeliveryPrompt,
} from "./delivery.ts";
import { planAttachments } from "./attachments.ts";
import { wake, type WakeRecord, type WakeTarget } from "./wake.ts";
import type { MentionRoster } from "./store.ts";
import type { FinishTurn } from "./turn.ts";
import { renderUnanswered } from "./unanswered.ts";
import { createSerialGate } from "../runtime/io.ts";
import { coalesceQueue, liveConversations } from "./queue.ts";

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
	/** 读上一次的唤醒记录：忙的时候要在它上面保留 `task`（私聊插话不覆盖任务频道）。 */
	readonly wakeOf?: (slug: string) => Promise<WakeRecord | undefined>;
	/** 一轮正常答完时的收尾（最终回答自动成消息）。 */
	readonly finishTurn?: FinishTurn;
	/** 频道 id → 标题（收尾/插话文案里说清「回哪儿」）。 */
	readonly titleOf?: (channelId: string) => string | undefined;
	/** 附件根目录。给了模型就能真的看见消息里的图片。 */
	readonly uploadsRoot?: string;
	/** 提示词模板目录（`<workspace>/prompt`）。投递要用它贴「怎么回话」那两段。 */
	readonly promptDir?: string;
};

/** 一条要落进频道的消息（`postMessage` 与 `appendNote` 的公共形状）。 */
type AppendInput = {
	readonly channelId: string;
	readonly from: string;
	readonly text: string;
	readonly at: number;
	readonly kind?: string;
	readonly replyTo?: number;
	readonly roster?: MentionRoster;
	readonly mention?: readonly string[];
	readonly attachments?: readonly Attachment[];
};

/**
 * 消息落盘的**唯一**实现：一次 commit，一次路径式 push。
 *
 * `postMessage`（说话）与 `appendNote`（系统留痕）都走这里。以前各写一份，其中
 * `appendNote` 没有 seq 自愈 —— 频道文档的 `nextSeq` 一旦落后，留痕会拿到一个撞号的
 * seq。同一类错误只该在一处发生，所以也只在修一处能修好。
 *
 * 频道不存在返回 `undefined`（调用方自己决定是报错还是静默）；其余失败照常抛。
 */
async function appendToChannel(
	deps: { readonly harness: Harness },
	input: AppendInput,
	context: Context,
): Promise<{ readonly channel: Channel; readonly message: Message } | undefined> {
	let appended: { readonly channel: Channel; readonly message: Message } | undefined;
	await deps.harness.commit(async (tx) => {
		const doc = (await tx.doc(ChannelDoc)) as ChannelState;
		const channel = doc.channels[input.channelId];
		if (channel === undefined) return;
		// 序号以**消息本身**为准，不以 `nextSeq` 为准（撞号的后果见 `postMessage` 的说明）。
		const highestSeq = (doc.messages[input.channelId] ?? []).reduce((max, item) => (item.seq > max ? item.seq : max), 0);
		if ((doc.nextSeq[input.channelId] ?? 1) <= highestSeq) doc.nextSeq[input.channelId] = highestSeq + 1;
		// `appendMessage` 返回的是新 state；这里只要它算好的 message，写入按路径原地做。
		const next = appendMessage(doc, input.channelId, {
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
		// 新数组」。两者写下去的消息一样，代价差三个数量级（见 `test/core/channel-write.test.ts`）。
		//
		// `push` 必须作用在**文档代理给出的那个数组**上：`doc.messages[id] ??=` 之后再 push
		// 本地变量不算数（那不是代理，提交时不会有任何 op，消息静默消失）。
		doc.messages[input.channelId] ??= [];
		(doc.messages[input.channelId] as Message[]).push(next.message);
		doc.nextSeq[input.channelId] = next.message.seq + 1;
		// 抄成纯对象再交出去：事务一关就不能再读代理（`Cannot use a settled overlay`）。
		appended = {
			channel: { ...channel, members: [...channel.members], wakeOnAll: [...channel.wakeOnAll] },
			message: JSON.parse(JSON.stringify(next.message)) as Message,
		};
	}, context);
	return appended;
}

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
	await appendToChannel(deps, { channelId, from: OWNER, text, at, kind: "note" }, context);
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

	// 提交之前先把「后面还要读到的东西」抄成纯数据：提交一关，读覆盖层就释放了，
	// 而成员列表、wakeOnAll、各人未读都要在提交之后才用得上。
	const channelMeta: Channel = {
		...channel,
		members: [...channel.members],
		wakeOnAll: [...channel.wakeOnAll],
	};
	const digestParts = new Map<string, { readonly total: number; readonly rows: readonly string[] }>();
	for (const slug of channelMeta.members) {
		if (slug === OWNER) continue;
		digestParts.set(slug, digestRows(deps.state, slug));
	}
	const appended = await appendToChannel(deps, input, context);
	if (appended === undefined) throw new Error(`频道不存在：${input.channelId}`);
	const message = appended.message;

	const liveChannel = channelMeta;
	if (input.wake === false || input.kind === "note") {
		return { channel: liveChannel, message, delivery: { delivered: [], failed: [], skipped: [] } };
	}

	// 我没有会话：它是「人」，不是 agent。`deliver` 会把它算进 skipped。
	const targets = deliveryTargets(liveChannel, message);
	if (targets.length === 0) {
		return { channel: liveChannel, message, delivery: { delivered: [], failed: [], skipped: [] } };
	}
	// 谁手上还有活：投递会打断他，正文要说明「这是插话，不是新任务」。
	// 取不到就当没人忙 —— 宁可少一句话，也不能让每次投递都失败。
	const busy = await liveConversations(deps.harness, context).catch(() => new Set<number>());
	const labelOf = deps.labelOf ?? ((slug: string) => slug);
	// 模板只读一次：摘要和正文用同一份，改 md 下一条生效。
	const prompt = await deliveryPrompt(deps.promptDir);
	// 摘要用**写之前**的 state：这条新消息已经在正文里了，再算进未读数会重复。
	const digests = new Map(
		[...digestParts].map(([slug, part]) => [slug, digestNotice(prompt.digest, part.total, part.rows)]),
	);
	const delivery = await deliver(
		{
			digests,
			prompt,
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
			...(deps.wakeOf === undefined ? {} : { wakeOf: deps.wakeOf }),
			...(deps.finishTurn === undefined ? {} : { finishTurn: deps.finishTurn }),
			titleOf: (channelId) => deps.state.channels[channelId]?.title,
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

export type { WakeRecord } from "./wake.ts";

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
	/** 已经读好的 delivery 模板；不给就现读一次（`promptDir`）。 */
	readonly prompt?: DeliveryPrompt;
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
	/** 读上一次的唤醒记录：忙的时候从它里面继承 `task`。缺省当没有（`task = reply`）。 */
	readonly wakeOf?: (slug: string) => Promise<WakeRecord | undefined>;
	/** 一轮正常答完时的收尾。缺省不补发。 */
	readonly finishTurn?: FinishTurn;
	/** 频道 id → 标题。插话文案里用标题说「回去哪个频道」。缺省直接用 id。 */
	readonly titleOf?: (channelId: string) => string | undefined;
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
	const prompt = options.prompt ?? (await deliveryPrompt(options.promptDir));
	// 附件只读一次：所有收件人拿到的是同一份图片内容块。
	const plan = await planAttachments(options.uploadsRoot, options.message.attachments);
	const bodyOf = (viewer: string, interrupted: boolean, taskChannelTitle?: string): string =>
		renderDelivery({
			channel: options.channel,
			message: options.message,
			viewer,
			labelOf: label,
			interrupted,
			...(taskChannelTitle === undefined ? {} : { taskChannelTitle }),
			attachmentLines: plan.lines,
			prompt,
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
		const interrupted = options.busy?.has(Number(conversation.id)) === true;
		// 两层唤醒记录：这一句回哪儿（`reply`）与手上那件活属于哪儿（`task`）。
		// 打断他正在跑的一轮时，`task` 继承上一次的记录 —— 私聊插话不覆盖任务频道，
		// 否则插话结束，团队频道就再也等不到结论（ADR-099）。
		const reply: WakeTarget = {
			channelId: options.channel.id,
			seq: options.message.seq,
			from: options.message.from,
			at: options.message.at,
		};
		const previous = options.wakeOf === undefined ? undefined : await options.wakeOf(slug).catch(() => undefined);
		const task = interrupted && previous !== undefined ? previous.task : reply;
		const taskChannelTitle =
			task.channelId === options.channel.id
				? undefined
				: (options.titleOf?.(task.channelId) ?? task.channelId);
		const base = bodyOf(slug, interrupted, taskChannelTitle);
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
				finishTurn: options.finishTurn,
			},
			{
				slug,
				requestId,
				coalesce: true,
				whenBusy: "steer",
				busy: options.busy?.has(Number(conversation.id)) === true,
				bodyOf: (merged) => {
					// 合并唤醒：告诉它「更早的几条还在频道里，先看一遍」。文案在 87-merged.md。
					const note = merged === 0 ? "" : mergedNotice(prompt.merged, merged);
					const body = note === "" ? base : `${base}\n\n${note}`;
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
				wakeRecord: { reply, task },
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
