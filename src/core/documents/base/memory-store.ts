/**
 * 记忆的机械读写：一条串行链上的「读全文 → 交给 build → 写回」。
 *
 * 只收这一点。去重、标题格式、校验失败是返回还是抛错，都是个人/团队各自的策略，
 * 留在它们的实现里 —— 两种记忆共用格式，但不共用判断。
 */
import { createSerialGate, readTextOrUndefined, writeTextAt } from "../../runtime/io.ts";

export type MemoryChange = {
	/** 写入前全文；文件不存在 = undefined（header 兜底归调用方）。 */
	readonly before: string | undefined;
	readonly after: string;
};

export type MemoryUpdate<T> = {
	/** undefined = 这次不写盘（校验失败 / 重复）。 */
	readonly next: string | undefined;
	/** 无论写不写，调用方要返回的值。 */
	readonly result: T;
};

export type MemoryStore = {
	readonly read: (path: string) => Promise<string | undefined>;
	readonly update: <T>(
		path: string,
		build: (before: string | undefined) => MemoryUpdate<T>,
		onWritten?: (change: MemoryChange) => Promise<void>,
	) => Promise<T>;
};

/**
 * 每个实现模块在模块级创建一个（个人一条闸、团队一条闸）。
 * 每次调用新建 store 会让并发测试丢条目 —— 串行只在同一条链上成立。
 */
export function createMemoryStore(gate = createSerialGate()): MemoryStore {
	return {
		read: (path) => readTextOrUndefined(path),
		update: (path, build, onWritten) =>
			gate(async () => {
				const before = await readTextOrUndefined(path);
				const { next, result } = build(before);
				if (next === undefined) return result;
				await writeTextAt(path, next);
				await onWritten?.({ before, after: next });
				return result;
			}),
	};
}
