// ── 投递编排 ───────────────────────────────────────────────────────────────
// 「写一条消息」与「把它交给该看的人」是一次写入的两半：收件人由消息本身算出来
// （`recipientsOf`），投递正文又由这条消息拼出来。落盘在 `write.ts`，这里只负责叫醒。
import { BACKGROUND_CONTEXT, type Context } from "../runtime/index.ts";
import type { Conversation } from "../runtime/index.ts";
import { deliveryPrompt, mergedNotice, renderDelivery, type DeliveryPrompt } from "./delivery.ts";
import { planAttachments } from "./attachments.ts";
import { wake } from "./wake.ts";
import type { Channel, Message } from "./types.ts";
import type { WakeRecord, WakeTarget } from "./turn/record.ts";
import type { FinishTurn } from "./turn/index.ts";

export type { WakeRecord } from "./turn/record.ts";

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
			woken: options.targets,
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
