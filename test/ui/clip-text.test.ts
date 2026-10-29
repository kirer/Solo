/**
 * 文本截断必须按「字素簇」切，不能按 UTF-16 码元切。
 *
 * 顾南雁的审计（P2-5）：`slice(0, N)` 会把 `🚀`（两个码元）或 `𠮷`（扩展 B 区）
 * 切成孤立代理，屏幕上就是一个 `�`。过程行摘要、侧栏预览、回复引用都走同一个
 * `clipText`，所以只要这里对了，那些地方就都对了。
 */
import { describe, expect, it } from "vitest";
import { clipText, clipWithEllipsis } from "../../ui/web/js/format.js";
import { clampLine, eventSummary } from "../../ui/web/js/rows.js";

describe("clipText：按字素截断", () => {
	it("emoji 不会被切成半个（孤立代理）", () => {
		// 「部署完成 🚀 全部通过」按码元切第 5 个会正好劈开 🚀
		expect(clipText("部署完成 🚀 全部通过", 5)).toBe("部署完成 ");
		expect(clipText("部署完成 🚀 全部通过", 6)).toBe("部署完成 🚀");
		// 输出里不许出现孤立代理
		expect(clipText("🚀🚀🚀", 2)).toBe("🚀🚀");
		expect([...clipText("🚀🚀🚀", 2)].every((ch) => ch.codePointAt(0) > 0xffff || ch.length === 1)).toBe(true);
	});

	it("扩展区汉字（𠮷 / U+20BB7）也按一个字算", () => {
		const text = "𠮷野家";
		expect(clipText(text, 1)).toBe("𠮷");
		expect(clipText(text, 2)).toBe("𠮷野");
		// 码元长度是 4，但字素只有 3 —— 按码元切会在这里切出半个字
		expect(text.length).toBe(4);
	});

	it("刚好边界：不超就原样返回，超一个才切", () => {
		expect(clipText("12345", 5)).toBe("12345");
		expect(clipText("123456", 5)).toBe("12345");
		expect(clipText("", 5)).toBe("");
		expect(clipText("abc", 0)).toBe("");
		// ZWJ 组合（一家人）算一个字素，不会被拆成三个人
		expect(clipText("👨‍👩‍👧👨‍👩‍👧", 1)).toBe("👨‍👩‍👧");
	});

	it("clipWithEllipsis 按字素算总长度（含省略号）不超过 limit", () => {
		// 6 = 5 个字素 + 「…」；第 6 个字素是 🚀，宁可不放也不切半个
		expect(clipWithEllipsis("部署完成 🚀 全部通过", 6)).toBe("部署完成 …");
		expect([...clipWithEllipsis("部署完成 🚀 全部通过", 6)]).toHaveLength(6);
		expect(clipWithEllipsis("短", 6)).toBe("短");
		expect(clipWithEllipsis("部署完成 🚀 全部通过", 5)).toBe("部署完成…");
		// emoji 正好落在边界上：不会被切开，也不会多出半个
		expect([...clipWithEllipsis("ab🚀cd", 4)]).toHaveLength(4);
		expect(clipWithEllipsis("ab🚀cd", 4)).toBe("ab🚀…");
	});
});

describe("过程行摘要走同一套截断", () => {
	it("60 字截断不会把 emoji 切一半", () => {
		const summary = eventSummary({ kind: "think", text: "想".repeat(58) + "🚀🚀🚀🚀", at: 1 });
		// 按字素数 60（UTF-16 长度会多，因为 🚀 占两个码元）—— 这正是不能按码元切的原因
		expect([...summary]).toHaveLength(60);
		expect(summary.endsWith("…")).toBe(true);
		// 最后一个字素是完整的 emoji 或省略号，不是孤立代理
		const last = [...summary].at(-2);
		expect(last === "🚀" || last === "想").toBe(true);
		// 10 个字素 + 1 个 emoji = 11 个字素；limit 10 时才截，且不会切出半个 🚀
		expect(clampLine("x".repeat(10) + "🚀", 11)).toBe("x".repeat(10) + "🚀");
		const clipped = clampLine("x".repeat(10) + "🚀", 10);
		expect([...clipped]).toHaveLength(10);
		expect(clipped.endsWith("…")).toBe(true);
	});
});
