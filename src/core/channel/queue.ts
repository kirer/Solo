/**
 * 唤醒队列：同一个会话最多留一个「还没开始」的排队项。
 *
 * 投递与「我插队」共用这一份判据 —— 两套口径迟早分叉。
 */
import type { Harness } from "../runtime/index.ts";
import { BACKGROUND_CONTEXT, type Context } from "../runtime/index.ts";
import { isBookkeeping } from "./bookkeeping.ts";

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
): (number | bigint | string)[] {
	const out: (number | bigint | string)[] = [];
	for (const submission of submissions) {
		if (Number(submission.conversationId) !== conversationId) continue;
		if (submission.status !== "queued") continue;
		if (keepRequestId !== undefined && submission.requestId === keepRequestId) continue;
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
 */
export async function coalesceQueue(
	harness: Harness,
	conversationId: number,
	keepRequestId: string,
	context: Context = BACKGROUND_CONTEXT,
): Promise<number> {
	const inspection = await harness.inspect(context);
	const pending = queuedAhead(inspection.submissions, conversationId, keepRequestId, 8);
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
 * 排掉两类「不是模型在干活」的：后台任务（代理自己的账本），以及收尾任务与只等
 * 收尾任务的 generation（答完之后的系统账务，ADR-077）。
 */
export async function liveConversations(
	harness: Harness,
	context: Context = BACKGROUND_CONTEXT,
): Promise<Set<number>> {
	const inspection = await harness.inspect(context);
	const kindOf = new Map<string, string>();
	for (const task of inspection.tasks) kindOf.set(String(task.record.id), task.record.kind);
	const busy = new Set<number>();
	for (const task of inspection.tasks) {
		if (task.record.background === true) continue;
		// 账务任务（收尾等）：它在跑不代表模型在干活。算进来会让紧随其后的一条消息
		// 被当成「插话」，模型只答一句、工具活丢掉（ADR-077）。哪些算账务由定义方
		// 登记（`bookkeeping.ts`），这里不认识具体 kind。
		if (isBookkeeping(task.record.kind)) continue;
		// 生成答完不会立刻结束：它要等 `afterRun` 的子任务（收尾）跑完，这一段状态是
		// `waiting`。等的全是账务任务，就说明模型已经收手了 —— 和上面同一条理由。
		if (
			task.state.kind === "waiting" &&
			task.state.on.length > 0 &&
			task.state.on.every((id) => isBookkeeping(kindOf.get(String(id)) ?? ""))
		) {
			continue;
		}
		busy.add(Number(task.record.conversationId));
	}
	return busy;
}
