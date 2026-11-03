/**
 * 频道落盘：把一条消息写进 `ChannelDoc`，只此一处。
 *
 * 这里**不叫醒人**：投递是 `post.ts` / `dispatch.ts` 的事。留痕（`appendNote`）与
 * 发言（`postMessage`）共用同一个写入实现，seq 自愈、路径式 push 都只在这里发生。
 */
import type { Context, Harness } from "../runtime/index.ts";
import { ChannelDoc, OWNER, type Attachment, type Channel, type ChannelState, type Message } from "./types.ts";
import { appendMessage } from "./rules.ts";
import type { MentionRoster } from "./mentions.ts";

type AppendInput = {
	readonly channelId: string;
	readonly from: string;
	readonly text: string;
	readonly at: number;
	/** 唯一的非默认 kind：系统留痕。发言不传，落库就是 `chat`。 */
	readonly kind?: "note";
	readonly noteOf?: string;
	readonly replyTo?: number;
	readonly roster?: MentionRoster;
	readonly mention?: readonly string[];
	readonly attachments?: readonly Attachment[];
	readonly options?: readonly string[];
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
export async function appendToChannel(
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
			...(input.noteOf === undefined ? {} : { noteOf: input.noteOf }),
			...(input.replyTo === undefined ? {} : { replyTo: input.replyTo }),
			...(input.roster === undefined ? {} : { roster: input.roster }),
			...(input.mention === undefined ? {} : { mention: input.mention }),
			...(input.attachments === undefined ? {} : { attachments: input.attachments }),
			...(input.options === undefined ? {} : { options: input.options }),
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
 * 只要求 `harness`（不需要完整的 `PostDeps`）：系统留痕（异常报告、报到）也走这里。
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
