/**
 * `forward`：把一条**已经落在频道里**的消息再交给几个人看（助理的后台分发）。
 *
 * 它不写第二条消息 —— 频道里没有「助理把这条转给了谁」这种可见的痕；收件人看到的
 * 仍是原文，只是多一句是谁转的（`routedBy`）。交给谁由助理决定，core 只做校验：
 * 必须是这个房间的人、不能是我、不能是发件人自己、已经被 @ 的人不重复叫。
 */
import type { Context } from "../runtime/index.ts";
import type { FlowPorts } from "./ports.ts";
import type { DeliverResult, RouteExistingInput } from "./types.ts";
import { validatePlan } from "./validate.ts";

export function createForward(ports: FlowPorts): (input: RouteExistingInput, ctx: Context) => Promise<DeliverResult> {
	return async (input, ctx) => {
		const snapshot = await ports.store.read(input.channelId, ctx);
		if (snapshot === undefined) throw new Error(`频道不存在：${input.channelId}`);
		const message = (snapshot.state.messages[input.channelId] ?? []).find(
			(item) => item.seq === input.seq,
		);
		if (message === undefined) throw new Error(`消息不存在：${input.channelId}#${String(input.seq)}`);

		// 已经被 @ 的人不重复叫：投递时他们本来就会收到这条，再转一次就是两句。
		const already = new Set(message.mentions);
		const plan = validatePlan(
			{ targets: input.targets.filter((slug) => !already.has(slug)), reason: "route" },
			snapshot.channel,
			message,
		);
		if (plan.targets.length === 0) return { delivered: [], failed: [], skipped: [] };

		return ports.runner.fanOut({
			state: snapshot.state,
			channel: snapshot.channel,
			message,
			plan,
			...(input.routedBy === undefined ? {} : { routedBy: input.routedBy }),
			ctx,
		});
	};
}
