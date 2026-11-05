/**
 * 策略链：按顺序问每个 `Router`，第一个给出决定的生效。
 *
 * 顺序就是装配层给的数组顺序（Phase 3 会把插件策略排在 `defaultRouter` 前面）。
 * 一个策略抛错只留一行日志、继续问下一个 —— 路由坏掉不该让消息发不出去。
 *
 * 最后的兜底是 `facts.defaultTargets`：连内置策略都没给决定时，仍然按今天的规则叫。
 */
import type { Context } from "../runtime/index.ts";
import type { Router } from "./ports.ts";
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
