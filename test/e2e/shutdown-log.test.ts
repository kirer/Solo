/**
 * 关停落盘回归测试（OPS-20261025-09）。
 *
 * 事故背景：`src/runtime/signals.ts` 原先在 SIGINT/SIGTERM/SIGHUP 的处理器里
 * **同步** `process.exit(0)`。而各入口的注册顺序是：
 *
 *   1. `setupSignalHandlers()`   ← 先注册（在 main.ts 顶部）
 *   2. `process.on("SIGTERM", shutdown)` ← 后注册（在 main.ts 末尾）
 *
 * Node 按注册顺序执行同一信号的监听器，所以第 1 个处理器里的同步退出
 * 直接终止了进程，第 2 个 `shutdown` 里 `server.close().then().finally()`
 * 的微任务**永远轮不到执行**——关停日志不落盘、实例锁不释放。
 *
 * 这个缺陷「加了就生效」的自述看不出问题：`writeEvent("[退出]")` 确实写了，
 * 只是那一行代码根本执行不到。所以必须有真实进程 + 真实信号的测试。
 *
 * 做法：spawn 真实的 `src/server/main.ts`（注册顺序与生产完全一致），
 * 用独立临时库与临时日志路径，发 SIGTERM，断言 app.log 里出现 `[退出]`。
 * **不触碰 workspace/company.sqlite，也不起平台实例**。
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, test } from "vitest";

const REPO = resolve(__dirname, "..", "..");

const children: ChildProcess[] = [];
const dirs: string[] = [];

afterEach(() => {
	for (const child of children.splice(0)) {
		try {
			child.kill("SIGKILL");
		} catch {
			// 已退出
		}
	}
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** 启动一次真实的 server 入口，返回子进程、日志路径与就绪 Promise。 */
async function startServer(
	signal: NodeJS.Signals,
): Promise<{ child: ChildProcess; logPath: string; ready: Promise<void> }> {
	const dir = mkdtempSync(join(tmpdir(), "ops09-"));
	dirs.push(dir);
	const logPath = join(dir, "logs", "app.log");
	// 端口选 0 之外的随机高位端口，避免与生产 7788 及并行测试冲突
	const port = 20_000 + Math.floor(Math.random() * 20_000);

	const child = spawn(
		process.execPath,
		[
			"--experimental-strip-types",
			join(REPO, "src", "server", "main.ts"),
			"--db",
			join(dir, "company.sqlite"),
			"--workspace",
			dir,
			"--log",
			logPath,
			"--port",
			String(port),
			"--no-open",
		],
		{ cwd: REPO, stdio: ["ignore", "pipe", "pipe"] },
	);
	children.push(child);

	let stderr = "";
	child.stderr?.on("data", (chunk: Buffer) => {
		stderr += chunk.toString();
	});

	// 就绪判定：stdout 里出现网页界面横幅（main.ts 在 serve 之后才打印它）
	const ready = new Promise<void>((resolveReady, rejectReady) => {
		const timer = setTimeout(() => rejectReady(new Error(`启动超时。stderr=${stderr.slice(0, 800)}`)), 60_000);
		child.stdout?.on("data", (chunk: Buffer) => {
			if (chunk.toString().includes("网页界面")) {
				clearTimeout(timer);
				resolveReady();
			}
		});
		child.once("exit", (code) => {
			clearTimeout(timer);
			rejectReady(new Error(`启动期退出 code=${code}。stderr=${stderr.slice(0, 800)}`));
		});
	});

	// signal 参数仅供调用方语义表达，实际信号由测试自己发
	void signal;
	return { child, logPath, ready };
}

/** 等子进程退出，返回退出码（超时返回 "timeout"）。 */
async function waitExit(child: ChildProcess, timeoutMs = 20_000): Promise<number | string | null> {
	return new Promise((resolveExit) => {
		const timer = setTimeout(() => resolveExit("timeout"), timeoutMs);
		child.once("exit", (code, sig) => {
			clearTimeout(timer);
			resolveExit(code ?? sig ?? null);
		});
	});
}

describe("关停落盘（OPS-20261025-09）", () => {
	test(
		"生产注册顺序下发 SIGTERM，app.log 必须出现 [退出]",
		async () => {
			const { child, logPath, ready } = await startServer("SIGTERM");
			await ready;

			expect(existsSync(logPath), "启动阶段不该有关键事件，app.log 尚不存在是正常的").toBe(false);

			const exited = waitExit(child);
			child.kill("SIGTERM");
			const code = await exited;
			expect(code, "收到 SIGTERM 后应当正常退出").not.toBe("timeout");

			// 修复前这里必然失败：signals.ts 同步 exit 抢跑，shutdown 的 finally 不执行
			expect(existsSync(logPath), "app.log 必须被创建（关停落盘）").toBe(true);
			const text = readFileSync(logPath, "utf8");
			expect(text).toContain("[退出]");
			expect(text).toContain("进程正常退出");
		},
		120_000,
	);

	test(
		"发 SIGHUP 也必须走同一条收尾（入口自己注册）",
		async () => {
			const { child, logPath, ready } = await startServer("SIGHUP");
			await ready;

			const exited = waitExit(child);
			child.kill("SIGHUP");
			const code = await exited;
			expect(code).not.toBe("timeout");

			// SIGHUP 原先只有 signals.ts 里那个同步退出的处理器；
			// 改成「只还原终端」之后，必须由入口自己注册 shutdown 接住。
			expect(existsSync(logPath), "SIGHUP 也必须落关停日志").toBe(true);
			expect(readFileSync(logPath, "utf8")).toContain("[退出]");
		},
		120_000,
	);
});
