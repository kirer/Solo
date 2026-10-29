/**
 * 上传孤儿清理（审计 P2-3）。
 *
 * 三条安全线都要钉住：引用真相是频道文档、太新的不动（可能是正在上传）、非附件名不碰。
 */
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sweepOrphanUploads } from "../../src/core/channel/uploads.ts";

let root = "";

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "core-uploads-"));
});

afterEach(async () => {
	await rm(root, { recursive: true, force: true });
});

async function put(id: string): Promise<void> {
	await writeFile(join(root, id), "body", "utf8");
	await writeFile(join(root, `${id}.json`), "{}", "utf8");
}

describe("sweepOrphanUploads", () => {
	it("没人引用的旧附件连本体带元数据一起删", async () => {
		const orphan = randomUUID();
		await put(orphan);
		const result = await sweepOrphanUploads(root, new Set(), Date.now() + 3_600_000);
		expect(result.removed).toBe(1);
		expect(await readdir(root)).toEqual([]);
	});

	it("被消息引用过的附件一个都不动（引用真相是频道文档）", async () => {
		const used = randomUUID();
		await put(used);
		const result = await sweepOrphanUploads(root, new Set([used]), Date.now() + 3_600_000);
		expect(result.removed).toBe(0);
		expect((await readdir(root)).sort()).toEqual([used, `${used}.json`].sort());
	});

	it("刚写下去的不动：可能是正在上传的那半套", async () => {
		const fresh = randomUUID();
		await put(fresh);
		const result = await sweepOrphanUploads(root, new Set(), Date.now());
		expect(result.removed).toBe(0);
		expect(result.keptRecent).toBe(2);
		expect((await readdir(root)).length).toBe(2);
	});

	it("不是附件 id 的东西不碰（.DS_Store、子目录、别的文件）", async () => {
		await writeFile(join(root, ".DS_Store"), "x", "utf8");
		await writeFile(join(root, "notes.txt"), "x", "utf8");
		await mkdir(join(root, "my dir"), { recursive: true });
		const result = await sweepOrphanUploads(root, new Set(), Date.now() + 3_600_000);
		expect(result.removed).toBe(0);
		expect(result.scanned).toBe(0);
		expect((await readdir(root)).sort()).toEqual([".DS_Store", "my dir", "notes.txt"].sort());
	});

	it("目录不存在时安静返回（第一次启动还没人传过文件）", async () => {
		const result = await sweepOrphanUploads(join(root, "nope"), new Set(), Date.now());
		expect(result).toEqual({ scanned: 0, removed: 0, keptRecent: 0 });
	});
});
