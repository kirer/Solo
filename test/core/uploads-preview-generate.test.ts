/**
 * 缩图**生成**：第一次要缩图时现编一张 WebP（`sharp` / libvips）。
 *
 * 老板 2026-11-11 批了装 `sharp`。这里钉四件事：
 * - 第一次 `preview=1` 就把缩图编出来落盘，第二次不再编（同一个字节数、mtime 不动）；
 * - 长边封顶 1568，**只缩不放**；
 * - 带 alpha 的图缩完角落里还是透明的（不能变白底）；
 * - 编不出来（坏文件）退回原图，且同一个 id 不再反复重试；本体被删，缩图跟着走。
 *
 * 真图是现编的：用 `sharp` 自己造一张 3000×2000 的和一张透明 PNG，比往仓库里塞
 * 二进制样本干净，也不会有人拿一张对不上的样本「修」出假绿。
 */
import { mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createUploads, previewPathOf } from "../../src/app/uploads.ts";

let root = "";
let uploads: ReturnType<typeof createUploads>;

function fakeShell(): Parameters<typeof createUploads>[0] {
	return {
		layout: { uploadsRoot: root },
		channels: async () => ({ messages: {} }),
	} as unknown as Parameters<typeof createUploads>[0];
}

/** 落一份附件本体 + 元数据，正文就是传进来的字节。 */
async function put(id: string, mime: string, bytes: Buffer): Promise<string> {
	const path = join(root, id);
	await writeFile(path, bytes);
	await writeFile(
		join(root, `${id}.json`),
		JSON.stringify({ name: "x", mime, bytes: bytes.length, at: Date.now() }),
		"utf8",
	);
	return path;
}

const ID = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const ID_BAD = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb";
const ID_SMALL = "cccccccc-3333-4333-8333-cccccccccccc";
const ID_ALPHA = "dddddddd-4444-4444-8444-dddddddddddd";

/** 3000×2000 的纯色 JPEG：一眼能看出缩没缩。 */
async function bigJpeg(): Promise<Buffer> {
	return sharp({
		create: { width: 3000, height: 2000, channels: 3, background: { r: 30, g: 120, b: 200 } },
	})
		.jpeg({ quality: 90 })
		.toBuffer();
}

/** 400×300 的小 JPEG：缩完必须还是 400 宽，不能被拉到 1568。 */
async function smallJpeg(): Promise<Buffer> {
	return sharp({
		create: { width: 400, height: 300, channels: 3, background: { r: 200, g: 60, b: 60 } },
	})
		.jpeg({ quality: 90 })
		.toBuffer();
}

/** 全透明的 800×600 PNG：缩完角上必须还是 alpha 0。 */
async function transparentPng(): Promise<Buffer> {
	return sharp({
		create: { width: 800, height: 600, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
	})
		.png()
		.toBuffer();
}

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "app-uploads-gen-"));
	uploads = createUploads(fakeShell());
});

afterEach(async () => {
	await rm(root, { recursive: true, force: true });
});

describe("缩图生成", () => {
	it("第一次 preview=1 就现编一张 WebP 落盘，长边缩到 1568", async () => {
		const original = await put(ID, "image/jpeg", await bigJpeg());

		const got = await uploads.read(ID, { preview: true });
		expect(got.mime).toBe("image/webp");
		expect(got.path).toBe(previewPathOf(root, ID));

		const meta = await sharp(got.path).metadata();
		expect(meta.format).toBe("webp");
		expect(Math.max(meta.width ?? 0, meta.height ?? 0)).toBe(1568);
		// 3000×2000 等比缩：1568 × 1045
		expect(meta.height).toBe(1045);

		// 缩图确实比原图小（不是把原图改个名）
		const before = (await stat(original)).size;
		const after = (await stat(got.path)).size;
		expect(after).toBeLessThan(before);
	});

	it("第二次 preview=1 直接用盘上那张，不重编", async () => {
		await put(ID, "image/jpeg", await bigJpeg());

		const first = await uploads.read(ID, { preview: true });
		const firstBytes = await readFile(first.path);
		const firstStat = await stat(first.path);

		// 等一小会儿，重编的话 mtime 会变
		await new Promise((resolve) => setTimeout(resolve, 120));

		const second = await uploads.read(ID, { preview: true });
		expect(second.bytes).toBe(first.bytes);
		expect((await stat(second.path)).mtimeMs).toBe(firstStat.mtimeMs);
		expect((await readFile(second.path)).equals(firstBytes)).toBe(true);
	});

	it("小图只缩不放：400 宽的原图缩完还是 400 宽", async () => {
		await put(ID_SMALL, "image/jpeg", await smallJpeg());

		const got = await uploads.read(ID_SMALL, { preview: true });
		const meta = await sharp(got.path).metadata();
		expect(meta.width).toBe(400);
		expect(meta.height).toBe(300);
	});

	it("带 alpha 的图缩完角落还是透明的，不铺白底", async () => {
		await put(ID_ALPHA, "image/png", await transparentPng());

		const got = await uploads.read(ID_ALPHA, { preview: true });
		expect(got.mime).toBe("image/webp");

		const { data, info } = await sharp(got.path).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
		expect(info.channels).toBe(4);
		// 角上第一颗像素：完全透明，不是 255,255,255,255
		expect([...data.subarray(0, 4)]).toEqual([0, 0, 0, 0]);
	});

	it("坏图编不出来就退回原图，而且不反复重试", async () => {
		const bytes = Buffer.from("这不是一张图", "utf8");
		await put(ID_BAD, "image/png", bytes);

		const got = await uploads.read(ID_BAD, { preview: true });
		expect(got.path).toBe(join(root, ID_BAD));
		expect(got.mime).toBe("image/png");
		expect(await stat(previewPathOf(root, ID_BAD) ?? "").catch(() => undefined)).toBeUndefined();

		// 第二次不该再试着编：把本体换成一张好图，也还是回原图（黑名单生效）
		await put(ID_BAD, "image/png", await smallJpeg());
		const again = await uploads.read(ID_BAD, { preview: true });
		expect(again.path).toBe(join(root, ID_BAD));
		expect(await stat(previewPathOf(root, ID_BAD) ?? "").catch(() => undefined)).toBeUndefined();
	});

	it("本体被删时缩图跟着走", async () => {
		await put(ID, "image/jpeg", await bigJpeg());
		const got = await uploads.read(ID, { preview: true });
		expect((await stat(got.path)).size).toBeGreaterThan(0);

		// 拨老，走 sweep 的孤儿回收（核心里的「删」都是这条路）
		const old = new Date(Date.now() - 11 * 60_000);
		for (const name of [ID, `${ID}.json`]) await utimes(join(root, name), old, old);
		await uploads.sweep();

		expect(await stat(join(root, ID)).catch(() => undefined)).toBeUndefined();
		expect(await stat(got.path).catch(() => undefined)).toBeUndefined();
	});
});
