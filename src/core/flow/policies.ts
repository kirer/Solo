/**
 * 策略链：按顺序问每个 `Router`，第一个给出决定的生效。
 *
 * 顺序就是装配层给的数组顺序（插件策略排在 `defaultRouter` 前面）。
 * 一个策略抛错只留一行日志、继续问下一个 —— 路由坏掉不该让消息发不出去。
 *
 * 最后的兜底是 `facts.defaultTargets`：连内置策略都没给决定时，仍然按今天的规则叫。
 */
import type { Context } from "../runtime/index.ts";
import type { FlowPolicy } from "../channel/types.ts";
import type { Router, Settler } from "./ports.ts";
import type { RecipientPlan, RouteFacts } from "./types.ts";

export async function resolvePlan(
	facts: RouteFacts,
	routers: readonly Router[],
	ctx: Context,
): Promise<RecipientPlan> {
	for (const router of routers) {
		let decision: Awaited<ReturnType<Router["decide"]>>;
		try {
			decision = await router.decide(facts, ctx);
		} catch (error) {
			console.warn(`[flow] 路由策略失败，跳过：${error instanceof Error ? error.message : String(error)}`);
			continue;
		}
		if (decision === undefined) continue;
		if (decision.kind === "drop") return { targets: [], reason: decision.reason };
		return { targets: [...decision.targets], reason: decision.reason };
	}
	return { targets: [...facts.defaultTargets], reason: "defaultTargets" };
}

/**
 * 把一组**外部策略**（插件注册的）接成一条 `Router`。
 *
 * `source` 是活引用：插件整份重装之后，下一次 `publish` 自动问新的那一批（ADR-026）。
 * 一条抛错只跳过它，不中断整条链。
 */
export function policyRouter(source: () => readonly FlowPolicy[]): Router {
	return {
		async decide(facts: RouteFacts) {
			for (const policy of source()) {
				if (policy.kind !== "router") continue;
				try {
					const decision = await policy.run(facts);
					if (decision !== undefined) return decision;
				} catch (error) {
					console.warn(`[flow] 分发策略失败，跳过：${error instanceof Error ? error.message : String(error)}`);
				}
			}
			return undefined;
		},
	};
}

/**
 * 把一组外部策略接成 `Settler`：**最后注册的那条 `settle` 生效**，
 * 弃权（`undefined`）或抛错都回退默认收尾。写盘与校验仍由 core 做。
 */
export function policySettler(source: () => readonly FlowPolicy[], fallback: Settler): Settler {
	return {
		async decide(facts, ctx) {
			let chosen: Extract<FlowPolicy, { kind: "settle" }> | undefined;
			for (const policy of source()) {
				if (policy.kind === "settle") chosen = policy;
			}
			if (chosen === undefined) return fallback.decide(facts, ctx);
			try {
				return (await chosen.run(facts)) ?? (await fallback.decide(facts, ctx));
			} catch (error) {
				console.warn(`[flow] 收尾策略失败，回退默认：${error instanceof Error ? error.message : String(error)}`);
				return fallback.decide(facts, ctx);
			}
		},
	};
}
