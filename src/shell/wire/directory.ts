/**
 * 名册落盘：slug ↔ 会话 id 的唯一写入口。
 *
 * **唯一的真相是这份文档**。内存里的 `directory` 只是它的镜像：每次写都先提交文档，
 * 提交成功后再把结果抄进内存；每次读都从文档抄一遍。以前是反过来的（读的时候把内存
 * 并到盘上并回写），后果是「开除一个人」只删了盘上的条目，下一次读又把他从内存并回去 ——
 * 重启后他的频道和私聊全回来了。
 */
import type { Context, Harness } from "../../core/runtime/index.ts";
import {
	DirectoryDoc,
	emptyDirectory,
	plainDirectory,
	type DirectoryState,
} from "../../core/channel/roster.ts";

/** 名册的顶层字段（写回去时要逐字段比，不能整份替换）。 */
const DIRECTORY_KEYS = ["slugToConversation", "conversationToSlug", "wake", "labels"] as const;

export type DirectoryWire = {
	/** 落一次名册变更：只写变化过的字段。 */
	save(change: (state: DirectoryState) => DirectoryState, ctx: Context): Promise<void>;
	/** 读名册（盘上那份，也就是唯一真相）。 */
	now(ctx: Context): Promise<DirectoryState>;
	/** 把这次运行的名册并进落盘那份（启动与 `rescan` 共用）。 */
	merge(labels: Readonly<Record<string, string>>, ctx: Context): Promise<void>;
	/** 新建会话之后立刻记下映射（`hire` 不走 `rescan`，不立刻写就会丢）。 */
	bind(slug: string, conversationId: number, ctx: Context): Promise<void>;
};

export function createDirectoryWire(deps: {
	readonly harness: Harness;
	/** 内存镜像：只跟着文档走，不再是第二份真相。 */
	readonly directory: DirectoryState;
}): DirectoryWire {
	const { harness, directory } = deps;

	/** 提交之后把文档抄进内存（原地改：别处持有的是同一个对象）。 */
	function adopt(state: DirectoryState): DirectoryState {
		Object.assign(directory, plainDirectory(state));
		return directory;
	}

	async function save(
		change: (state: DirectoryState) => DirectoryState,
		ctx: Context,
	): Promise<void> {
		let after: DirectoryState | undefined;
		await harness.commit(async (tx) => {
			const doc = (await tx.doc(DirectoryDoc)) as DirectoryState;
			// 旧写法是 `Object.assign(doc, change({ ...emptyDirectory(), ...doc }))`：
			// 把「文档代理展开出来的整份状态」原样写回去。展开出来的是**覆盖层的节点**，
			// 再写回同一个覆盖层，等于拿旧节点覆盖新值 —— 表现就是「名册里少一个人」，
			// 而且没有任何报错（顾南雁的映射就是这么丢的）。
			const before = plainDirectory(doc);
			after = change(before);
			for (const key of DIRECTORY_KEYS) {
				if (JSON.stringify(after[key]) === JSON.stringify(before[key])) continue;
				// 一个字段一次写：路径式更新，不会连带重写整份名册。
				doc[key] = after[key] as never;
			}
		}, ctx);
		if (after !== undefined) adopt(after);
	}

	async function now(ctx: Context): Promise<DirectoryState> {
		const doc = (await harness.snapshot(DirectoryDoc, ctx)) ?? emptyDirectory();
		return adopt(doc);
	}

	async function merge(labels: Readonly<Record<string, string>>, ctx: Context): Promise<void> {
		await save((state) => ({ ...state, labels: { ...state.labels, ...labels } }), ctx);
	}

	async function bind(slug: string, conversationId: number, ctx: Context): Promise<void> {
		await save(
			(state) => ({
				...state,
				slugToConversation: { ...state.slugToConversation, [slug]: conversationId },
				conversationToSlug: { ...state.conversationToSlug, [String(conversationId)]: slug },
			}),
			ctx,
		);
	}

	return { save, now, merge, bind };
}
