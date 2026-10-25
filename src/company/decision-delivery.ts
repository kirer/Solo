/**
 * 拍板结果的投递：答复一旦落进待决文档，**必须**让提问方看得见。
 *
 * 为什么单独一个模块：`escalation.ts` 与 `disposition.ts` 都要调用它，
 * 而 `escalation → disposition` 已经是动态导入破环的关系，再让两边静态互导
 * 会形成真正的运行时环。这里只依赖运行时与文档定义，谁都能安全导入。
 *
 * 这里解决的是一个真实故障（用户报的「回复完没反应，还得再在聊天里发一遍」）：
 * 原先 `answerPending` / `settleDisposition` 只把答案写进 `PendingDoc` 与
 * `AuditDoc`——两者都不进会话流，界面上什么都看不到；而升级任务醒来后也只写
 * 审计与 trail，**没有任何东西通知提问方**。于是「拍板」在协议上是成立的，
 * 在体验上完全断链：拍板的人以为没生效，被拍板的人永远等不到。
 *
 * 两步缺一不可：
 * 1. 往提问方会话流写一条 `app.decision` 条目 —— 界面立刻看得到「谁拍了什么」；
 * 2. 往提问方会话投一条 input —— **唤醒**它，让它拿着这个决定继续干活
 *    （不唤醒的话，员工只会看到一条通知，然后继续等）。
 */
import { BACKGROUND_CONTEXT, type Context, type CompanyRuntime } from "../runtime/index.ts";
import { CompanyDoc, type CompanyState } from "./docs.ts";

/** 一条已完成的拍板。 */
export type DecisionDelivery = {
	/** 待决项编号（`esc:1277:2` / `disp:...`）。 */
	readonly key: string;
	/** 问题正文（会截断，只用于界面上让人认出是哪一件）。 */
	readonly question: string;
	/** 决定内容。 */
	readonly answer: string;
	/** 拍板人（显示名或权限位）。 */
	readonly answeredBy: string;
	/** 提问方会话（决定投递到这里）。 */
	readonly askerConversationId: number;
	/** 提问方的显示名（喂给 `to` 字段）。 */
	readonly askerLabel: string;
	/** 是不是处置类（暂搁 / 放弃），界面上措辞不同。 */
	readonly disposition?: boolean;
};

/** 层级 / 显示名的可读文案：owner 说「老板」，其余原样。 */
function labelOf(answeredBy: string): string {
	return answeredBy === "owner" ? "老板" : answeredBy;
}

/**
 * 把决定投递给提问方：先落一条会话条目，再唤醒它。
 *
 * 两步都**尽力而为**：投递失败不能让已经成立的决定回滚（决定已经写进待决文档，
 * 那是唯一真相源）。但失败会写 stderr——静默失败正是这次要消灭的东西。
 */
export async function deliverDecision(
	runtime: CompanyRuntime,
	decision: DecisionDelivery,
	context: Context = BACKGROUND_CONTEXT,
): Promise<void> {
	const decider = labelOf(decision.answeredBy);
	const kindLabel = decision.disposition === true ? "处置已定" : "拍板结果";

	// 一次投递同时完成两件事：落一条 `app.decision` 条目（界面看得见）+ 唤醒提问方
	// （让它拿着决定继续）。
	//
	// 只能用 submit 一次完成，不能「先 appendEntry 再 submit」：`submit` 的 `entry`
	// 参数本身就会落成一条条目，前者会凭空多出一条重复记录（实测确实重复了 2 条）。
	//
	// 投递内容刻意写成**一句话的事实陈述**而非命令：拍板可能是「暂搁」，
	// 也可能是「换方案」，具体怎么做是它自己的判断。附上 key 让它能复查。
	try {
		const conversation = await runtime.harness.conversation(
			decision.askerConversationId as never,
			context,
		);
		if (conversation === undefined) return;
		const body = [
			`【${kindLabel}】${decider} 对「${summarize(decision.question)}」的答复：`,
			decision.answer,
			`（编号 ${decision.key}，已记录在案，无需再确认）`,
		].join("\n");
		await conversation.submit(
			{
				type: "input",
				content: body,
				requestId: `decision:${decision.key}`,
				// 标记来源：这条不是老板发的，也不是派活，界面上不该显示成「老板的消息」。
				entry: {
					kind: "app.decision",
					data: {
						from: decider,
						to: decision.askerLabel,
						text: decision.answer.slice(0, 1200),
						question: decision.question.slice(0, 400),
						ref: decision.key,
						label: kindLabel,
						at: Date.now(),
					},
				},
				whenBusy: "steer",
			},
			context,
		);
	} catch (error) {
		process.stderr.write(
			`[拍板投递失败·唤醒] ${decision.key}: ${error instanceof Error ? error.message : String(error)}\n`,
		);
	}
}

/** 问题压成一行，用于「对『…』的答复」这种引用。 */
function summarize(question: string): string {
	const flat = question.replace(/\s+/g, " ").trim();
	return flat.length <= 60 ? flat : `${flat.slice(0, 60)}…`;
}

/**
 * 会话主人的显示名（投递条目的 `to` 字段用）。
 *
 * 解析不到就返回空串——`refOfLabel` 会把它降级成系统，不影响投递本身。
 */
export function labelOfConversation(
	state: CompanyState | undefined,
	conversationId: number,
): string {
	if (state === undefined) return "";
	for (const [role, id] of Object.entries(state.roles ?? {})) {
		if (Number(id) !== conversationId) continue;
		return role === "ceo" ? "CEO" : role.toUpperCase();
	}
	for (const project of Object.values(state.projects ?? {})) {
		if (project.leader === conversationId) return project.leaderName ?? project.name;
	}
	for (const person of Object.values(state.staff ?? {})) {
		if (person.conversationId === conversationId) return person.name;
	}
	return "";
}

/** 读一次公司结构，供调用方取标签（避免每个调用点各写一遍 snapshot）。 */
export async function readCompanyState(
	runtime: CompanyRuntime,
	context: Context = BACKGROUND_CONTEXT,
): Promise<CompanyState | undefined> {
	return runtime.harness.snapshot(CompanyDoc, context);
}
