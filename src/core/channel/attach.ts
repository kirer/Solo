/**
 * 附件 → 模型能看见的东西。
 *
 * 背景：老板发一张截图，模型以前只看到一行字「[图片] 宽图.png」，于是它只能回
 * 「我读不了图里的内容」。这是实现的问题，不是模型的问题 —— 底层（pi-ai）的
 * `UserInput` 本来就允许 `{ type: "image", data, mimeType }` 内容块。
 *
 * 两类附件走两条路：
 *
 * - **图片**：读成 base64 内联进这一轮输入。模型真的看得见。
 * - **其它文件**：不内联（模型没法直接吃 PDF/zip），但把**工作区内的路径**告诉它，
 *   它自己的 `read_file` 就能读（文本、代码、csv、json 都能读）。
 *
 * 三条闸，都因为「图片按 token 计费，而且是每一轮都重发」：
 *
 * 1. 一条消息最多 `MAX_INLINE_IMAGES` 张图。
 * 2. 单张超过 `MAX_INLINE_IMAGE_BYTES` 不内联。
 * 3. 一条消息的图片总量超过 `MAX_INLINE_TOTAL_BYTES` 就截断到放得下的那几张。
 *
 * 被截掉的图必须在正文里说清「没给你看」—— 悄悄丢掉会让模型以为它看过了。
 */
import { readFile } from "node:fs/promises";
import type { Attachment } from "./state.ts";
import { readUploadMeta, uploadPathOf } from "./uploads.ts";

/** 一条消息最多内联几张图。 */
export const MAX_INLINE_IMAGES = 4;
/** 单张图的上限（原始字节）。base64 会再涨三分之一，所以留了余量。 */
export const MAX_INLINE_IMAGE_BYTES = 4 * 1024 * 1024;
/** 一条消息里所有内联图的原始字节总量上限。 */
export const MAX_INLINE_TOTAL_BYTES = 8 * 1024 * 1024;

/** 模型能直接看的图片内容块。形状由 pi-ai 的 `ImageContent` 定。 */
export type InlineImage = {
	readonly type: "image";
	readonly data: string;
	readonly mimeType: string;
};

export type AttachmentPlan = {
	/** 直接塞进这一轮输入的图片。可能少于附件里的图片数（被闸挡住的不在这里）。 */
	readonly images: readonly InlineImage[];
	/** 拼进正文的说明，一行一条。没有附件时为空数组。 */
	readonly lines: readonly string[];
};

/** 没给附件时的空计划。省得调用方到处判 `undefined`。 */
export const NO_ATTACHMENTS: AttachmentPlan = { images: [], lines: [] };

/** `11 B` / `4.2 KB` / `1.3 MB` —— 与界面同一套写法。 */
function humanBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * 把附件读成「图片内容块 + 正文说明」。
 *
 * `root` 是附件根目录（`<workspace>/uploads`）。拿不到根、或某个附件本体已经不在，
 * 都退化成「只有说明」而不是抛错 —— 附件不该让一条已经落库的消息变成错误。
 */
export async function planAttachments(
	root: string | undefined,
	attachments: readonly Attachment[] | undefined,
): Promise<AttachmentPlan> {
	if (attachments === undefined || attachments.length === 0) return NO_ATTACHMENTS;

	const images: InlineImage[] = [];
	const lines: string[] = [];
	let totalBytes = 0;

	for (const attachment of attachments) {
		const size = humanBytes(attachment.bytes);
		if (attachment.kind !== "image") {
			lines.push(
				`- 文件「${attachment.name}」（${size}）：用 read_file 读它，path 写 uploads/${attachment.id}`,
			);
			continue;
		}
		// 图片：能内联就内联，不能就老实说没给。
		const path = root === undefined ? undefined : uploadPathOf(root, attachment.id);
		if (path === undefined) {
			lines.push(`- 图片「${attachment.name}」（${size}）：没有取到文件，别假装看过。`);
			continue;
		}
		if (attachment.bytes > MAX_INLINE_IMAGE_BYTES) {
			lines.push(
				`- 图片「${attachment.name}」（${size}）：太大，没有直接给你看。要细节请老板说一句里面的内容，或者裁小一点再发。`,
			);
			continue;
		}
		if (images.length >= MAX_INLINE_IMAGES) {
			lines.push(
				`- 图片「${attachment.name}」（${size}）：这条消息图片超过 ${MAX_INLINE_IMAGES} 张，这一张没给你看。`,
			);
			continue;
		}
		if (totalBytes + attachment.bytes > MAX_INLINE_TOTAL_BYTES) {
			lines.push(
				`- 图片「${attachment.name}」（${size}）：加上其它图超过单条上限，这一张没给你看。`,
			);
			continue;
		}
		let bytes: Buffer;
		try {
			bytes = await readFile(path);
		} catch {
			lines.push(`- 图片「${attachment.name}」（${size}）：文件已不在，别假装看过。`);
			continue;
		}
		const meta = await readUploadMeta(root as string, attachment.id).catch(() => undefined);
		// mime 从磁盘元数据来（HTTP 上传时写下的），不信文档里那份可以改的副本。
		const mimeType = meta?.mime ?? "image/png";
		images.push({ type: "image", data: bytes.toString("base64"), mimeType });
		totalBytes += attachment.bytes;
		lines.push(`- 图片「${attachment.name}」已经直接给你看了。`);
	}

	return { images, lines };
}
