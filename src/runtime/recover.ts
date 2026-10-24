/**
 * 恢复与自愈。
 *
 * 三条职责（见 company-runtime 规格）：
 * 1. 打开后恢复上次进程遗留的未完成任务；恢复前不执行任何处理器。
 * 2. 巡检因反复崩溃被暂停的任务，报告给宿主。
 * 3. 因存储故障关闭后自动重开，并依靠语义化请求标识去重重复投递。
 */
import { BACKGROUND_CONTEXT, type Context } from "@earendil-works/chord/context";
import type { Harness } from "@earendil-works/pi-durable";
import type { CompanyRuntime, RuntimeReport } from "./open.ts";

/** 一个被暂停（受阻）的任务。 */
export type ParkedTask = {
	readonly taskId: string;
	readonly taskKind: string;
	readonly conversationId: number;
	/** 受阻原因，目前只有「反复崩溃达到上限」。 */
	readonly reason: "restart-limit";
};

/** 恢复结果。 */
export type RecoveryResult = {
	/** 打开时发现、已重新调度或仍待运行的任务数。 */
	readonly pendingTasks: number;
	/** 被暂停、需要人工干预的任务。 */
	readonly parkedTasks: readonly ParkedTask[];
};

/**
 * 恢复运行时：先巡检（不执行任何处理器），再开启调度。
 *
 * 顺序很重要：`inspect()` 只读不跑代码，`resume()` 才开始调度。
 * 规格要求「恢复前不执行任何处理器」，所以必须先 inspect 后 resume。
 */
export async function recover(runtime: CompanyRuntime, context: Context = BACKGROUND_CONTEXT): Promise<RecoveryResult> {
	const inspection = await runtime.harness.inspect(context);

	const parkedTasks: ParkedTask[] = [];
	let pendingTasks = 0;

	for (const task of inspection.tasks) {
		const state = task.state;
		if (state.kind === "blocked" && state.reason === "restart_limit") {
			parkedTasks.push({
				taskId: String(task.record.id),
				taskKind: task.record.kind,
				conversationId: Number(task.record.conversationId),
				reason: "restart-limit",
			});
		} else if (state.kind === "ready" || state.kind === "running" || state.kind === "waiting") {
			pendingTasks += 1;
		}
	}

	// 巡检完成后再开调度。
	runtime.harness.resume();

	return { pendingTasks, parkedTasks };
}

/** 重试一个被暂停的任务。 */
export async function retryParked(
	runtime: CompanyRuntime,
	taskId: string,
	context: Context = BACKGROUND_CONTEXT,
): Promise<void> {
	await runtime.harness.retryTask(Number(taskId) as never, context);
}

/** 自愈配置。 */
export type SelfHealingOptions = {
	/** 重开失败后是否继续重试。 */
	readonly keepRetrying?: boolean;
	/** 两次重开之间的等待毫秒数。 */
	readonly retryDelayMs?: number;
	/** 每次重开后执行的恢复动作。 */
	readonly onReopen?: (runtime: CompanyRuntime) => Promise<void> | void;
	/** 报告。 */
	readonly onReport?: (report: RuntimeReport) => void;
};

/**
 * 监听运行时关闭，因故障关闭时自动重开。
 *
 * 存储错误是致命的：一次失败整个运行时自我关闭，不重试（底层设计如此）。
 * 宿主必须自己重开，并依靠语义化请求标识让重复投递被去重。
 *
 * @returns 停止监听的函数
 */
export function watchForFailure(
	runtime: CompanyRuntime,
	reopen: () => Promise<CompanyRuntime>,
	options: SelfHealingOptions = {},
): () => void {
	let stopped = false;
	const delay = options.retryDelayMs ?? 500;

	const run = async (): Promise<void> => {
		const end = await runtime.harness.closed;
		if (stopped) return;
		if (end.reason !== "failed") return;

		options.onReport?.({ kind: "runtime-failed", error: end.error });

		while (!stopped) {
			try {
				const next = await reopen();
				await options.onReopen?.(next);
				return;
			} catch (error) {
				options.onReport?.({ kind: "other", error });
				if (options.keepRetrying === false) return;
				await new Promise((resolve) => setTimeout(resolve, delay));
			}
		}
	};

	void run();

	return () => {
		stopped = true;
	};
}

/** 等待运行时彻底空闲（所有普通归属范围的任务结束）。 */
export async function waitForIdle(runtime: CompanyRuntime, context: Context = BACKGROUND_CONTEXT): Promise<void> {
	await runtime.harness.waitForIdle(context);
}

/** 底层 harness 的只读诊断视图：活跃任务与未结算提交。 */
export async function inspect(runtime: CompanyRuntime, context: Context = BACKGROUND_CONTEXT) {
	return runtime.harness.inspect(context);
}

/** 判断运行时是否已因故障失效。 */
export function hasFailed(runtime: CompanyRuntime): boolean {
	return runtime.failure() !== undefined;
}

/** 供内部模块使用：取底层 harness（业务层不应调用）。 */
export function rawHarness(runtime: CompanyRuntime): Harness {
	return runtime.harness;
}
