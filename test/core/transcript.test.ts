/**
 * 投影纯函数测试：会话条目 → 个人频道消息。
 *
 * 这是「老板能看见员工思考」功能的唯一连线。逻辑都在 `projectAssistantEntry` 里，
 * 不依赖运行时，所以纯测它。
 */
import { describe, expect, test } from "vitest";
import { projectAssistantEntry } from "../../src/core/channel/transcript.ts";
import type { EntryRecord } from "../../src/core/runtime/index.ts";

/** 造一条 `pi.assistant` 条目。 */
function assistantEntry(content: readonly unknown[]): EntryRecord {
	return {
		id: 1 as never,
		conversationId: 2 as never,
		kind: "pi.assistant",
		model: [{ role: "assistant", content: content as never }] as never,
	} as EntryRecord;
}

describe("projectAssistantEntry", () => {
	test("没有 thinking / text 的条目返回空", () => {
		const entry = assistantEntry([{ type: "toolCall", name: "say", arguments: { text: "hi" } }]);
		expect(projectAssistantEntry(entry)).toEqual([]);
	});

	test("thinking → think，text → say", () => {
		const entry = assistantEntry([
			{ type: "thinking", thinking: "该立项了" },
			{ type: "text", text: "我立个项目" },
		]);
		expect(projectAssistantEntry(entry)).toEqual([
			{ kind: "think", text: "该立项了" },
			{ kind: "say", text: "我立个项目" },
		]);
	});

	test("say 工具调用被跳过（它已在目标频道成消息）", () => {
		const entry = assistantEntry([{ type: "toolCall", name: "say", arguments: { text: "已通知" } }]);
		expect(projectAssistantEntry(entry)).toEqual([]);
	});

	test("非 say 工具调用 → tool，参数被摘要", () => {
		const entry = assistantEntry([
			{
				type: "toolCall",
				name: "run",
				arguments: { command: "npm start", cwd: "/x", extra: { a: 1 } },
			},
		]);
		const out = projectAssistantEntry(entry);
		expect(out).toHaveLength(1);
		expect(out[0]!.kind).toBe("tool");
		expect(out[0]!.text).toContain("run");
		expect(out[0]!.text).toContain("command=");
		expect(out[0]!.text).toContain("{…}"); // 嵌套对象被压成规模
	});

	test("空 thinking / text 块被忽略", () => {
		const entry = assistantEntry([{ type: "thinking", thinking: "   " }, { type: "text", text: "" }]);
		expect(projectAssistantEntry(entry)).toEqual([]);
	});

	test("非 pi.assistant 条目返回空", () => {
		const entry = { id: 1 as never, conversationId: 2 as never, kind: "pi.tool-result" } as EntryRecord;
		expect(projectAssistantEntry(entry)).toEqual([]);
	});
});
