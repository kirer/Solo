/**
 * 私聊里最后一段（还在跑的）过程组默认展开 —— 老板刷新后要看得到过程。
 *
 * 组头现在只说「查看过程」，全折叠的话刷新完屏幕上只有一排「查看过程」，
 * 看起来像没有新消息。所以判据是：**私聊 + 还在跑 + 最后一段** 才展开；
 * 历史组、项目/公司频道一律折叠（项目频道放的是结论）。
 */
import { describe, expect, it } from "vitest";
import { shouldOpenByDefault } from "../../ui/app/src/rows.ts";

describe("shouldOpenByDefault", () => {
	it("私聊里正在跑的最后一段 → 展开", () => {
		expect(shouldOpenByDefault({ channelKind: "dm", running: true, isLast: true })).toBe(true);
	});

	it("私聊里的历史组 / 已完成的组 → 仍然折叠", () => {
		expect(shouldOpenByDefault({ channelKind: "dm", running: false, isLast: true })).toBe(false);
		expect(shouldOpenByDefault({ channelKind: "dm", running: true, isLast: false })).toBe(false);
	});

	it("项目频道、公司频道全折叠（哪怕在跑的最后一段）", () => {
		expect(shouldOpenByDefault({ channelKind: "project", running: true, isLast: true })).toBe(false);
		expect(shouldOpenByDefault({ channelKind: "company", running: true, isLast: true })).toBe(false);
		expect(shouldOpenByDefault({ channelKind: "leadership", running: true, isLast: true })).toBe(false);
	});

	it("缺省参数不展开", () => {
		// 重构后签名要求一个入参对象（不再是「全部可选参数的默认值」），所以这里传空对象。
		expect(shouldOpenByDefault({})).toBe(false);
		expect(shouldOpenByDefault({ channelKind: "dm", running: true })).toBe(false);
		expect(shouldOpenByDefault({ running: true, isLast: true })).toBe(false);
	});
});
