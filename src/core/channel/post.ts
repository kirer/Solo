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
import { ChannelDoc, OWNER, appendMessage, recipientsOf, type Channel, type ChannelState, type Message } from "./state.ts";
import { deliver, liveConversations, type DeliverResult, type WakeRecord } from "./deliver.ts";

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
				arr[idx] = {
					...arr[idx]!,
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
		created = finalMessage;
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
	// 谁手上还有活：投递会打断他，正文要说明「这是插话，不是新任务」。
	// 取不到就当没人忙 —— 宁可少一句话，也不能让每次投递都失败。
	const busy = await liveConversations(deps.harness, context).catch(() => new Set<number>());
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
		},
		context,
	);
	return { channel, message, delivery };
}
