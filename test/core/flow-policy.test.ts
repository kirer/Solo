/**
 * 策略链：第一个给出决定的生效；都弃权就用内置事实里的名单。
 *
 * 这里用假 router，不碰频道、不碰库 —— 路由顺序本来就该能脱离这两样测。
 */
import { describe, expect, it } from "vitest";
import { BACKGROUND_CONTEXT } from "../../src/core/runtime/index.ts";
import { defaultRouter } from "../../src/core/flow/defaults/router.ts";
import { resolvePlan } from "../../src/core/flow/policies.ts";
import type { Router } from "../../src/core/flow/ports.ts";
import type { RouteFacts } from "../../src/core/flow/types.ts";

const facts: RouteFacts = {
	message: { seq: 1, from: "owner", text: "上线吧", kind: "chat", mentions: [] },
	channel: { id: "group:demo", kind: "group", members: ["owner", "a", "b"], wakeOnAll: ["a"] },
	defaultTargets: ["a"],
};

describe("resolvePlan", () => {
	it("第一个返回决定的生效，后面的不再问", async () => {
		const calls: string[] = [];
		const routers: Router[] = [
			{
				async decide() {
					calls.push("first");
					return undefined;
				},
			},
			{
				async decide() {
					calls.push("second");
					return { kind: "targets", targets: ["b"], reason: "关键词：上线" };
				},
			},
			{
				async decide() {
					calls.push("third");
					return { kind: "targets", targets: ["a"], reason: "不该到这里" };
				},
			},
		];

		await expect(resolvePlan(facts, routers, BACKGROUND_CONTEXT)).resolves.toEqual({
			targets: ["b"],
			reason: "关键词：上线",
		});
		expect(calls).toEqual(["first", "second"]);
	});

	it("drop 明确不叫人，也不会落到默认名单", async () => {
		const routers: Router[] = [{ decide: async () => ({ kind: "drop", reason: "静默" }) }];
		await expect(resolvePlan(facts, routers, BACKGROUND_CONTEXT)).resolves.toEqual({ targets: [], reason: "静默" });
	});

	it("都弃权时用 facts.defaultTargets", async () => {
		const routers: Router[] = [{ decide: async () => undefined }, defaultRouter()];
		await expect(resolvePlan(facts, routers, BACKGROUND_CONTEXT)).resolves.toEqual({
			targets: ["a"],
			reason: "default",
		});
	});

	it("一条策略抛错只跳过它，下一条照常", async () => {
		const routers: Router[] = [
			{
				async decide() {
					throw new Error("坏了");
				},
			},
			defaultRouter(),
		];
		await expect(resolvePlan(facts, routers, BACKGROUND_CONTEXT)).resolves.toEqual({
			targets: ["a"],
			reason: "default",
		});
	});

	it("没有任何策略时回退到 defaultTargets", async () => {
		await expect(resolvePlan(facts, [], BACKGROUND_CONTEXT)).resolves.toEqual({
			targets: ["a"],
			reason: "defaultTargets",
		});
	});
});
