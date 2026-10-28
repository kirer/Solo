/**
 * 「会话记录 → 个人频道」的投影管道。
 *
 * agent 想什么、调了什么工具，都躺在 pi-durable 的会话条目里（`pi.assistant`）；频道消息
 * 是另一份东西。这一段代码是两者之间**唯一**的连线：把条目里已经写下的思考/文案/工具
 * 调用读出来，落成人老板看得见的 `kind:"think"|"say"|"tool"` 消息。
 *
 * 为什么要落库而不是读时拼：会话条目**没有时间戳**（存储层的 `entries` 表只有自增 id 与
 * 提交序号），读时拼接无法把两句思考插到正确的两条消息之间，只能整段堆在末尾。所以投影
 * 结果必须落地，落地时刻就是它发生过的时刻。
 *
 * 代价因此是双份：同一条思考在 `entries` 里一份、在频道消息里一份。这不是冗余存储，是
 * 两份数据各自回答不同的问题 —— 前者回答「模型当初看到/说过什么」（续跑要用），后者
 * 回答「老板什么时候看到的」（时间线要用）。两份都只按条数线性增长。
 */
import type { Cursor, EntryRecord, Harness } from "../runtime/index.ts";
import { BACKGROUND_CONTEXT, type Context } from "../runtime/index.ts";
import { ChannelDoc, OWNER, personalId, tail, type ChannelState } from "../channel/state.ts";
import { projectAssistantEntry, type Projection } from "../channel/transcript.ts";
import type { DirectoryState } from "../agent/roster.ts";

/**
 * 投影游标：每轮读到的最后一条 `pi.assistant` 条目 id，按会话记。
 *
 * 从这里读、写回文档（`ChannelState.cursors`）：这样重启后能接着上次的进度，
 * 而不是从头重扫一遍历史（否则每次重启个人频道都会长出一批重复的思考/文案卡）。
 */
async function loadCursor(harness: Harness, convId: number, context: Context): Promise<number> {
	const doc = (await harness.snapshot(ChannelDoc, context)) as ChannelState | undefined;
	return doc?.cursors?.[String(convId)] ?? 0;
}

async function saveCursor(harness: Harness, convId: number, entryId: number, context: Context): Promise<void> {
	await harness.commit(async (tx) => {
		const doc = (await tx.doc(ChannelDoc)) as ChannelState;
		doc.cursors = { ...(doc.cursors ?? {}), [String(convId)]: entryId };
	}, context);
}

/**
 * 把一条 `pi.assistant` 条目投影进对应 agent 的个人频道（去重 + 持久化游标）。
 *
 * 这是整个「老板能看见员工思考」功能的唯一连线：思考不是 agent 主动说出来的
 * （它不知道自己在被围观），而是运行时把会话里已经写下的记录读出来丢进个人频道。
 * 投影前先看游标：只投影比游标新的条目，避免把历史重投一遍（重启不重复长卡）。
 */
async function projectEntry(
	harness: Harness,
	directory: DirectoryState,
	convId: number,
	entry: EntryRecord,
	context: Context,
): Promise<void> {
	const slug = directory.conversationToSlug[String(convId)];
	if (slug === undefined || slug === OWNER) return;
	const projections = projectAssistantEntry(entry as never);
	const channelId = personalId(slug);
	const state = (await harness.snapshot(ChannelDoc, context)) as ChannelState | undefined;
	if (state?.channels[channelId] === undefined) return;
	if (projections.length === 0) {
		await saveCursor(harness, convId, Number(entry.id), context);
		return;
	}
	for (const projection of projections) {
		// 他刚在同一个频道用 `say` 说过同样的话（最常见：交付结论里带同一个链接），
		// 再投影一次就是一条重复消息。只跳过正文，思考与工具卡片照常显示。
		if (projection.kind === "say" && alreadySaid(state, channelId, slug, projection.text)) continue;
		await postProjectedMessage(harness, state, channelId, slug, projection, context);
	}
	await saveCursor(harness, convId, Number(entry.id), context);
}

/** 最近 5 分钟内，同一人在同一频道是否已经说过同一件事（正文相同，或带同一个链接）。 */
function alreadySaid(state: ChannelState, channelId: string, slug: string, text: string): boolean {
	const last = tail(state, channelId, 1)[0];
	if (last === undefined || last.from !== slug || Date.now() - last.at > 5 * 60_000) return false;
	const norm = (value: string) => value.replace(/[\s*_`#>~-]+/g, "").trim();
	if (norm(last.text) === norm(text)) return true;
	const links = (value: string): string[] => value.match(/https?:\/\/[^\s)）]+/g) ?? [];
	const spoken = links(last.text);
	return spoken.length > 0 && links(text).some((link) => spoken.includes(link));
}

/**
 * 订阅会话提交：只把**比游标新**的 `pi.assistant` 条目投影进个人频道。
 */
function makeTranscriptSink(harness: Harness, directory: DirectoryState) {
	return async (publication: import("../runtime/index.ts").CommitPublication, context: Context): Promise<void> => {
		for (const change of publication.changes) {
			if (change.type !== "entry") continue;
			const entry = change.value;
			if (entry.kind !== "pi.assistant") continue;
			const convId = Number(entry.conversationId);
			if (convId <= 0) continue;
			const last = await loadCursor(harness, convId, context);
			if (Number(entry.id) <= last) continue;
			await projectEntry(harness, directory, convId, entry, context);
		}
	};
}

/**
 * 启动回填：把每个 agent 会话里**还没投影过**的历史 `pi.assistant` 条目，按时间顺序
 * 投影进它的个人频道。
 *
 * 为什么必须有这一步：投影订阅只在「新提交」触发，所以历史条目从没被投影过 ——
 * 个人频道里只能看到当前这轮之后的思考/文案/工具调用，之前的全缺（症状就是
 * 「个人频道全是工具调用、看不到他怎么想」）。回填让历史也可见，且因为游标持久化，
 * 重启只是续接、不会重复长卡。
 */
export async function backfillTranscripts(
	harness: Harness,
	directory: DirectoryState,
	context: Context,
): Promise<void> {
	for (const [slug, convId] of Object.entries(directory.slugToConversation)) {
		if (slug === OWNER) continue;
		const cid = Number(convId);
		if (cid <= 0) continue;
		const last = await loadCursor(harness, cid, context);
		let cursor: Cursor | undefined;
		// 升序、从游标之后开始扫，逐页投影。
		for (;;) {
			const conv = await harness.conversation(cid as never, context);
			if (conv === undefined) break;
			const page = await conv.entries(
				{ order: "ascending", minEntryId: (last + 1) as never },
				64,
				cursor,
				context,
			);
			if (page === undefined || page.items.length === 0) break;
			for (const item of page.items) {
				if (item.kind !== "pi.assistant") continue;
				await projectEntry(harness, directory, cid, item as EntryRecord, context);
			}
			if (page.next === undefined) break;
			cursor = page.next;
		}
	}
}

/** 落一条投影消息。与 `logWork` 同一条路径，但带 `kind` 让 UI 区分显示。 */
async function postProjectedMessage(
	harness: Harness,
	state: ChannelState,
	channelId: string,
	slug: string,
	projection: Projection,
	context: Context,
): Promise<void> {
	try {
		const { postMessage } = await import("../channel/post.ts");
		await postMessage(
			{
				harness,
				state,
				conversationOf: async () => undefined,
				labelOf: (s: string) => s,
			},
			{ channelId, from: slug, text: projection.text, at: Date.now(), kind: projection.kind, wake: false },
			context,
		);
	} catch {
		/* 投影失败绝不影响主流程 */
	}
}

/**
 * 订阅会话提交，开启投影。返回取消订阅函数。
 *
 * 放在 `assembleCore` 末尾：此时名册已就绪，且 `subscribeCommits` 听众跑在
 * 主提交之后，能拿到稳定快照。
 */
export function startTranscriptSink(harness: Harness, directory: DirectoryState): () => void {
	const sink = makeTranscriptSink(harness, directory);
	return harness.subscribeCommits((publication) => {
		// 必须在 BACKGROUND_CONTEXT 里跑：提交回调拿到的 context 属于刚结束的那次任务，
		// 任务一结束它就被 abort。用它读游标/写消息会抛 `Task N invocation has ended`，
		// 而且是 fire-and-forget 的未处理拒绝 —— 既崩进程，又让最后一条 assistant 文案
		// （往往正是给老板的交付结论）永远投影不进个人频道。
		void sink(publication, BACKGROUND_CONTEXT).catch((error) => {
			console.error("[projection] 投影失败：", error instanceof Error ? error.message : String(error));
		});
	});
}
