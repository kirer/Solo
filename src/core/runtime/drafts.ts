/**
 * 「正在说」草稿：从提交里捞出模型正在生成的那句话。
 *
 * ## 为什么不用库的事件流
 *
 * `watchEvents()` 的 `message_update` 里本该带 `text_delta` / `toolcall_delta`，实测
 * **一条都没有**（`docs/CONCESSIONS.md` C-007）：网关确实在逐字推（直接调 `streamSimple`
 * 能收到 219 个 delta、跨 1.8 秒），但库的 `message_update` 靠「这次提交与上次提交的
 * partial 不是同一个对象」判定，实测只有每段消息的第一次提交命中，之后全是零。
 *
 * 所以改从**提交本身**拿：`subscribeCommits` 的 `DocumentCommitChange` 直接带着
 * `conversationId` 和这次提交后的整份文档 `value`。挑 `record.kind === "pi.live"`
 * 的那些读 `generation.message` —— 实测 `say` 的 `text` 参数确实是逐字长的
 * （15 → 42 → 71 → … → 256 字，约每 100ms 一次）。
 *
 * 这个文件住在 `runtime/` 是因为它必须碰 `LiveDoc`（边界 1）。它只**读**：
 * 不提交、不改文档、不产生任何状态。
 */
import type { Harness } from "@earendil-works/pi-durable";
import { LiveDoc } from "@earendil-works/pi-durable";

/** 草稿最多带多少字：界面只显示尾部几行，整段传过去只是白占带宽。 */
export const DRAFT_TAIL = 600;

/**
 * 从一份 `pi.live` 文档里取出「他正在说的那句话」。
 *
 * 只认 `say` 的 `text` 参数：`run` 的命令、`remember` 的正文都不是要说给老板听的话，
 * 把它们当草稿推出去等于把工具参数当发言（C-007 记过一次同样的教训）。
 *
 * 返回 `undefined` 有两种含义 —— 「这一轮没在说」和「说完了」。调用方按「清掉」处理，
 * 因为两种情况界面上都该把草稿收起来。
 */
export function draftTextOf(live: unknown): string | undefined {
	const generation = (live as { generation?: { message?: { content?: unknown } } } | undefined)?.generation;
	const content = generation?.message?.content;
	if (!Array.isArray(content)) return undefined;
	for (const block of content) {
		if (typeof block !== "object" || block === null) continue;
		const item = block as { type?: unknown; name?: unknown; arguments?: unknown };
		if (item.type !== "toolCall" || item.name !== "say") continue;
		const args = item.arguments as { text?: unknown } | undefined;
		const text = typeof args?.text === "string" ? args.text : undefined;
		if (text === undefined || text.trim() === "") continue;
		return text.length > DRAFT_TAIL ? text.slice(-DRAFT_TAIL) : text;
	}
	return undefined;
}

/**
 * 订阅每个会话「正在说的那句话」，返回卸载函数。
 *
 * 每 100ms 一次提交就会回调一次，**调用方必须自己节流**（这里不节流：节流窗口是界面
 * 关心的事，放在这里会让「谁该收到」变得不好测）。
 */
export function watchSayDrafts(
	harness: Harness,
	listener: (conversationId: number, text: string | undefined) => void,
): () => void {
	return harness.subscribeCommits((publication) => {
		for (const change of publication.changes) {
			if (change.type !== "document") continue;
			if (change.record.kind !== LiveDoc.definition.kind) continue;
			const conversationId = change.conversationId;
			if (conversationId === undefined) continue;
			listener(Number(conversationId), draftTextOf(change.value));
		}
	});
}
