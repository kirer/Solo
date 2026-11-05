/**
 * 一个会「第一次跑就挂住、重放后跑完」的任务，只给 kill -9 测试用。
 *
 * 第一次调用（`restarts` 为空）：打印一行、然后永不返回，等父进程把整个进程打死。
 * 重放时：底座在 open 时把 `running` 改回 `pending` 并 `restarts + 1`，这里看到
 * `restarts >= 1` 就正常收尾 —— 用来证明「任务没有被 Solo 杀掉，是底座接着跑完的」。
 */
import { createRegistry, defineExtension, defineTask } from "../../src/core/runtime/index.ts";

export type CrashResult = { readonly tries: number };

export const crashTask = defineTask<Record<string, never>, { phase: "run" }, CrashResult>({
	name: "test.crash",
	version: 1,
	initial: () => ({ phase: "run" }),
	phases: {
		run: async (task, runtime, context) => {
			if ((task.restarts ?? 0) === 0) {
				console.log("TASK_RUNNING");
				await new Promise<never>(() => undefined);
			}
			await runtime.commit(
				() => ({ status: "terminal", outcome: { status: "completed", result: { tries: 1 } } }),
				context,
			);
		},
	},
	abort: async (_task, runtime, context) => {
		await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context);
	},
});

export const crashExtension = defineExtension({ name: "test-crash", tasks: [crashTask] });

export function crashRegistry() {
	const registry = createRegistry();
	registry.install(crashExtension);
	return registry;
}
