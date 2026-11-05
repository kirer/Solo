/**
 * 名册落盘：slug ↔ 会话 id 的唯一写入口。
 *
 * 名册是**缓存**：这次运行里开过的会话是真话，落盘那份可能落后。所以读的时候
 * 用 `mergeDirectory` 把内存并进去，发现缺人就补一次；写的时候只写变化过的字段，
 * 不整份替换（整份替换会把别的提交刚写进去的人覆盖掉，且不报错）。
 */
import type { Context, Harness } from "../../core/runtime/index.ts";
import {
	DirectoryDoc,
	emptyDirectory,
	mergeDirectory,
	plainDirectory,
	type DirectoryState,
} from "../../core/agent/roster.ts";

/** 名册的顶层字段（写回去时要逐字段比，不能整份替换）。 */
const DIRECTORY_KEYS = ["slugToConversation", "conversationToSlug", "wake", "labels"] as const;

export type DirectoryWire = {
	/** 落一次名册变更：只写变化过的字段。 */
	save(change: (state: DirectoryState) => DirectoryState, ctx: Context): Promise<void>;
	/** 读名册：内存里的会话 + 落盘那份；落盘缺人时顺手补齐。 */
	now(ctx: Context): Promise<DirectoryState>;
	/** 把这次运行的名册并进落盘那份（启动与 `rescan` 共用）。 */
	merge(labels: Readonly<Record<string, string>>, ctx: Context): Promise<void>;
	/** 新建会话之后立刻记下映射（`hire` 不走 `rescan`，不立刻写就会丢）。 */
	bind(slug: string, conversationId: number, ctx: Context): Promise<void>;
};

export function createDirectoryWire(deps: {
	readonly harness: Harness;
	/** 内存里的那份：读的时候优先信它。 */
	readonly directory: DirectoryState;
}): DirectoryWire {
	const { harness, directory } = deps;

	async function save(
		change: (state: DirectoryState) => DirectoryState,
		ctx: Context,
	): Promise<void> {
		await harness.commit(async (tx) => {
			const doc = (await tx.doc(DirectoryDoc)) as DirectoryState;
			// 旧写法是 `Object.assign(doc, change({ ...emptyDirectory(), ...doc }))`：
			// 把「文档代理展开出来的整份状态」原样写回去。展开出来的是**覆盖层的节点**，
			// 再写回同一个覆盖层，等于拿旧节点覆盖新值 —— 表现就是「名册里少一个人」，
			// 而且没有任何报错（顾南雁的映射就是这么丢的）。
			const before = plainDirectory(doc);
			const after = change(before);
			for (const key of DIRECTORY_KEYS) {
				if (JSON.stringify(after[key]) === JSON.stringify(before[key])) continue;
				// 一个字段一次写：路径式更新，不会连带重写整份名册。
				doc[key] = after[key] as never;
			}
		}, ctx);
	}

	async function now(ctx: Context): Promise<DirectoryState> {
		const doc = (await harness.snapshot(DirectoryDoc, ctx)) ?? emptyDirectory();
		const merged = mergeDirectory(doc, directory);
		if (Object.keys(merged.slugToConversation).length !== Object.keys(doc.slugToConversation).length) {
			await save(() => merged, ctx);
		}
		return merged;
	}

	async function merge(labels: Readonly<Record<string, string>>, ctx: Context): Promise<void> {
		await harness.commit(async (tx) => {
			const doc = (await tx.doc(DirectoryDoc)) as DirectoryState;
			Object.assign(doc, {
				slugToConversation: { ...doc.slugToConversation, ...directory.slugToConversation },
				conversationToSlug: { ...doc.conversationToSlug, ...directory.conversationToSlug },
				labels: { ...doc.labels, ...labels },
			});
			directory.labels = { ...doc.labels };
		}, ctx);
	}

	async function bind(slug: string, conversationId: number, ctx: Context): Promise<void> {
		directory.slugToConversation[slug] = conversationId;
		directory.conversationToSlug[String(conversationId)] = slug;
		await harness.commit(async (tx) => {
			const doc = (await tx.doc(DirectoryDoc)) as DirectoryState;
			const before = plainDirectory(doc);
			doc.slugToConversation = { ...before.slugToConversation, [slug]: conversationId };
			doc.conversationToSlug = { ...before.conversationToSlug, [String(conversationId)]: slug };
		}, ctx);
	}

	return { save, now, merge, bind };
}
