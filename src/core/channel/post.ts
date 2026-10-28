/**
 * 发消息：落库 + 唤醒，成对完成。
 *
 * 这是新核心里唯一「写频道」的入口。落库与唤醒必须在同一个地方做，否则会出现
 * 两种静默失败：
 *
 * - **存了没叫**（消息在，人不知道）——踩过一次：`say` 不解析正文里的
 *   `@`，CPO 用 `say` 发了「@CEO 项目已建好」，CEO 从来没被唤醒，项目静默停摆。
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
	type Channel,
	type ChannelState,
	type Message,
} from "./state.ts";
import { EMPTY_ROSTER } from "./alias.ts";
import type { MentionRoster } from "./alias.ts";
import { deliver, liveConversations, type DeliverIssue, type DeliverResult, type WakeRecord } from "./deliver.ts";

// T-016 v2：占位填充时的逐字增量推送钩子。由 serveCore 在启动时挂载（写进 channelClients），
// 未挂载时为空操作 —— post.ts 不依赖 shell/serve，避免循环依赖。
// 语义：某条 pending 占位被真实回复原地填充时，推 `token`（分片增量）+ `done`（全文兜底）。
type ChannelStreamHook = (channelId: string, seq: number, fullText: string) => void;
let channelStreamHook: ChannelStreamHook | undefined;
export function setChannelStreamHook(hook: ChannelStreamHook | undefined): void {
	channelStreamHook = hook;
}

/** T-016 v2：该频道是否还有前端 SSE 订阅（serveCore 注入的查询函数）。无人订阅则不产生增量事件。 */
let channelClientsHas: (channelId: string) => boolean = () => false;
export function setChannelClientsHas(fn: (channelId: string) => boolean): void {
	channelClientsHas = fn;
}

export type PostResult = {
	readonly channel: Channel;
	readonly message: Message;
	/** 没唤醒任何人时是空数组。 */
	readonly delivery: DeliverResult;
};

export type PostInput = {
	readonly channelId: string;
	readonly from: string;
	readonly text: string;
	readonly at: number;
	readonly kind?: string;
	readonly replyTo?: number;
	/** 名册：给了就按名册把 `@老板` / `@CEO` 落库成规范 slug。 */
	readonly roster?: MentionRoster;
	/** 正文里没写、但要记进 `mentions` 的 slug（`decision` 自动补 `owner` 走这条）。 */
	readonly mention?: readonly string[];
	/** 不想唤醒任何人（比如系统留痕）。缺省会唤醒。 */
	readonly wake?: false;
	/** T-016：占位消息生成状态（缺省 undefined → done）。 */
	readonly status?: "pending" | "done" | "error";
	/** T-016：占位归属的被唤醒人 slug。 */
	readonly pendingFor?: string;
};

export type PostDeps = {
	readonly harness: Harness;
	readonly state: ChannelState;
	readonly conversationOf: (slug: string) => Promise<Conversation | undefined>;
	readonly labelOf?: (slug: string) => string;
	readonly rememberWake?: (slug: string, wake: WakeRecord) => Promise<void>;
};

/**
 * 追一条系统留痕到频道。`note` 不唤醒、不计未读（见 `Message.kind`），所以这里不碰
 * 投递层，否则「系统说一下没人被叫醒」会反过来叫醒人。
 */
async function appendNote(deps: PostDeps, channelId: string, text: string, at: number, context: Context): Promise<void> {
	await deps.harness.commit(async (tx) => {
		const doc = (await tx.doc(ChannelDoc)) as ChannelState;
		const next = appendMessage(doc, channelId, { from: OWNER, text, at, kind: "note" });
		const list = doc.messages[channelId];
		if (list === undefined) doc.messages[channelId] = [next.message];
		else (list as Message[]).push(next.message);
		doc.nextSeq[channelId] = next.message.seq + 1;
	}, context);
}

/** 投递没成时给老板留一句话。分开列，不糊成一句：两种原因的处置完全不同。 */
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
	const channel = deps.state.channels[input.channelId];
	if (channel === undefined) throw new Error(`频道不存在：${input.channelId}`);

	let created: Message | undefined;
	let filledSeq: number | undefined;
	let filledText = "";
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
		// appendMessage 返回的是新 state；这里只要它算好的 message，写入按路径原地做。
		const next = appendMessage(state, input.channelId, {
			from: input.from,
			text: input.text,
			at: input.at,
			...(input.kind === undefined ? {} : { kind: input.kind }),
			...(input.replyTo === undefined ? {} : { replyTo: input.replyTo }),
			...(input.roster === undefined ? {} : { roster: input.roster }),
			...(input.mention === undefined ? {} : { mention: input.mention }),
			...(input.status === undefined ? {} : { status: input.status }),
			...(input.pendingFor === undefined ? {} : { pendingFor: input.pendingFor }),
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
		const list = doc.messages[input.channelId];
		// T-016 占位吸收：非占位消息（真实发言）落到频道时，若本频道还有一条
		// `status==="pending" && pendingFor===input.from && text===""` 的占位（自己之前被 @ 后留的 loading 气泡），
		// 就**原地填充**它（把 text/mentions/kind/at 写成真实回复、status 置 done），不另开一条 —— 占位即最终消息。
		// 占位创建时 text="" 不会命中（被吸收的是非空消息）。
		const isFillingRealReply =
			input.status !== "pending" &&
			input.text.trim() !== "" &&
			list !== undefined;
		let finalMessage: Message = next.message;
		if (isFillingRealReply) {
			const arr = list as Message[];
			const idx = arr.findIndex(
				(m) => m.status === "pending" && m.pendingFor === input.from && (m.text ?? "").trim() === "",
			);
			if (idx >= 0) {
				// 下标替换 = 数组结构性变更，文档代理稳定落盘（保留占位原 seq/from/pendingFor）。
				const placeholder = arr[idx]!;
				filledSeq = placeholder.seq;
				filledText = input.text;
				arr[idx] = {
					...placeholder,
					text: input.text,
					mentions: next.message.mentions,
					kind: next.message.kind,
					at: input.at,
					status: "done",
				};
				finalMessage = arr[idx]!;
			}
		}
		if (finalMessage === next.message) {
			if (list === undefined) doc.messages[input.channelId] = [next.message];
			else (list as Message[]).push(next.message);
			state.nextSeq[input.channelId] = next.message.seq + 1;
		}
		// 接力到上限：**只落消息、不投递**，再留一条 note 说清楚为什么没人被叫醒。
		// 不投递就是暂停：消息已经在频道里任何人随时能读到，「继续」不需要按钮 ——
		// 老板一发言 `botHopsSinceOwner` 自动归零。
		if (capped) {
			const noted = appendMessage(state, input.channelId, {
				from: OWNER,
				text: `接力到上限（${cappedLimit} 次）：这条只记下，没人被叫醒。老板说一句，或者自己 @ 人，就能接着走。`,
				at: input.at,
				kind: "note",
			});
			(doc.messages[input.channelId] as Message[]).push(noted.message);
			state.nextSeq[input.channelId] = noted.message.seq + 1;
		}
		created = finalMessage;
	}, context);

	const message = created as Message;
	// T-016 v2：占位被真实回复原地填充 → 推逐字增量（token 分片 + done 全文兜底）。
	// 后端落库层已写好最终全文，这里只负责「把全文按片推给前端做渐显」，不重复写库。
	if (filledSeq !== undefined && channelClientsHas(channel.id) && channelStreamHook !== undefined) {
		channelStreamHook(channel.id, filledSeq, filledText);
	}
	if (input.wake === false || input.kind === "note") {
		return { channel, message, delivery: { delivered: [], failed: [], skipped: [] } };
	}
	if (capped) return { channel, message, delivery: { delivered: [], failed: [], skipped: [] } };

	// 老板没有会话：它是「人」，不是 agent。`deliver` 会把它算进 skipped。
	const targets = recipientsOf(channel, message).filter((slug) => slug !== OWNER);
	if (targets.length === 0) {
		return { channel, message, delivery: { delivered: [], failed: [], skipped: [] } };
	}
	// 谁手上还有活：投递会打断他，正文要说明「这是插话，不是新任务」。
	// 取不到就当没人忙 —— 宁可少一句话，也不能让每次投递都失败。
	const busy = await liveConversations(deps.harness, context).catch(() => new Set<number>());
	const labelOf = deps.labelOf ?? ((slug: string) => slug);
	const delivery = await deliver(
		{
			// 摘要用**写之前**的 state：这条新消息已经在正文里了，再算进未读数会重复。
			state: deps.state,
			channel,
			message,
			targets,
			busy,
			conversationOf: deps.conversationOf,
			...(deps.labelOf === undefined ? {} : { labelOf: deps.labelOf }),
			...(deps.rememberWake === undefined ? {} : { rememberWake: deps.rememberWake }),
			// 没人被叫醒就说一句：只写 stderr 的话，频道里一片空白，
			// 老板看到的「我说了没人理」和「系统挂了」长得一模一样。
			notify: async (issues) => {
				await appendNote(deps, channel.id, renderIssues(message.seq, issues, labelOf), Date.now(), context);
			},
		},
		context,
	);
	return { channel, message, delivery };
}
