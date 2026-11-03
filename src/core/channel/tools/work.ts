/**
 * `work`：**接活、报进度、问人、重试、收工**。
 *
 * 它对应 dsh 里的整套「授权执行」：闸门判这条消息算不算活（`core/work/gate.ts`），
 * 接受了才立工单（`core/work/ticket.ts`），干活的过程用一次一次汇报推进。
 *
 * 为什么要多一个工具，而不是继续用 `say` 说话：
 *
 * - **话说完就散了，活得留下来。** 一张工单要记住「谁派的、按什么授权、做到哪一步」；
 *   这些不是聊天记录能承担的。
 * - **只有闸门能发号。** `open` 会重新走一遍闸门 —— 模型在提示词里说自己「可以」
 *   不算数，策略在 md 里才算数。
 * - **阶段要有唯一答案。** 「下一步该干什么」由 `stageOf` 一张表算出来，界面、
 *   工具返回、模型自述用的是同一份。
 *
 * 六个动作对应 dsh 的六个概念：`open` = Eval 的接受 / `report` = Report /
 * `ask` = Attention / `retry` = 重新派工 / `stop` = 收工 / `list` = 看一眼手上有什么。
 */
import { BACKGROUND_CONTEXT, Type, defineTool } from "../../runtime/index.ts";
import { wakeOf } from "../../agent/roster.ts";
import { OWNER } from "../types.ts";
import { postMessage } from "../post.ts";
import { mentionRoster, postDeps, readState, selfOrError, text, type CoreToolDeps } from "./context.ts";
import { fill } from "../../md/catalog.ts";
import type { Slots } from "../../md/text.ts";
import { readPolicy } from "../../work/policy.ts";
import { gateOf, mandateHolds } from "../../work/gate.ts";
import { describeStage } from "../../work/stage.ts";
import {
	WorkDoc,
	answerTicket,
	askTicket,
	openTicket,
	openTicketsIn,
	recordDecision,
	reportTicket,
	retryTicket,
	stopTicket,
	ticketById,
	ticketsOf,
} from "../../work/ticket.ts";
import { emptyWorkState, triggerOf, type Gate, type ReportOutcome, type Ticket, type WorkState } from "../../work/types.ts";

const OUTCOMES: readonly ReportOutcome[] = ["progress", "waiting", "ready", "blocked", "failed", "dropped"];
const ACTIONS = ["open", "report", "ask", "answer", "retry", "stop", "list"] as const;

export function createWorkTool(deps: CoreToolDeps) {
	const t = (key: string, slots: Slots = {}): string => fill(deps.text, key, slots);

	const load = async (): Promise<WorkState> =>
		(await deps.harness.snapshot(WorkDoc, BACKGROUND_CONTEXT)) ?? emptyWorkState();

	const save = async (state: WorkState): Promise<void> => {
		await deps.harness.commit(async (tx) => {
			const doc = await tx.doc<WorkState>(WorkDoc);
			// 整字段替换：工单与判断留痕都有上限（≤200），不像频道消息那样一条一条 append 才扛得住。
			doc.tickets = state.tickets;
			doc.decisions = state.decisions;
			doc.nextTicket = state.nextTicket;
		}, BACKGROUND_CONTEXT);
	};

	/** 一句话说清一张工单长什么样。工具返回、`list`、问人的消息都用这一份。 */
	const line = (ticket: Ticket): string =>
		t("work.line", {
			id: ticket.id,
			title: ticket.title,
			stage: describeStage(ticket),
			strength: ticket.mandate.strength === "explicit" ? t("work.strength.explicit") : t("work.strength.inferred"),
		});

	const refuse = (reason: "unknown" | "ended" | "taken" | "not-accepted", id?: string): string =>
		t(`work.refuse.${reason}`, { id: id ?? "" });

	const badAction = (): string => t("work.refuse.bad-action", { allowed: ACTIONS.join(" / ") });

	/** 闸门的判断落成一条留痕。接与不接只差一个 `ticket`。 */
	const noteGate = (state: WorkState, channelId: string, gate: Gate, triggerId: string, at: number, ticket?: string): WorkState =>
		recordDecision(state, {
			trigger: triggerId,
			channel: channelId,
			outcome: gate.outcome,
			...(gate.strength === undefined ? {} : { strength: gate.strength }),
			reason: gate.reason,
			...(ticket === undefined ? {} : { ticket }),
			at,
		});

	return defineTool({
		name: "work",
		description: t("work.description"),
		parameters: Type.Object({
			action: Type.String({ description: t("work.param.action") }),
			ticket: Type.Optional(Type.String({ description: t("work.param.ticket") })),
			title: Type.Optional(Type.String({ description: t("work.param.title") })),
			scope: Type.Optional(Type.String({ description: t("work.param.scope") })),
			trigger: Type.Optional(Type.String({ description: t("work.param.trigger") })),
			outcome: Type.Optional(Type.String({ description: t("work.param.outcome") })),
			text: Type.Optional(Type.String({ description: t("work.param.text") })),
			question: Type.Optional(Type.String({ description: t("work.param.question") })),
			options: Type.Optional(Type.Array(Type.String(), { description: t("work.param.options") })),
		}),
		execute: async (args, api, context) => {
			const ctx = context ?? BACKGROUND_CONTEXT;
			const slug = await selfOrError(deps, Number(api.conversationId), ctx);
			if (typeof slug !== "string") return text(slug);

			const action = (args.action ?? "").trim();
			// 先认动作，再谈工单号：写错动作时回「工单号没给」等于答非所问。
			if (!(ACTIONS as readonly string[]).includes(action)) return text(badAction());
			const state = await load();
			const now = Date.now();

			if (action === "open") {
				const policy = await readPolicy(deps.layout.policyFile);
				const channels = await readState(deps);
				const directory = await deps.directory(ctx);
				const wake = wakeOf(directory, Number(api.conversationId));
				if (wake === undefined) return text(t("work.refuse.no-wake"));

				// `trigger` 可以显式给（`频道#seq`），缺省就是叫醒我的那条消息。
				const wanted = args.trigger?.trim();
				const parts = wanted === undefined ? [] : wanted.split("#");
				const channelId = parts.length > 1 ? parts.slice(0, -1).join("#") : wake.reply.channelId;
				const seq = parts.length > 1 ? Number(parts[parts.length - 1]) : wanted !== undefined ? Number(wanted) : wake.reply.seq;
				const channel = channels.channels[channelId];
				if (channel === undefined || !channel.members.includes(slug)) return text(t("work.refuse.no-channel"));
				const message = (channels.messages[channelId] ?? []).find((item) => item.seq === seq);
				if (message === undefined) return text(t("work.refuse.no-message", { seq: String(seq) }));

				const trigger = triggerOf(channel, message, slug);
				const open = openTicketsIn(state, channelId);
				const gate = gateOf({ trigger, policy, open });
				const title = (args.title ?? "").trim() || t("work.open.default-title", { text: trigger.text.slice(0, 40) });

				if (gate.outcome !== "accept") {
					await save(noteGate(state, channelId, gate, trigger.id, now));
					return text(t("work.open.refused", { reason: gate.reason }));
				}

				const result = openTicket(state, {
					trigger,
					gate,
					title,
					scope: (args.scope ?? "").trim() || t("work.open.default-scope"),
					assignee: slug,
					at: now,
				});
				if (!result.ok) return text(refuse(result.reason));
				await save(noteGate(result.state, channelId, gate, trigger.id, now, result.ticket.id));
				return text(
					t("work.open.done", {
						id: result.ticket.id,
						title: result.ticket.title,
						scope: result.ticket.mandate.scope,
						strength: gate.strength === "explicit" ? t("work.strength.explicit") : t("work.strength.inferred"),
					}),
				);
			}

			if (action === "list") {
				const mine = ticketsOf(state, slug).filter((ticket) => ticket.endedAt === undefined);
				if (mine.length === 0) return text(t("work.list.empty"));
				return text(mine.map(line).join("\n"));
			}

			// 以下动作都要工单号。
			const id = (args.ticket ?? "").trim().toUpperCase();
			if (id === "") return text(t("work.refuse.no-id"));
			const ticket = ticketById(state, id);
			if (ticket === undefined) return text(refuse("unknown", id));

			if (action === "report") {
				const outcome = (args.outcome ?? "").trim() as ReportOutcome;
				if (!OUTCOMES.includes(outcome)) return text(t("work.refuse.bad-outcome", { allowed: OUTCOMES.join(" / ") }));
				const body = (args.text ?? "").trim();
				if (body === "") return text(t("work.refuse.no-text"));
				const result = reportTicket(state, id, { outcome, text: body, at: now });
				if (!result.ok) return text(refuse(result.reason, id));
				await save(result.state);
				return text(t("work.report.done", { id, stage: describeStage(result.ticket) }));
			}

			if (action === "ask") {
				const question = (args.question ?? args.text ?? "").trim();
				if (question === "") return text(t("work.refuse.no-question"));
				const options = (args.options ?? []).map((item) => item.trim()).filter((item) => item !== "");
				if (options.length === 1 || options.length > 6 || new Set(options).size !== options.length) {
					return text(t("work.refuse.bad-options"));
				}
				const result = askTicket(state, id, { question, options, at: now });
				if (!result.ok) return text(refuse(result.reason, id));
				await save(result.state);

				// 问题要落成一条消息才能真的叫醒人。用 `choice`（有选项）或 `question`：
				// 界面按这条画选项卡，回答就是一条普通消息 + `replyTo`（ADR-035，不开新路由）。
				const channels = await readState(deps);
				const channel = channels.channels[ticket.channel];
				if (channel === undefined) return text(t("work.refuse.no-channel"));
				const roster = await mentionRoster(deps);
				const posted = await postMessage(
					postDeps(deps, channels, ctx),
					{
						channelId: ticket.channel,
						from: slug,
						text: `@${OWNER} ${question}`,
						at: now,
						kind: options.length >= 2 ? "choice" : "question",
						...(options.length >= 2 ? { options } : {}),
						mention: [OWNER],
						roster,
					},
					ctx,
				);
				if (deps.afterPost !== undefined) await deps.afterPost(posted.message, ticket.channel, ctx);
				return text(t("work.ask.done", { id, seq: String(posted.message.seq) }));
			}

			if (action === "retry") {
				// 重新开工前，先确认当初的授权还站得住（规矩被删、策略改过 → 重新请示）。
				const policy = await readPolicy(deps.layout.policyFile);
				const holds = mandateHolds(ticket, policy);
				if (!holds.ok) return text(t("work.retry.refused", { reason: holds.reason }));
				const result = retryTicket(state, id, now);
				if (!result.ok) return text(refuse(result.reason, id));
				await save(result.state);
				return text(t("work.retry.done", { id, attempts: String(result.ticket.assignment.attempts) }));
			}

			if (action === "answer") {
				const result = answerTicket(state, id, now);
				if (!result.ok) return text(refuse(result.reason, id));
				await save(result.state);
				return text(t("work.answer.done", { id }));
			}

			if (action === "stop") {
				const result = stopTicket(state, id, "human", now);
				if (!result.ok) return text(refuse(result.reason, id));
				await save(result.state);
				return text(t("work.stop.done", { id }));
			}

			return text(t("work.refuse.bad-action", { allowed: "open / report / ask / answer / retry / stop / list" }));
		},
	});
}
