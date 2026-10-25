/**
 * WAL 治理：显式 pragma 策略 + 可观测的 checkpoint 动作。
 *
 * 背景（D-01，首次巡检 P1）：
 * `workspace/company.sqlite` 主库 929KB，而 `company.sqlite-wal` 涨到 4.16MB（约 4.5 倍）。
 * 之前的排查结论是「`src/runtime/open.ts` 里没有任何 pragma」——**这个结论只对了一半**，
 * 读底层实现（`@earendil-works/chord/dist/sqlite/node.js` 的 `openNodeSqliteDatabase`）可见：
 * 库自己会设 `journal_mode=WAL` / `synchronous=NORMAL` / `wal_autocheckpoint=1000`，
 * 并在 `close()` 时做一次 `wal_checkpoint(TRUNCATE)`。
 *
 * 所以 WAL 膨胀的真实成因不是「没开 WAL」，而是：
 * 1. `wal_autocheckpoint` 只把 WAL **回绕复用**、把已提交页搬回主库，**不会缩小文件**。
 *    1000 页 × 4096 字节 ≈ 4.0MB 正好是它的上限——实测 WAL 4.16MB 恰好停在这个水位，
 *    说明 autocheckpoint 一直在工作，只是文件永远长到阈值就不动了。
 * 2. 真正能把文件**缩回去**的 `wal_checkpoint(TRUNCATE)` 只在 `close()` 里发生。
 *    服务是常驻进程（launchd 托管、KeepAlive），几天不重启就几天不 TRUNCATE。
 *
 * 因此这里的做法分两层，互不替代：
 * - **显式声明 pragma**：不再依赖库的默认值。库哪天改默认、或有人换掉 adapter，
 *   我们仍然拿得到设计意图（见 `applyPragmas`）。这是「配置有据可查」，也是 D-01 的原始诉求。
 * - **可观测的 checkpoint**：用一条**独立的短连接**定期 `wal_checkpoint(TRUNCATE)`。
 *   为什么另开连接而不是复用 harness 那条：harness 的底层连接被封在 `SqliteStorage` 私有字段里，
 *   而往它的串行队列里插 pragma 需要改动底层库；另开连接是 SQLite 设计上支持的并发路径，
 *   且 TRUNCATE 在有读者时只会返回 `busy=1`、**不会阻塞写者、不会损坏数据**
 *   （本地实测：13.6MB WAL → 0 字节，`quick_check` 仍 `ok`）。
 *
 * 取舍（已写进交付说明）：checkpoint 放在「启动后一次 + 空闲巡检时一次」，不做高频定时器——
 * 高频 TRUNCATE 会和前台写入抢 WAL 索引锁，得不偿失；而 WAL 膨胀是「天级」问题，分钟级检查足够。
 */
import { DatabaseSync } from "node:sqlite";

/**
 * 我们要求的 pragma 策略。
 *
 * - `journal_mode = WAL`：显式声明，不依赖默认值。WAL 让读不阻塞写，是长跑服务的前提。
 * - `synchronous = NORMAL`：WAL 下的推荐值。`FULL` 每次提交都 fsync，长跑写入代价过高；
 *   `OFF` 在进程崩溃时会丢最近提交。`NORMAL` 在 WAL 下只保证「数据库不损坏」，
 *   进程崩溃（不是断电）不丢已提交数据——正好匹配本平台「单进程、崩溃后有自愈重开」的模型。
 * - `wal_autocheckpoint = 1000`：约 4MB 回绕一次，是 SQLite 默认值，够用且实测稳态就在此。
 * - `busy_timeout`：并发短连接做 checkpoint 时不要立刻 `SQLITE_BUSY` 失败。
 */
export const WAL_PRAGMAS = {
	journalMode: "WAL",
	synchronous: "NORMAL",
	walAutocheckpointPages: 1_000,
	busyTimeoutMs: 5_000,
} as const;

/** 把策略翻成可直接 `exec` 的 pragma 语句（顺序固定，便于测试与排查）。 */
export function pragmaStatements(): readonly string[] {
	return [
		`PRAGMA journal_mode = ${WAL_PRAGMAS.journalMode}`,
		`PRAGMA synchronous = ${WAL_PRAGMAS.synchronous}`,
		`PRAGMA wal_autocheckpoint = ${WAL_PRAGMAS.walAutocheckpointPages}`,
	];
}

/** 当前库的 pragma 实际值（用于验证「声明生效了」而不只是「我们写下去了」）。 */
export type PragmaSnapshot = {
	readonly journalMode: string;
	readonly synchronous: number;
	readonly walAutocheckpoint: number;
};

/** 一次 checkpoint 的结果。 */
export type CheckpointResult = {
	/** 是否成功发起（连接/PRAGMA 出错时为 false）。 */
	readonly ok: boolean;
	/** WAL 是否还有被占用的帧（`busy=1` 表示有读者在场，本次没搬完）。 */
	readonly busy: boolean;
	/** WAL 文件总帧数。 */
	readonly log: number;
	/** 本次实际 checkpoint 的帧数。 */
	readonly checkpointed: number;
	/** 失败原因（`ok=false` 时）。 */
	readonly error?: string;
};

/**
 * 显式施加 pragma 到一条**已有**连接上。
 *
 * 供测试与未来「自己开连接」的场景复用；生产路径由 `openNodeSqliteStorage` 的 options 承担
 * （见 open.ts），两边共用同一份 `WAL_PRAGMAS`，避免口径漂移。
 */
export async function applyPragmas(exec: (sql: string) => Promise<void>): Promise<void> {
	for (const statement of pragmaStatements()) await exec(statement);
}

/** 读一条连接的 pragma 现值。 */
export function readPragmas(db: DatabaseSync): PragmaSnapshot {
	const one = <T extends object>(sql: string): T | undefined => db.prepare(sql).get() as T | undefined;
	const journal = one<{ journal_mode: string }>("PRAGMA journal_mode");
	const sync = one<{ synchronous: number }>("PRAGMA synchronous");
	const auto = one<{ wal_autocheckpoint: number }>("PRAGMA wal_autocheckpoint");
	return {
		journalMode: String(journal?.journal_mode ?? ""),
		synchronous: Number(sync?.synchronous ?? -1),
		walAutocheckpoint: Number(auto?.wal_autocheckpoint ?? -1),
	};
}

/**
 * 对 `databasePath` 做一次 `wal_checkpoint(TRUNCATE)`，把 WAL 文件缩回 0。
 *
 * 用**独立短连接**：不触碰 harness 正在用的那条连接，也不改它的串行队列。
 * 任何异常都吞掉并放在返回值里——checkpoint 失败绝不能让服务出错（它只是维护动作）。
 *
 * @param databasePath 目标库文件路径。
 */
export async function checkpointTruncate(databasePath: string): Promise<CheckpointResult> {
	if (databasePath === ":memory:") {
		// 内存库没有 WAL 文件，checkpoint 无意义。
		return { ok: true, busy: false, log: 0, checkpointed: 0 };
	}
	let db: DatabaseSync | undefined;
	try {
		db = new DatabaseSync(databasePath, { timeout: WAL_PRAGMAS.busyTimeoutMs });
		const row = db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get() as
			| { busy?: number; log?: number; checkpointed?: number }
			| undefined;
		return {
			ok: true,
			busy: Number(row?.busy ?? 0) !== 0,
			log: Number(row?.log ?? 0),
			checkpointed: Number(row?.checkpointed ?? 0),
		};
	} catch (error) {
		return {
			ok: false,
			busy: false,
			log: 0,
			checkpointed: 0,
			error: error instanceof Error ? error.message : String(error),
		};
	} finally {
		try {
			db?.close();
		} catch {
			// 关闭失败无所谓：这条连接只用来发一条 PRAGMA。
		}
	}
}
