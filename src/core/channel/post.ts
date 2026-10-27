/**
 * 发消息：落库 + 唤醒，成对完成。
 *
 * 这是新核心里唯一「写频道」的入口。落库与唤醒必须在同一个地方做，否则会出现
 * 两种静默失败：
 *
 * - **存了没叫**（消息在，人不知道）——旧核心踩过一次：`say` 不解析正文里的
 *   `@`，CPO 用 `say` 发了「@CEO 项目已建好」，CEO 从来没被唤醒，项目静默停摆。
 * - **叫了没存**（人醒来看不到东西）——不会报错，只会让 agent 反复「你说什么？」。
 *
 * 所以 `postMessage` 里三件事固定这个顺序：解析 @ → 写文档 → 唤醒收件人。
 */
import type { Conversation, Harness } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT, type Context } from "../runtime/index.ts";
import { ChannelDoc, OWNER, appendMessage, recipientsOf, type Channel, type ChannelState, type Message } from "./state.ts";
import { deliver, type DeliverResult, type WakeRecord } from "./deliver.ts";

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
	/** 不想唤醒任何人（比如系统留痕）。缺省会唤醒。 */
	readonly wake?: false;
};

export type PostDeps = {
	readonly harness: Harness;
	readonly state: ChannelState;
	readonly conversationOf: (slug: string) => Promise<Conversation | undefined>;
	readonly labelOf?: (slug: string) => string;
	readonly rememberWake?: (slug: string, wake: WakeRecord) => Promise<void>;
};

/**
 * 写一条消息并唤醒该唤醒的人。
 *
 * 文档写入用 `commit` + 路径式追加（推一条 + 改两个数字），**不整频道替换**：
 * 一个群频道可以有 800 条消息，整值替换会让每条消息重写整个频道（旧核心实测
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
		});
		// 必须**整体替换**这个键，不能用 list.push()：文档的读取给的是副本，
		// 往里 push 不会产生任何 op，提交后消息会静默消失（实测踩过）。
		state.messages[input.channelId] = [...(state.messages[input.channelId] ?? []), next.message];
		state.nextSeq[input.channelId] = next.message.seq + 1;
		created = next.message;
	}, context);

	const message = created as Message;
	if (input.wake === false || input.kind === "note") {
		return { channel, message, delivery: { delivered: [], failed: [], skipped: [] } };
	}

	// 老板没有会话：它是「人」，不是 agent。`deliver` 会把它算进 skipped。
	const targets = recipientsOf(channel, message).filter((slug) => slug !== OWNER);
	if (targets.length === 0) {
		return { channel, message, delivery: { delivered: [], failed: [], skipped: [] } };
	}
	const delivery = await deliver(
		deps.harness,
		{
			// 摘要用**写之前**的 state：这条新消息已经在正文里了，再算进未读数会重复。
			state: deps.state,
			channel,
			message,
			targets,
			conversationOf: deps.conversationOf,
			...(deps.labelOf === undefined ? {} : { labelOf: deps.labelOf }),
			...(deps.rememberWake === undefined ? {} : { rememberWake: deps.rememberWake }),
		},
		context,
	);
	return { channel, message, delivery };
}
