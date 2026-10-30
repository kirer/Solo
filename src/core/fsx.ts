/**
 * 工作区文件的唯二入口之一（另一个是 `runtime/io.ts` 的绝对路径机械 IO）。
 *
 * 为什么要有这一层：V2 的账是 21 个文件各写一套 `read + write + 错误处理 + 路径拼接`，
 * 78 处调用，于是「读不到算不算错」有五种答案，其中三种会让提示词里出现半句话。
 * 现在「读不到 = `undefined`」只有一个出处。
 *
 * 这一层额外管两件别人管不了的事：
 *
 * 1. **路径必须落在工作区内**。`identity.md` / 技能 / 记忆全是模型自己写得动的文件，
 *    给它一个能拼 `../../.ssh/id_rsa` 的 `write`，剩下的只是时间问题。
 * 2. **列表必须有序**。目录顺序来自文件系统，不同机器不一样；而提示词要求逐字节确定性
 *    （`SEED-CONTRACT.md` §4），所以排序交给 `runtime/io` 的码点比较。
 */
import { rm } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { listDirSorted, mtimeOrUndefined, readTextOrUndefined, writeTextAt, type DirEntry } from "./runtime/io.ts";

/** 一个目录项。与 `runtime/io` 的 `DirEntry` 是同一个形状。 */
export type FsxEntry = DirEntry;

/** 工作区访问句柄。所有方法收的是**相对工作区根**的路径。 */
export type Fsx = {
	readonly root: string;
	/** 读一份文本。不存在/读失败 = `undefined`。 */
	readText(rel: string): Promise<string | undefined>;
	/** 写一份文本，父目录自动建。 */
	writeText(rel: string, text: string): Promise<void>;
	/** 列目录，按名字码点升序。目录不存在 = 空数组。 */
	list(rel: string): Promise<readonly FsxEntry[]>;
	/** 存在吗（文件或目录都算）。 */
	exists(rel: string): Promise<boolean>;
	/** 删文件或目录（递归）。不存在不算错。 */
	remove(rel: string): Promise<void>;
};

/** 越界访问。捕获方只看 `code`，不看类名。 */
class FsxEscapeError extends Error {
	readonly code = "outside-workspace";
	readonly rel: string;

	constructor(rel: string, root: string) {
		super(`路径逃出工作区：${rel}（根：${root}）`);
		this.name = "FsxEscapeError";
		this.rel = rel;
	}
}

/**
 * 把相对路径钉死在工作区内，返回绝对路径。越界抛 `FsxEscapeError`。
 *
 * 绝对路径一律拒绝：`/etc/passwd` 与 `../../x` 是同一类问题，没必要分别处理。
 * 判据是**解析后**的 `relative()`，所以 `a/../../b` 这种绕路也拦得住。
 */
function resolveIn(root: string, rel: string): string {
	if (isAbsolute(rel)) throw new FsxEscapeError(rel, root);
	const base = resolve(root);
	const target = resolve(base, rel);
	const back = relative(base, target);
	if (back === ".." || back.startsWith(`..${sep}`) || isAbsolute(back)) {
		throw new FsxEscapeError(rel, root);
	}
	return target;
}

/**
 * `resolveIn` 的「不抛」版本：越界返回 `undefined`。
 *
 * 留给「用户给了一个路径」的入口（工具的 `file`），那里越界是一句可回答的错误，
 * 不是异常。
 */
export function resolveInOrUndefined(root: string, rel: string): string | undefined {
	try {
		return resolveIn(root, rel);
	} catch {
		return undefined;
	}
}

/** 造一个句柄。根目录只在这里解析一次。 */
export function createFsx(root: string): Fsx {
	const at = (rel: string): string => resolveIn(root, rel);

	return {
		root: resolve(root),

		readText: (rel) => readTextOrUndefined(at(rel)),

		writeText: async (rel, text) => {
			await writeTextAt(at(rel), text);
		},

		list: (rel) => listDirSorted(at(rel)),

		exists: async (rel) => (await mtimeOrUndefined(at(rel))) !== undefined,

		remove: async (rel) => {
			await rm(at(rel), { recursive: true, force: true });
		},
	};
}
