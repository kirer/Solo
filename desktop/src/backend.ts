/**
 * 后端：一个普通子进程，用 Electron 自带的 Node 跑同一份源码。
 *
 * 打包后 Electron 的 Node 是 24.x，类型擦除已经稳定（不需要 `--experimental-strip-types`），
 * `node:sqlite` 也是内置的 —— 所以**不打包、不 transpile、不加原生依赖**：
 * `app.asar/src/shell/main.ts` 原地就能跑，`import.meta.url` 向上找 `seed/` 和
 * `ui/web/` 的相对深度也一像素没变。
 *
 * 壳与内核之间只有一条线：**进程边界**。壳不 import `src/core/` 的任何东西
 * （`scripts/check-boundaries.mjs` 会拦），只认 `[core] http://…` 这一行（`ready-line.ts`）。
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createWriteStream, mkdirSync, renameSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { parseReadyLine } from "./ready-line.ts";

export type Backend = {
	readonly url: string;
	/** 优雅停：SIGTERM 等 5 秒，超时就 SIGKILL（Windows 上 kill 本就是强制结束）。 */
	stop(): Promise<void>;
};

export type BackendOptions = {
	/** `main.ts` 的绝对路径。 */
	readonly entry: string;
	/** 应用私有目录：助理、提示词、插件、配置、库。 */
	readonly appRoot: string;
	/** 用户目录（`~/.solo`）：成员、团队、技能、规矩。 */
	readonly userRoot: string;
	/** 后端 stdout / stderr 落这儿。 */
	readonly logFile: string;
	readonly onLog?: (line: string) => void;
	/**
	 * 后端自己退出时通知壳（`stop()` 杀的不算）。重置用退出码 75 表示「重开」，
	 * 和 `src/shell/main.ts` 的 `RESET_EXIT_CODE` 对齐。
	 */
	readonly onExit?: (code: number) => void;
};

const READY_TIMEOUT = 60_000;

/** 日志文件超过 5 MB 就轮转一代（和 `logs/` 下的其它文件同一个规矩）。 */
function openLog(file: string): ReturnType<typeof createWriteStream> {
	mkdirSync(dirname(file), { recursive: true });
	try {
		if (statSync(file).size > 5 * 1024 * 1024) renameSync(file, `${file}.1`);
	} catch {
		// 第一次跑：文件还不存在，正常。
	}
	return createWriteStream(file, { flags: "a" });
}

function spawnOnce(
	options: BackendOptions,
	port: number,
	log: ReturnType<typeof createWriteStream>,
): Promise<{ url: string; child: ChildProcess }> {
	return new Promise((resolve, reject) => {
		const child = spawn(
			process.execPath,
			[
				options.entry,
				"--port",
				String(port),
				"--host",
				"127.0.0.1",
				"--app-root",
				options.appRoot,
				"--user-root",
				options.userRoot,
			],
			{
				// ELECTRON_RUN_AS_NODE：让 Electron 可执行文件以 Node 身份跑，
				// 用户机器上不用另装 node。
				env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
				stdio: ["ignore", "pipe", "pipe"],
				windowsHide: true,
			},
		);

		let settled = false;
		let tail = "";
		const timer = setTimeout(() => {
			if (settled) return;
			settled = true;
			child.kill("SIGKILL");
			reject(new Error("后端 60 秒还没起来"));
		}, READY_TIMEOUT);

		/** 逐行读一个流：落日志，顺便等就绪那一行。 */
		const read = (stream: NodeJS.ReadableStream | null, echo: boolean): void => {
			if (stream === null) return;
			let buffer = "";
			stream.setEncoding("utf8");
			stream.on("data", (chunk: string) => {
				log.write(chunk);
				buffer += chunk;
				const lines = buffer.split("\n");
				buffer = lines.pop() ?? "";
				for (const line of lines) {
					if (line.trim() === "") continue;
					tail = `${tail}\n${line}`.slice(-2000);
					if (echo) options.onLog?.(line);
					if (settled) continue;
					const url = parseReadyLine(line);
					if (url === undefined) continue;
					settled = true;
					clearTimeout(timer);
					resolve({ url, child });
				}
			});
		};
		read(child.stdout, true);
		read(child.stderr, false);

		child.on("error", (error) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			reject(error);
		});
		// 就绪前退出（端口被占、seed 坏了、提示词模板缺失…）：把最后几行带上，别让人对着空窗口猜。
		child.on("exit", (code) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			reject(new Error(`后端没起来（退出码 ${String(code)}）${tail}`));
		});
	});
}

export async function startBackend(options: BackendOptions): Promise<Backend> {
	const log = openLog(options.logFile);
	let started: { url: string; child: ChildProcess };
	try {
		// 先试固定端口：localStorage（主题、布局）按 origin 存，端口每次变等于偏好每次丢。
		started = await spawnOnce(options, 7788, log);
	} catch (error) {
		// 7788 被占（比如同时开着 `npm start`）就退到随机端口，而不是拒绝启动。
		if (!String((error as Error).message).includes("EADDRINUSE")) {
			log.end();
			throw error;
		}
		started = await spawnOnce(options, 0, log);
	}

	const { child, url } = started;
	let stopped = false;
	child.on("exit", (code) => {
		if (stopped) return;
		options.onExit?.(code ?? -1);
	});
	return {
		url,
		stop: async () => {
			stopped = true;
			if (child.exitCode !== null) {
				log.end();
				return;
			}
			const exited = new Promise<void>((done) => child.once("exit", () => done()));
			child.kill("SIGTERM");
			const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
			await exited;
			clearTimeout(timer);
			log.end();
		},
	};
}
