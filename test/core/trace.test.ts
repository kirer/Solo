/**
 * 轨迹派生：会话条目 → 一轮的步骤。
 *
 * 这些用例守的是「界面上每个数字都有出处」：标题是算出来的、耗时只在有时间戳时出现、
 * 连续思考合并、工具结果并进前一个调用、截断有话说。
 */
import { describe, expect, it } from "vitest";
import { groupsOf } from "../../src/app/trace.ts";
import { buildTurn, slimTurn, stripAnsi, summaryOf, withoutSteps } from "../../src/app/trace.ts";
import type { EntryRecord } from "../../src/core/runtime/index.ts";


function entry(kind: string, model: unknown[], data?: unknown): EntryRecord {
	return {
		id: `e-${Math.random().toString(36).slice(2)}` as never,
		conversationId: 1 as never,
		kind,
		model: model as never,
		...(data === undefined ? {} : { data: data as never }),
	};
}

function assistant(content: unknown[], timestamp = 1000): EntryRecord {
	return entry("pi.assistant", [{ role: "assistant", content, timestamp }]);
}

function result(toolCallId: string, text: string, timestamp = 3200, isError = false): EntryRecord {
	return entry("pi.tool-result", [{ role: "toolResult", toolCallId, toolName: "run", content: [{ type: "text", text }], isError, timestamp }]);
}

function facts(overrides: Partial<Parameters<typeof buildTurn>[1]> = {}) {
	return {
		channelId: "c1",
		seq: 7,
		slug: "zhiyan",
		label: "知言",
		startedAt: 100,
		live: false,
		...overrides,
	};
}

describe("buildTurn", () => {
	it("把一次 run 调用画成一步，结果并进同一行", () => {
		const turn = buildTurn(
			[assistant([{ type: "toolCall", id: "call-1", name: "run", arguments: { command: "npm test" } }]), result("call-1", "$ npm test\n✓ 12\n退出码 0")],
			facts({ replySeq: 9, endedAt: 5000 }),
		);
		expect(turn.steps).toHaveLength(1);
		const step = turn.steps![0]!;
		expect(step.kind).toBe("run");
		expect(step.title).toBe("运行 npm test");
		expect(step.status).toBe("ok");
		expect(step.ms).toBe(2200);
		expect(step.exitCode).toBe(0);
		expect(step.output).toContain("✓ 12");
		expect(turn.status).toBe("done");
	});

	it("连续的 thinking 合并成一条，时长不编造", () => {
		const turn = buildTurn(
			[assistant([{ type: "thinking", thinking: "先看测试" }]), assistant([{ type: "thinking", thinking: "再看实现" }])],
			facts({ live: true }),
		);
		expect(turn.steps).toHaveLength(1);
		expect(turn.steps![0]!.text).toBe("先看测试\n\n再看实现");
		expect(turn.steps![0]!.ms).toBeUndefined();
		expect(turn.status).toBe("running");
	});

	it("file 的读写分成两种步骤，写带行数", () => {
		const turn = buildTurn(
			[
				assistant([
					{ type: "toolCall", id: "r", name: "file", arguments: { action: "read", path: "a.ts" } },
					{ type: "toolCall", id: "w", name: "file", arguments: { action: "write", path: "b.ts", content: "1\n2\n3" } },
				]),
			],
			facts(),
		);
		expect(turn.steps!.map((step) => step.kind)).toEqual(["file-read", "file-write"]);
		expect(turn.steps![1]!.added).toBe(3);
		expect(turn.summary).toBe("读了 1 个文件 · 写了 1 个文件");
	});

	it("说话不算过程：say 与正文都不进步骤", () => {
		const turn = buildTurn(
			[
				assistant([
					{ type: "text", text: "跑完了。" },
					{ type: "toolCall", id: "s", name: "say", arguments: { text: "跑完了。", channel: "c1" } },
				]),
			],
			facts({ replySeq: 2 }),
		);
		// 说出口的话就是频道里那条消息，画成步骤会和工作记录里的原文重复一遍。
		expect(turn.steps).toHaveLength(0);
		expect(turn.stepCount).toBe(0);
		expect(turn.status).toBe("done");
	});

	it("一轮结束了还挂着 running 的步骤 = 那次调用没回来", () => {
		const turn = buildTurn(
			[assistant([{ type: "toolCall", id: "x", name: "run", arguments: { command: "sleep 999" } }])],
			facts({ live: false }),
		);
		expect(turn.steps![0]!.status).toBe("failed");
		expect(turn.status).toBe("aborted");
	});

	it("未知工具兜底成 tool 步骤，原名留着", () => {
		const turn = buildTurn([assistant([{ type: "toolCall", id: "u", name: "mystery", arguments: {} }])], facts());
		expect(turn.steps![0]!.kind).toBe("tool");
		expect(turn.steps![0]!.tool).toBe("mystery");
	});

	it("超过 200 步就截断并标记", () => {
		const calls = Array.from({ length: 260 }, (_, index) => ({
			type: "toolCall",
			id: `c-${String(index)}`,
			name: "chats",
			arguments: {},
		}));
		const turn = buildTurn([assistant(calls)], facts());
		expect(turn.steps).toHaveLength(200);
		expect(turn.truncated).toBe(true);
	});
});

describe("摘要与瘦身", () => {
	it("摘要按固定顺序、零项不出现", () => {
		const summary = summaryOf(
			[
				{ id: "1", kind: "run", title: "运行 a", status: "ok" },
				{ id: "2", kind: "file-write", title: "写了 b", status: "ok" },
			],
			{ startedAt: 0, endedAt: 1000 },
		);
		expect(summary).toBe("运行 1 条命令 · 写了 1 个文件");
	});

	it("一步事都没做时写「想了 Ns」", () => {
		expect(summaryOf([], { startedAt: 0, endedAt: 12_000 })).toBe("想了 12s");
	});

	it("折叠版不带 steps", () => {
		const turn = buildTurn([assistant([{ type: "thinking", thinking: "嗯" }])], facts());
		expect(withoutSteps(turn).steps).toBeUndefined();
	});

	it("推送版把长输出压到 2 KB", () => {
		const turn = buildTurn(
			[assistant([{ type: "toolCall", id: "c", name: "run", arguments: { command: "cat big" } }]), result("c", "x".repeat(9000))],
			facts(),
		);
		const slim = slimTurn(turn);
		expect(slim.steps![0]!.output!.length).toBeLessThan(2100);
		expect(slim.steps![0]!.truncated).toBe(true);
	});

	it("剥 ANSI", () => {
		expect(stripAnsi("\u001b[31m红\u001b[0m")).toBe("红");
	});
});

describe("跨频道切轮：私聊页的工作记录", () => {
	const trigger = (channelId: string, seq: number) => entry("core.channel", [], { channelId, seq });

	it("每个 core.channel 都收口，组里带上它发生的频道", () => {
		const entries = [
			trigger("team:alpha", 1),
			assistant([{ type: "thinking", thinking: "嗯" }]),
			trigger("dm:owner-linyue", 1),
			assistant([{ type: "thinking", thinking: "嗯" }]),
		];
		const groups = groupsOf(entries, 0, Number.MAX_SAFE_INTEGER);
		expect(groups.map((group) => group.channelId)).toEqual(["team:alpha", "dm:owner-linyue"]);
		// 两轮各自在下一个 core.channel 处收口。
		expect(groups[0]!.end).toBe(2);
		expect(groups[1]!.start).toBe(2);
	});

	it("窗口按 seq 过滤，但 seq 是频道内序号", () => {
		const entries = [trigger("a", 5), trigger("b", 2), trigger("a", 9)];
		expect(groupsOf(entries, 2, 5).map((group) => [group.channelId, group.seq])).toEqual([
			["a", 5],
			["b", 2],
		]);
	});

	it("没有 channelId 的条目不开组", () => {
		expect(groupsOf([entry("core.channel", [], { seq: 1 })], 0, 9)).toEqual([]);
	});
});
