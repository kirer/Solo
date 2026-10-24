/**
 * 终端信号处理。
 *
 * 进程被 Ctrl+C 或异常死亡打断时，终端可能停在 raw 模式（光标不可见、
 * 不回显）。这里注册一次性的清理，保证无论怎么退出都还原终端。
 */
const RESTORE = "\u001b[?25h\u001b[?1000l\u001b[?1002l\u001b[?1006l\u001b[0m";

let installed = false;

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
	process.on("uncaughtException", (error) => {
		restore();
		process.stderr.write(`未捕获异常：${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
		process.exit(1);
	});
	process.on("unhandledRejection", (reason) => {
		restore();
		process.stderr.write(`未处理的 Promise 拒绝：${String(reason)}\n`);
		process.exit(1);
	});
}
