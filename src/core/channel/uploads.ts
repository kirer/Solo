/**
 * 附件：文件落在磁盘上，频道文档里只留一条引用。
 *
 * 为什么不做成「把附件塞进频道文档」：频道文档是**单一**文档，每条消息都是一条增量
 * op。把 base64 塞进去，等于每条消息都往同一条时间线上多背几 MB —— 这个仓库已经
 * 吃过一次「一条消息重写整个频道」（189 条消息涨到 27 MB，见 ADR-027）。所以：
 *
 * ```
 * <workspace>/uploads/<id>        ← 文件本体（id = randomUUID）
 * <workspace>/uploads/<id>.json   ← { name, mime, bytes, at }
 * ```
 *
 * 元数据单独一个文件而不是一个总索引：索引要么频繁重写成大 JSON，要么在并发上传时
 * 互相覆盖。一个文件一份元数据，写入是原子的、并发无冲突，列目录就能校验。
 *
 * **id 是客户端唯一能影响路径的东西**，所以只允许 `[A-Za-z0-9-]`：`..`、`/`、`%2e`
 * 一个都过不去。所有拼路径的地方都必须先过 `isUploadId`。
 */
import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Attachment } from "../channel/state.ts";

/** 单文件上限。25MB 够放截图与文稿，又不至于一条消息把磁盘塞满。 */
export const UPLOAD_MAX_BYTES = 25 * 1024 * 1024;

/** 一条消息最多带几个附件。超过这个数界面也排不下，直接拒。 */
export const UPLOAD_PER_MESSAGE = 10;

/**
 * id 的合法形状。
 *
 * 用白名单而不是「过滤掉 `..`」：过滤法永远漏一种编码（`%2e%2e`、Unicode 归一化、
 * Windows 的反斜杠），白名单只有一种结果。
 */
const ID_PATTERN = /^[A-Za-z0-9-]+$/;

export function isUploadId(id: string): boolean {
	return ID_PATTERN.test(id);
}

/**
 * 能在浏览器里**内联**显示的图片类型。
 *
 * 故意不含 `image/svg+xml`：SVG 是能跑脚本的文档，同源内联等于给自己开一个 XSS 口子。
 * SVG 一律按文件下载（`kind: "file"`），要看就下载后本地打开。
 */
const INLINE_IMAGE = /^image\/(png|jpeg|webp|gif|avif|bmp)$/;

/** 按 mime 判类别。客户端声明的 `kind` 一律不信，只信这里。 */
export function kindOfMime(mime: string): "image" | "file" {
	return INLINE_IMAGE.test(mime) ? "image" : "file";
}

/** 规范化 `content-type`：去掉 `; charset=...`、转小写；没给就是八位字节流。 */
export function mimeOf(raw: string | undefined): string {
	const value = (raw ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
	return value === "" || !value.includes("/") ? "application/octet-stream" : value;
}

/**
 * 文件名清洗：只留最后一段、去掉控制字符、限长。
 *
 * 名字只用于显示与下载建议名，但仍然不能带路径 —— 有些客户端会把整条本地路径当名字
 * 发上来（`C:\Users\...\a.png`），带着它进 `content-disposition` 就是路径泄露。
 */
export function safeName(raw: string | undefined): string {
	const flat = (raw ?? "").split(/[\\/]/).pop() ?? "";
	// eslint-disable-next-line no-control-regex
	const cleaned = flat.replace(/[\u0000-\u001f\u007f]/g, "").trim();
	const capped = [...cleaned].slice(0, 120).join("");
	return capped === "" ? "附件" : capped;
}

/**
 * 从请求里取文件名：优先 `x-filename` 头，其次 `?name=`。
 *
 * 头部是 latin-1 通道，放不进原始中文，所以客户端会先 `encodeURIComponent`；这里
 * 见到 `%` 就试着解一次。解不开（名字里本来就有个光秃秃的 `%`）就按原文用。
 */
export function nameFrom(headerValue: string | undefined, queryValue: string | null): string {
	const raw = (headerValue ?? "").trim() !== "" ? (headerValue as string) : (queryValue ?? "");
	let decoded = raw;
	if (raw.includes("%")) {
		try {
			decoded = decodeURIComponent(raw);
		} catch {
			decoded = raw;
		}
	}
	return safeName(decoded);
}

/**
 * `content-disposition` 头。
 *
 * 两段都给：`filename=` 是 ASCII 兜底（老客户端只认它），`filename*=UTF-8''` 才是
 * 真名（中文文件名只有这一段是对的）。
 */
export function contentDisposition(inline: boolean, name: string): string {
	const ascii = name.replace(/[^\u0020-\u007e]/g, "_").replace(/["\\]/g, "_");
	const encoded = encodeURIComponent(name).replace(
		/['()*]/g,
		(char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
	);
	return `${inline ? "inline" : "attachment"}; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

/** 磁盘上的元数据。键顺序固定，写出去就是确定的字节。 */
export type UploadMeta = {
	readonly name: string;
	readonly mime: string;
	readonly bytes: number;
	readonly at: number;
};

/** 附件根目录：`<workspace>/uploads`。`agentsRoot` 是 `<workspace>/agents`。 */
export function uploadsRootOf(agentsRoot: string): string {
	return join(dirname(agentsRoot), "uploads");
}

/** 文件本体路径。id 不合法就给 `undefined`（调用方必须当「没有」处理）。 */
export function uploadPathOf(root: string, id: string): string | undefined {
	return isUploadId(id) ? join(root, id) : undefined;
}

function metaPathOf(root: string, id: string): string | undefined {
	return isUploadId(id) ? join(root, `${id}.json`) : undefined;
}

/** 落一个新附件，返回频道文档里要存的那条引用。 */
export async function putUpload(
	root: string,
	input: { readonly name: string; readonly mime: string; readonly bytes: Uint8Array; readonly at: number },
): Promise<Attachment> {
	const id = randomUUID();
	await mkdir(root, { recursive: true });
	await writeFile(join(root, id), input.bytes);
	const meta: UploadMeta = {
		name: safeName(input.name),
		mime: input.mime,
		bytes: input.bytes.byteLength,
		at: input.at,
	};
	await writeFile(join(root, `${id}.json`), `${JSON.stringify(meta, null, "\t")}\n`, "utf8");
	return { id, name: meta.name, kind: kindOfMime(meta.mime), bytes: meta.bytes };
}

/**
 * 读一个附件的元数据；文件本体不在就当作不存在。
 *
 * 为什么还要 `stat` 一次本体：写入是两次 write，进程被 kill 在中间会留下一个只有
 * 元数据的孤儿。只读 `.json` 就会让界面显示一个点了必然 404 的附件。
 */
export async function readUploadMeta(root: string, id: string): Promise<UploadMeta | undefined> {
	const metaPath = metaPathOf(root, id);
	const bodyPath = uploadPathOf(root, id);
	if (metaPath === undefined || bodyPath === undefined) return undefined;
	let raw: string;
	try {
		raw = await readFile(metaPath, "utf8");
	} catch {
		return undefined;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return undefined;
	}
	const meta = parsed as Partial<UploadMeta>;
	if (
		typeof meta.name !== "string" ||
		typeof meta.mime !== "string" ||
		typeof meta.bytes !== "number" ||
		typeof meta.at !== "number"
	) {
		return undefined;
	}
	try {
		const info = await stat(bodyPath);
		if (info.size !== meta.bytes) return undefined;
	} catch {
		return undefined;
	}
	return { name: meta.name, mime: meta.mime, bytes: meta.bytes, at: meta.at };
}

/**
 * 扫掉没人引用的附件（审计 P2-3）。
 *
 * 为什么会有孤儿：`putUpload` 是两次 `writeFile`（本体 + 元数据），进程在中间被杀就留下
 * 半套；另外「上传了但没发出去」（我选了图又关掉页面）也会留一份永远没人用的文件。
 * `readUploadMeta` 只是把它显示成「不存在」，磁盘上一直占着。
 *
 * 三条安全线：
 * 1. **引用真相是频道文档里的 `attachments`**（调用方传进来），不是元数据文件；
 * 2. **太新的不动**：`minAgeMs` 之内的文件可能是正在上传的（写本体和写元数据之间），
 *    删了就是把人正在发的图弄丢；
 * 3. 只认 `isUploadId` 的纯文件名，别的（`.DS_Store`、子目录）一律不碰。
 */
export async function sweepOrphanUploads(
	root: string,
	referenced: ReadonlySet<string>,
	now: number,
	options: { readonly minAgeMs?: number } = {},
): Promise<{ scanned: number; removed: number; keptRecent: number }> {
	const minAgeMs = options.minAgeMs ?? 10 * 60_000;
	let scanned = 0;
	let removed = 0;
	let keptRecent = 0;
	let names: string[];
	try {
		names = await readdir(root);
	} catch {
		return { scanned, removed, keptRecent };
	}
	for (const name of names) {
		const id = name.endsWith(".json") ? name.slice(0, -".json".length) : name;
		if (!isUploadId(id)) continue;
		scanned += 1;
		if (referenced.has(id)) continue;
		const info = await stat(join(root, name)).catch(() => null);
		// 只删**普通文件**：同名目录（`sub` 也符合 id 白名单）删不掉，算进「已删」会骗人。
		if (info === null || !info.isFile()) continue;
		if (now - info.mtimeMs < minAgeMs) {
			keptRecent += 1;
			continue;
		}
		const ok = await unlink(join(root, name)).then(
			() => true,
			() => false,
		);
		if (ok && name === id) removed += 1;
	}
	return { scanned, removed, keptRecent };
}

/** 附件超出上限。单独一个类型，好让路由把它翻成 413 而不是 500。 */
export class UploadTooLargeError extends Error {
	readonly limit: number;

	constructor(limit: number) {
		super(`附件超过上限：${Math.round(limit / 1024 / 1024)}MB`);
		this.name = "UploadTooLargeError";
		this.limit = limit;
	}
}

/**
 * 读原始二进制正文，超上限立刻停。
 *
 * 边读边数而不是先读完再比：25MB 的上限如果先落地就失去了意义 —— 一个 4GB 的
 * 请求会先把内存吃光。这里读到超限就抛，剩下的字节由连接自己断开。
 */
export async function readBounded(
	chunks: AsyncIterable<Uint8Array | string>,
	limit = UPLOAD_MAX_BYTES,
): Promise<Buffer> {
	const parts: Buffer[] = [];
	let total = 0;
	for await (const chunk of chunks) {
		const part = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : Buffer.from(chunk);
		total += part.length;
		if (total > limit) throw new UploadTooLargeError(limit);
		parts.push(part);
	}
	return Buffer.concat(parts);
}

/**
 * 纯附件消息的正文占位。
 *
 * 为什么不能留空：下游很多判据按「正文非空」过滤（接力上限、占位吸收、`unread`、
 * 提示词里的发言摘要），空正文的消息对模型等于不存在 —— 我发了一张图，agent 什么
 * 都看不到。这份占位是**确定**的（同名同序同字节），并且前端认得这个形状，不会重复画。
 */
export function placeholderOf(attachments: readonly Attachment[]): string {
	return attachments
		.map((item) => (item.kind === "image" ? `[图片] ${item.name}` : `[文件] ${item.name}`))
		.join("\n");
}
