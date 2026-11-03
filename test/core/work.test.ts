/**
 * 派活这一块：策略（md）→ 闸门 → 工单 → 阶段。
 *
 * 这四段都是纯函数，所以这里不碰盘、不碰运行时，直接给事实算结果。要钉住的是
 * **授权**那几条：谁能派、推出来的活什么时候算数、工单上盖的章什么时候失效 ——
 * 这几条错了，模型就有了它不该有的权限。
 */
import { describe, expect, it } from "vitest";
import { DEFAULT_POLICY, parsePolicy, policyVersion, renderPolicy } from "../../src/core/work/policy.ts";
import { gateOf, mandateHolds, triggerSeq } from "../../src/core/work/gate.ts";
import { describeStage, canRetry, stageOf } from "../../src/core/work/stage.ts";
import {
	answerTicket,
	askTicket,
	emptyWorkState,
	openTicket,
	openTicketsIn,
	recordDecision,
	reportTicket,
	retryTicket,
	stopTicket,
	ticketById,
} from "../../src/core/work/index.ts";
import { MAX_TICKETS } from "../../src/core/work/types.ts";
import type { Gate, Policy, Ticket, Trigger } from "../../src/core/work/types.ts";

const POLICY_MD = `---
mode: observe
---

# 谁能派活

## 明确 @ 我 / 私聊

- 所有人

## 不 @ 也能派

- \`owner\`

# 规矩

## 只在工作区里改

动手只改自己的工作区。

## 交付前自己验

改完要跑测试。
`;

function trigger(over: Partial<Trigger> = {}): Trigger {
	return {
		id: "dm:owner-x#4",
		channel: "dm:owner-x",
		seq: 4,
		from: "owner",
		human: true,
		addressed: "direct",
		at: 1000,
		text: "帮我看看这个",
		...over,
	};
}

function gate(over: Partial<Gate> = {}): Gate {
	return {
		outcome: "accept",
		strength: "explicit",
		rules: ["只在工作区里改"],
		policyVersion: "v1",
		reason: "点名找我。",
		...over,
	};
}

function opened(policy: Policy = parsePolicy(POLICY_MD)): Ticket {
	const result = openTicket(emptyWorkState(), {
		trigger: trigger(),
		gate: gate({ policyVersion: policy.version }),
		title: "看看这个",
		scope: "只读这个仓库",
		assignee: "cto",
		at: 1000,
	});
	if (!result.ok) throw new Error(result.reason);
	return result.ticket;
}

describe("策略：policy.md 就是判据", () => {
	it("解析模式、两份名单与规矩", () => {
		const policy = parsePolicy(POLICY_MD);
		expect(policy.mode).toBe("observe");
		expect(policy.addressed).toEqual(["*"]);
		expect(policy.inferred).toEqual(["owner"]);
		expect(policy.rules.map((rule) => rule.id)).toEqual(["只在工作区里改", "交付前自己验"]);
		expect(policy.rules[0]?.body).toBe("动手只改自己的工作区。");
	});

	it("写坏的模式退回 off，不抛", () => {
		expect(parsePolicy("---\nmode: 乱写\n---\n").mode).toBe("off");
		expect(DEFAULT_POLICY.mode).toBe("off");
	});

	it("版本跟着内容走：改一个字就变，空白不影响", () => {
		const a = policyVersion(POLICY_MD);
		expect(policyVersion(POLICY_MD.replace("\n", "\r\n"))).toBe(a);
		expect(policyVersion(POLICY_MD + "\n")).toBe(a);
		expect(policyVersion(POLICY_MD.replace("跑测试", "跑两次测试"))).not.toBe(a);
	});

	it("渲染成提示词：模式、名单、规矩都在", () => {
		const text = renderPolicy(parsePolicy(POLICY_MD));
		expect(text).toContain("只记下来");
		expect(text).toContain("owner");
		expect(text).toContain("只在工作区里改");
	});
});

describe("闸门：谁能派活", () => {
	const policy = parsePolicy(POLICY_MD);

	it("点名 / 私聊：明说，直接接", () => {
		expect(gateOf({ trigger: trigger(), policy }).outcome).toBe("accept");
		expect(gateOf({ trigger: trigger({ addressed: "mention" }), policy }).strength).toBe("explicit");
	});

	it("agent 说的话不算派活", () => {
		const gate = gateOf({ trigger: trigger({ from: "cto", human: false, addressed: "mention" }), policy });
		expect(gate.outcome).toBe("ignore");
	});

	it("没点名，在名单里：observe 只记不动手", () => {
		const gate = gateOf({ trigger: trigger({ addressed: undefined }), policy });
		expect(gate.outcome).toBe("observe");
		expect(gate.strength).toBe("inferred");
	});

	it("没点名，不在名单里：不理", () => {
		const gate = gateOf({ trigger: trigger({ addressed: undefined, from: "stranger" }), policy });
		expect(gate.outcome).toBe("ignore");
	});

	it("auto 模式下推出来的也接", () => {
		const auto = { ...policy, mode: "auto" as const };
		expect(gateOf({ trigger: trigger({ addressed: undefined }), policy: auto }).outcome).toBe("accept");
	});

	it("off 模式下推出来的不接", () => {
		const off = { ...policy, mode: "off" as const };
		expect(gateOf({ trigger: trigger({ addressed: undefined }), policy: off }).outcome).toBe("ignore");
	});

	it("既有工单的追问：明说，不要求点名", () => {
		const ticket = opened(policy);
		const gate = gateOf({ trigger: trigger({ seq: 9, addressed: undefined }), policy, open: [ticket] });
		expect(gate.outcome).toBe("accept");
		expect(gate.strength).toBe("explicit");
	});

	it("工单之前的老消息不算追问", () => {
		const ticket = opened(policy);
		const gate = gateOf({ trigger: trigger({ seq: 1, addressed: undefined }), policy: { ...policy, mode: "off" }, open: [ticket] });
		expect(gate.outcome).toBe("ignore");
	});

	it("工单里记着来源消息的序号", () => {
		expect(triggerSeq(opened(policy))).toBe(4);
	});
});

describe("工单：立、报、问、答、重试、停", () => {
	it("只有 accept 才发号", () => {
		const result = openTicket(emptyWorkState(), {
			trigger: trigger(),
			gate: gate({ outcome: "observe" }),
			title: "看看",
			scope: "只读",
			assignee: "cto",
			at: 1,
		});
		expect(result.ok).toBe(false);
	});

	it("结束的单子有回收上界，没结束的一张都不丢", () => {
		let state = emptyWorkState();
		for (let index = 0; index < MAX_TICKETS + 5; index += 1) {
			const next = openTicket(state, {
				trigger: trigger({ seq: index + 1 }),
				gate: gate({ outcome: "accept", strength: "explicit", policyVersion: "v", rules: [] }),
				title: `第 ${index}`,
				scope: "只读",
				assignee: "cto",
				at: index + 1,
			});
			if (!next.ok) throw new Error("应当立上");
			state = next.state;
			const stopped = stopTicket(state, next.ticket.id, "dropped", index + 1);
			if (!stopped.ok) throw new Error("应当停下");
			state = stopped.state;
		}
		// 最后一张故意不收：它必须留下。
		const last = openTicket(state, {
			trigger: trigger({ seq: 999 }),
			gate: gate({ outcome: "accept", strength: "explicit", policyVersion: "v", rules: [] }),
			title: "还没完",
			scope: "只读",
			assignee: "cto",
			at: 999,
		});
		if (!last.ok) throw new Error("应当立上");
		const ids = Object.keys(last.state.tickets);
		expect(ids.length).toBe(MAX_TICKETS + 1);
		expect(last.state.tickets[last.ticket.id]?.endedAt).toBeUndefined();
		expect(ids).not.toContain("T1");
	});

	it("工单号自增，授权原样盖章", () => {
		const policy = parsePolicy(POLICY_MD);
		const first = openTicket(emptyWorkState(), {
			trigger: trigger(),
			gate: gate({ policyVersion: policy.version }),
			title: "甲",
			scope: "只读",
			assignee: "cto",
			at: 1,
		});
		if (!first.ok) throw new Error("应当立上");
		const second = openTicket(first.state, {
			trigger: trigger({ seq: 5 }),
			gate: gate({ policyVersion: policy.version }),
			title: "乙",
			scope: "只读",
			assignee: "cto",
			at: 2,
		});
		if (!second.ok) throw new Error("应当立上");
		expect(first.ticket.id).toBe("T1");
		expect(second.ticket.id).toBe("T2");
		expect(first.ticket.mandate.policyVersion).toBe(policy.version);
		expect(first.ticket.mandate.requester).toBe("owner");
		expect(first.ticket.mandate.trigger).toBe("dm:owner-x#4");
	});

	it("报 ready → 等人验收；人回话之后离开验收", () => {
		const ticket = opened();
		const state = reportTicket({ ...emptyWorkState(), tickets: { T1: ticket } }, "T1", {
			outcome: "ready",
			text: "做完了",
			at: 2000,
		});
		if (!state.ok) throw new Error("应当记上");
		expect(stageOf(state.ticket)).toEqual({ stage: "person", action: "review" });
		expect(stageOf(state.ticket, { spokeAfter: true }).stage).toBe("idle");
	});

	it("问人 → 停在等人回答；答过 → 接着干", () => {
		let state = { ...emptyWorkState(), tickets: { T1: opened() } };
		const asked = askTicket(state, "T1", { question: "要不要动这个文件？", options: ["动", "不动"], at: 2000 });
		if (!asked.ok) throw new Error("应当记上");
		state = asked.state;
		expect(stageOf(asked.ticket)).toEqual({ stage: "person", action: "answer" });

		const answered = answerTicket(state, "T1", 3000);
		if (!answered.ok) throw new Error("应当答上");
		expect(stageOf(answered.ticket)).toEqual({ stage: "working" });
		expect(answered.ticket.assignment.attempts).toBe(2);
	});

	it("在干的时候不能重试；卡住之后可以", () => {
		const ticket = opened();
		expect(canRetry(ticket)).toBe(false);
		const blocked = reportTicket({ ...emptyWorkState(), tickets: { T1: ticket } }, "T1", {
			outcome: "blocked",
			text: "缺一个权限",
			at: 2000,
		});
		if (!blocked.ok) throw new Error("应当记上");
		expect(canRetry(blocked.ticket)).toBe(true);
		expect(stageOf(blocked.ticket)).toEqual({ stage: "person", action: "blocked" });
	});

	it("重试加一次次数，汇报历史留着", () => {
		let state = { ...emptyWorkState(), tickets: { T1: opened() } };
		const failed = reportTicket(state, "T1", { outcome: "failed", text: "跑砸了", at: 2000 });
		if (!failed.ok) throw new Error("应当记上");
		state = failed.state;
		const retried = retryTicket(state, "T1", 3000);
		if (!retried.ok) throw new Error("应当重试上");
		expect(retried.ticket.assignment.attempts).toBe(2);
		expect(retried.ticket.reports).toHaveLength(1);
		expect(stageOf(retried.ticket)).toEqual({ stage: "working", action: "queued" });
	});

	it("收工之后不能再改", () => {
		const state = { ...emptyWorkState(), tickets: { T1: opened() } };
		const stopped = stopTicket(state, "T1", "completed", 2000);
		if (!stopped.ok) throw new Error("应当停上");
		expect(stageOf(stopped.ticket)).toEqual({ stage: "ended", why: "completed" });
		expect(reportTicket(stopped.state, "T1", { outcome: "progress", text: "还在", at: 3 }).ok).toBe(false);
		expect(ticketById(stopped.state, "T9")).toBeUndefined();
	});

	it("留痕最多 200 条", () => {
		let state = emptyWorkState();
		for (let index = 0; index < 250; index += 1) {
			state = recordDecision(state, {
				trigger: `c#${String(index)}`,
				channel: "c",
				outcome: "ignore",
				rules: [],
				reason: "不关我事",
				at: index,
			});
		}
		expect(state.decisions).toHaveLength(200);
		expect(state.decisions[0]?.trigger).toBe("c#50");
	});

	it("频道里只列没结束的活", () => {
		const ticket = opened();
		const done = stopTicket({ ...emptyWorkState(), tickets: { T1: ticket } }, "T1", "completed", 2);
		if (!done.ok) throw new Error("应当停上");
		expect(openTicketsIn(done.state, "dm:owner-x")).toHaveLength(0);
		expect(openTicketsIn({ ...emptyWorkState(), tickets: { T1: ticket } }, "dm:owner-x")).toHaveLength(1);
	});
});

describe("授权会失效", () => {
	const policy = parsePolicy(POLICY_MD);

	it("规矩还在、版本没变：站得住", () => {
		expect(mandateHolds(opened(policy), policy)).toEqual({ ok: true });
	});

	it("规矩被删了：停", () => {
		const holds = mandateHolds(opened(policy), { ...policy, rules: [], version: policy.version });
		expect(holds.ok).toBe(false);
	});

	it("策略改过：停（要重新请示）", () => {
		const holds = mandateHolds(opened(policy), { ...policy, version: "另一个版本" });
		expect(holds.ok).toBe(false);
	});
});

describe("阶段话有人话版本", () => {
	it("每个阶段都说得出来", () => {
		expect(describeStage(opened())).toBe("在干");
		const asked = askTicket({ ...emptyWorkState(), tickets: { T1: opened() } }, "T1", {
			question: "问一下",
			options: [],
			at: 2,
		});
		if (!asked.ok) throw new Error("应当记上");
		expect(describeStage(asked.ticket)).toBe("在等人回答");
	});
});
