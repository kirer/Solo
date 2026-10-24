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
	for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
		process.on(signal, () => {
			restore();
			process.exit(0);
		});
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
