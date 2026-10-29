/**
 * 处理中占位（「开始处理」）。
 *
 * 老板报过一个现象：旧占位一直挂着「开始处理…」。两个原因都在前端这侧可修：
 *   1. 存量占位落库的是改前的文案 —— 界面不再读 message.text，固定显示「开始处理」；
 *   2. 那条占位根本没被覆盖 —— 同一个人在这之后已经说过话的占位，就是残留，不画。
 * 服务端不动，这里只测纯函数（DOM 那一半由 app.js 的 dropStalePlaceholders 负责）。
 */
import { describe, expect, it } from "vitest";
import { PLACEHOLDER_TTL_MS, PROCESSING_TEXT, isExpiredPlaceholder, isStalePlaceholder } from "../../ui/app/src/rows.ts";

const placeholder = (seq, slug = "知言", at = 1_000) => ({
	seq,
	fromSlug: slug,
	kind: "say",
	text: "开始处理…",
	status: "pending",
	processing: true,
	at,
});
const say = (seq, slug = "知言", at = 2_000) => ({ seq, fromSlug: slug, kind: "say", text: "做完了。", at });
const think = (seq, slug = "知言", at = 1_500) => ({ seq, fromSlug: slug, kind: "think", text: "想一下。", at });

describe("处理中占位", () => {
	it("文案固定为「开始处理」，不读存量 message.text", () => {
		expect(PROCESSING_TEXT).toBe("开始处理");
	});

	it("本人在这之后说过话 → 这条占位是残留", () => {
		const messages = [placeholder(1), think(2), say(3)];
		expect(isStalePlaceholder(messages[0], messages, 0)).toBe(true);
	});

	it("本人只在后面想过/跑过，还没开口 → 占位仍然有效", () => {
		const messages = [placeholder(1), think(2)];
		expect(isStalePlaceholder(messages[0], messages, 0)).toBe(false);
	});

	it("别人说话不算：占位还是这个人的进行中", () => {
		const messages = [placeholder(1), say(2, "沈舟")];
		expect(isStalePlaceholder(messages[0], messages, 0)).toBe(false);
	});

	it("放了十分钟还没人接 → 超时（叫了没会话的同事那种）", () => {
		const ph = placeholder(1, "顾南雁", 1_000);
		expect(PLACEHOLDER_TTL_MS).toBe(10 * 60 * 1000);
		// 刚发出来：不算超时
		expect(isExpiredPlaceholder(ph, 1_000 + 60_000)).toBe(false);
		// 刚好到 10 分钟：仍算活着（用 > 而不是 >=，边界不提前消失）
		expect(isExpiredPlaceholder(ph, 1_000 + PLACEHOLDER_TTL_MS)).toBe(false);
		// 超过 10 分钟：超时，界面上不画
		expect(isExpiredPlaceholder(ph, 1_000 + PLACEHOLDER_TTL_MS + 1)).toBe(true);
	});

	it("非占位行、时间戳缺失的行不会被当成超时", () => {
		expect(isExpiredPlaceholder(say(1), Date.now())).toBe(false);
		expect(isExpiredPlaceholder({ ...placeholder(2), at: undefined }, Date.now())).toBe(false);
		expect(isExpiredPlaceholder(null, Date.now())).toBe(false);
	});

	it("非占位行、后面的占位都不算残留", () => {
		const messages = [say(1), placeholder(2), placeholder(3)];
		expect(isStalePlaceholder(messages[0], messages, 0)).toBe(false);
		expect(isStalePlaceholder(messages[1], messages, 1)).toBe(false);
	});
});
