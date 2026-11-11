/**
 * 附件缩图的取用与回收。
 *
 * 老板 2026-11-11：带图频道 21 张图 80MB 全量下，列表要缩图、点开要原图。
 *
 * 这里钉的是**跟「用不用图像库」无关的那一半**：
 * - 什么时候回缩图、什么时候必须回原图（`preview=1&download=1` / 不带 `preview`）；
 * - 缩图不在盘上时退回原图，不能因为缩图把图看不了；
 * - 缩图跟附件本体同一条命：本体被删（`drop` / `sweep`），缩图跟着走，盘不会一直涨。
 *
 * 缩图本身怎么编码（WebP / 用不用 `sharp`）不在这条测试里 —— 那要等老板拍板。
 */
import { mkdir, mkdtemp, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createUploads, PREVIEW_DIR, previewPathOf } from "../../src/app/uploads.ts";

let root = "";
let uploads: ReturnType<typeof createUploads>;

/**
 * `createUploads` 只用到 `layout.uploadsRoot` 和 `channels()`。
 * `channels()` 必须给：`sweep` 第一行就调它，不给就抛，被那个 `try/catch` 吞成「什么都没扫」——
 * 测试会静默变成「什么都没验」。
 */
function fakeShell(): Parameters<typeof createUploads>[0] {
	return {
		layout: { uploadsRoot: root },
		channels: async () => ({ messages: {} }),
	} as unknown as Parameters<typeof createUploads>[0];
}

async function put(id: string, mime: string, body = "original-bytes"): Promise<string> {
	const path = join(root, id);
	await writeFile(path, body, "utf8");
	await writeFile(
		join(root, `${id}.json`),
		JSON.stringify({ name: "x", mime, bytes: Buffer.byteLength(body), at: Date.now() }),
		"utf8",
	);
	return path;
}

async function putThumb(id: string): Promise<string> {
	const path = previewPathOf(root, id) ?? "";
	await mkdir(join(root, PREVIEW_DIR), { recursive: true });
	await writeFile(path, "thumb-bytes", "utf8");
	return path;
}

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "app-uploads-preview-"));
	uploads = createUploads(fakeShell());
});

afterEach(async () => {
	await rm(root, { recursive: true, force: true });
});

describe("附件缩图", () => {
	it("preview=1 的图片：缩图在就用缩图，明说 image/webp", async () => {
		const id = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
		const original = await put(id, "image/png");
		await putThumb(id);
		const file = await uploads.read(id, { preview: true });
		expect(file.path).toBe(previewPathOf(root, id));
		expect(file.path).not.toBe(original);
		expect(file.mime).toBe("image/webp");
		expect(file.bytes).toBe(Buffer.byteLength("thumb-bytes"));
		expect(file.inline).toBe(true);
	});

	it("preview=1&download=1 还是原图（点开/另存不受缩图影响）", async () => {
		const id = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb";
		const original = await put(id, "image/png");
		await putThumb(id);
		const file = await uploads.read(id, { preview: true, download: true });
		expect(file.path).toBe(original);
		expect(file.mime).toBe("image/png");
	});

	it("不带 preview 还是原图（老界面、旧链接不该被悄悄换成缩图）", async () => {
		const id = "cccccccc-3333-4333-8333-cccccccccccc";
		const original = await put(id, "image/png");
		await putThumb(id);
		const file = await uploads.read(id);
		expect(file.path).toBe(original);
	});

	it("缩图还没生成：退回原图，不能把图看不了", async () => {
		const id = "dddddddd-4444-4444-8444-dddddddddddd";
		const original = await put(id, "image/jpeg");
		const file = await uploads.read(id, { preview: true });
		expect(file.path).toBe(original);
		expect(file.mime).toBe("image/jpeg");
	});

	it("缩图是个 0 字节的坏文件：也退回原图，不推一个空响应出去", async () => {
		const id = "eeeeeeee-5555-4555-8555-eeeeeeeeeeee";
		const original = await put(id, "image/jpeg");
		await putThumb(id);
		await writeFile(previewPathOf(root, id) ?? "", "", "utf8");
		const file = await uploads.read(id, { preview: true });
		expect(file.path).toBe(original);
	});

	it("文本与 PDF 一个字节都不动：它们本来就不该有缩图", async () => {
		const textId = "11111111-6666-4666-8666-111111111111";
		await put(textId, "text/markdown");
		await putThumb(textId); // 就算盘上有，也不许拿它顶替
		const text = await uploads.read(textId, { preview: true });
		expect(text.mime).toBe("text/markdown; charset=utf-8");
		expect(text.path).toBe(join(root, textId));

		const pdfId = "22222222-7777-4777-8777-222222222222";
		await put(pdfId, "application/pdf");
		await putThumb(pdfId);
		const pdf = await uploads.read(pdfId, { preview: true });
		expect(pdf.mime).toBe("application/pdf");
		expect(pdf.path).toBe(join(root, pdfId));
	});

	it("本体被删掉时缩图跟着走：盘不会一直涨", async () => {
		// `drop` 只对待发附件（`staged-`）生效，普通附件靠 `sweep` 回收；
		// 两条路都得把缩图带上，所以这里两条都打一遍。
		const dropped = `33333333-8888-4888-8888-333333333333`;
		const droppedPath = await put(dropped, "image/png");
		const droppedThumb = await putThumb(dropped);
		// `sweep` 只收「超过 10 分钟」的：把本体拨到 11 分钟前，不然它算「可能正在上传的」。
		const old = new Date(Date.now() - 11 * 60_000);
		await utimes(droppedPath, old, old);
		await utimes(`${droppedPath}.json`, old, old);
		await uploads.sweep();
		await expect(stat(droppedPath)).rejects.toThrow();
		await expect(stat(droppedThumb)).rejects.toThrow();

		const staged = `staged-44444444-9999-4999-8999-444444444444`;
		await put(staged, "image/png");
		const stagedThumb = await putThumb(staged);
		await uploads.drop([staged]);
		await expect(stat(stagedThumb)).rejects.toThrow();
	});
});
