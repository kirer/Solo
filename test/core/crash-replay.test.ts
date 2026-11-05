/**
 * 真 kill -9：任务留在 `running`，重开后由底座重放并跑完（ADR-074）。
 *
 * 这是 Phase 2 的核心证据。单测里 `reconcile` 只能伪造「open 之后」的现场；
 * 只有真的杀进程才能证明两件事：
 *
 * 1. `Harness.open` 会把 `running` 改成 `pending` 并 `restarts + 1`，而不是把任务丢掉；
 * 2. `resume()` 之后任务真的从断点继续，而不是靠 Solo 自己补一条输入。
 */
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { createModels } from "@earendil-works/pi-ai";
import { BACKGROUND_CONTEXT } from "../../src/core/runtime/index.ts";
import { openCore, type CoreRuntime } from "../../src/core/runtime/open.ts";
import { crashRegistry } from "../fixtures/crash-task.ts";

const here = dirname(fileURLToPath(import.meta.url));
const childScript = join(here, "..", "fixtures", "crash-child.ts");
const roots: string[] = [];
const runtimes: CoreRuntime[] = [];

afterEach(async () => {
	for (const runtime of runtimes.splice(0).reverse()) await runtime.close().catch(() => undefined);
	for (const root of roots.splice(0).reverse()) await rm(root, { recursive: true, force: true });
});

/** 起子进程，等它把任务跑起来；返回任务 id 和「被杀死」的承诺。 */
async function startAndKill(): Promise<{ taskId: number; databasePath: string; killed: Promise<void> }> {
	const root = await mkdtemp(join(tmpdir(), "crash-replay-"));
	roots.push(root);
	const databasePath = join(root, "core.sqlite");
	const child = spawn(process.execPath, ["--experimental-strip-types", childScript], {
		env: { ...process.env, CRASH_DB: databasePath },
		stdio: ["ignore", "pipe", "pipe"],
	});

	let taskId: number | undefined;
	let running = false;
	let output = "";
	const ready = new Promise<void>((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(`子进程没跑起来：\n${output}`)), 15_000);
		const onData = (chunk: Buffer) => {
			output += chunk.toString("utf8");
			for (const line of output.split("\n")) {
				const id = /^TASK_ID (\d+)$/.exec(line.trim());
				if (id !== null) taskId = Number(id[1]);
				if (line.trim() === "TASK_RUNNING") running = true;
			}
			if (taskId !== undefined && running) {
				clearTimeout(timer);
				resolve();
			}
		};
		child.stdout.on("data", onData);
		child.stderr.on("data", (chunk: Buffer) => {
			output += chunk.toString("utf8");
		});
		child.on("exit", (code) => {
			if (!running) reject(new Error(`子进程提前退出（${String(code)}）：\n${output}`));
		});
	});

	await ready;
	expect(taskId).toBeDefined();
	child.kill("SIGKILL");
	const killed = new Promise<void>((resolve) => child.on("exit", () => resolve()));

	return { taskId: taskId as number, databasePath, killed };
}

describe("kill -9 之后：底座重放", () => {
	it("任务从 running 变回 pending（restarts + 1），resume 后跑完", async () => {
		const { taskId, databasePath, killed } = await startAndKill();
		await killed;

		const runtime = await openCore({
			databasePath,
			models: createModels(),
			registry: crashRegistry(),
		});
		runtimes.push(runtime);

		const before = await runtime.harness.inspect();
		const task = before.tasks.find((item) => String(item.record.id) === String(taskId));
		expect(task).toBeDefined();
		expect(task?.record.state.status).toBe("pending");
		expect(task?.record.restarts).toBeGreaterThanOrEqual(1);

		runtime.harness.resume();
		const settled = await runtime.harness.waitForTask(taskId as never, BACKGROUND_CONTEXT);
		expect(settled.state.status).toBe("terminal");
		expect(settled.state.outcome).toMatchObject({ status: "completed", result: { tries: 1 } });
	}, 30_000);
});
