/**
 * 会话列表未读数：0 不显示、1–99 显示数字、>99 显示「99+」。
 *
 * 我的验收口径是「造 >99 未读时显示 99+ 且行宽不变」。固定行宽那半在
 * shell.css（.ch-badge 的 flex:none / min-width / tabular-nums），能在这里
 * 断言的是文案：`unreadLabel` 必须是纯函数，且 100 与 10000 输出同一个字符串 ——
 * 徽标宽度才不会随数字位数跳。
 */
import { describe, expect, it } from "vitest";
import { unreadLabel } from "../../ui/app/src/lib/format.ts";

describe("unreadLabel", () => {
	it("0 / 负数 / 脏值都不显示", () => {
		expect(unreadLabel(0)).toBe("");
		expect(unreadLabel(-3)).toBe("");
		expect(unreadLabel(undefined)).toBe("");
		expect(unreadLabel(Number.NaN)).toBe("");
	});

	it("1 到 99 原样显示数字（含边界 99）", () => {
		expect(unreadLabel(1)).toBe("1");
		expect(unreadLabel(42)).toBe("42");
		expect(unreadLabel(99)).toBe("99");
	});

	it("超过 99 一律 99+，三位数和四位数输出同一个字符串", () => {
		expect(unreadLabel(100)).toBe("99+");
		expect(unreadLabel(1234)).toBe("99+");
		expect(unreadLabel(100)).toBe(unreadLabel(9999));
	});
});
