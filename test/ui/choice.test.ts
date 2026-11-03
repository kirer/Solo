/**
 * 「等我选」的判据：最后一条带选项的消息，且它之后我没说过话。
 *
 * 这条规则只在界面里，错了不会报错 —— 只会表现为「该弹的选框不弹」或「答完了还弹」。
 */
import { describe, expect, it } from "vitest";
import type { Message } from "../../ui/app/src/api/types.ts";
import { pendingChoice } from "../../ui/app/src/composer/choice.ts";

function msg(part: Partial<Message> & Pick<Message, "seq" | "fromSlug">): Message {
	return {
		at: part.seq,
		from: part.seq,
		fromLabel: part.fromSlug,
		kind: "chat",
		text: "",
		mentions: [],
		read: true,
		...part,
	} as Message;
}

describe("pendingChoice", () => {
	it("没有选项的消息不弹", () => {
		expect(pendingChoice([msg({ seq: 1, fromSlug: "知言", text: "做完了" })])).toBeUndefined();
	});

	it("最后一条带选项、之后我没说话 → 就是它", () => {
		const pending = pendingChoice([
			msg({ seq: 1, fromSlug: "知言" }),
			msg({ seq: 2, fromSlug: "知言", text: "选哪个？", options: ["A", "B"] }),
		]);
		expect(pending?.seq).toBe(2);
		expect(pending?.options).toEqual(["A", "B"]);
	});

	it("我已经回过一句 → 不再弹（无论有没有用 replyTo）", () => {
		expect(
			pendingChoice([
				msg({ seq: 2, fromSlug: "知言", options: ["A", "B"] }),
				msg({ seq: 3, fromSlug: "owner", text: "就 A" }),
			]),
		).toBeUndefined();
	});

	it("自己发的选项不算等我选", () => {
		expect(pendingChoice([msg({ seq: 1, fromSlug: "owner", options: ["A", "B"] })])).toBeUndefined();
	});

	it("中间夹着别人的普通消息，选框还在", () => {
		const pending = pendingChoice([
			msg({ seq: 2, fromSlug: "知言", options: ["A", "B"] }),
			msg({ seq: 3, fromSlug: "林越", text: "我先做别的" }),
		]);
		expect(pending?.seq).toBe(2);
	});
});
