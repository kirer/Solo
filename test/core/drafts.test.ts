import { describe, expect, it } from "vitest";
import { DRAFT_TAIL, draftTextOf } from "../../src/core/runtime/drafts.ts";

function live(content: readonly unknown[]): unknown {
	return { generation: { message: { content } } };
}

describe("draftTextOf", () => {
	it("没有正在生成的回合就是 undefined", () => {
		expect(draftTextOf(undefined)).toBeUndefined();
		expect(draftTextOf({})).toBeUndefined();
		expect(draftTextOf({ generation: {} })).toBeUndefined();
	});

	it("只认 say 的 text，不把 run 的命令当发言", () => {
		const command = live([{ type: "toolCall", name: "run", arguments: { command: "ls -la" } }]);
		expect(draftTextOf(command)).toBeUndefined();
		const say = live([{ type: "toolCall", name: "say", arguments: { text: "我看了一下" } }]);
		expect(draftTextOf(say)).toBe("我看了一下");
	});

	it("参数还没到（arguments 空）时不算草稿", () => {
		expect(draftTextOf(live([{ type: "toolCall", name: "say", arguments: {} }]))).toBeUndefined();
		expect(draftTextOf(live([{ type: "toolCall", name: "say", arguments: { text: "   " } }]))).toBeUndefined();
	});

	it("思考块不算草稿 —— 那是它自己看的东西", () => {
		expect(draftTextOf(live([{ type: "thinking", thinking: "让我想想" }]))).toBeUndefined();
	});

	it("太长只留尾部，界面不会为了看不见的字付带宽", () => {
		const text = "字".repeat(DRAFT_TAIL + 300);
		const draft = draftTextOf(live([{ type: "toolCall", name: "say", arguments: { text } }]));
		expect(draft).toHaveLength(DRAFT_TAIL);
		expect(draft).toBe(text.slice(-DRAFT_TAIL));
	});

	it("多个 say 取第一个有正文的（模型可能先试一句再改）", () => {
		const content = [
			{ type: "toolCall", name: "say", arguments: {} },
			{ type: "toolCall", name: "say", arguments: { text: "这句" } },
		];
		expect(draftTextOf(live(content))).toBe("这句");
	});
});
