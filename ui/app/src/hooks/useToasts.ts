/**
 * 提示条。三条上限、3.6 秒自动消失。
 *
 * 为什么不做成「留在屏幕上直到点掉」：这些提示全是「刚才那下没成」，
 * 留着只会挡住消息。真正的错误留在服务端日志里。
 */

import { useCallback, useEffect, useRef, useState } from "react";

export type Tone = "info" | "error";
export type Toast = { id: number; text: string; tone: Tone };

const TOAST_MS = 3_600;
const MAX_TOASTS = 3;

export function useToasts(): {
	toasts: Toast[];
	toast: (text: string, tone?: Tone) => void;
	dismiss: (id: number) => void;
} {
	const [toasts, setToasts] = useState<Toast[]>([]);
	const next = useRef(0);
	const timers = useRef(new Set<number>());

	const dismiss = useCallback((id: number) => {
		setToasts((current) => current.filter((item) => item.id !== id));
	}, []);

	const toast = useCallback((text: string, tone: Tone = "info") => {
		const id = next.current++;
		setToasts((current) => [...current.slice(-(MAX_TOASTS - 1)), { id, text, tone }]);
		const timer = window.setTimeout(() => {
			timers.current.delete(timer);
			setToasts((current) => current.filter((item) => item.id !== id));
		}, TOAST_MS);
		timers.current.add(timer);
	}, []);

	useEffect(
		() => () => {
			for (const timer of timers.current) window.clearTimeout(timer);
			timers.current.clear();
		},
		[],
	);

	return { toasts, toast, dismiss };
}
