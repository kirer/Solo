/**
 * 两条 SSE 订阅：组织（谁在、谁改名）与当前频道（新消息）。
 *
 * 关键纪律：**事件只负责把数据交给 store，不负责画**。
 * 上一个版本在 SSE 回调里直接 `feed.replaceChildren(...)` 重建整列，
 * 一条 agent 跑一轮就把页面卡死（实测 15 秒重建 1616 次、最长一次卡 2.7 秒）。
 * 现在事件只 patch 状态，React 自己决定要不要重画。
 */

import { useEffect, useRef } from "react";
import type { Message } from "../api/types.ts";
import { applyMessage, refreshLists, setConn } from "../state/store.ts";
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
				// 侧栏与「找你」的刷新只有一条路（`store.refreshLists`）：org 推送很密，
				// 一条消息会连带推好几条事件，这里只要把「有新东西了」交给 store。
				void refreshLists();
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
