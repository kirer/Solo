/**
 * 工作区的只读文件树（右栏「文件」页）。
 *
 * 三道闸全在这一个函数里，顺序有讲究：
 * 1) 前缀校验挡 `../..`；
 * 2) 链接本身不跟随 —— 右栏不需要顺着链接爬到工作区外面；
 * 3) 真实路径再校验一次 —— 父目录可能是链接，`resolve` 出来的字符串看着在里面，
 *    落盘时却落在外面。只查字符串前缀是审计 P0-2 的成因。
 *
 * 越界一律 403，前端不做 `..` 判断 —— 一件事有两处判断就会有两套答案。
 */
import { lstat, readdir, readFile, realpath, stat } from "node:fs/promises";
import { basename, dirname, join, resolve, sep } from "node:path";
import type { ViewFileEntry, ViewFilesList, ViewFileText } from "../view/dto.ts";
import { AppError } from "./errors.ts";
import type { CoreServices } from "./types.ts";
import {
	contentDisposition,
	kindOfMime,
	readUploadMeta,
	sweepOrphanUploads,
	uploadPathOf,
	uploadsRootOf,
} from "../channel/files.ts";

/** 右栏预览的上限：再大就不是「看一眼」，该下载了。 */
const FILE_TEXT_LIMIT = 200_000;

/** 文件列表一页多少条（默认 / 上限）。 */
const FILE_LIST_DEFAULT = 500;
const FILE_LIST_MAX = 2000;

/** 目录列表里同时开多少个 `stat`。够快，又不会在大目录上把文件描述符打满。 */
const FILE_STAT_CONCURRENCY = 16;

/** 右栏「文件」不该看见/不该读的东西：隐藏文件、node_modules、库与配置、附件与日志。 */
const HIDDEN_FILES = new Set(["core.sqlite", "settings.json"]);

/**
 * 名字规则。列表与直接访问**共用这一份** —— 只在列表里过滤等于没过滤。
 *
 * `relativePath` 用 `/` 分隔、相对工作区根（与接口返回的 `path` 同一口径）。
 */
export function fileHidden(name: string, relativePath: string): boolean {
	if (name.startsWith(".")) return true;
	if (name === "node_modules") return true;
	if (HIDDEN_FILES.has(name)) return true;
	const path = relativePath.split(sep).join("/");
	if (path === "uploads" || path.startsWith("uploads/")) return true;
	if (path.startsWith("logs/") && name.endsWith(".jsonl")) return true;
	return false;
}

/**
 * 限并发地跑一遍异步映射。
 *
 * 为什么不用 `Promise.all`：5000 个文件的目录会同时开 5000 个 `stat`，把 fd 和内存一起打满 ——
 * 那正是审计里「串行太慢」的反面错误。这里的并发上限是固定的，结果顺序与输入一致。
 */
export async function mapLimit<T, R>(
	items: readonly T[],
	limit: number,
	run: (item: T) => Promise<R>,
): Promise<R[]> {
	const out = new Array<R>(items.length);
	let next = 0;
	const worker = async (): Promise<void> => {
		for (;;) {
			const index = next;
			next += 1;
			if (index >= items.length) return;
			out[index] = await run(items[index] as T);
		}
	};
	await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
	return out;
}

export type FilesQuery = {
	readonly path?: string | undefined;
	readonly limit?: number | undefined;
	readonly offset?: number | undefined;
};

export function createFiles(workspaceRoot: string) {
	async function list(query: FilesQuery = {}): Promise<ViewFilesList | ViewFileText> {
		const asked = query.path ?? "";
		// 分页（审计 P2-2）：默认一页 500 条 —— 右栏那种目录远远用不完，
		// 而 5000 个文件的目录不会一次全 stat 一遍。上限 2000 防止被当成批量接口用。
		const askedLimit = query.limit ?? Number.NaN;
		const askedOffset = query.offset ?? Number.NaN;
		const limit =
			Number.isFinite(askedLimit) && askedLimit > 0 ? Math.min(Math.floor(askedLimit), FILE_LIST_MAX) : FILE_LIST_DEFAULT;
		const offset = Number.isFinite(askedOffset) && askedOffset > 0 ? Math.floor(askedOffset) : 0;
		const root = resolve(workspaceRoot);
		const target = resolve(root, asked);
		if (target !== root && !target.startsWith(root + sep)) throw new AppError("forbidden", "只能看工作区里的文件");
		const link = await lstat(target).catch(() => null);
		if (link === null) throw new AppError("not-found", "没有这个文件");
		if (link.isSymbolicLink()) throw new AppError("forbidden", "不跟随符号链接");
		const realRoot = (await realpath(root).catch(() => null)) ?? root;
		const real = await realpath(target).catch(() => null);
		if (real === null) throw new AppError("not-found", "没有这个文件");
		if (real !== realRoot && !real.startsWith(realRoot + sep)) throw new AppError("forbidden", "只能看工作区里的文件");
		const relative = target === root ? "" : target.slice(root.length + 1);
		// 名字规则对**直接访问**同样生效：只把隐藏文件从列表里去掉是假安全，
		// 知道名字的人照样能读（`?path=core.sqlite` 就是整库）。
		if (relative !== "" && fileHidden(basename(target), relative)) throw new AppError("not-found", "没有这个文件");
		const info = await stat(target).catch(() => null);
		if (info === null) throw new AppError("not-found", "没有这个文件");
		const parent = target === root ? null : dirname(target) === root ? "" : dirname(target).slice(root.length + 1);
		const shown = target === root ? "" : target.slice(root.length + 1);
		if (info.isFile()) {
			// 只把像文本的东西读出来：大于 200KB 或前 4KB 里有 NUL 就当二进制，
			// 只报大小，不猜它的内容。
			const size = info.size;
			if (size > FILE_TEXT_LIMIT) {
				return { path: shown, parent, file: { name: basename(target), bytes: size, binary: true, text: "" } };
			}
			const bytes = await readFile(target);
			const binary = bytes.subarray(0, 4096).includes(0);
			return {
				path: shown,
				parent,
				file: { name: basename(target), bytes: size, binary, text: binary ? "" : bytes.toString("utf8") },
			};
		}
		const names = await readdir(target, { withFileTypes: true });
		// 隐藏文件、node_modules 与敏感文件不进列表：那不是我要读的东西，
		// 只是噪音或不该看的（规则见 `fileHidden`，与直接访问共用一份）。
		const visible = names.filter(
			(dirent) => !fileHidden(dirent.name, relative === "" ? dirent.name : `${relative}/${dirent.name}`),
		);
		// 先按名字排（目录在前）再分页：顺序必须**稳定**，否则翻页会漏条目或重复。
		visible.sort((left, right) => {
			const leftDir = left.isDirectory();
			const rightDir = right.isDirectory();
			if (leftDir !== rightDir) return leftDir ? -1 : 1;
			return left.name.localeCompare(right.name, "zh");
		});
		const total = visible.length;
		const page = visible.slice(offset, offset + limit);
		const entries: ViewFileEntry[] = await mapLimit(page, FILE_STAT_CONCURRENCY, async (dirent) => {
			const meta = await stat(join(target, dirent.name)).catch(() => null);
			// stat 失败（刚被删、权限不足）**仍然返回这一条**：从列表里悄悄少一个文件，
			// 比显示成 0 字节更让人困惑 —— 后者点开就知道怎么回事。
			const dir = meta === null ? dirent.isDirectory() : meta.isDirectory();
			return {
				name: dirent.name,
				kind: dir ? "dir" : "file",
				bytes: meta === null || dir ? 0 : meta.size,
				at: meta === null ? 0 : Math.round(meta.mtimeMs),
			};
		});
		return {
			path: shown,
			parent,
			entries,
			// 前端目前不用这两个字段（默认一页 500 条，够右栏用）；给脚本一个明确的
			// 「还有多少没给」的说法，而不是让人数 entries 猜。
			total,
			truncated: offset + entries.length < total,
		};
	}

	return { list };
}

export type Files = ReturnType<typeof createFiles>;

// ── 附件（原 `uploads.ts`）──────────────────────────────────────────────
// 并进这里的原因：「上传」和「下载」是同一件事的两个方向，中间还共用一份元数据格式；
// 分两个文件时，`contentDisposition` 这种只有一边用的细节也得两边都 import。

/**
 * 附件：存进来的元数据 + 取出去的那一条。
 *
 * 迁移前这段逻辑一半在 `serve.ts` 的 handler 里（`writeHead` 拼 Content-Disposition），
 * 一半在 `channel/uploads.ts` 里。分界线在这里划清：**app 决定「这个 id 是什么、
 * 该不该内联、叫什么名字」**，传输层只负责把字节推出去。
 */

/** 取一个附件时要给传输层的东西。 */
export type UploadForRead = {
	readonly path: string;
	readonly mime: string;
	readonly bytes: number;
	readonly name: string;
	/** 图片默认内联（点缩略图开大图才能直接显示），其余一律下载。 */
	readonly inline: boolean;
	readonly disposition: string;
};

export function createUploads(shell: CoreServices) {
	const root = uploadsRootOf(shell.agentsRoot);

	async function read(id: string, options: { readonly download?: boolean } = {}): Promise<UploadForRead> {
		// 白名单 id 同时挡住了路径穿越：`../core.sqlite` 在 `:id` 里捕获不到 `/`，
		// 但 `..%2f` 能被解码回来，所以还是靠 `isUploadId` 再收一道。
		const path = uploadPathOf(root, id);
		const meta = await readUploadMeta(root, id);
		if (path === undefined || meta === undefined) throw new AppError("not-found", "没有这个文件");
		const inline = options.download !== true && kindOfMime(meta.mime) === "image";
		return {
			path,
			mime: meta.mime,
			bytes: meta.bytes,
			name: meta.name,
			inline,
			disposition: contentDisposition(inline, meta.name),
		};
	}

	/**
	 * 清一次上传孤儿（审计 P2-3）。
	 *
	 * 引用真相是频道文档里的 `attachments`：一条消息引用过的 id 一个都不动，其余超过
	 * 10 分钟的（避免误删正在上传的那半套）删掉。失败只记一行，不影响启动 ——
	 * 清不掉只是占点磁盘。
	 */
	async function sweep(): Promise<void> {
		try {
			const state = await shell.channels();
			const referenced = new Set<string>();
			for (const list of Object.values(state.messages ?? {})) {
				for (const message of list) {
					for (const attachment of message.attachments ?? []) referenced.add(attachment.id);
				}
			}
			const result = await sweepOrphanUploads(root, referenced, Date.now());
			if (result.removed > 0) {
				console.log(`[core] 清掉 ${result.removed} 个没人引用的上传文件（扫描 ${result.scanned} 个）`);
			}
		} catch {
			/* 清理失败不影响启动 */
		}
	}

	return { root, read, sweep };
}

export type Uploads = ReturnType<typeof createUploads>;
