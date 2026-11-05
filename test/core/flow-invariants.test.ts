/**
 * 最后一道校验：策略只能提议，core 决定谁真的被叫。
 *
 * 这一组断言不看投递实现，只看名单 —— 非成员、我、发件人自己、重复目标都被滤掉，
 * 顺序不变。
 */
import { describe, expect, it } from "vitest";
import type { Channel } from "../../src/core/channel/types.ts";
import { validatePlan } from "../../src/core/flow/validate.ts";

const channel: Channel = {
	id: "group:demo",
	title: "演示群",
	members: ["owner", "a", "b"],
	wakeOnAll: ["owner"],
	createdAt: 1,
};

describe("validatePlan", () => {
	it("只留下这个房间里、不是我自己、不是发件人的人", () => {
		expect(validatePlan({ targets: ["owner", "a", "outsider", "b"], reason: "route" }, channel, { from: "b" })).toEqual({
			targets: ["a"],
			reason: "route",
		});
	});

	it("去重但保持提议的顺序", () => {
		expect(validatePlan({ targets: ["b", "a", "b"], reason: "policy" }, channel, { from: "owner" }).targets).toEqual([
			"b",
			"a",
		]);
	});

	it("全部被滤掉时是空名单，不是报错", () => {
		expect(validatePlan({ targets: ["owner"], reason: "wakeTo" }, channel, { from: "owner" })).toEqual({
			targets: [],
			reason: "wakeTo",
		});
	});
});
