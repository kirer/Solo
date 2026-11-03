/**
 * 闸门：**一条消息算不算让我干活**。确定性的那半边。
 *
 * dsh 的 Eval 是「确定的 Gate + 模型的 Assessment」。这里把两半分清了：
 *
 * - **Gate（本文件，纯函数）**：谁说、算不算点名、策略允不允许、是不是既有工单的追问。
 *   这部分不许模型参与 —— 授权是人给的，模型自己说「我觉得可以」不算数。
 * - **Assessment（模型）**：这条活值不值得接、拆成什么。它只能**在闸门放行之后**
 *   才能立工单（`work(action=open)` 会再走一遍闸门）。
 *
 * 这也解释了为什么 `work` 工具拒绝创建工单时模型不能自己绕过：闸门在工具里，
 * 不在提示词里。
 */
import { allows } from "./policy.ts";
import type { Gate, Policy, Strength, Ticket, Trigger } from "./types.ts";

export type GateInput = {
	readonly trigger: Trigger;
	readonly policy: Policy;
	/** 这个频道里还没结束的工单（判「是不是同一个人的追问」）。 */
	readonly open?: readonly Ticket[];
};

/**
 * 判一条触发。
 *
 * 顺序有讲究：**点名 > 追问 > 名单**。一个没在被叫醒的人名里的人 @ 了我，
 * 依然该接（点名本身就是授权）；反过来，一份把自己加进 `inferred` 的 agent 不会
 * 因为名单而多出授权 —— `human` 那一条先挡在前面。
 */
export function gateOf({ trigger, policy, open = [] }: GateInput): Gate {
	if (!trigger.human) {
		return { outcome: "ignore", strength: undefined, rules: [], policyVersion: policy.version, reason: "不是人派的话，不算派活。" };
	}

	const rules = policy.rules.map((rule) => rule.id);

	if (trigger.addressed !== undefined) {
		if (!allows(policy.addressed, trigger.from)) {
			return { outcome: "ignore", strength: undefined, rules: [], policyVersion: policy.version, reason: "这个人不在「明着派活」的名单里。" };
		}
		return { outcome: "accept", strength: "explicit", rules, policyVersion: policy.version, reason: "点名找我。" };
	}

	const following = open.find((ticket) => ticket.channel === trigger.channel && ticket.mandate.requester === trigger.from);
	if (following !== undefined && trigger.seq > triggerSeq(following)) {
		return { outcome: "accept", strength: "explicit", rules, policyVersion: policy.version, reason: `接着 ${following.id} 说的事。` };
	}

	if (!allows(policy.inferred, trigger.from)) {
		return { outcome: "ignore", strength: undefined, rules: [], policyVersion: policy.version, reason: "没点名，也不在「不 @ 也能派」的名单里。" };
	}
	const strength: Strength = "inferred";
	if (policy.mode === "auto") {
		return { outcome: "accept", strength, rules, policyVersion: policy.version, reason: "在名单里，模式 auto。" };
	}
	if (policy.mode === "observe") {
		return { outcome: "observe", strength, rules, policyVersion: policy.version, reason: "在名单里，模式 observe：只记下来。" };
	}
	return { outcome: "ignore", strength, rules: [], policyVersion: policy.version, reason: "在名单里，模式 off：不动手。" };
}

/** 工单是从第几条消息来的。旧工单上记的是 `频道#seq`。 */
export function triggerSeq(ticket: Ticket): number {
	const parts = ticket.mandate.trigger.split("#");
	return Number(parts[parts.length - 1] ?? 0) || 0;
}

/**
 * 重校验：**接着做之前的活之前，先确认授权还站得住。**
 *
 * 规矩会被我删掉、改名字。工单上记的是「按 `改代码先跑测试` 这条授权」，那条规矩没了，
 * 这张工单就没有依据了 —— 不能悄悄地继续做，要让模型停下来重新请示。
 */
export function mandateHolds(ticket: Ticket, policy: Policy): { ok: true } | { ok: false; reason: string } {
	const alive = new Set(policy.rules.map((rule) => rule.id));
	const gone = ticket.mandate.rules.filter((id) => !alive.has(id));
	if (gone.length > 0) {
		return { ok: false, reason: `授权里的规矩已经不在了：${gone.join("、")}。重新请示再动。` };
	}
	if (ticket.mandate.policyVersion !== policy.version) {
		return { ok: false, reason: "派活的策略变了。重新请示再动。" };
	}
	return { ok: true };
}
