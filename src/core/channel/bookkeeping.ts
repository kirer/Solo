/**
 * 系统账务任务：它在跑、或者在等它，都**不代表模型在干活**。
 *
 * 队列用它判断「这个人是不是正忙」（`liveConversations`）：把收尾任务算成忙，紧随
 * 其后的一条消息会被当成插话，模型只答一句、工具活丢掉（ADR-077）。
 *
 * 为什么要有这一份登记，而不是在队列里写死 kind：底座没给这个标记 ——
 * `TaskOptions.background` 只对会话自建的任务开放，`afterRun` 子任务设不了
 * （见 `docs/CONCESSIONS.md`）。所以由任务定义在自己旁边登记一行；新增一类收尾 /
 * 摘要任务时不用改队列。
 */
const kinds = new Set<string>();

/** 定义任务时登记：这个 kind 是账务，不算「在干活」。 */
export function declareBookkeeping(kind: string): void {
	kinds.add(kind);
}

/** 这个任务 kind 是账务吗。没登记过的一律当成真活。 */
export function isBookkeeping(kind: string): boolean {
	return kinds.has(kind);
}
