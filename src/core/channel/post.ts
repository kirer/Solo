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
	parseMentions,
	recipientsOf,
	relayLimit,
	type Attachment,
	type Channel,
	type ChannelState,
	type Message,
} from "./state.ts";
import { EMPTY_ROSTER } from "./alias.ts";
import type { MentionRoster } from "./alias.ts";
import {
	deliver,
	coalesceQueue,
	liveConversations,
	renderDigest,
	type DeliverIssue,
	type DeliverResult,
	type WakeRecord,
} from "./deliver.ts";
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

