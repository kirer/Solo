/**
 * 名册：slug ↔ 会话 id。
 *
 * 为什么需要它：`identity.md` 是文件夹里的文档，它不知道自己的会话 id（会话是底层
 * 分配的），而频道消息又要按会话投递。这份文档就是那唯一一张对照表。
 *
 * 它是**可重建的缓存**，不是真相：真相是文件夹。删掉它，重启后按文件夹重建即可；
 * 它存在的唯一理由是「会话 id 不能从文件名推出来」。
 *
 * 住在 `channel/`：它记的是会话 id 与唤醒记录，不是人的档案。只许依赖
 * `./turn/record.ts` 与 `../documents/member/identity.ts`，不许 import wiring/post/flow。
 */
import {
	BACKGROUND_CONTEXT,
	defineDoc,
	type Conversation,
	type Context,
	type Harness,
	type JsonObject,
	type Tx,
} from "../runtime/index.ts";
import { migrateWake, parseWake, type WakeRecord } from "./turn/record.ts";
import { OWNER_SLUG } from "../documents/member/identity.ts";

export type { WakeRecord } from "./turn/record.ts";

export type DirectoryState = {
	/** slug → 主会话 id。 */
	slugToConversation: Record<string, number>;
	/** 会话 id（字符串）→ slug。反查用（工具靠它认「我是谁」）。 */
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

/**
 * v1 → v2：唤醒记录从平铺改成两层（`reply` / `task`，ADR-099）。
 *
 * 读的每一处都要记着「旧形状长什么样」；现在在升版本时归一次，`parseWake` 只认
 * 两层形状。读不出来的记录（坏数据）直接丢掉 —— 唤醒记录是可重建的缓存，不是档案。
 */
function migrateWakes(value: JsonObject, fromVersion: number): DirectoryState {
	if (fromVersion >= 2) return value as unknown as DirectoryState;
	const state = value as unknown as DirectoryState;
	const wake: Record<string, JsonObject> = {};
	for (const [id, raw] of Object.entries(state.wake ?? {})) {
		const record = migrateWake(raw);
		if (record !== undefined) wake[id] = { reply: { ...record.reply }, task: { ...record.task } };
	}
	return { ...value, wake } as unknown as DirectoryState;
}

export const DirectoryDoc = defineDoc<DirectoryState>({
	kind: "core.directory",
	version: 2,
	migrate: migrateWakes,
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

/** 读一次唤醒（`wake` 的值类型是 `JsonObject`，读的时候收窄；旧形状在 v2 迁移时已归好）。 */
export function wakeOf(state: DirectoryState, conversationId: number | string): WakeRecord | undefined {
	return parseWake(state.wake[String(conversationId)]);
}


/** slug → 会话 id。 */
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

/** 这次运行里开过的这条会话的 id（没有就 `undefined`）。 */
function liveConversationId(
	live: (() => ReadonlyMap<string, Conversation>) | undefined,
	slug: string,
): number | undefined {
	const found = live?.().get(slug);
	return found === undefined ? undefined : (found.id as unknown as number);
}

/**
 * 唤醒要用的那两件事：**这个人的会话在哪**、**记下他被谁在哪个频道叫醒**。
 *
 * 投递、我说话两条路以前各写一份闭包，两份的读法还不完全一样
 * （有人先查内存会话表、有人只查文档）。现在只有这一份。
 *
 * `live`：装配期内存里的会话表。会话开出来就 `bind` 进名册，所以它只是快路径；
 * 盘上那条真的丢了时（旧库、手工清过），它也是让这个人还能被叫醒的最后一份证据。
 */
export function directoryWake(deps: {
	readonly harness: Harness;
	readonly live?: () => ReadonlyMap<string, Conversation>;
	/** 名册里还找不到这个人时开一条（装配层给）。 */
	readonly open?: (slug: string, context: Context) => Promise<Conversation | undefined>;
}): {
	readonly conversationOf: (slug: string, context: Context) => Promise<Conversation | undefined>;
	readonly rememberWake: (slug: string, wake: WakeRecord, context: Context) => Promise<void>;
	/**
	 * 同一个 `rememberWake`，但写进调用方的 commit。
	 *
	 * 投递要「记 wake」和「入队」原子完成（ADR-076）：`submit` 一提交对方就可能开跑，
	 * 那时名下没有 wake，他只能退到最早那个频道去答。同一个 commit 里先写文档再准入，
	 * 两个结果要么都在、要么都不在。
	 */
	readonly rememberWakeTx: (tx: Tx, slug: string, wake: WakeRecord) => Promise<void>;
} {
	const writeWake = async (tx: Tx, slug: string, wake: WakeRecord): Promise<void> => {
		const doc = (await tx.doc(DirectoryDoc)) as DirectoryState;
		// 文档是名册的真相；只有它丢了这条映射时才退回这次运行开过的会话，
		// 并把映射补进文档（下一次提交不能再把缺人的那份写回去）。
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
			},
		};
	};

	return {
		async conversationOf(slug, context) {
			const known = deps.live?.().get(slug);
			if (known !== undefined) return known;
			const directory = (await deps.harness.snapshot(DirectoryDoc, context)) ?? emptyDirectory();
			const id = conversationFor(directory, slug);
			if (id === undefined) return deps.open?.(slug, context);
			return deps.harness.conversation(id as never, context);
		},
		async rememberWake(slug, wake, context = BACKGROUND_CONTEXT) {
			await deps.harness.commit((tx) => writeWake(tx, slug, wake), context);
		},
		rememberWakeTx: writeWake,
	};
}
