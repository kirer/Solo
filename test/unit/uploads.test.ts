/**
 * 附件仓库的单元测试：落盘、读回、名字净化与上限。
 */
import { afterEach, describe, expect, test } from "vitest";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createUploadStore, safeName, UploadTooLargeError } from "../../src/server/uploads.ts";

const dirs: string[] = [];

async function tempStore(maxBytes?: number) {
	const dir = await mkdtemp(join(tmpdir(), "aic-uploads-"));
	dirs.push(dir);
	return { store: createUploadStore({ root: join(dir, "uploads"), ...(maxBytes === undefined ? {} : { maxBytes }) }), dir };
}

afterEach(async () => {
	for (const dir of dirs) await rm(dir, { recursive: true, force: true });
	dirs.length = 0;
});

describe("文件名净化", () => {
	test("去掉路径部分与危险字符", () => {
		expect(safeName("../../etc/passwd")).toBe("passwd");
		expect(safeName("a/b/c.txt")).toBe("c.txt");
		expect(safeName("a\\b\\c.txt")).toBe("c.txt");
		expect(safeName("bad\u0000name.txt")).toBe("badname.txt");
		expect(safeName("")).toBe("file");
		expect(safeName("..")).toBe("file");
	});

	test("中文名保留，超长截断", () => {
		expect(safeName("季度报告 2026.pdf")).toBe("季度报告 2026.pdf");
		expect(safeName("x".repeat(300)).length).toBeLessThanOrEqual(120);
	});
});

describe("保存与读取", () => {
	test("保存后能按 id 读回元数据与原始字节", async () => {
		const { store } = await tempStore();
		const bytes = Buffer.from("hello 世界", "utf8");
		const file = await store.save({ bytes, name: "报告.txt", mime: "text/plain" });

		expect(file.id).toMatch(/^[a-f0-9]{16}$/);
		expect(file.name).toBe("报告.txt");
		expect(file.size).toBe(bytes.byteLength);
		expect(file.path.startsWith(join(store.root, file.id))).toBe(true);
		await access(file.path);

		const found = await store.get(file.id);
		expect(found).toMatchObject({ id: file.id, name: "报告.txt", mime: "text/plain" });
		expect((await store.read(found!)).toString("utf8")).toBe("hello 世界");
	});

	test("名字对不上 / id 不合法 / 不存在都返回 undefined", async () => {
		const { store } = await tempStore();
		const file = await store.save({ bytes: Buffer.from("x"), name: "a.txt", mime: "text/plain" });
		expect(await store.resolve(file.id, "a.txt")).toBeDefined();
		expect(await store.resolve(file.id, "b.txt")).toBeUndefined();
		expect(await store.resolve("../etc", "a.txt")).toBeUndefined();
		expect(await store.get("nope")).toBeUndefined();
	});

	test("空 content-type 回退 octet-stream", async () => {
		const { store } = await tempStore();
		const file = await store.save({ bytes: Buffer.from("x"), name: "a", mime: "" });
		expect(file.mime).toBe("application/octet-stream");
	});

	test("超过上限抛 UploadTooLargeError", async () => {
		const { store } = await tempStore(8);
		await expect(store.save({ bytes: Buffer.alloc(9), name: "big.bin", mime: "application/octet-stream" })).rejects.toBeInstanceOf(
			UploadTooLargeError,
		);
	});
});
