/**
 * 名册：slug ↔ 会话 id。
 *
 * 为什么需要它：`identity.md` 是文件夹里的文档，它不知道自己的会话 id（会话是底层
 * 分配的），而频道消息又要按会话投递。这份文档就是那唯一一张对照表。
 *
 * 它是**可重建的缓存**，不是真相：真相是文件夹。删掉它，重启后按文件夹重建即可；
 * 它存在的唯一理由是「会话 id 不能从文件名推出来」。
 */
import { defineDoc, type JsonObject } from "../runtime/index.ts";

/** 一次唤醒：谁在哪个频道、第几条消息叫的我。 */
export type WakeRecord = { channelId: string; seq: number; from: string; at: number };

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
	checkpointWhen: () => false,
});

export function emptyDirectory(): DirectoryState {
	return { slugToConversation: {}, conversationToSlug: {}, wake: {}, labels: {} };
}

/** 读一次唤醒（`wake` 的值类型是 `JsonObject`，读的时候收窄）。 */
export function wakeOf(state: DirectoryState, conversationId: number | string): WakeRecord | undefined {
	const raw = state.wake[String(conversationId)];
	if (raw === undefined) return undefined;
	const { channelId, seq, from, at } = raw;
	if (typeof channelId !== "string" || typeof seq !== "number" || typeof from !== "string" || typeof at !== "number") {
		return undefined;
	}
	return { channelId, seq, from, at };
}

export function bind(state: DirectoryState, slug: string, conversationId: number): DirectoryState {
	return {
		...state,
		slugToConversation: { ...state.slugToConversation, [slug]: conversationId },
		conversationToSlug: { ...state.conversationToSlug, [String(conversationId)]: slug },
	};
}

export function conversationFor(state: DirectoryState, slug: string): number | undefined {
	return state.slugToConversation[slug];
}

export function slugFor(state: DirectoryState, conversationId: number | string): string | undefined {
	return state.conversationToSlug[String(conversationId)];
}
