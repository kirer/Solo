/**
 * 附件（原 `uploads.ts`）：上传落盘与取回。
 *
 * 只读文件树已经删掉（ADR-091）——界面上没有「文件」页了，这个文件只剩附件。
 * 分界线照旧：**app 决定「这个 id 是什么、该不该内联、叫什么名字」**，
 * 传输层只负责把字节推出去。
 */
import { randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { basename } from "node:path";
import { createFiles } from "./files.ts";
import type { CoreServices } from "./types.ts";
import { AppError } from "./errors.ts";
import {
	contentDisposition,
	kindOfMime,
	putUpload,
	readUploadMeta,
	sweepOrphanUploads,
	uploadPathOf,
} from "../core/channel/attachments.ts";

/**
 * 「把正文里这个路径转成附件」用的前缀。
 *
 * 生成的是**真的一个附件**（同一个目录、同一份元数据），只是名字带前缀：发出去之前它
 * 没人引用，`sweep` 会照旧收走；发出去以后消息里引用的是它的 id，和手选上传的没区别。
 * 前缀的作用只有一个 —— 让 `read` 知道「这个能在还没发的时候预览」。
 */
export const STAGED_PREFIX = "staged-";

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
	/** 转附件时走的是同一条预览/校验：路径规矩只有一份。 */
	const files = createFiles(shell.layout);

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

	/**
	 * 把正文里的一个路径转成一个**待发附件**。
	 *
	 * 两个必须：①**先过 `files.preview`**，路径校验一条都不新写 —— 那三条硬线（相对路径、
	 * 不许 `..`、隐藏文件与自家密钥不给看）本来就在那儿，绕开它等于开了第二个后门；
	 * ②只搬 `preview` 认的字节（文本 / 图片 / PDF，各有大小上限），认不出的不搬 ——
	 * 转成附件以后，界面就要负责把它画出来，画不了的东西别往队列里放。
	 *
	 * id 带 `STAGED_PREFIX`：发出去之前没人引用，`sweep` 到点会收走，不会一直占磁盘。
	 */
	async function stage(path: string): Promise<{ readonly id: string; readonly name: string; readonly kind: "image" | "file"; readonly bytes: number }> {
		const file = await files.preview(path);
		// 认不出的格式与找不到分开说：前者是「换不了」，后者是「没这个文件」。
		if (file.kind === "none") throw new AppError(file.status === 415 ? "bad-request" : "not-found", file.reason);
		let bytes: Uint8Array;
		try {
			bytes = await readFile(file.path);
		} catch {
			throw new AppError("not-found", "这个文件读不出来");
		}
		// 读完再看一眼大小：`preview` 判的是它 `stat` 那一刻的大小，中间被改大就不搬。
		const now = await stat(file.path).catch(() => undefined);
		if (now === undefined || now.size !== bytes.byteLength) throw new AppError("bad-request", "文件正在变，稍后再试");
		const name = basename(file.name) === "" ? "附件" : file.name;
		return await putUpload(root, { id: STAGED_PREFIX + randomUUID(), name, mime: file.mime, bytes, at: Date.now() });
	}

	return { root, read, stage, sweep };
}
