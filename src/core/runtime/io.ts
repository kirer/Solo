/**
 * 机械的 IO 小事：读一份文本（读不到就是 `undefined`），以及把写操作串成一条链。
 *
 * 为什么放在 `runtime/`：这两件事都是**纯机械**的，谁都要用（`agent/`、`team/`、
 * `channel/`），但谁都不该拥有别人。放最底一层，依赖方向不变。
 *
 * 也不放进 `view/`：那是零 IO 的投影层，它连 `node:*` 都不许 import。
 */
import { readFile } from "node:fs/promises";

/** 读一份文本。文件不存在/没权限 = `undefined`（缺席是常态，不是错误）。 */
export async function readTextOrUndefined(path: string): Promise<string | undefined> {
	try {
		return await readFile(path, "utf8");
	} catch {
		return undefined;
	}
}

/** 一条 Promise 尾链：后一个任务等前一个结束，无论它成败。 */
export type SerialGate = <T>(operation: () => Promise<T>) => Promise<T>;

/**
 * 造一条写闸。
 *
 * `读 → 拼 → 写` 不是原子的：两个调用并发跑，后写的那个会用旧的 `existing` 覆盖掉
 * 前一个刚写进去的东西（丢了，而且没有任何迹象）。链只保证同一条链上的顺序，
 * 不保证跨进程；**每条写路径各自一条链** —— 频道写入不该排在记忆落盘后面。
 */
export function createSerialGate(): SerialGate {
	let tail: Promise<unknown> = Promise.resolve();
	return <T>(operation: () => Promise<T>): Promise<T> => {
		const next = tail.then(operation, operation);
		tail = next.catch(() => undefined);
		return next;
	};
}
