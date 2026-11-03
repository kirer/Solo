/**
 * 一张工单现在在哪个阶段 —— **一个纯函数，只从工单自己的状态算**。
 *
 * 这张表是从 dsh 的 `ticketStage` 一比一搬过来的（`ended → delivery → answer →
 * review → blocked/failed → queued → idle → working`），只去掉我们还没有的
 * `delivery`（交付提醒由 `say` 自己完成，不另记状态）。
 *
 * 为什么值得单独立一个文件：阶段只有一张表，界面上、工具返回里、让它自己判断
 * 「下一步该干什么」用的都是这一份。散在三个地方，就会出现「界面说在等人、
 * 它自己觉得还在干」。
 */
import type { ReportOutcome, Ticket } from "./types.ts";

export type Stage =
	/** 结束了。`why` 说清是怎么结束的。 */
	| { stage: "ended"; why: NonNullable<Ticket["endedBy"]> }
	/** 在等人：回答一个问题 / 验收一份结果 / 处理一次卡住。 */
	| { stage: "person"; action: "answer" | "review" | "blocked" | "failed" }
	/** 在干：排着队，或者正在干。 */
	| { stage: "working"; action: "queued" }
	| { stage: "working" }
	/** 空闲：汇报了在等、或者这一轮已经结束了，但活没完。 */
	| { stage: "idle" };

export type StageInput = {
	/**
	 * 最后一次汇报之后，派活的人有没有再说话。
	 *
	 * `review`（成果等人验收）只在「人还没回话」时成立 —— 他回了一句「好的」，
	 * 这张工单就不该继续挂在「等人」上。这个事实在频道消息里，不在工单里，所以由
	 * 调用方算出来传进来。缺省 = 没回过。
	 */
	readonly spokeAfter?: boolean;
};

export function stageOf(ticket: Ticket, input: StageInput = {}): Stage {
	if (ticket.endedAt !== undefined) {
		return { stage: "ended", why: ticket.endedBy ?? "completed" };
	}
	if (ticket.attention !== undefined) return { stage: "person", action: "answer" };

	// 只认**这一次**执行之后写的汇报：重试 / 答过问题会开一次新的执行（`assignment.at` 前移），
	// 上一次留下的「卡住」「在等」就不再代表现在。
	const latest = latestReport(ticket);
	const report = latest !== undefined && latest.at >= ticket.assignment.at ? latest : undefined;
	const outcome: ReportOutcome | undefined = report?.outcome;
	if (outcome === "ready" && input.spokeAfter !== true) return { stage: "person", action: "review" };
	if ((outcome === "blocked" || outcome === "failed") && ticket.assignment.state !== "running") {
		return { stage: "person", action: outcome };
	}
	if (ticket.assignment.state === "pending") return { stage: "working", action: "queued" };
	if (outcome === "waiting" || ticket.assignment.state === "ended") return { stage: "idle" };
	return { stage: "working" };
}

/** 最后一次汇报。没有汇报 = 还没开张。 */
function latestReport(ticket: Ticket): Ticket["reports"][number] | undefined {
	return ticket.reports[ticket.reports.length - 1];
}

/** 能不能重试：没结束，而且停在「等人」或空闲上。正在干的时候不能重试（会跑两份）。 */
export function canRetry(ticket: Ticket, input: StageInput = {}): boolean {
	const stage = stageOf(ticket, input);
	if (stage.stage === "ended") return false;
	if (stage.stage === "working" && !("action" in stage)) return false;
	return true;
}

/** 一段给模型读的阶段话。 */
export function describeStage(ticket: Ticket, input: StageInput = {}): string {
	const stage = stageOf(ticket, input);
	switch (stage.stage) {
		case "ended":
			return `已结束（${stage.why}）`;
		case "person":
			return stage.action === "answer"
				? "在等人回答"
				: stage.action === "review"
					? "等人验收"
					: stage.action === "blocked"
						? "卡住了，等人处理"
						: "失败了，等人处理";
		case "working":
			return "action" in stage ? "排着队（还没开始）" : "在干";
		case "idle":
			return "空闲（活没完，没人在等）";
	}
}
