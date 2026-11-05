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

describe("turn-report：名册 → 任务输入", () => {
	test("会话能反查到人、也有唤醒记录时，三样都带上", () => {
		const input = turnReportInputFor({ answer: "42" }, directoryWith({}), 7);
		expect(input).toEqual({ slug: "林越", answer: "42", wake });
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
			{ conversationId: 7, snapshot: async () => directoryWith({}) },
			{},
		)) as { tasks: { input: TurnReportInput }[] } | undefined;
		expect(result?.tasks).toHaveLength(1);
		expect(result?.tasks[0]?.input).toEqual({ slug: "林越", answer: "42", wake });
	});

	test("名册里没人时钩子什么都不要求", async () => {
		const { hook } = createTurnReport(async () => ({ kind: "silent", reason: "no-target" }));
		const afterRun = (hook.handlers as { afterRun: (...args: unknown[]) => Promise<unknown> }).afterRun;
		expect(
			await afterRun(
				{ answer: "42", reason: "answer", first: "1", last: "1" },
				{ conversationId: 99, snapshot: async () => directoryWith({}) },
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
