/**
 * 终端信号处理。
 *
 * 进程被 Ctrl+C 或异常死亡打断时，终端可能停在 raw 模式（光标不可见、
 * 不回显）。这里注册一次性的清理，保证无论怎么退出都还原终端。
 */
const RESTORE = "\u001b[?25h\u001b[?1000l\u001b[?1002l\u001b[?1006l\u001b[0m";

let installed = false;

/** 收尾任务的单条超时：任何一个卡住都不能把进程吊死。 */
const SHUTDOWN_TIMEOUT_MS = 3_000;

/** 注册过的收尾任务（LIFO：后注册的先跑，与资源获取顺序相反）。 */
const shutdownTasks: (() => void | Promise<void>)[] = [];

/**
 * 注册一个「进程要死了，先做这个」的收尾函数（幂等、LIFO）。
 *
 * 入口（`src/server/main.ts`、`src/tui/main.ts`）在拿到运行时/服务之后注册，
 * 这样致命错误路径也能走到它们，而不是被 `process.exit(1)` 硬砍。
 */
export function onShutdown(task: () => void | Promise<void>): void {
	shutdownTasks.push(task);
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => {
		setTimeout(resolve, ms).unref();
	});
}

/** 安装进程退出与信号处理（幂等）。 */
export function setupSignalHandlers(): void {
	if (installed) return;
	installed = true;

	const restore = (): void => {
		try {
			process.stdout.write(RESTORE);
		} catch {
			// 输出已关闭时忽略
		}
	};

	process.on("exit", restore);

	// 信号处理**只还原终端，不退出进程**。
	//
	// 原先这里同步调用 `process.exit(0)`，造成一个真实事故（OPS-20261025-09）：
	// 各入口（src/server/main.ts、src/tui/main.ts）都是先 `setupSignalHandlers()`
	// 再注册自己的 `shutdown`；同一信号按注册顺序执行，于是这里的同步退出
	// 把后面那个 shutdown 里的 `server.close().then().finally()` 微任务**整个跳过**——
	// 关停日志不落盘、实例锁不释放、未完成的工作来不及收尾。
	//
	// 现在交给各入口自己的 shutdown 收尾（它们最后都会 `process.exit`）。
	// 终端还原不受影响：`process.on("exit", restore)` 在进程真正退出时仍会触发，
	// 且 TUI 走 `app.stop() -> tui.stop()` 还有一条自己的还原路径。
	for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
		process.on(signal, restore);
	}
	// 致命错误：先让各入口的 shutdown 跑完，再退出。
	//
	// 以前是 `restore()` 之后**直接** `process.exit(1)`：实例锁不释放
	// （`src/runtime/instance-lock.ts`）、`src/server/main.ts` 的 shutdown 流程被整个跳过、
	// 关停日志不落盘。而 `unhandledRejection` 在真实场景里并不总是「进程已不可用」——
	// 一个畸形 HTTP Host 头曾经就能走到这里（见 `src/server/http.ts` 的兜底 catch）。
	// 现在：注册过的收尾函数按顺序跑（有超时兜底），跑完再退出。
	let exiting = false;
	const fatal = (label: string, detail: string): void => {
		restore();
		process.stderr.write(`${label}：${detail}\n`);
		if (exiting) return; // 收尾过程本身再抛错就不要再递归
		exiting = true;
		void (async () => {
			// LIFO：后注册的先跑（与资源获取顺序相反）
		for (const task of [...shutdownTasks].reverse()) {
				try {
					await Promise.race([task(), delay(SHUTDOWN_TIMEOUT_MS)]);
				} catch (error) {
					process.stderr.write(`收尾失败：${String(error)}\n`);
				}
			}
		})().finally(() => process.exit(1));
		// 收尾任务全部卡住时兜底：不让进程吊着
		setTimeout(() => process.exit(1), SHUTDOWN_TIMEOUT_MS * 2).unref();
	};
	process.on("uncaughtException", (error) => {
		fatal("未捕获异常", error instanceof Error ? (error.stack ?? error.message) : String(error));
	});
	process.on("unhandledRejection", (reason) => {
		fatal("未处理的 Promise 拒绝", String(reason));
	});
}
