/**
 * 名字规则的唯一一份（ADR-096）。
 *
 * agent / 团队 / 技能都是**目录名**，名字有一部分来自模型写的自由文本。三处各写一份
 * 正则时，最松的那一处就是路径穿越的入口 —— 这些用例钉住「一份规则 + 两个方向的用法」，
 * 以及旧名字（`assertSlug` / `assertTeamSlug` / `slugify`）仍然可用。
 */
import { describe, expect, test } from "vitest";
import { assertName, isSafeName, skillDirName, slugifyName } from "../../src/core/naming.ts";
import { assertTeamSlug } from "../../src/core/team/doc.ts";

describe("名字字符集", () => {
	test("字母、数字、中文、- 和 _ 是名字", () => {
		for (const value of ["cto", "a_b-c", "林越", "小恐龙2"]) expect(isSafeName(value)).toBe(true);
	});

	test("点号、斜杠、空白、空串都不是名字", () => {
		for (const value of [".", "..", "", "a/b", "a b", "a.b", "../x", "a@b"]) {
			expect(isSafeName(value), value).toBe(false);
		}
	});
});

describe("assertName：校验而非清洗", () => {
	test("三种名字共用同一套字符判断", () => {
		expect(assertName("林越", "agent")).toBe("林越");
		expect(assertName("alpha-2", "team")).toBe("alpha-2");
		expect(() => assertName("a/b", "skill")).toThrow(/技能名/);
	});

	test("owner 只能当对话的另一端，不能当 agent", () => {
		expect(() => assertName("owner", "agent")).toThrow(/slug/);
		// 团队和技能里没有保留名。
		expect(assertName("owner", "team")).toBe("owner");
		expect(assertName("owner", "skill")).toBe("owner");
	});

	test("错误文案说清「是什么不能用作名字」", () => {
		expect(() => assertName("..", "agent")).toThrow(/不能用作slug/);
		expect(() => assertName("..", "team")).toThrow(/不能用作团队 slug/);
	});
});

describe("slugifyName：人类名字 → 目录名", () => {
	test("中文保留，空白与符号变 -，点号一律去掉", () => {
		expect(slugifyName("林 越")).toBe("林-越");
		expect(slugifyName("A/B")).toBe("A-B");
		expect(slugifyName("..")).toBe("agent");
		expect(slugifyName("a.b")).toBe("ab");
	});

	test("清洗结果一定能过 assertName（否则 hire 会建出一个失败的人）", () => {
		for (const raw of ["a b", "a/b", "..", "!!!", "张三 (前端)"]) {
			expect(() => assertName(slugifyName(raw), "agent"), raw).not.toThrow();
		}
	});
});

describe("skillDirName：替换而不是拒绝", () => {
	test("斜杠变 -；空名与点号仍然拒绝", () => {
		expect(skillDirName("写/周报")).toBe("写-周报");
		expect(skillDirName("写周报")).toBe("写周报");
		expect(() => skillDirName("")).toThrow(/技能名不能为空/);
		expect(() => skillDirName("..")).toThrow(/技能名不能为空/);
	});
});

describe("团队 slug 用同一套规则，错误文案说清对象", () => {
	test("assertTeamSlug", () => {
		expect(assertTeamSlug("alpha")).toBe("alpha");
		expect(() => assertTeamSlug("a/b")).toThrow(/团队 slug/);
	});
});
