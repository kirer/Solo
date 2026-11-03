/**
 * 接活的入口：**一条消息叫醒几个人，代码就替他们立几张工单**。
 *
 * 为什么这一步不交给模型：实测（2026-11-02，deepseek-v4.1-flash）它在提示词里
 * 读到了「先立工单」，照样直接开工 —— 十几次唤醒，一次 `work(open)` 都没有。
 * 提示词里再写多少遍都是同一个结果。而「一条消息叫醒了谁、是谁派的」本来就是
 * 确定的事实，不需要判断：判断（这事值不值得接）已经在闸门里，闸门是纯函数。
 *
 * 于是分工变成：**代码立单、模型推进**。模型拿到工单号之后会真的用它（实测：
 * 正文里写着「这一轮属于 T1」，它就去 `report` 了）—— 它缺的不是意愿，是「有单子」这件事。
 *
 * 收尾那一半在 `channel/turn/finish.ts`：一轮结束还一个汇报都没有的单子自动收工，
 * 免得每句「在吗」都留一张永远开着的工单。
 */
import { BACKGROUND_CONTEXT, type Context, type Harness } from "../runtime/index.ts";
import { OWNER, type Channel, type Message } from "../channel/types.ts";
import { readPolicy } from "./policy.ts";
import { gateOf } from "./gate.ts";
import { WorkDoc, openTicket, openTicketsIn, stopTicket } from "./ticket.ts";
import { emptyWorkState, triggerOf, type Ticket, type WorkState } from "./types.ts";

export type IntakeDeps = {
	readonly harness: Harness;
	/** `<userRoot>/policy.md`：谁能派活由它说了算。 */
	readonly policyFile: string;
};

/**
 * 这条消息给 `to` 的那张工单：同一件事的追问沿用旧的，不另开。
 *
 * 「同一件事」= 同一频道、同一派活人、同一执行人、这条没点名。点了名就是另起的活。
 */
function followUpIn(state: WorkState, channel: string, from: string, to: string, addressed: boolean): Ticket | undefined {
	if (addressed) return undefined;
	const open = openTicketsIn(state, channel).filter((ticket) => ticket.assignee === to && ticket.mandate.requester === from);
	return open[open.length - 1];
}

/**
 * 这次唤醒该不该有工单 —— 一次算清这条消息的**所有**收件人，一次落盘。
 *
 * 只有人能派活（agent 之间互相派活不算，和闸门同一判据）；闸门不接受就没有单子。
 * 返回 slug → 工单；不在里面的那几个就是「这轮不算活」。
 */
export async function intakeAll(
	deps: IntakeDeps,
	channel: Channel,
	message: Message,
	targets: readonly string[],
	context: Context = BACKGROUND_CONTEXT,
): Promise<ReadonlyMap<string, Ticket>> {
	const opened = new Map<string, Ticket>();
	if (message.from !== OWNER) return opened;
	const people = targets.filter((slug) => slug !== OWNER);
	if (people.length === 0) return opened;
	const policy = await readPolicy(deps.policyFile);
	const before = (await deps.harness.snapshot(WorkDoc, context)) ?? emptyWorkState();
	let state = before;
	for (const to of people) {
		const trigger = triggerOf(channel, message, to);
		const reuse = followUpIn(state, channel.id, message.from, to, trigger.addressed !== undefined);
		if (reuse !== undefined) {
			opened.set(to, reuse);
			continue;
		}
		const gate = gateOf({ trigger, policy, open: openTicketsIn(state, channel.id) });
		if (gate.outcome !== "accept") continue;
		const result = openTicket(state, {
			trigger,
			gate,
			title: titleOf(message.text),
			scope: "这条消息说的那件事",
			assignee: to,
			at: message.at,
		});
		if (!result.ok) continue;
		state = result.state;
		opened.set(to, result.ticket);
	}
	if (state !== before) {
		await deps.harness.commit(async (tx) => {
			const doc = await tx.doc<WorkState>(WorkDoc);
			doc.tickets = state.tickets;
			doc.nextTicket = state.nextTicket;
			doc.decisions = state.decisions;
		}, context);
	}
	return opened;
}

/** 标题给人看，别把开头的 `@谁` 抄进去 —— 那是称呼，不是这件事。 */
function titleOf(text: string): string {
	return text.replace(/^(?:\s*@\S+)+\s*/, "").replace(/\s+/g, " ").trim().slice(0, 40) || "一件活";
}

/**
 * 一轮收尾：**这个频道里、到这一条为止、一个汇报都没有的工单，自动收工**。
 *
 * 否则每句「在吗」都会留下一张永远「在干」的单子，`list` 一天就废了。
 * 汇报过的（progress / ready / blocked）说明模型把它当活干了，留着。
 *
 * 按序号往后扫，不是只认叫醒它的那一条：连着发几条时早的那几条被合并唤醒撤掉了，
 * 它们对应的单子不会有自己的收尾 —— 只认一条就会留下永远开着的幽灵。
 */
export async function closeUntouched(
	deps: IntakeDeps,
	input: { slug: string; channelId: string; seq: number },
	context: Context = BACKGROUND_CONTEXT,
): Promise<void> {
	const prefix = `${input.channelId}#`;
	const state = (await deps.harness.snapshot(WorkDoc, context)) ?? emptyWorkState();
	let next = state;
	for (const ticket of openTicketsIn(state, input.channelId)) {
		if (ticket.assignee !== input.slug || ticket.reports.length > 0) continue;
		const seq = Number(ticket.mandate.trigger.slice(prefix.length));
		if (!Number.isFinite(seq) || seq > input.seq) continue;
		const stopped = stopTicket(next, ticket.id, "dropped", Date.now());
		if (stopped.ok) next = stopped.state;
	}
	if (next === state) return;
	await deps.harness.commit(async (tx) => {
		const doc = await tx.doc<WorkState>(WorkDoc);
		doc.tickets = next.tickets;
	}, context);
}
