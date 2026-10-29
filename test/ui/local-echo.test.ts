/**
 * 发送成功之后，消息必须马上看得见（审计 P1-5）。
 *
 * 以前只靠 SSE 回显：EventSource 正在重连的那几秒里，POST 已经成功、输入框已经清空，
 * 但列表里没有这条消息 —— 老板会以为没发出去，再发一遍。
 * 现在 POST 返回的 `seq` 直接落一条本地消息；SSE 到达时按同一个 seq 覆盖（幂等），
 * 不会变成两条。
 */
import { describe, expect, it } from "vitest";
import { channelCursor, insertLocalMessage, localEcho, mergeMessage, mergeMessages } from "../../ui/web/js/messages.js";

const history = [
	{ seq: 1, fromSlug: "owner", kind: "say", text: "开始。", at: 1_000 },
	{ seq: 2, fromSlug: "知言", kind: "say", text: "好。", at: 2_000 },
];

describe("localEcho：POST 成功即落本地一条", () => {
	it("SSE 没回显时，发送的内容也已经进了列表", () => {
		const echo = localEcho({ seq: 3, text: "把前端剩下的收一下", at: 3_000 });
		const messages = insertLocalMessage(history, echo);
		expect(messages).toHaveLength(3);
		expect(messages.at(-1)).toMatchObject({ seq: 3, text: "把前端剩下的收一下", fromSlug: "owner" });
		// 断线期间界面就靠这一条：内容在、seq 在，能按 seq 定位
		expect(messages.some((message) => message.text === "把前端剩下的收一下")).toBe(true);
	});

	it("kind 用 chat（和服务端一致），带 local 标记与回复引用，附件可选", () => {
		expect(localEcho({ seq: 3, text: "x" }).kind).toBe("chat");
		const echo = localEcho({ seq: 9, text: "看这张", replyTo: 2, attachments: [{ id: "a1", name: "x.png", kind: "image", bytes: 10 }] });
		expect(echo.local).toBe(true);
		expect(echo.replyTo).toBe(2);
		expect(echo.attachments).toHaveLength(1);
	});

	it("SSE 随后到达同一个 seq：覆盖而不是追加第二条", () => {
		const echo = localEcho({ seq: 3, text: "把前端剩下的收一下", at: 3_000 });
		const afterEcho = insertLocalMessage(history, echo);
		// 服务端回显（可能带更多字段、文案被规范化）
		const server = { seq: 3, fromSlug: "owner", fromLabel: "老大", kind: "say", text: "把前端剩下的收一下", at: 3_050 };
		const merged = mergeMessage(afterEcho.find((message) => message.seq === 3), server);
		const afterSse = afterEcho.map((message) => (message.seq === 3 ? merged : message));
		expect(afterSse).toHaveLength(3);
		expect(afterSse.find((message) => message.seq === 3)?.at).toBe(3_050);
		// 整列合并（补历史那条路）也不会出现两条
		expect(mergeMessages(afterEcho, [server])).toHaveLength(3);
	});

	it("落本地一条后把频道游标推到该 seq（重连的 since 不会漏）", () => {
		const channel = { id: "proj:solo", lastSeq: 5, lastAt: 1_000 };
		const cursor = channelCursor(channel, 9, 2_000);
		expect(cursor).toEqual({ lastSeq: 9, lastAt: 2_000 });
		// 只会往前推，不会被更小的 seq 拖回去
		expect(channelCursor({ lastSeq: 9, lastAt: 2_000 }, 7, 1_500)).toEqual({ lastSeq: 9, lastAt: 2_000 });
		expect(channelCursor(null, 3)).toEqual({ lastSeq: 0, lastAt: 0 });
	});

	it("同一个 seq 插两次不会变成两行", () => {
		const echo = localEcho({ seq: 3, text: "重发一次", at: 3_000 });
		const once = insertLocalMessage(history, echo);
		const twice = insertLocalMessage(once, { ...echo, text: "重发一次（更新）" });
		expect(twice).toHaveLength(3);
		expect(twice.find((message) => message.seq === 3)?.text).toBe("重发一次（更新）");
	});
});
