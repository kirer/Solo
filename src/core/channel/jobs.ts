/**
 * 后台命令：起一条、记一条、跑完把结果交回去。
 *
 * 为什么不是「以 `&` 结尾就算后台」：那是**脱手**——起了就不管，PID 一给，回音永远不会来。
 * 真正的异步是把一条慢命令丢出去，人接着干别的，跑完了结果自己回到频道里，叫起跑的人
 * 回来看。两者是两种意图，所以 `run` 上分成 `background: true` 与 `&` / `nohup`。
 *
 * 三条硬线：
 * - **最多跑 30 分钟**：没人看着的后台命令会一直占着，杀掉比让它烂着好。
 * - **落一条记录**（`logs/run/<id>.json`）：进程崩了，重启时才知道有谁的活在半空中。
 * - **输出只留尾巴**：一次跑整套测试能吐几百 KB，进上下文的只能是结尾那段。
 */
import { spawn, type ChildProcess } from "node:child_process";
import { join } from "node:path";
import { ensureDir, listDirSorted, readTextOrUndefined, removeAt, writeTextAt } from "../runtime/io.ts";

/** 一条后台命令最多活这么久，到点杀掉。 */
export const RUN_LIMIT_MS = 30 * 60_000;

/** 回给模型的结果最多这么长（字符）。日志全文留在 `logs/run/<id>.log`。 */
export const RUN_OUTPUT_LIMIT = 8_000;

/** 进程内最多留这么多输出；再长就只留尾巴（防止一条命令把内存吃光）。 */
const MEMORY_LIMIT = 256 * 1024;

export type RunJob = {
	readonly id: string;
	readonly slug: string;
	readonly channelId: string;
	readonly command: string;
	readonly pid: number;
	readonly startedAt: number;
};

export type RunOutcome = {
	/** 退出码；被信号杀掉是 `null`。 */
	readonly code: number | null;
	/** 到点被杀。 */
	readonly timedOut: boolean;
	/** 输出尾巴（已经按 `RUN_OUTPUT_LIMIT` 剪过）。 */
	readonly log: string;
	readonly logPath: string;
};

export type StartRunInput = {
	/** 记录与日志的目录（`<workspace>/logs/run`）。 */
	readonly dir: string;
	readonly slug: string;
	readonly channelId: string;
	readonly command: string;
	readonly cwd: string;
	readonly limitMs?: number;
	/** 跑完（或被杀、或起不来）时回调。回调抛错只写 stderr，不影响别人。 */
	readonly onDone: (outcome: RunOutcome) => Promise<void>;
};

/** 杀一整个进程组：`detached` 起的子进程带着自己的一窝 shell，只杀 pid 会留下孤儿。 */
export function killGroup(pid: number | undefined): void {
	if (pid === undefined || pid <= 0) return;
	if (process.platform === "win32") {
		// `process.kill(-pid)` 是 POSIX 的进程组写法，Windows 上没有。用 taskkill 连子树
		// 一起杀：只杀 cmd 的话，它拉起的 ping / node 还占着输出管道，`close` 永远不来。
		const killer = spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
		killer.once("error", () => {
			try {
				process.kill(pid, "SIGKILL");
			} catch {
				/* 已经没了 */
			}
		});
		killer.unref();
		return;
	}
	try {
		process.kill(-pid, "SIGKILL");
	} catch {
		try {
			process.kill(pid, "SIGKILL");
		} catch {
			/* 已经没了 */
		}
	}
}

function isAlive(pid: number): boolean {
	if (pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

/** 起一条后台命令。立刻返回，结果走 `onDone`。 */
export async function startRunJob(input: StartRunInput): Promise<RunJob> {
	await ensureDir(input.dir);
	const startedAt = Date.now();
	const id = `${startedAt}-${Math.random().toString(36).slice(2, 8)}`;
	const logPath = join(input.dir, `${id}.log`);

	const child: ChildProcess = spawn(input.command, {
		shell: true,
		cwd: input.cwd,
		detached: true,
		stdio: ["ignore", "pipe", "pipe"],
	});
	const job: RunJob = {
		id,
		slug: input.slug,
		channelId: input.channelId,
		command: input.command,
		pid: child.pid ?? -1,
		startedAt,
	};
	let output = "";
	const collect = (chunk: Buffer): void => {
		output += chunk.toString();
		if (output.length > MEMORY_LIMIT) output = output.slice(-MEMORY_LIMIT);
	};
	child.stdout?.on("data", collect);
	child.stderr?.on("data", collect);

	let timedOut = false;
	const limit = input.limitMs ?? RUN_LIMIT_MS;
	const timer = setTimeout(() => {
		timedOut = true;
		killGroup(child.pid);
	}, limit);
	// 定时器不该自己撑住进程：服务关掉时就该退。
	timer.unref();

	let settled = false;
	const finish = (code: number | null, note = ""): void => {
		if (settled) return;
		settled = true;
		clearTimeout(timer);
		void (async () => {
			const tail = output.length > RUN_OUTPUT_LIMIT ? output.slice(-RUN_OUTPUT_LIMIT) : output;
			// 日志全文落盘（留给人看），记录删掉（它只用于「崩了之后找孤儿」）。
			await writeTextAt(logPath, note === "" ? output : `${output}\n${note}`).catch(() => undefined);
			await removeAt(join(input.dir, `${id}.json`)).catch(() => undefined);
			await input.onDone({ code, timedOut, log: tail, logPath }).catch((error: unknown) => {
				process.stderr.write(
					`[后台命令回调失败] ${id}: ${error instanceof Error ? error.message : String(error)}\n`,
				);
			});
		})();
	};

	// 监听必须挂在任何 `await` 之前：命令可能在 `await` 的间隙里就跑完了，
	// 那一瞬间没有 `close` 监听，结果就永远等不到、记录也永远留着。
	child.once("error", (error) => finish(null, `[起不来] ${error.message}`));
	child.once("close", (code) => finish(code));

	// 记录写不下去（磁盘满）就当场报错，别让一条命令跑在没人知道的地方。
	// 已经跑完的就不写了：写完再删的窗口里留下的是一条永远清不掉的孤儿记录。
	if (!settled) await writeTextAt(join(input.dir, `${id}.json`), JSON.stringify(job));
	return job;
}

export type StaleRun = {
	readonly job: RunJob;
	/** 重启时它还活着，被我们杀掉了。 */
	readonly killed: boolean;
};

/** 从磁盘上读回来的一条记录。坏记录返回 `undefined`（不因为一行坏 JSON 卡住启动）。 */
function parseJob(raw: string): RunJob | undefined {
	try {
		const value = JSON.parse(raw) as Partial<RunJob>;
		if (
			typeof value.id !== "string" ||
			typeof value.slug !== "string" ||
			typeof value.channelId !== "string" ||
			typeof value.command !== "string" ||
			typeof value.pid !== "number"
		) {
			return undefined;
		}
		return {
			id: value.id,
			slug: value.slug,
			channelId: value.channelId,
			command: value.command,
			pid: value.pid,
			startedAt: typeof value.startedAt === "number" ? value.startedAt : 0,
		};
	} catch {
		return undefined;
	}
}

/**
 * 启动时清一遍：上一轮进程里起的后台命令，服务已经重启，结果再也回不来了。
 *
 * 活着的杀掉（否则它在没人知道的地方跑着，还占着端口），死掉的只留一条账。
 * 记录一律删掉 —— 留着它下次启动还会再报一遍。
 */
export async function sweepRunJobs(dir: string): Promise<readonly StaleRun[]> {
	const out: StaleRun[] = [];
	for (const entry of await listDirSorted(dir)) {
		if (entry.kind !== "file" || !entry.name.endsWith(".json")) continue;
		const path = join(dir, entry.name);
		const raw = await readTextOrUndefined(path);
		await removeAt(path);
		const job = raw === undefined ? undefined : parseJob(raw);
		if (job === undefined) continue;
		const alive = isAlive(job.pid);
		if (alive) killGroup(job.pid);
		out.push({ job, killed: alive });
	}
	return out;
}
