/**
 * 删一条记忆 = 重建整篇，且必须逐字节对得上。
 *
 * 这里为什么逐字节比：旧实现（行切片 + 拼回）在**删中间一节**时会把后面的节吞掉、
 * 在**删末节**时留下一段重复正文 —— 两种都是静默的数据损坏，断言「条数对了」查不出来。
 */
import { describe, expect, it } from "vitest";
import { removeSection, sectionsOf } from "../../src/core/agent/memory.ts";

const DOC = ["# 记忆", "", "## A", "甲", "", "## B", "乙一", "乙二", "", "## C", "丙", ""].join("\n");

describe("removeSection：按 sectionsOf 的口径重建", () => {
	it("删中间一节：前后两节都留着，条数只减一", () => {
		const next = removeSection(DOC, "B");
		expect(next).toBe(["# 记忆", "", "## A", "甲", "", "## C", "丙"].join("\n"));
		expect(sectionsOf(next ?? "").map((section) => section.heading)).toEqual(["A", "C"]);
	});

	it("删首节：序言（标题）保留，剩下的节不丢", () => {
		const next = removeSection(DOC, "A");
		expect(next).toBe(["# 记忆", "", "## B", "乙一", "乙二", "", "## C", "丙"].join("\n"));
		expect(sectionsOf(next ?? "").map((section) => section.heading)).toEqual(["B", "C"]);
	});

	it("删末节：不留重复正文、不留空标题", () => {
		const next = removeSection(DOC, "C");
		expect(next).toBe(["# 记忆", "", "## A", "甲", "", "## B", "乙一", "乙二"].join("\n"));
		expect(next?.includes("丙")).toBe(false);
	});

	it("标题带尾随空格也能删（与 sectionsOf 的 trim 一致）", () => {
		const source = ["# 记忆", "", "## 带空格  ", "正文", "", "## 别的", "另一条"].join("\n");
		const next = removeSection(source, "带空格");
		expect(next).toBe(["# 记忆", "", "## 别的", "另一条"].join("\n"));
		// 反过来：传入带空格的标题同样能删
		expect(removeSection(source, "  带空格  ")?.includes("正文")).toBe(false);
	});

	it("只剩一节时删掉：文件里只剩序言，条数为 0", () => {
		const source = ["# 记忆", "", "## 唯一", "内容"].join("\n");
		const next = removeSection(source, "唯一");
		expect(next).toBe("# 记忆");
		expect(sectionsOf(next ?? "")).toEqual([]);
	});

	it("没有这一节 / 空标题：返回 undefined，调用方据此回 404", () => {
		expect(removeSection(DOC, "不存在")).toBeUndefined();
		expect(removeSection(DOC, "")).toBeUndefined();
		expect(removeSection(DOC, "   ")).toBeUndefined();
	});
});
