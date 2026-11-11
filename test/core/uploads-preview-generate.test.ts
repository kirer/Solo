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
import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
const ID_DROP = "staged-eeeeeeee-5555-4555-8555-eeeeeeeeeeee";

/**
 * 用 `sharp` 造样本/读缩图，用完必须 `destroy()`。
 *
 * Windows 上 libvips 会一直握着文件句柄，不释放的话 `afterEach` 删临时目录会撞 `EBUSY`
 * （CI 上就是这么红的）。这不是「绕开断言」，是把句柄还回去。
 */
async function withSharp<T>(make: () => sharp.Sharp, use: (pipeline: sharp.Sharp) => Promise<T>): Promise<T> {
	const pipeline = make();
	try {
		return await use(pipeline);
	} finally {
		pipeline.destroy();
	}
}

/** 3000×2000 的纯色 JPEG：一眼能看出缩没缩。 */
async function bigJpeg(): Promise<Buffer> {
	return withSharp(
		() => sharp({ create: { width: 3000, height: 2000, channels: 3, background: { r: 30, g: 120, b: 200 } } }),
		(pipeline) => pipeline.jpeg({ quality: 90 }).toBuffer(),
	);
}

/** 400×300 的小 JPEG：缩完必须还是 400 宽，不能被拉到 1568。 */
async function smallJpeg(): Promise<Buffer> {
	return withSharp(
		() => sharp({ create: { width: 400, height: 300, channels: 3, background: { r: 200, g: 60, b: 60 } } }),
		(pipeline) => pipeline.jpeg({ quality: 90 }).toBuffer(),
	);
}

/** 全透明的 800×600 PNG：缩完角上必须还是 alpha 0。 */
async function transparentPng(): Promise<Buffer> {
	return withSharp(
		() => sharp({ create: { width: 800, height: 600, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }),
		(pipeline) => pipeline.png().toBuffer(),
	);
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

		// 按字节读，不按路径交给 libvips：Windows 上按路径打开会在临时目录里留下被攥着的句柄，
		// 后面的 rm 就撞 EBUSY。断言本身没变，只是换了个输入来源。
		const bytes = await readFile(got.path);
		const meta = await withSharp(() => sharp(bytes), (pipeline) => pipeline.metadata());
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
		const bytes = await readFile(got.path);
		const meta = await withSharp(() => sharp(bytes), (pipeline) => pipeline.metadata());
		expect(meta.width).toBe(400);
		expect(meta.height).toBe(300);
	});

	it("带 alpha 的图缩完角落还是透明的，不铺白底", async () => {
		await put(ID_ALPHA, "image/png", await transparentPng());

		const got = await uploads.read(ID_ALPHA, { preview: true });
		expect(got.mime).toBe("image/webp");

		const alphaBytes = await readFile(got.path);
		const { data, info } = await withSharp(
			() => sharp(alphaBytes),
			(pipeline) => pipeline.ensureAlpha().raw().toBuffer({ resolveWithObject: true }),
		);
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

	it("界面丢掉待发附件时，缩图一起删干净（不是静默留孤儿）", async () => {
		await put(ID_DROP, "image/jpeg", await bigJpeg());
		const got = await uploads.read(ID_DROP, { preview: true });
		expect(got.path).toBe(previewPathOf(root, ID_DROP));
		expect((await stat(got.path)).size).toBeGreaterThan(0);

		const logged: string[] = [];
		const spy = vi.spyOn(console, "log").mockImplementation((line: unknown) => {
			logged.push(String(line));
		});
		try {
			await uploads.drop([ID_DROP]);
		} finally {
			spy.mockRestore();
		}

		// 本体、元数据、缩图三样都得没；删不掉的话这回是「记一条日志」，不是吞掉。
		expect(await stat(join(root, ID_DROP)).catch(() => undefined)).toBeUndefined();
		expect(await stat(join(root, `${ID_DROP}.json`)).catch(() => undefined)).toBeUndefined();
		expect(await stat(got.path).catch(() => undefined)).toBeUndefined();
		expect(logged.filter((line) => line.includes("删不掉"))).toEqual([]);
	});

	it("缩图删不掉时不静默：记一条日志，路径写清", async () => {
		// 让缩图那一格变成目录：unlink 一定失败（EISDIR/EPERM），删不掉。
		const thumb = previewPathOf(root, ID_DROP);
		expect(thumb).toBeDefined();
		await mkdir(join(root, "previews"), { recursive: true });
		await mkdir(thumb ?? "", { recursive: true });

		const logged: string[] = [];
		const spy = vi.spyOn(console, "log").mockImplementation((line: unknown) => {
			logged.push(String(line));
		});
		try {
			await uploads.drop([ID_DROP]);
		} finally {
			spy.mockRestore();
		}

		expect(logged.some((line) => line.includes("删不掉") && line.includes(thumb ?? "<none>"))).toBe(true);
	});
});
