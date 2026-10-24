/**
 * 单进程单库保护。
 *
 * 本平台的持久化是「一个 SQLite 库 + 单个长期存活的进程」。库没有跨进程协调：
 * 第二个进程只要打开同一个库（哪怕随后因为端口被占而退出），就会和正在跑的
 * 会话形成两个写者，先打开的那个会收到 storage error 并崩溃。
 *
 * 真实事故（2026-10-25）：项目负责人用 bash 起了一个新的平台进程做「重启验证」，
 * 新进程在监听 7788 之前先打开了同一个库 → 正在跑的服务进入
 * `SessionFailed` 循环并退出（日志：`PathError: unresolvable path: ["tools",0]`），
 * 而新进程只留下一行 `EADDRINUSE`。结果是服务彻底停了，谁都没起来。
 *
 * 所以在打开库之前先抢一个 `<db>.lock`（O_EXCL）；锁里记录 pid，pid 已死则
 * 视为残留锁自动接管。这样任何第二个实例（包括 agent 用 bash 起的）都会
 * 在碰库之前被明确拒绝。
 */
import { open, readFile, unlink } from "node:fs/promises";

export type InstanceLock = {
	/** 锁文件路径。 */
	readonly path: string;
	/** 释放锁（幂等）。 */
	release(): Promise<void>;
};

/** 判断 pid 是否还活着。 */
function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		// EPERM 说明进程存在但没权限发信号，仍算活着
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

/**
 * 获取数据库独占锁。
 *
 * @throws 已有存活进程持锁时抛错，**不要**捕获后继续打开库——那正是事故的成因。
 */
export async function acquireInstanceLock(databasePath: string): Promise<InstanceLock> {
	const lockPath = `${databasePath}.lock`;
	const payload = JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() });

	for (let attempt = 0; attempt < 3; attempt += 1) {
		try {
			const handle = await open(lockPath, "wx");
			await handle.writeFile(payload, "utf8");
			await handle.close();
			return {
				path: lockPath,
				release: async () => {
					await unlink(lockPath).catch(() => undefined);
				},
			};
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;

			const raw = await readFile(lockPath, "utf8").catch(() => "");
			let holder: number | undefined;
			try {
				holder = Number((JSON.parse(raw) as { pid?: number }).pid);
			} catch {
				holder = undefined;
			}

			if (holder !== undefined && Number.isInteger(holder) && holder > 0 && isProcessAlive(holder)) {
				throw new Error(
					[
						`数据库已被进程 ${holder} 占用：${databasePath}`,
						"本平台是单进程单库，第二个实例会让正在跑的服务崩溃（storage error）。",
						"请先停掉现有进程再启动；如果确认那个进程已经不在了，删除锁文件后重试：",
						`  rm ${lockPath}`,
					].join("\n"),
				);
			}

			// 残留锁（pid 已死或内容不可读）：接管
			await unlink(lockPath).catch(() => undefined);
		}
	}

	throw new Error(`无法获取独占锁：${lockPath}`);
}
