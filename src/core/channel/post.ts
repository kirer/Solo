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
 * 所以 `postMessage` 里三件事固定这个顺序：解析 @ → 写文档（`write.ts`）→
 * 唤醒收件人（`dispatch.ts`）。
 */
import type { Conversation, Harness } from "../runtime/index.ts";
import { BACKGROUND_CONTEXT, type Context } from "../runtime/index.ts";
import { OWNER, type Attachment, type Channel, type ChannelState, type Message } from "./types.ts";
import { deliveryTargets } from "./mentions.ts";
import type { MentionRoster } from "./mentions.ts";
import type { WakeRecord } from "./turn/record.ts";
import { appendNote, appendToChannel } from "./write.ts";
import { speakerBefore } from "./rules.ts";
import { deliver, type DeliverIssue, type DeliverResult } from "./dispatch.ts";
import { deliveryPrompt, digestNotice, digestRows } from "./delivery.ts";
import type { FinishTurn } from "./turn/index.ts";
import { renderUnanswered } from "./unanswered.ts";
import { createSerialGate } from "../runtime/io.ts";
import { coalesceQueue, liveConversations } from "./queue.ts";
import { fill, type TextCatalog } from "../md/catalog.ts";

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
	/** 留痕的种类（`run` = 后台命令跑完）；只对 `note` 有意义，界面据此收成一行。 */
	readonly noteOf?: string;
	readonly replyTo?: number;
	/** 名册：给了就按名册把 `@我` / `@CEO` 落库成规范 slug。 */
	readonly roster?: MentionRoster;
	/** 正文里没写、但要记进 `mentions` 的 slug（`decision` 自动补 `owner` 走这条）。 */
	readonly mention?: readonly string[];
	/** 不想唤醒任何人（比如系统留痕）。缺省会唤醒。 */
	readonly wake?: false;
	/**
	 * 系统留痕也要叫醒谁时用（后台命令跑完，叫起跑的人回来看结果）。
	 *
	 * 给了就跳过「谁被 @」的推算：`note` 默认谁也不叫，而这条的收件人不是从正文里
	 * 解析出来的，是「谁起的这条命令」。
	 */
	readonly wakeTo?: readonly string[];
	/** 附件引用。必须在这里给（不是事后补），否则投递时还不知道有图，模型就看不见。 */
	readonly attachments?: readonly Attachment[];
	/** 要我选的选项（2–6 个）。落库、进界面，投递照常。 */
	readonly options?: readonly string[];
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
	/** 机械文案目录（`text/`）。投递头、留痕、摘要行从这里取。 */
	readonly text?: TextCatalog;
};

/** 投递没成时给我留一句话。分开列，不糊成一句：两种原因的处置完全不同。 */
function renderIssues(
	seq: number,
	issues: readonly DeliverIssue[],
	labelOf: (slug: string) => string,
	catalog?: TextCatalog,
): string {
	return issues
		.map((issue) =>
			issue.reason === "failed"
				? fill(catalog, "post.issue.failed", {
						seq,
						label: labelOf(issue.slug),
						detail: issue.detail ?? fill(catalog, "post.issue.unknown"),
					})
				: fill(catalog, "post.issue.skipped", { seq, label: labelOf(issue.slug) }),
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
		digestParts.set(slug, digestRows(deps.state, slug, 5, deps.text));
	}
	const appended = await appendToChannel(deps, input, context);
	if (appended === undefined) throw new Error(`频道不存在：${input.channelId}`);
	const message = appended.message;

	const liveChannel = channelMeta;
	// `note` 默认谁也不叫（系统留痕）；显式给了 `wakeTo` 才叫 —— 后台命令跑完，
	// 起跑的那个人得回来看结果，否则这条结果只是躺在频道里。
	if (input.wake === false || (input.kind === "note" && input.wakeTo === undefined)) {
		return { channel: liveChannel, message, delivery: { delivered: [], failed: [], skipped: [] } };
	}

	// 我没有会话：它是「人」，不是 agent。`deliver` 会把它算进 skipped。
	// 我不 @ 人时接上一位说话的（`speakerBefore`），不是固定第一个成员（ADR-015）。
	const targets = input.wakeTo ?? deliveryTargets(liveChannel, message, speakerBefore(deps.state, liveChannel.id, message.seq));
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
			coalesceQueue: (conversationId, keepRequestId, incoming) =>
				coalesceQueue(deps.harness, conversationId, keepRequestId, context, incoming),
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
				await appendNote(
					deps,
					liveChannel.id,
					renderUnanswered(seq, label, reason, deps.text),
					Date.now(),
					BACKGROUND_CONTEXT,
				);
			},
			// 没人被叫醒就说一句：只写 stderr 的话，频道里一片空白，
			// 我看到的「我说了没人理」和「系统挂了」长得一模一样。
			notify: async (issues) => {
				await appendNote(
					deps,
					liveChannel.id,
					renderIssues(message.seq, issues, labelOf, deps.text),
					Date.now(),
					context,
				);
			},
		},
		context,
	);
	return { channel: liveChannel, message, delivery };
}
