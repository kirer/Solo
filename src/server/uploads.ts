/**
 * 附件存储：`workspace/uploads/<id>/<name>`。
 *
 * 附件是「老板在对话里拖进来 / 粘贴的文件」。不解析内容，只落盘并把
 * 绝对路径交给模型——任何模型都能用 read / bash 工具去读，不需要附件
 * 专用工具，也不需要模型支持多模态。
 *
 * 设计取舍：
 * - 一个文件一个目录 + meta.json：`<id>` 不可猜（随机 8 字节），
 *   `<name>` 只用于下载时还原文件名；路径穿越由 {@link safeName} 阻断。
 * - 元数据独立落盘：进程重启后仍能下载，不依赖内存表。
 * - 单文件上限 20MiB：一个人本机产品的合理上限，超过直接 413。
 */
import { randomBytes } from "node:crypto";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";

/** 默认单文件上限：20MiB。 */
export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;

/** 已落盘的一个附件。 */
export type UploadedFile = {
	readonly id: string;
	readonly name: string;
	readonly size: number;
	readonly mime: string;
	/** 磁盘上的绝对路径（注入给模型的引用就用它）。 */
	readonly path: string;
	readonly createdAt: number;
};

/** 附件仓库。 */
export type UploadStore = {
	readonly root: string;
	/** 保存一份原始字节。 */
	save(input: {
		readonly bytes: Buffer;
		readonly name: string;
		readonly mime: string;
	}): Promise<UploadedFile>;
	/** 按 id 取元数据。 */
	get(id: string): Promise<UploadedFile | undefined>;
	/** 读回原始字节（下载用）。 */
	read(file: UploadedFile): Promise<Buffer>;
	/** 注入消息时只需要路径；不存在返回 undefined。 */
	resolve(id: string, name?: string): Promise<UploadedFile | undefined>;
};

/** 合法 id：16 位十六进制（见 {@link newId}）。 */
const ID_PATTERN = /^[a-f0-9]{16}$/;

/** 打开附件仓库（目录按需创建，不在启动时落盘）。 */
export function createUploadStore(options: {
	readonly root: string;
	readonly maxBytes?: number;
}): UploadStore {
	const root = options.root;
	const maxBytes = options.maxBytes ?? MAX_UPLOAD_BYTES;

	const store: UploadStore = {
		root,
		async save(input): Promise<UploadedFile> {
			if (input.bytes.byteLength > maxBytes) {
				throw new UploadTooLargeError(maxBytes);
			}
			const id = newId();
			const name = safeName(input.name);
			const directory = join(root, id);
			await mkdir(directory, { recursive: true });
			const path = join(directory, name);
			await writeFile(path, input.bytes);
			const file: UploadedFile = {
				id,
				name,
				size: input.bytes.byteLength,
				mime: input.mime === "" ? "application/octet-stream" : input.mime,
				path,
				createdAt: Date.now(),
			};
			await writeFile(join(directory, "meta.json"), `${JSON.stringify(file)}\n`, "utf8");
			return file;
		},
		async get(id): Promise<UploadedFile | undefined> {
			if (!ID_PATTERN.test(id)) return undefined;
			try {
				const raw = JSON.parse(await readFile(join(root, id, "meta.json"), "utf8")) as Partial<UploadedFile>;
				if (typeof raw.name !== "string" || typeof raw.size !== "number" || typeof raw.path !== "string") {
					return undefined;
				}
				return {
					id,
					name: raw.name,
					size: raw.size,
					mime: typeof raw.mime === "string" && raw.mime !== "" ? raw.mime : "application/octet-stream",
					path: raw.path,
					createdAt: typeof raw.createdAt === "number" ? raw.createdAt : 0,
				};
			} catch {
				return undefined;
			}
		},
		async read(file): Promise<Buffer> {
			return readFile(file.path);
		},
		async resolve(id, name): Promise<UploadedFile | undefined> {
			const file = await store.get(id);
			if (file === undefined) return undefined;
			// 下载 URL 里的名字只是「好看」；对不上说明 URL 被改过，按不存在处理
			if (name !== undefined && safeName(name) !== file.name) return undefined;
			return file;
		},
	};

	return store;
}

/** 附件超过上限（HTTP 层映射成 413）。 */
export class UploadTooLargeError extends Error {
	readonly limit: number;

	constructor(limit: number) {
		super(`附件超过 ${Math.round(limit / (1024 * 1024))}MiB 上限`);
		this.limit = limit;
	}
}

/** 删掉一份附件（保留给测试 / 将来清理用）。 */
export async function removeUpload(store: UploadStore, id: string): Promise<void> {
	const file = await store.get(id);
	if (file === undefined) return;
	await unlink(file.path).catch(() => undefined);
	await unlink(join(store.root, id, "meta.json")).catch(() => undefined);
}

/** 随机 id：8 字节 = 16 位十六进制。 */
function newId(): string {
	return randomBytes(8).toString("hex");
}

/**
 * 文件名净化：只留 basename，去掉路径分隔符与控制字符，限长 120。
 *
 * 必须做：`../../.ssh/id_rsa` 这种名字若原样进 join，会把文件写到目录外。
 */
export function safeName(input: string): string {
	const base = basename(input.replace(/\\/g, "/"))
		// 去掉控制字符（含 NUL）与 Windows 保留字符
		.replace(/[\u0000-\u001f\u007f<>:"|?*]/g, "")
		.trim();
	const fallback = base === "" || base === "." || base === ".." ? "file" : base;
	return fallback.slice(0, 120);
}
