/**
 * 单进程单库保护的回归测试。
 *
 * 真实事故：项目负责人用 bash 起第二个平台实例做「重启验证」，
 * 新实例在监听端口前就打开了同一个库，导致正在跑的服务 storage error 崩溃。
 * 这个锁必须在碰库之前拒绝第二个实例。
 */
import { afterEach, describe, expect, test } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireInstanceLock } from "../../src/runtime/index.ts";

const dirs: string[] = [];

async function tempDb(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "instance-lock-"));
	dirs.push(dir);
	return join(dir, "company.sqlite");
}

afterEach(async () => {
	for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

describe("单进程单库锁", () => {
	test("同一库的第二个实例被拒绝", async () => {
		const db = await tempDb();
		const lock = await acquireInstanceLock(db);
		await expect(acquireInstanceLock(db)).rejects.toThrow(/已被进程/);
		await lock.release();
	});

	test("释放之后可以重新获取", async () => {
		const db = await tempDb();
		const first = await acquireInstanceLock(db);
		await first.release();
		const second = await acquireInstanceLock(db);
		await second.release();
	});

	test("残留锁（持有进程已死）会被接管", async () => {
		const db = await tempDb();
		// 999999 几乎不可能是一个存活进程；写成残留锁
		await writeFile(`${db}.lock`, JSON.stringify({ pid: 999999, startedAt: new Date().toISOString() }), "utf8");
		const lock = await acquireInstanceLock(db);
		await lock.release();
	});

	test("锁文件内容损坏时也能接管", async () => {
		const db = await tempDb();
		await writeFile(`${db}.lock`, "not-json", "utf8");
		const lock = await acquireInstanceLock(db);
		await lock.release();
	});
});
