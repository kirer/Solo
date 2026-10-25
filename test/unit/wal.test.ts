/**
 * D-01 回归：WAL 治理（pragma 显式声明 + 可观测 checkpoint）。
 *
 * 真实问题（首次巡检 D-01，P1）：
 * `workspace/company.sqlite` 主库 929KB，`company.sqlite-wal` 却有 4.16MB（约 4.5 倍）。
 *
 * 排查后的真实成因（不是「没开 WAL」）：
 * - 底层 `openNodeSqliteDatabase`（@earendil-works/chord/dist/sqlite/node.js）本来就设了
 *   `journal_mode=WAL` / `synchronous=NORMAL` / `wal_autocheckpoint=1000`，并在 `close()`
 *   里做 `wal_checkpoint(TRUNCATE)`。
 * - `wal_autocheckpoint` 只**回绕**文件、不缩小文件：1000 页 × 4096B ≈ 4.0MB 就是稳态上限，
 *   实测 4.16MB 正卡在那。
 * - 真正能缩回的 `TRUNCATE` 只在 close() 里发生，而服务是常驻进程（launchd KeepAlive），
 *   几天不重启 → 几天不 TRUNCATE。
 *
 * 所以本文件断言两件事：
 * 1. 我们**显式**声明 pragma（不再依赖库默认值），且值确实是 WAL / NORMAL / 1000。
 * 2. `checkpointTruncate` 能把 WAL 文件真的缩回 0，且不损坏库。
 *
 * 全部用临时目录里的临时库，**绝不碰 workspace/company.sqlite**。
 */
import { existsSync, statSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, test } from "vitest";
import {
	applyPragmas,
	checkpointTruncate,
	pragmaStatements,
	readPragmas,
	WAL_PRAGMAS,
} from "../../src/runtime/wal.ts";

const dirs: string[] = [];

async function tempDb(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "wal-治理-"));
	dirs.push(dir);
	return join(dir, "company.sqlite");
}

afterEach(async () => {
	for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

function walSize(dbPath: string): number {
	const wal = `${dbPath}-wal`;
	return existsSync(wal) ? statSync(wal).size : 0;
}

describe("pragma 策略：显式声明，不依赖底层默认", () => {
	test("策略常量就是我们要的值（synchronous=NORMAL 的理由见 wal.ts）", () => {
		expect(WAL_PRAGMAS.journalMode).toBe("WAL");
		expect(WAL_PRAGMAS.synchronous).toBe("NORMAL");
		expect(WAL_PRAGMAS.walAutocheckpointPages).toBe(1_000);
	});

	test("pragmaStatements 生成可执行的语句，且包含 journal_mode / synchronous / wal_autocheckpoint", () => {
		const statements = pragmaStatements();
		expect(statements).toContain("PRAGMA journal_mode = WAL");
		expect(statements).toContain("PRAGMA synchronous = NORMAL");
		expect(statements).toContain("PRAGMA wal_autocheckpoint = 1000");
	});

	test("applyPragmas 后读回来的 pragma 与策略一致（真建临时库验证）", async () => {
		const dbPath = await tempDb();
		const db = new DatabaseSync(dbPath);
		try {
			// 先把 journal_mode 设成非 WAL，证明 applyPragmas 真的改了它，而不是「本来就这样」
			db.exec("PRAGMA journal_mode = DELETE");
			await applyPragmas(async (sql) => {
				db.exec(sql);
			});

			const snapshot = readPragmas(db);
			expect(snapshot.journalMode.toLowerCase()).toBe("wal");
			// synchronous: 0=OFF 1=NORMAL 2=FULL 3=EXTRA
			expect(snapshot.synchronous).toBe(1);
			expect(snapshot.walAutocheckpoint).toBe(1_000);
		} finally {
			db.close();
		}
	});
});

describe("checkpointTruncate：真的把 WAL 缩回 0", () => {
	test("写入大量数据把 WAL 撑大后，TRUNCATE checkpoint 把它缩回 0 且数据完好", async () => {
		const dbPath = await tempDb();
		const db = new DatabaseSync(dbPath);
		try {
			await applyPragmas(async (sql) => {
				db.exec(sql);
			});
			// 关掉自动回绕，制造「WAL 一直长」的真实场景
			db.exec("PRAGMA wal_autocheckpoint = 0");
			db.exec("CREATE TABLE t (x TEXT)");
			const insert = db.prepare("INSERT INTO t VALUES (?)");
			for (let index = 0; index < 2_000; index += 1) insert.run("y".repeat(200));

			const before = walSize(dbPath);
			expect(before).toBeGreaterThan(1_000_000); // 确实撑大了，才有东西可缩

			const result = await checkpointTruncate(dbPath);
			expect(result.ok).toBe(true);
			expect(result.busy).toBe(false);

			// 核心断言：文件真的缩回 0（autocheckpoint 做不到这件事）
			expect(walSize(dbPath)).toBe(0);
			// 数据没丢、库没坏
			expect(Number((db.prepare("SELECT count(*) AS n FROM t").get() as { n: number }).n)).toBe(2_000);
			expect((db.prepare("PRAGMA quick_check").get() as { quick_check: string }).quick_check).toBe("ok");
		} finally {
			db.close();
		}
	});

	test("库不存在时 checkpoint 不抛，返回结构说明（失败只是维护动作失败，不能让服务崩）", async () => {
		const dbPath = await tempDb();
		const result = await checkpointTruncate(join(dbPath, "..", "no-such-dir", "missing.sqlite"));
		// 父目录不存在 → node:sqlite 打不开；这里只要求「不抛、有结论」
		expect(result.ok).toBe(false);
		expect(typeof result.error).toBe("string");
	});

	test("内存库是 no-op（没有 WAL 文件可收）", async () => {
		const result = await checkpointTruncate(":memory:");
		expect(result).toEqual({ ok: true, busy: false, log: 0, checkpointed: 0 });
	});
});
