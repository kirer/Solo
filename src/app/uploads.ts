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
} from "../core/channel/attachments.ts";

/** 取一个附件时要给传输层的东西。 */
export type UploadForRead = {
	readonly path: string;
	readonly mime: string;
	readonly bytes: number;
	readonly name: string;
	/** 浏览器直接显示（图片 / PDF / 文本），而不是下载。 */
	readonly inline: boolean;
	readonly disposition: string;
};

export function createUploads(shell: CoreServices) {
	const root = shell.layout.uploadsRoot;

	/**
	 * `preview` = 在聊天里点开看一眼：图片 / PDF / 文本内联，其余照旧下载。
	 *
	 * HTML **永远按 `text/plain`** 发：附件是同源的，一个自称 HTML 的上传一旦当页面执行，
	 * 就是自己给自己开了一个 XSS。预览文本也声明编码 —— 中文文件不声明会变乱码。
	 */
	async function read(
		id: string,
		options: { readonly download?: boolean; readonly preview?: boolean } = {},
	): Promise<UploadForRead> {
		// 白名单 id 同时挡住了路径穿越：`../core.sqlite` 在 `:id` 里捕获不到 `/`，
		// 但 `..%2f` 能被解码回来，所以还是靠 `isUploadId` 再收一道。
		const path = uploadPathOf(root, id);
		const meta = await readUploadMeta(root, id);
		if (path === undefined || meta === undefined) throw new AppError("not-found", "没有这个文件");
		const text = meta.mime.startsWith("text/") || meta.mime === "application/pdf";
		const inline = options.download !== true && (kindOfMime(meta.mime) === "image" || (options.preview === true && text));
		const mime = inline && options.preview === true && meta.mime.startsWith("text/") ? `${meta.mime}; charset=utf-8` : meta.mime;
		return {
			path,
			mime: inline && options.preview === true && meta.mime === "text/html" ? "text/plain; charset=utf-8" : mime,
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
