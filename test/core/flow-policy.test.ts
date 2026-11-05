/**
 * 策略链：第一个给出决定的生效；都弃权就用内置事实里的名单。
 *
 * 这里用假 router，不碰频道、不碰库 —— 路由顺序本来就该能脱离这两样测。
 */
import { describe, expect, it } from "vitest";
import { BACKGROUND_CONTEXT } from "../../src/core/runtime/index.ts";
import { emptyChannelState, type ChannelState, type FlowPolicy, type SettleFacts } from "../../src/core/channel/types.ts";
import { defaultRouter } from "../../src/core/flow/defaults/router.ts";
import { defaultSettler } from "../../src/core/flow/defaults/settle.ts";
import { policyRouter, policySettler, resolvePlan } from "../../src/core/flow/policies.ts";
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

describe("外部策略（插件注册的那一份）", () => {
	const settleFacts = (): SettleFacts => {
		const state: ChannelState = emptyChannelState();
		state.channels["group:demo"] = {
			id: "group:demo",
			title: "演示群",
			members: ["owner", "a", "b"],
			wakeOnAll: [],
			createdAt: 1,
		};
		const at = { channelId: "group:demo", seq: 1, from: "owner", at: 1 };
		return { slug: "a", wake: { reply: at, task: at }, state, text: "结论", saidLast: false };
	};

	it("policyRouter：先注册的 router 先问，第一条决定生效", async () => {
		const source = (): FlowPolicy[] => [
			{ kind: "router", run: () => undefined },
			{ kind: "router", run: () => ({ kind: "targets", targets: ["b"], reason: "插件：关键词" }) },
		];
		await expect(resolvePlan(facts, [policyRouter(source), defaultRouter()], BACKGROUND_CONTEXT)).resolves.toEqual({
			targets: ["b"],
			reason: "插件：关键词",
		});
	});

	it("policyRouter：一条抛错只跳过它，下一条照常", async () => {
		const source = (): FlowPolicy[] => [
			{
				kind: "router",
				run: () => {
					throw new Error("坏了");
				},
			},
			{ kind: "router", run: () => ({ kind: "drop", reason: "插件：静默" }) },
		];
		await expect(resolvePlan(facts, [policyRouter(source)], BACKGROUND_CONTEXT)).resolves.toEqual({
			targets: [],
			reason: "插件：静默",
		});
	});

	it("policySettler：没有 settle 策略时走默认收尾", async () => {
		const settle = policySettler(() => [], defaultSettler());
		await expect(settle.decide(settleFacts(), BACKGROUND_CONTEXT)).resolves.toEqual({
			kind: "repost",
			channelId: "group:demo",
			text: "结论",
		});
	});

	it("policySettler：最后注册的那条生效，弃权回退默认", async () => {
		const source = (): FlowPolicy[] => [
			{ kind: "settle", run: () => ({ kind: "repost", channelId: "group:demo", text: "第一条" }) },
			{ kind: "settle", run: () => ({ kind: "repost", channelId: "group:demo", text: "第二条" }) },
		];
		await expect(policySettler(source, defaultSettler()).decide(settleFacts(), BACKGROUND_CONTEXT)).resolves.toEqual({
			kind: "repost",
			channelId: "group:demo",
			text: "第二条",
		});
		await expect(
			policySettler(
				() => [{ kind: "settle", run: () => undefined }],
				defaultSettler(),
			).decide(settleFacts(), BACKGROUND_CONTEXT),
		).resolves.toEqual({ kind: "repost", channelId: "group:demo", text: "结论" });
	});

	it("policySettler：抛错回退默认收尾", async () => {
		const source = (): FlowPolicy[] => [
			{
				kind: "settle",
				run: () => {
					throw new Error("坏了");
				},
			},
		];
		await expect(policySettler(source, defaultSettler()).decide(settleFacts(), BACKGROUND_CONTEXT)).resolves.toEqual({
			kind: "repost",
			channelId: "group:demo",
			text: "结论",
		});
	});
});
