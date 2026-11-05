/**
 * 最后一道校验：任何策略只能**提议**，落盘与入队由 core 决定。
 *
 * 过滤四类：
 * - 不在这个频道里的人（防止策略把消息投到别人房间）；
 * - 我（`owner` 没有会话，是「人」，不是 agent）；
 * - 发件人自己（不自己叫醒自己）；
 * - 重复的目标（同一条消息只投一次）。
 *
 * 这一步不写日志：被过滤掉的目标是策略的越界提议，不是投递失败。
 */
import { OWNER, type Channel, type Message } from "../channel/types.ts";
import type { RecipientPlan } from "./types.ts";

export function validatePlan(plan: RecipientPlan, channel: Channel, message: Pick<Message, "from">): RecipientPlan {
	const members = new Set(channel.members);
	const targets = [...new Set(plan.targets)].filter(
		(slug) => slug !== OWNER && slug !== message.from && members.has(slug),
	);
	return { targets, reason: plan.reason };
}
