/**
 * 名册：slug ↔ 会话 id。
 *
 * 为什么需要它：`identity.md` 是文件夹里的文档，它不知道自己的会话 id（会话是底层
 * 分配的），而频道消息又要按会话投递。这份文档就是那唯一一张对照表。
 *
 * 它是**可重建的缓存**，不是真相：真相是文件夹。删掉它，重启后按文件夹重建即可；
 * 它存在的唯一理由是「会话 id 不能从文件名推出来」。
 */
import { BACKGROUND_CONTEXT, defineDoc, type Conversation, type Context, type Harness, type JsonObject } from "../runtime/index.ts";
import { parseWake, type WakeRecord } from "../channel/turn/record.ts";
import { OWNER_SLUG } from "./identity.ts";

export type { WakeRecord } from "../channel/turn/record.ts";

export type DirectoryState = {
	/** slug → 会话 id。 */
	slugToConversation: Record<string, number>;
	/** 会话 id（字符串）→ slug。反查用。 */
	conversationToSlug: Record<string, string>;
	/** 会话 id（字符串）→ 它最后被谁在哪个频道叫醒。工具用它决定「默认在哪儿回话」。 */
	wake: Record<string, JsonObject>;
	/**
	 * slug → 显示名。**纯粹的投影**，真相是 `identity.md` 的 `name`。
	 *
	 * 为什么存一份：界面到处要显示名（消息发送方、成员列表、组织图），而每次
	 * 读一眼 `identity.md` 太贵（一次频道渲染要几十次）。名册本来就在内存里，
	 * 顺手带上；`identity.md` 改名后下一次 `rescan` 会把它刷新。
	 */
	labels: Record<string, string>;
};

export const DirectoryDoc = defineDoc<DirectoryState>({
	kind: "core.directory",
	version: 1,
	scope: "session",
	initial: () => ({ slugToConversation: {}, conversationToSlug: {}, wake: {}, labels: {} }),
	// 名册也是「每次改动都是增量」的文档：`wake` 每次有人被叫醒就写一次，`labels` 每次
	// rescan 刷一遍。原来写 `() => false` 的结果是增量永不回收 —— 实测 164 条 delta / 44KB，
	// 而频道文档只有 13 个。按条数压基线就是确定的回收上界。
	checkpointWhen: (_value, _ops, info) => info.deltasSinceBase >= 64,
});

export function emptyDirectory(): DirectoryState {
	return { slugToConversation: {}, conversationToSlug: {}, wake: {}, labels: {} };
}

/** slug → 显示名（名册里没有就给 slug 本身；我是「我」）。 */
export function labelIn(directory: DirectoryState, slug: string): string {
	if (slug === OWNER_SLUG) return "我";
	return directory.labels[slug] ?? slug;
}

/**
 * 读一次唤醒（`wake` 的值类型是 `JsonObject`，读的时候收窄）。
 *
 * 旧数据是平铺的一层，`parseWake` 会把它的 `reply` / `task` 都当成同一条。
 */
export function wakeOf(state: DirectoryState, conversationId: number | string): WakeRecord | undefined {
	return parseWake(state.wake[String(conversationId)]);
}


export function conversationFor(state: DirectoryState, slug: string): number | undefined {
	return state.slugToConversation[slug];
}

export function slugFor(state: DirectoryState, conversationId: number | string): string | undefined {
	return state.conversationToSlug[String(conversationId)];
}

/**
 * 把名册文档抄成纯数据。
 *
 * 为什么必须抄：`tx.doc()` 给的是**覆盖层代理**，它的嵌套值也是代理。把代理的值原样
 * 写回同一个覆盖层会静默丢数据（见 `assemble.ts` 的 `saveDirectory`）。这份文档很小
 * （几个人 + 唤醒记录），JSON 来回一次比任何「小心地读代理」都便宜且确定。
 */
export function plainDirectory(source: DirectoryState): DirectoryState {
	const json = JSON.stringify({
		slugToConversation: source.slugToConversation ?? {},
		conversationToSlug: source.conversationToSlug ?? {},
		wake: source.wake ?? {},
		labels: source.labels ?? {},
	});
	return JSON.parse(json) as DirectoryState;
}

/**
 * 落盘的名册 + 这次运行里真实开过的会话。
 *
 * 名册是缓存，真相是文件夹与「这次运行开出来的会话」。落盘那份可能落后（旧库、丢过写、
 * 上一版只写了内存），所以读的时候**内存优先**：只要这次运行里给他开过会话，他就是那个人。
 * 只在读的时候合并不够 —— 缺的那条会被下一次提交原样写到盘上，所以调用方还要顺手回写。
 */
export function mergeDirectory(base: DirectoryState, live: DirectoryState): DirectoryState {
	return {
		slugToConversation: { ...base.slugToConversation, ...live.slugToConversation },
		conversationToSlug: { ...base.conversationToSlug, ...live.conversationToSlug },
		wake: base.wake,
		labels: { ...base.labels, ...live.labels },
	};
}

/** 这次运行里给这个人开过的会话 id（没有就 `undefined`）。 */
export function liveConversationId(
	live: (() => ReadonlyMap<string, Conversation>) | undefined,
	slug: string,
): number | undefined {
	const found = live?.().get(slug);
	return found === undefined ? undefined : (found.id as unknown as number);
}

/**
 * 唤醒要用的那两件事：**这个人的会话在哪**、**记下他被谁在哪个频道叫醒**。
 *
 * 投递、我说话、团队沉淀三条路以前各写一份闭包，三份的读法还不完全一样
 * （有人先查内存会话表、有人只查文档）。现在只有这一份。
 *
 * `live`：装配期内存里的会话表。名册是异步落盘的，刚 `hire` 出来的人可能还没写进去，
 * 先查内存才不会把「新招的人」静默算成「没有人」。
 */
export function directoryWake(deps: {
	readonly harness: Harness;
	readonly live?: () => ReadonlyMap<string, Conversation>;
}): {
	readonly conversationOf: (slug: string, context: Context) => Promise<Conversation | undefined>;
	readonly rememberWake: (slug: string, wake: WakeRecord, context: Context) => Promise<void>;
} {
	return {
		async conversationOf(slug, context) {
			const known = deps.live?.().get(slug);
			if (known !== undefined) return known;
			const directory = (await deps.harness.snapshot(DirectoryDoc, context)) ?? emptyDirectory();
			const id = conversationFor(directory, slug);
			if (id === undefined) return undefined;
			return deps.harness.conversation(id as never, context);
		},
		async rememberWake(slug, wake, context = BACKGROUND_CONTEXT) {
			await deps.harness.commit(async (tx) => {
				const doc = (await tx.doc(DirectoryDoc)) as DirectoryState;
				// 先看这份运行里的会话表，再看文档。
				// 文档可能落后（实测：三个人的映射只活在内核内存里，落盘那份只有助理，
				// 于是他们的工具全被拒「你还不在名册里」，叫醒也记不上）。内存里有会话就是人。
				const id = conversationFor(doc, slug) ?? liveConversationId(deps.live, slug);
				if (id === undefined) return;
				// 文档里缺这条就顺手补上：只读不补的话，下一次提交还会把缺人的那份写回去。
				if (conversationFor(doc, slug) === undefined) {
					doc.slugToConversation = { ...doc.slugToConversation, [slug]: id };
					doc.conversationToSlug = { ...doc.conversationToSlug, [String(id)]: slug };
				}
				// 只写 `wake` 这一个字段：把整份名册展开再写回去，任何一处覆盖层节点被顺手
				// 写回来就是一次静默丢人。
				doc.wake = {
					...plainDirectory(doc).wake,
					[String(id)]: {
						reply: { ...wake.reply },
						task: { ...wake.task },
						// `quiet` 不能丢：写回时只搬 reply/task 的话，沉淀那一轮的「安静」
						// 就在落盘这一步被抹平了，报账又会变回群里的一条普通消息。
						...(wake.quiet === true ? { quiet: true as const } : {}),
					},
				};
			}, context);
		},
	};
}
