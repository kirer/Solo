/**
 * 附件（原 `uploads.ts`）：上传落盘与取回。
 *
 * 只读文件树已经删掉（ADR-091）——界面上没有「文件」页了，这个文件只剩附件。
 * 分界线照旧：**app 决定「这个 id 是什么、该不该内联、叫什么名字」**，
 * 传输层只负责把字节推出去。
 */
import type { CoreServices } from "./types.ts";
import { AppError } from "./errors.ts";
import {
	contentDisposition,
	kindOfMime,
	readUploadMeta,
	sweepOrphanUploads,
	uploadPathOf,
	uploadsRootOf,
} from "../channel/files.ts";

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
