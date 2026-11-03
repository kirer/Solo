/**
 * 机械的 IO 小事：读一份文本（读不到就是 `undefined`）、写一份文本、列一个目录、
 * 往 JSONL 追加一行、问一句「什么时候改的」，以及把写操作串成一条链。
 *
 * 为什么放在 `runtime/`：这些都是**纯机械**的，谁都要用（`agent/`、`team/`、
 * `channel/`），但谁都不该拥有别人。放最底一层，依赖方向不变。
 *
 * 与 `fsx.ts` 的分工：`fsx` 管**工作区内的相对路径**（它负责越界判定），这里管
 * **已经算好的绝对路径**。两边都不再让调用方自己拼 `mkdir + writeFile`。
 *
 * 也不放进 `view/`：那是零 IO 的投影层，它连 `node:*` 都不许 import。
 */
import { watch, type FSWatcher } from "node:fs";
import { appendFile, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

/** 一个目录项。`kind` 是 `readdir` 直接给的，不为判类型多跑一次 `stat`。 */
export type DirEntry = {
	readonly name: string;
	readonly kind: "file" | "dir" | "other";
};

/** 读一份文本。文件不存在/没权限 = `undefined`（缺席是常态，不是错误）。 */
export async function readTextOrUndefined(path: string): Promise<string | undefined> {
	try {
		return await readFile(path, "utf8");
	} catch {
		return undefined;
	}
}

/** 写一份文本，父目录自动建。写才可能失败，失败就抛。 */
export async function writeTextAt(path: string, text: string): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, text, "utf8");
}

/** 写一份**二进制**，父目录自动建。装机（插件文件夹导入）要原样搬图片这类文件。 */
export async function writeBytesAt(path: string, bytes: Uint8Array): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, bytes);
}

/** 移动 / 改名（同一块盘上是原子 rename）。目标已存在会失败，不覆盖。 */
export async function moveAt(from: string, to: string): Promise<void> {
	await mkdir(dirname(to), { recursive: true });
	await rename(from, to);
}

/** 删一个文件。不存在不算错（清扫时别人可能刚删过）。 */
export async function removeAt(path: string): Promise<void> {
	await rm(path, { force: true });
}

/** 删一个目录树。不存在不算错。只给「删用户明确点名要删的那一个目录」用。 */
export async function removeDirAt(path: string): Promise<void> {
	await rm(path, { recursive: true, force: true });
}

/** 建目录（递归）。已经存在不算错。 */
export async function ensureDir(path: string): Promise<void> {
	await mkdir(path, { recursive: true });
}

/** 存在吗（文件或目录都算）。 */
export async function existsAt(path: string): Promise<boolean> {
	return (await mtimeOrUndefined(path)) !== undefined;
}

/** 文件版本戳：`mtimeMs:size`。同一次写入要么同时改这两样，要么都不改。 */
export function stampOf(info: { readonly mtimeMs: number; readonly size: number }): string {
	return `${info.mtimeMs}:${info.size}`;
}

/** 修改时间（毫秒）。不存在 = `undefined`。 */
export async function mtimeOrUndefined(path: string): Promise<number | undefined> {
	try {
		return (await stat(path)).mtimeMs;
	} catch {
		return undefined;
	}
}

/**
 * 往一个 JSONL 追加一行。
 *
 * `rotateAt`：文件超过这个字节数就改名成 `.1`（覆盖上一代）再写 —— 日志类文件
 * 只留一代，满了不轮转能把工作区写爆。
 */
export async function appendJsonLine(
	file: string,
	value: unknown,
	options: { readonly rotateAt?: number } = {},
): Promise<void> {
	if (options.rotateAt !== undefined) {
		const info = await stat(file).catch(() => undefined);
		if (info !== undefined && info.size > options.rotateAt) {
			await rename(file, `${file}.1`).catch(() => undefined);
		}
	}
	await mkdir(dirname(file), { recursive: true });
	await appendFile(file, `${JSON.stringify(value)}\n`, "utf8");
}

/**
 * 列目录，按名字码点升序。目录不存在/读失败 = 空数组。
 *
 * 排序在**这里**做：目录顺序来自文件系统，不同机器不一样；而提示词要求逐字节
 * 确定性（`SEED-CONTRACT.md` §4），所以比较用码点，不用 `localeCompare`（后者
 * 跟着机器的 locale 变）。
 */
export async function listDirSorted(path: string): Promise<readonly DirEntry[]> {
	let entries;
	try {
		entries = await readdir(path, { withFileTypes: true });
	} catch {
		return [];
	}
	return entries
		.map((entry): DirEntry => ({
			name: entry.name,
			kind: entry.isFile() ? "file" : entry.isDirectory() ? "dir" : "other",
		}))
		.sort(byName);
}

/** 码点比较：不用 `localeCompare`，它随 locale 变，提示词会跟着变。 */
function compareCodePoints(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0;
}

/** 按 `name` 的码点排序。目录项、技能、工具、能力清单都用这一份口径。 */
export function byName<T extends { readonly name: string }>(a: T, b: T): number {
	return compareCodePoints(a.name, b.name);
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

/**
 * 盯一个目录（递归）里发生的变化，返回停止函数。
 *
 * 只转交「变了」这件事，不合并：调用方自己 debounce（一次保存常常是好几个事件）。
 * 盯不上（目录不存在、平台不支持递归 watcher）就返回空函数 —— 那样只是「改完不自动生效」，
 * 不能让服务启动失败。`unref` 保证这个 watcher 不会把进程吊住。
 */
export function watchDirAt(dir: string, onChange: () => void): () => void {
	let watcher: FSWatcher;
	try {
		watcher = watch(dir, { recursive: true }, () => onChange());
	} catch {
		return () => undefined;
	}
	watcher.on("error", () => undefined);
	watcher.unref();
	return () => watcher.close();
}
