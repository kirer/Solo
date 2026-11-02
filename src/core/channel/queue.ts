/**
 * 唤醒队列：同一个会话最多留一个「还没开始」的排队项。
 *
 * 投递与「我插队」共用这一份判据 —— 两套口径迟早分叉。
 *
 * 但「可以互相替代」只在**同一条轻重**上成立：叫人来干活的和叫人去记账的不是一回事，
 * 后者把前者撤掉，人醒来就只做账、不答话（见 `WakePriority`）。
 */
import type { Harness } from "../runtime/index.ts";
import { BACKGROUND_CONTEXT, type Context } from "../runtime/index.ts";

/**
 * 唤醒的轻重。
 *
 * - `work`：要人读上下文、动手、回话（投递）；
 * - `bookkeeping`：只是让他记一笔（团队记忆沉淀），quiet，不答话。
 *
 * 规则只有一条：**轻的撤不掉重的**。重的可以撤轻的 —— 他马上要读整个频道了，
 * 记账可以等下一批。以后再加看门狗通报、插件通知这类唤醒，按轻重插进这张表就行。
 */
export type WakePriority = "work" | "bookkeeping";

const RANK: Record<WakePriority, number> = { bookkeeping: 0, work: 1 };

/**
 * 一条唤醒是什么性质 —— 由它的 `requestId` 前缀决定。
 *
 * `requestId` 本来就是「谁叫的、为什么叫」的身份：沉淀是 `settle:…`，投递是 `ch:…`。
 * 单独再存一个字段只会多一处能对不上的地方。
 */
export function priorityOf(requestId: string | undefined): WakePriority {
	return (requestId ?? "").startsWith("settle:") ? "bookkeeping" : "work";
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
	incoming: WakePriority = "work",
): (number | bigint | string)[] {
	const out: (number | bigint | string)[] = [];
	for (const submission of submissions) {
		if (Number(submission.conversationId) !== conversationId) continue;
		if (submission.status !== "queued") continue;
		if (keepRequestId !== undefined && submission.requestId === keepRequestId) continue;
		// 轻的撤不掉重的：记账让路给记账，干活谁都能让路。
		if (RANK[priorityOf(submission.requestId)] > RANK[incoming]) continue;
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
 *
 * `incoming` 是这一条自己的轻重：它决定谁能被撤。踩过：团队频道连着几条消息进来时，
 * 沉淀的唤醒把管理员手上那条投递唤醒挤掉了，他醒来只整理记忆、一句话没答
 * （实测 2026-11-02，周野三次被叫醒，三次都只剩沉淀）。
 */
export async function coalesceQueue(
	harness: Harness,
	conversationId: number,
	keepRequestId: string,
	context: Context = BACKGROUND_CONTEXT,
	incoming: WakePriority = "work",
): Promise<number> {
	const inspection = await harness.inspect(context);
	const pending = queuedAhead(inspection.submissions, conversationId, keepRequestId, 8, incoming);
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
