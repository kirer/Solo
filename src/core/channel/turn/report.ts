/**
 * 答完写回频道：一件**会活过进程**的收尾活。
 *
 * 宿主侧的收尾（结算回调里调 `finishTurn`）有两个窗口：答案提交了、回调还没跑；
 * 回调跑了、消息还没落盘。两个窗口里重启，频道里就永远少那一句 —— 而正文只存在
 * 会话条目里，模型又没调 `say`，等于结论丢了。
 *
 * 1.5.0 的 `afterRun` + durable task 把这两步接起来：答案提交、输入结算 `done` 之后，
 * 底座问每个选了 `core-tools` 的会话要「收尾任务」，把任务写成这一轮 generation 的
 * 子任务；进程重启后任务还在，`assembleCore` 的 `resume()` 会把它跑完。
 *
 * 任务只做一件事：调传进来的 `finishTurn`。收尾本身是幂等的（同文判据），所以在
 * 「消息落了、终态还没提交」的窗口里重放不会双发。
 */
import {
	defineTask,
	GenerationTask,
	hook,
	runEndTask,
	type Context,
	type HookRegistration,
	type RunSummary,
	type Task,
} from "../../runtime/index.ts";
import { DirectoryDoc, emptyDirectory, slugFor, wakeOf, type DirectoryState } from "../roster.ts";
import type { EntryReader, FinishTurn } from "./finish.ts";
import { TURN_REPORT_TASK, type WakeRecord } from "./record.ts";

export type TurnReportInput = {
	readonly slug: string;
	/** 这一轮的答案条目 id（`RunSummary.answer`）。 */
	readonly answer: string;
	readonly wake: WakeRecord;
};

export type TurnReportState = { readonly phase: "report" };

/** 任务终态里留一张收据：哪条答案被收过尾。 */
export type TurnReportResult = { readonly answer: string };

/**
 * 从名册里取这次收尾要的三样东西。
 *
 * 名册是唯一能反查「这条会话是谁」的地方；没有唤醒记录说明这一轮不是被消息叫起来的
 * （例如手动继续），没有可回的地方，不收尾。
 */
export function turnReportInputFor(
	run: Pick<RunSummary, "answer">,
	directory: DirectoryState,
	conversationId: number | string,
): TurnReportInput | undefined {
	const slug = slugFor(directory, conversationId);
	const wake = wakeOf(directory, conversationId);
	if (slug === undefined || wake === undefined) return undefined;
	return {
		slug,
		answer: String(run.answer),
		wake: { reply: { ...wake.reply }, task: { ...wake.task } },
	};
}

/**
 * 造这一份收尾能力：任务 + `afterRun` 钩子。
 *
 * 每次装配现造（和 `core-tools` 一起装）：终态任务按**名字**从注册表重新解析，
 * 插件热重装换上去的也是同一份定义。
 */
export function createTurnReport(finishTurn: FinishTurn): {
	readonly task: Task<TurnReportInput, TurnReportState, TurnReportResult, object>;
	readonly hook: HookRegistration;
} {
	const task = defineTask<TurnReportInput, TurnReportState, TurnReportResult>({
		name: TURN_REPORT_TASK,
		version: 1,
		initial: () => ({ phase: "report" }),
		phases: {
			report: async (running, runtime, context) => {
				const reader: EntryReader = {
					entries: (query, limit, cursor, ctx) => runtime.entries(query, limit, cursor, ctx),
				};
				await finishTurn(
					{
						slug: running.input.slug,
						conversation: reader,
						answer: running.input.answer,
						wake: running.input.wake,
					},
					context,
				);
				await runtime.commit(
					() => ({
						status: "terminal",
						outcome: { status: "completed", result: { answer: running.input.answer } },
					}),
					context,
				);
			},
		},
		// 被 Stop / 关库打断：登记成 aborted。没发出去的那句会随下次输入的自然收尾补上，
		// 或者由用户在界面里点「继续这一轮」。
		abort: async (_running, runtime, context) => {
			await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context);
		},
	});

	const registration: HookRegistration = hook(GenerationTask, {
		afterRun: async (run, api, context: Context) => {
			const directory = (await api.snapshot(DirectoryDoc, context)) ?? emptyDirectory();
			const input = turnReportInputFor(run, directory, api.conversationId);
			if (input === undefined) return undefined;
			return { tasks: [runEndTask(task, input)] };
		},
	});

	return { task, hook: registration };
}
