/**
 * `useSyncExternalStore` 的薄封装。
 *
 * 选择器在每次 store 变化时都会被调用，所以**必须在外部声明**（不要写成内联箭头），
 * 否则每次渲染都是新函数、每次都触发重渲染的判定变成「永远不等」。
 * 这里用 `Object.is` 比较结果，选择器返回一个数字/字符串是最安全的用法。
 */

import { useSyncExternalStore } from "react";
import { getState, subscribe } from "./store.ts";
import type { State } from "./store.ts";

export function useStore<T>(select: (state: State) => T): T {
	return useSyncExternalStore(
		subscribe,
		() => select(getState()),
		() => select(getState()),
	);
}
