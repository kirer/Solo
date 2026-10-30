/**
 * 两条 SSE 订阅：组织（谁在、谁改名）与当前频道（新消息 / 占位被覆盖）。
 *
 * 关键纪律：**事件只负责把数据交给 store，不负责画**。
 * 上一个版本在 SSE 回调里直接 `feed.replaceChildren(...)` 重建整列，
 * 一条 agent 跑一轮就把页面卡死（实测 15 秒重建 1616 次、最长一次卡 2.7 秒）。
 * 现在事件只 patch 状态，React 自己决定要不要重画。
 */

import { useEffect, useRef } from "react";
import { getAttention, getChannels } from "../api/client.ts";
import type { Message } from "../api/types.ts";
import { applyDraft, applyMessage, getState, patch, setConn } from "../state/store.ts";
import { useStore } from "../state/useStore.ts";

/** 打不开就等一等再试，退避到 15 秒封顶：服务重启期间不要每 100ms 打一次。 */
const RETRY_MIN_MS = 1_000;
const RETRY_MAX_MS = 15_000;

export function useOrgStream(): void {
	useEffect(() => {
		let source: EventSource | null = null;
		let retry = RETRY_MIN_MS;
		let timer: number | undefined;
		let closed = false;

		const connect = (): void => {
			if (closed) return;
			source = new EventSource("/api/stream/org");
			source.addEventListener("org", () => {
				retry = RETRY_MIN_MS;
				void refreshSide();
			});
			source.addEventListener("error", () => {
				source?.close();
				source = null;
				setConn(false);
				timer = window.setTimeout(connect, retry);
				retry = Math.min(RETRY_MAX_MS, retry * 2);
			});
		};

		connect();
		return () => {
			closed = true;
			if (timer !== undefined) window.clearTimeout(timer);
			source?.close();
		};
	}, []);
}

/**
 * 侧栏与「找你」的刷新。
 *
 * 一次提交会连带推好几条 org 事件（一条消息、一个占位、一次填充），
 * 每条都拉一次 `/api/channels` + `/api/attention` 就是三次网络往返 + 三次整栏重画。
 * 合并到一次 300ms 的尾巴上。
 */
async function refreshSide(): Promise<void> {
	try {
		const [lists, attention] = await Promise.all([getChannels(), getAttention()]);
		patch({ channels: lists.channels, attention: attention.items, attentionUnread: attention.unread });
		setConn(true);
		const current = getState();
		// 侧栏预览与未读数变了，但「当前频道」的标题行也要跟着变（比如未读清零）。
		if (current.detail !== null) {
			const fresh = lists.channels.find((channel) => channel.id === current.detail?.channel.id);
			if (fresh !== undefined) {
				patch({ detail: { ...current.detail, channel: { ...current.detail.channel, ...fresh } } });
			}
		}
	} catch {
		setConn(false);
	}
}

/** 当前频道的消息流。切频道就重连（带上 since，避免把历史整段重推一遍）。 */
export function useChannelStream(): void {
	const currentId = useCurrentId();
	const lastSeq = useLastSeq();
	const key = `${currentId ?? ""}:${lastSeq}`;

	const held = useRef<{ source: EventSource | null }>({ source: null });

	useEffect(() => {
		if (currentId === null) return;
		const source = new EventSource(
			`/api/channels/${encodeURIComponent(currentId)}/stream${lastSeq > 0 ? `?since=${lastSeq}` : ""}`,
		);
		held.current.source = source;

		source.addEventListener("create", (event) => {
			const message = parse<Message>(event);
			if (message !== null && message.seq !== undefined) applyMessage(currentId, message);
		});
		// `done` 是「这条消息的正文定稿了」：服务端给全文，前端整行替换。
		// 不再往已经渲染成 HTML 的正文里追加纯文本（旧版本那样做，两种渲染混在一个容器里）。
		source.addEventListener("done", (event) => {
			const payload = parse<{ seq: number; text: string; status?: string }>(event);
			if (payload === null) return;
			const state = getState();
			const messages = state.detail?.messages;
			if (messages === undefined) return;
			const index = messages.findIndex((item) => item.seq === payload.seq);
			if (index < 0) return;
			const next = messages.slice();
			next[index] = { ...messages[index]!, text: payload.text, processing: false, status: "done" };
			patch({ detail: { ...state.detail!, messages: next } });
		});
		// `draft` 是「他正在说的那句话」（还没落库）：只用来画末尾那行预览，
		// 真消息一到（`create` / `done`）store 会自己把它删掉。
		source.addEventListener("draft", (event) => {
			const payload = parse<{ slug: string; text: string }>(event);
			if (payload === null || typeof payload.slug !== "string" || typeof payload.text !== "string") return;
			applyDraft(payload.slug, payload.text);
		});
		source.addEventListener("error", () => {
			source.close();
			setConn(false);
		});

		return () => source.close();
		// 只在频道或窗口末尾变化时重连；`lastSeq` 就是「这次要从哪之后开始听」。
	}, [key]);
}

function parse<T>(event: MessageEvent<string>): T | null {
	try {
		return JSON.parse(event.data) as T;
	} catch {
		return null;
	}
}

function useCurrentId(): string | null {
	return useStore((state) => state.currentId);
}

function useLastSeq(): number {
	return useStore((state) => state.detail?.messages.at(-1)?.seq ?? 0);
}
