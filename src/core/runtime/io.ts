/**
 * 机械的 IO 小事：读一份文本（读不到就是 `undefined`）、写一份文本、列一个目录、
 * 往 JSONL 追加一行、问一句「什么时候改的」，以及把写操作串成一条链。
 *
 * 为什么放在 `runtime/`：这些都是**纯机械**的，谁都要用（`documents/`、`channel/`），
 * 但谁都不该拥有别人。放最底一层，依赖方向不变。
 *
 * 与 `fsx.ts` 的分工：`fsx` 管**工作区内的相对路径**（它负责越界判定），这里管
 * **已经算好的绝对路径**。两边都不再让调用方自己拼 `mkdir + writeFile`。
 *
 * 也不放进 `view/`：那是零 IO 的投影层，它连 `node:*` 都不许 import。
 */
import { watch, type FSWatcher } from "node:fs";
import { appendFile, mkdir, readdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
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

/**
 * 测试专用：在临时文件写好、换上去之前插一次失败。
 *
 * 为什么需要它：要验「写到一半崩掉，原件还在」，就得真的让流程在那一刻断。
 * 靠给目录改权限造失败不可靠（root 跑测试时权限位不生效），靠写进目录也不对
 * （那在更早的地方就被拒了，根本没走到这）。所以留一个可注入的点。
 *
 * 生产走的是模块顶层那个 `undefined` —— 没人调 `setAtomicWriteFault` 就永远不触发。
 */
let faultAfterTempWrite: (() => Promise<void>) | undefined;

/** 给测试用：设 / 清那个注入点。传 `undefined` 就清掉。 */
export function setAtomicWriteFault(fault: (() => Promise<void>) | undefined): void {
	faultAfterTempWrite = fault;
}

/** 一次原子替换的结果：替换前后的字节数，坏掉时是 `undefined`。 */
export type AtomicWriteResult = {
	/** 写之前那个文件多大。文件本来不存在 = `undefined`。 */
	readonly before: number | undefined;
	/** 写之后再读回来有多大。 */
	readonly after: number;
};

/**
 * 原子写一份文本：先写同目录的临时文件，落盘后 `rename` 换成目标，再把目标读回来核字节数。
 *
 * 为什么不直接 `writeFile`：`writeFile` 一上手就把目标截断。中途崩了（进程被杀、盘满、
 * 传进来的是空串）留下一份**半截或 0 字节**的文件，原件已经没了 —— 这就是
 * 「`file write` 传空正文把 10572 字节写成 1 字节」那次事故的形状。
 *
 * 临时文件必须和目标**同目录**：跨盘 rename 不是原子的，还会退化成「复制 + 删」。
 *
 * 读回来核对是多一层保险：`rename` 成功不等于内容对（写盘时盘满了、底层悄悄短写）。
 * 发现对不上就抛 —— 调用方据此报「写坏了」，而不是回一句「已写入」骗人。
 */
export async function writeTextAtomic(path: string, text: string): Promise<AtomicWriteResult> {
	const dir = dirname(path);
	await mkdir(dir, { recursive: true });
	const before = await sizeOrUndefined(path);
	// 临时名带 pid + 随机串：同一个目录里两个 agent 同时写，不会互相踩掉临时文件。
	const temp = `${path}.${String(process.pid)}.${Math.random().toString(36).slice(2, 10)}.tmp`;
	try {
		await writeFile(temp, text, "utf8");
		// 测试钩子：在「临时文件已落地、还没换上去」这一瞬插一次失败。
		// 这里才是真正危险的位置 —— 直接 `writeFile` 到目标的话，读的人已经看到半截了。
		// 生产里 `faultAfterTempWrite` 是 `undefined`，这一行什么都不做。
		await faultAfterTempWrite?.();
		await rename(temp, path);
	} catch (error) {
		// 临时文件可能已经建出来了：留着会在工作区里长出一堆 `.tmp`。清掉再抛。
		await rm(temp, { force: true }).catch(() => undefined);
		throw error;
	}
	const written = await readFile(path, "utf8").catch(() => undefined);
	if (written !== text) {
		throw new Error(
			`写进去读回来对不上：${path}（应为 ${String(Buffer.byteLength(text, "utf8"))} 字节，实为 ${String(
				written === undefined ? "读不出来" : `${String(Buffer.byteLength(written, "utf8"))} 字节`,
			)}）`,
		);
	}
	return { before, after: Buffer.byteLength(text, "utf8") };
}

/** 文件多大。不存在 = `undefined`（不是 0：0 是「存在且空」，两件事）。 */
export async function sizeOrUndefined(path: string): Promise<number | undefined> {
	try {
		const info = await stat(path);
		return info.isFile() ? info.size : undefined;
	} catch {
		return undefined;
	}
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

/** 一份**普通文件**的体量与修改时间。目录 / 不存在 / 没权限 = `undefined`。 */
/**
 * 看一个路径是什么：文件 / 目录 / 不存在。
 *
 * **目录也要回**（`isFile: false`），不能一起当成「不存在」：界面上点一个目录，
 * 报「找不到这个文件」是在说谎 —— 它明明在那儿，只是点不了。区分留给调用方说。
 * 别的种类（套接字、设备）按「不存在」处理：预览不了，也没什么可说的。
 */
export async function fileStatAt(
	path: string,
): Promise<{ readonly size: number; readonly mtimeMs: number; readonly isFile: boolean } | undefined> {
	try {
		const info = await stat(path);
		if (info.isFile()) return { size: info.size, mtimeMs: info.mtimeMs, isFile: true };
		if (info.isDirectory()) return { size: 0, mtimeMs: info.mtimeMs, isFile: false };
		return undefined;
	} catch {
		return undefined;
	}
}

/** 解析完软链接的真实路径。不存在 / 没权限 = `undefined`。 */
export async function realPathOrUndefined(path: string): Promise<string | undefined> {
	try {
		return await realpath(path);
	} catch {
		return undefined;
	}
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
export function watchDirAt(
	dir: string,
	onChange: () => void,
	options: { readonly recursive?: boolean } = {},
): () => void {
	let watcher: FSWatcher;
	try {
		watcher = watch(dir, { recursive: options.recursive ?? true }, () => onChange());
	} catch {
		return () => undefined;
	}
	watcher.on("error", () => undefined);
	watcher.unref();
	return () => watcher.close();
}
