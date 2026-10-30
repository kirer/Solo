/**
 * 文件系统的**唯一入口**。
 *
 * 全项目只有这一个文件 import `node:fs`。理由是 V2 的账：21 个文件各写一套
 * `read + write + 错误处理 + 路径拼接`，78 处调用，于是「读不到算不算错」有五种答案，
 * 其中三种会让提示词里出现半句话。收成一处之后，答案只有一个。
 *
 * 三条硬约束：
 *
 * 1. **路径必须落在工作区内**。`identity.md` / 技能 / 记忆全是模型自己写得动的文件，
 *    给它一个能拼 `../../.ssh/id_rsa` 的 `write`，剩下的只是时间问题。
 * 2. **列表必须有序**。目录顺序来自文件系统，不同机器不一样；而提示词要求逐字节确定性
 *    （`SEED-CONTRACT.md` §4），所以排序在这里做，用码点比较而不是 `localeCompare`
 *    —— 后者跟着机器的 locale 变。
 * 3. **读不到不是错误**。缺席是常态（新 agent 还没有记忆、项目还没装技能），
 *    返回 `undefined`；写才可能失败，失败就抛。
 */
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

/** 一个目录项。`kind` 是 `readdir` 直接给的，不为判类型多跑一次 `stat`。 */
export type FsxEntry = {
	readonly name: string;
	readonly kind: "file" | "dir" | "other";
};

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

/** 越界访问。名字固定，调用方与测试都按它判。 */
export class FsxEscapeError extends Error {
	readonly code = "outside-workspace";
	readonly rel: string;

	constructor(rel: string, root: string) {
		super(`路径逃出工作区：${rel}（根：${root}）`);
		this.name = "FsxEscapeError";
		this.rel = rel;
	}
}

/** `stat` 拿不到 = 不存在。`exists` 用它，不走「列目录 + 读文本」那种两趟的绕路。 */
async function statOrUndefined(path: string) {
	try {
		return await stat(path);
	} catch {
		return undefined;
	}
}

/** 码点比较：不用 `localeCompare`，它随 locale 变，提示词会跟着变。 */
function byName(a: FsxEntry, b: FsxEntry): number {
	return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

/**
 * 把相对路径钉死在工作区内，返回绝对路径。越界抛 `FsxEscapeError`。
 *
 * 绝对路径一律拒绝：`/etc/passwd` 与 `../../x` 是同一类问题，没必要分别处理。
 * 判据是**解析后**的 `relative()`，所以 `a/../../b` 这种绕路也拦得住。
 */
export function resolveIn(root: string, rel: string): string {
	if (isAbsolute(rel)) throw new FsxEscapeError(rel, root);
	const base = resolve(root);
	const target = resolve(base, rel);
	const back = relative(base, target);
	if (back === ".." || back.startsWith(`..${sep}`) || isAbsolute(back)) {
		throw new FsxEscapeError(rel, root);
	}
	return target;
}

/** 造一个句柄。根目录只在这里解析一次。 */
export function createFsx(root: string): Fsx {
	const base = resolve(root);

	const at = (rel: string): string => resolveIn(base, rel);

	return {
		root: base,

		async readText(rel) {
			try {
				return await readFile(at(rel), "utf8");
			} catch {
				return undefined;
			}
		},

		async writeText(rel, text) {
			const target = at(rel);
			await mkdir(dirname(target), { recursive: true });
			await writeFile(target, text, "utf8");
		},

		async list(rel) {
			let entries;
			try {
				entries = await readdir(at(rel), { withFileTypes: true });
			} catch {
				return [];
			}
			const out: FsxEntry[] = entries.map((entry) => ({
				name: entry.name,
				kind: entry.isFile() ? "file" : entry.isDirectory() ? "dir" : "other",
			}));
			return out.sort(byName);
		},

		async exists(rel) {
			return (await statOrUndefined(at(rel))) !== undefined;
		},

		async remove(rel) {
			await rm(at(rel), { recursive: true, force: true });
		},
	};
}
