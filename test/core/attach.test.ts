/**
 * 附件 → 模型能看见的内容块。
 *
 * 这个文件的存在本身就是一次修正：以前我发截图，模型只看到「[图片] x.png」，
 * 于是回「我读不了图片」。底层 `UserInput` 本来允许图片内容块 —— 是我们的投递层
 * 没把文件读出来。
 */
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	MAX_INLINE_IMAGES,
	MAX_INLINE_IMAGE_BYTES,
	planAttachments,
} from "../../src/core/channel/attachments.ts";
import type { Attachment } from "../../src/core/channel/types.ts";

let root = "";

beforeEach(async () => {
	root = join(tmpdir(), `attach-${Date.now()}-${Math.random().toString(16).slice(2)}`);
	await mkdir(root, { recursive: true });
});

afterEach(async () => {
	await rm(root, { recursive: true, force: true });
});

/** 落一个假附件：本体 + 元数据，和 `putUpload` 写出来的形状一致。 */
async function put(
	id: string,
	options: { mime?: string; bytes?: Buffer } = {},
): Promise<Attachment> {
	const bytes = options.bytes ?? Buffer.from("fake-png-bytes");
	const mime = options.mime ?? "image/png";
	await writeFile(join(root, id), bytes);
	await writeFile(
		join(root, `${id}.json`),
		JSON.stringify({ name: `${id}.png`, mime, bytes: bytes.byteLength, at: 1 }),
		"utf8",
	);
	return {
		id,
		name: `${id}.png`,
		kind: mime.startsWith("image/") ? "image" : "file",
		bytes: bytes.byteLength,
	};
}

describe("planAttachments", () => {
	it("没有附件：空计划", async () => {
		const plan = await planAttachments(root, undefined);
		expect(plan.images).toEqual([]);
		expect(plan.lines).toEqual([]);
		expect((await planAttachments(root, [])).images).toEqual([]);
	});

	it("图片读成内容块，mime 走磁盘元数据", async () => {
		const item = await put("a1", { bytes: Buffer.from("png-a") });
		const plan = await planAttachments(root, [item]);
		expect(plan.images).toHaveLength(1);
		expect(plan.images[0]?.type).toBe("image");
		expect(plan.images[0]?.mimeType).toBe("image/png");
		expect(Buffer.from(plan.images[0]!.data, "base64").toString()).toBe("png-a");
		expect(plan.lines.join("\n")).toContain("已经直接给你看了");
	});

	it("非图片文件不内联，给 file(action=read) 的路径", async () => {
		const item = await put("b1", { mime: "text/plain" });
		const plan = await planAttachments(root, [item]);
		expect(plan.images).toEqual([]);
		expect(plan.lines.join("\n")).toContain("uploads/b1");
		expect(plan.lines.join("\n")).toContain("file(action=read)");
	});

	it("超过单张上限：不内联，但明确说没给看", async () => {
		const item: Attachment = {
			id: "big",
			name: "big.png",
			kind: "image",
			// 只报大小，不真的写这么大的文件 —— 闸在 readFile 之前就生效。
			bytes: MAX_INLINE_IMAGE_BYTES + 1,
		};
		const plan = await planAttachments(root, [item]);
		expect(plan.images).toEqual([]);
		expect(plan.lines.join("\n")).toContain("没有直接给你看");
	});

	it(`超过 ${MAX_INLINE_IMAGES} 张：只内联前面几张，其余说清楚`, async () => {
		const items: Attachment[] = [];
		for (let index = 0; index <= MAX_INLINE_IMAGES; index += 1) {
			items.push(await put(`c${index}`));
		}
		const plan = await planAttachments(root, items);
		expect(plan.images).toHaveLength(MAX_INLINE_IMAGES);
		expect(plan.lines.filter((line) => line.includes("没给你看"))).toHaveLength(1);
	});

	it("本体不见了：不崩，也不假装看过", async () => {
		const item: Attachment = { id: "gone", name: "gone.png", kind: "image", bytes: 10 };
		const plan = await planAttachments(root, [item]);
		expect(plan.images).toEqual([]);
		expect(plan.lines.join("\n")).toContain("别假装看过");
	});

	it("没有附件根：图片不内联，文件也没路径可给", async () => {
		const image = await put("d1");
		const file = await put("d2", { mime: "text/plain" });
		const plan = await planAttachments(undefined, [image, file]);
		expect(plan.images).toEqual([]);
		expect(plan.lines.join("\n")).toContain("没有取到文件");
		// 文件那一条也不能凭空编一个能读的路径 —— 但它仍要报出 id，人能自己去看。
		expect(plan.lines.join("\n")).toContain("uploads/d2");
	});
});
