/**
 * 唤醒：**叫醒一个人，只有这一条路**。
 *
 * V2 有两条路：`post()` 那条有全套兜底（合并唤醒、记 wake、没产出留痕、delivery 两段），
 * 而 `team/settle.ts` 直接 `conversation.submit()` —— 裸提示词，没留痕、没回话规矩、
 * 没合并。于是同一个「叫醒」在两处行为不同，settle 那条出问题时频道里一片空白，
 * 跟「模型不肯干」长得一模一样（实测排查了很久）。
 *
 * V3 把机制收进这一个函数，调用点只负责两件事：**叫醒谁**、**他看到什么**。
 * 其余（合并排队项、记 wake、没产出留痕、一轮一句的重置）都在这里，只写一遍。
 *
 * 分两步的理由：正文里要写「把 N 条并成了这一条」，所以**必须先合并、再拼正文**。
 * 调用点给的是 `bodyOf(merged, busy)` 而不是拼好的字符串。
 */
import type { Conversation, InputEntry, UserInput } from "../runtime/index.ts";
import { BACKGROUND_CONTEXT, type Context } from "../runtime/index.ts";
import { clearSpoken } from "./speech.ts";
import { watchSettled } from "./unanswered.ts";

/** 「刚被谁在哪个频道叫醒」。工具用它决定「默认在哪儿回话」。 */
export type WakeRecord = {
	readonly channelId: string;
	readonly seq: number;
	readonly from: string;
	readonly at: number;
};

/** 这一轮一个字都没产出时，往哪儿留痕。 */
export type WakeNote = {
	readonly slug: string;
	readonly label: string;
	readonly seq: number;
	readonly reason: string;
};

export type WakeDeps = {
	/** slug → 会话。`undefined` = 这个人没有会话（比如我）。 */
	readonly conversationOf: (slug: string) => Promise<Conversation | undefined>;
	/** 撤掉这个会话里还没开始的排队项，让新的一条取代它们。返回合并了几条。 */
	readonly coalesceQueue?: ((conversationId: number, keepRequestId: string) => Promise<number>) | undefined;
	/** 这一轮没产出时留痕。不传就只写 stderr。 */
	readonly noteUnanswered?: ((note: WakeNote) => Promise<void> | void) | undefined;
	/** 记「被谁叫醒」。不传就不记（工具会退到「我最早的那个频道」）。 */
	readonly rememberWake?: ((slug: string, wake: WakeRecord) => Promise<void>) | undefined;
};

export type WakeInput = {
	readonly slug: string;
	/** 幂等键：同一条消息重复投递只醒一次（崩溃恢复下的至少一次语义）。 */
	readonly requestId: string;
	/**
	 * 他看到的那段正文。`merged` = 这次合并掉了几条没开始的唤醒，`busy` = 他此刻手上有活。
	 *
	 * 正文必须由调用点拼：投递要知道「这条还 @ 了谁」，沉淀要知道「这批消息是哪几条」。
	 * 入口只保证**拼完之后的那些事**一处不落。
	 */
	readonly bodyOf: (merged: number, busy: boolean) => string | UserInput;
	/** 忙的时候怎么插：群里的一句问题不该等整轮答完（`steer`），沉淀可以排队（`followUp`）。 */
	readonly whenBusy: "steer" | "followUp";
	/** 合并唤醒：同一会话最多留一个「还没开始」的排队项。 */
	readonly coalesce: boolean;
	/** 这一轮没产出时留痕的位置。`seq` 是「这条消息」的序号。 */
	readonly note?: { readonly channelId: string; readonly seq: number; readonly label: string } | undefined;
	/** 投递前记一笔「被谁在哪叫醒」。 */
	readonly wakeRecord?: WakeRecord | undefined;
	/** 这条输入的账本条目（`kind` + 数据），诊断用。 */
	readonly entry?: InputEntry | undefined;
	/** 他此刻手上有活（要打断他正在干的事）。缺省 = 不知道，当没有。 */
	readonly busy?: boolean | undefined;
};

export type WakeResult =
	| { readonly status: "delivered"; readonly merged: number }
	| { readonly status: "skipped" }
	| { readonly status: "failed"; readonly detail: string };

/**
 * 叫醒一个人。**不等待回复** —— 消息已经在频道里了，这里只负责「让他看见」。
 *
 * 失败不抛：消息不会丢，对方下次醒来会看到未读摘要。但**没产出会留痕**（`note`），
 * 否则频道里一片空白，我看到的「我说了没人回」和「系统挂了」长得一模一样。
 */
export async function wake(
	deps: WakeDeps,
	input: WakeInput,
	context: Context = BACKGROUND_CONTEXT,
): Promise<WakeResult> {
	try {
		const conversation = await deps.conversationOf(input.slug);
		if (conversation === undefined) return { status: "skipped" };
		const conversationId = Number(conversation.id);

		// 先合并、再拼正文：正文里要写「把 N 条并成了这一条」。
		const merged =
			input.coalesce && deps.coalesceQueue !== undefined
				? await deps.coalesceQueue(conversationId, input.requestId).catch(() => 0)
				: 0;

		const content = input.bodyOf(merged, input.busy === true);

		// 先记 wake、再提交：反过来的话有竞态 —— `submit` 一入队对方就可能跑起来，
		// 那时它查不到 wake，只能退到「我最早的那个频道」（往往是私聊），于是答在私聊里、
		// 问的人在原频道什么都看不到。
		clearSpoken(conversationId);
		if (deps.rememberWake !== undefined && input.wakeRecord !== undefined) {
			await deps.rememberWake(input.slug, input.wakeRecord);
		}

		const submission = await conversation.submit(
			{
				type: "input",
				content,
				requestId: input.requestId,
				...(input.entry === undefined ? {} : { entry: input.entry }),
				whenBusy: input.whenBusy,
			},
			context,
		);

		// 这一轮结算时「一个字都没说」留痕：频道里至少有人能看出「他回答了没」。
		const report = deps.noteUnanswered;
		const note = input.note;
		if (report !== undefined && note !== undefined) {
			watchSettled(submission, async (reason) => {
				await report({ slug: input.slug, label: note.label, seq: note.seq, reason: reason ?? "unanswered" });
			});
		}
		return { status: "delivered", merged };
	} catch (error) {
		return { status: "failed", detail: error instanceof Error ? error.message : String(error) };
	}
}
