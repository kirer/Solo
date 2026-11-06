/**
 * durable 收尾（ADR-077）：`afterRun` 从名册取三样东西、任务把它交给收尾器。
 *
 * 任务的「重启后还活着」由 `crash-turn-report.test.ts` 真杀进程证明；这里钉住
 * 钩子的输入与任务的终态，免得它们悄悄变成另一件事。
 */
import { describe, expect, test } from "vitest";
import {
	createTurnReport,
	turnReportInputFor,
	type TurnReportInput,
	type TurnReportState,
} from "../../src/core/channel/turn/report.ts";
import { emptyDirectory, type DirectoryState } from "../../src/core/channel/roster.ts";
import { liveConversations } from "../../src/core/channel/queue.ts";
import { TURN_REPORT_TASK } from "../../src/core/channel/turn/record.ts";
import type { FinishTurnInfo } from "../../src/core/channel/turn/finish.ts";

const wake = {
	reply: { channelId: "dm:owner-林越", seq: 3, from: "owner", at: 10 },
	task: { channelId: "team:alpha", seq: 2, from: "owner", at: 9 },
};

function directoryWith(mapping: Partial<DirectoryState>): DirectoryState {
	return {
		...emptyDirectory(),
		slugToConversation: { 林越: 7 },
		conversationToSlug: { "7": "林越" },
		wake: { "7": wake },
		...mapping,
	};
}

/** 唤醒条目：开跑时放进去的那条 `core.channel`。 */
const wakeEntry = {
	id: 1,
	conversationId: 7,
	kind: "core.channel",
	data: { channelId: "team:alpha", seq: 2, from: "owner", at: 9, text: "上工", mentions: [] },
} as never;

describe("turn-report：名册 → 任务输入", () => {
	test("会话能反查到人、也有唤醒记录时，三样都带上", () => {
		const input = turnReportInputFor({ answer: "42" }, directoryWith({}), 7);
		expect(input).toEqual({ slug: "林越", answer: "42", wake });
	});

	test("跑动期间名册的 reply 被新消息覆盖：以开跑那条条目为准", () => {
		// 实测 2026-11-06：林柯答完自我介绍，频道里又来一条派活，名册的 reply 变成 4；
		// 收尾按 4 找「他说过话没有」找不到 seq 2 那句，同一段又补发一遍。
		const overwritten = directoryWith({
			wake: { "7": { reply: { channelId: "team:alpha", seq: 4, from: "Solo", at: 11 }, task: wake.task } },
		});
		const input = turnReportInputFor({ answer: "42" }, overwritten, 7, wakeEntry);
		expect(input?.wake.reply).toEqual({ channelId: "team:alpha", seq: 2, from: "owner", at: 9 });
		// `task` 仍然取自名册（插话一轮继承的那份）。
		expect(input?.wake.task).toEqual(wake.task);
	});

	test("第一条不是唤醒条目（继续 / 压缩）→ 退回名册的 reply", () => {
		const input = turnReportInputFor({ answer: "42" }, directoryWith({}), 7, {
			id: 9,
			conversationId: 7,
			kind: "pi.user",
		} as never);
		expect(input?.wake).toEqual(wake);
	});

	test("名册里没有这个人（子会话、压缩任务）→ 不收尾", () => {
		expect(turnReportInputFor({ answer: "42" }, directoryWith({}), 99)).toBeUndefined();
	});

	test("没有唤醒记录（手动继续）→ 不知道该回哪个频道，不收尾", () => {
		expect(turnReportInputFor({ answer: "42" }, directoryWith({ wake: {} }), 7)).toBeUndefined();
	});

	test("输入是纯数据：改它不会碰名册里的那份", () => {
		const directory = directoryWith({});
		const input = turnReportInputFor({ answer: "42" }, directory, 7);
		expect(input).toBeDefined();
		(input as { wake: { reply: { seq: number } } }).wake.reply.seq = 99;
		expect(directory.wake["7"]).toEqual(wake);
	});
});

describe("turn-report：不冒充「还在干活」", () => {
	test("收尾任务在跑不算 busy；真生成与后台任务照旧", async () => {
		const tasks = [
			{ record: { id: 1, kind: TURN_REPORT_TASK, conversationId: 7, background: false }, state: { kind: "running" } },
			{ record: { id: 2, kind: "pi.generation", conversationId: 8, background: false }, state: { kind: "running" } },
			{ record: { id: 3, kind: "pi.generation", conversationId: 9, background: true }, state: { kind: "running" } },
			// 10：答完了，生成在等收尾任务 —— 和收尾任务本身一样不算 busy。
			{ record: { id: 4, kind: TURN_REPORT_TASK, conversationId: 10, background: false }, state: { kind: "running" } },
			{ record: { id: 5, kind: "pi.generation", conversationId: 10, background: false }, state: { kind: "waiting", on: [4] } },
			// 11：生成在等一个真工具任务 —— 还在干活。
			{ record: { id: 6, kind: "core.run", conversationId: 11, background: false }, state: { kind: "running" } },
			{ record: { id: 7, kind: "pi.generation", conversationId: 11, background: false }, state: { kind: "waiting", on: [6] } },
		];
		const busy = await liveConversations({ inspect: async () => ({ tasks }) } as never);
		expect([...busy]).toEqual([8, 11]);
	});
});

describe("turn-report：钩子与任务", () => {
	test("afterRun 返回一个 runEndTask，input 与名册一致", async () => {
		const { hook } = createTurnReport(async () => ({ kind: "silent", reason: "no-target" }));
		expect(hook.task).toBe("pi.generation");
		const afterRun = (hook.handlers as { afterRun: (...args: unknown[]) => Promise<unknown> }).afterRun;
		const result = (await afterRun(
			{ answer: "42", reason: "answer", first: "1", last: "1" },
			{ conversationId: 7, snapshot: async () => directoryWith({}), entry: async () => wakeEntry },
			{},
		)) as { tasks: { input: TurnReportInput }[] } | undefined;
		expect(result?.tasks).toHaveLength(1);
		// `reply` 取自开跑那条条目（不是名册里此刻的）；`task` 仍来自名册。
		expect(result?.tasks[0]?.input).toEqual({
			slug: "林越",
			answer: "42",
			wake: { reply: { channelId: "team:alpha", seq: 2, from: "owner", at: 9 }, task: wake.task },
		});
	});

	test("名册里没人时钩子什么都不要求", async () => {
		const { hook } = createTurnReport(async () => ({ kind: "silent", reason: "no-target" }));
		const afterRun = (hook.handlers as { afterRun: (...args: unknown[]) => Promise<unknown> }).afterRun;
		expect(
			await afterRun(
				{ answer: "42", reason: "answer", first: "1", last: "1" },
				{ conversationId: 99, snapshot: async () => directoryWith({}), entry: async () => undefined },
				{},
			),
		).toBeUndefined();
	});

	test("任务把输入交给收尾器，然后提交 completed 收据", async () => {
		const seen: FinishTurnInfo[] = [];
		const { task } = createTurnReport(async (info) => {
			seen.push(info);
			return { kind: "silent", reason: "no-target" };
		});
		const input: TurnReportInput = { slug: "林越", answer: "42", wake };
		const committed: unknown[] = [];
		const running = { input, state: { status: "running", checkpoint: { phase: "report" } } };
		await task.definition.phases.report(running as never, {
			entries: async () => ({ items: [] }),
			commit: async (change: () => unknown) => {
				committed.push(change());
			},
		} as never, {} as never);

		expect(seen).toHaveLength(1);
		expect(seen[0]?.slug).toBe("林越");
		expect(seen[0]?.answer).toBe("42");
		expect(seen[0]?.wake).toEqual(wake);
		expect(committed).toEqual([{ status: "terminal", outcome: { status: "completed", result: { answer: "42" } } }]);
	});

	test("补发失败 → 终态记 failed，不报 completed", async () => {
		const { task } = createTurnReport(async () => ({ kind: "failed", error: "频道写不进去" }));
		const committed: unknown[] = [];
		await task.definition.phases.report(
			{ input: { slug: "林越", answer: "42", wake }, state: { status: "running", checkpoint: { phase: "report" } } } as never,
			{
				entries: async () => ({ items: [] }),
				commit: async (change: () => unknown) => {
					committed.push(change());
				},
			} as never,
			{} as never,
		);

		expect(committed).toEqual([
			{ status: "terminal", outcome: { status: "failed", error: { message: "频道写不进去" } } },
		]);
	});

	test("被中断时提交 aborted", async () => {
		const { task } = createTurnReport(async () => ({ kind: "silent", reason: "no-target" }));
		const committed: unknown[] = [];
		await task.definition.abort({ input: { slug: "林越", answer: "42", wake } } as never, {
			commit: async (change: () => unknown) => {
				committed.push(change());
			},
		} as never, {} as never);
		expect(committed).toEqual([{ status: "terminal", outcome: { status: "aborted" } }]);
	});
});

// 类型只在编译期用：防止状态定义哪天被改成别的字符串。
const _state: TurnReportState = { phase: "report" };
void _state;
