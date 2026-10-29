/**
 * 投影纯函数测试：会话条目 → 个人频道消息。
 *
 * 这是「老板能看见员工思考」功能的唯一连线。逻辑都在 `projectAssistantEntry` 里，
 * 不依赖运行时，所以纯测它。
 */
import { describe, expect, test } from "vitest";
import { isFillerThinking, projectAssistantEntry } from "../../src/core/channel/transcript.ts";
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

describe("收尾噪声思考不落库（老板会误以为他还在干活）", () => {
	test("纯收尾词或标点：不落", () => {
		for (const text of ["End.", "done", "OK.", "完成。", "结束", "Done!", "……", "OK, done."]) {
			expect(isFillerThinking(text)).toBe(true);
		}
		const entry = assistantEntry([{ type: "thinking", thinking: "End." }]);
		expect(projectAssistantEntry(entry)).toEqual([]);
	});

	test("有意义的思考照落（一个实词就够）", () => {
		for (const text of ["Done. 接下来我看日志", "看完了，改三处", "End of the log? 还要看第二份"]) {
			expect(isFillerThinking(text)).toBe(false);
		}
		const entry = assistantEntry([{ type: "thinking", thinking: "先看日志再改" }]);
		expect(projectAssistantEntry(entry)).toEqual([{ kind: "think", text: "先看日志再改" }]);
	});

	test("正文里的 `End.` 不受影响 —— 那是他说的话，不是过程", () => {
		const entry = assistantEntry([{ type: "text", text: "End." }]);
		expect(projectAssistantEntry(entry)).toEqual([{ kind: "say", text: "End." }]);
	});
});
