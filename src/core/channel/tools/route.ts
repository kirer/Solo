/**
 * `route`：助理把频道里的一条消息**在后台**交给该看的人。
 *
 * 团队频道的唤醒表只有助理（`wakeOnAll = assistants`）：每条新消息先到助理，
 * 它判断跟谁有关，再用这个工具把原消息转给那个人。频道里不出现「转交」这条消息 ——
 * 所以它是 `noteOf: "route"` 的隐藏留痕，界面只画收件人之后的回复（ADR-063）。
 *
 * 只有助理能用：转交给谁看是统筹，不是每个人都能替别人决定要读什么。
 */
import { BACKGROUND_CONTEXT, Type, defineTool, type Context } from "../../runtime/index.ts";
import { assistantsOf, readAllIdentities } from "../../documents/member/identity.ts";
import { wakeOf } from "../roster.ts";
import { OWNER } from "../types.ts";
import { appendToChannel, commitTaskNote, type TaskNotePlan } from "../write.ts";
import { tasksOf, type Task } from "../types.ts";
import { resolveMention } from "../mentions.ts";
import { defaultChannel } from "./channel-choice.ts";
import { mentionRoster, readState, selfOrError, text, type CoreToolDeps } from "./context.ts";
import { fill } from "../../documents/base/catalog.ts";

/** 转交那句 + 板上那句：两句一起给，别让模型只看到一半。 */
function join(main: string, extra: string): string {
	return extra === "" ? main : `${main}\n${extra}`;
}

export function createRouteTool(deps: CoreToolDeps) {
	const t = (key: string, slots: Record<string, string | number | undefined> = {}): string =>
		fill(deps.text, key, slots);
	const tool = defineTool({
		name: "route",
		description: t("route.description"),
		parameters: Type.Object({
			to: Type.Array(Type.String(), { description: t("route.param.to") }),
			goal: Type.Optional(Type.String({ description: t("route.param.goal") })),
			accept: Type.Optional(Type.String({ description: t("route.param.accept") })),
			seq: Type.Optional(Type.Number({ description: t("route.param.seq") })),
			channel: Type.Optional(Type.String({ description: t("route.param.channel") })),
		}),
		execute: async (args, api, context) => {
			const ctx: Context = context ?? BACKGROUND_CONTEXT;
			const conversationId = Number(api.conversationId);
			const slug = await selfOrError(deps, conversationId, ctx, "route.self.missing");
			if (typeof slug !== "string") return text(slug);

			const all = await readAllIdentities(deps.layout.agentRoots);
			if (!assistantsOf(deps.layout, all).includes(slug)) return text(t("route.refuse.not-assistant"));

			const state = await readState(deps);
			const target = await defaultChannel(deps, state, slug, conversationId, args.channel, ctx);
			if ("error" in target) return text(target);
			const channel = state.channels[target.channelId];
			if (channel === undefined) return text(t("chats.channel.missing"));

			// 不给 seq 就默认「我刚被叫醒的那条」：助理通常就是读完它之后决定转给谁的。
			let seq = args.seq;
			if (seq === undefined) {
				const directory = await deps.directory(ctx);
				const wake = wakeOf(directory, conversationId);
				if (wake === undefined || wake.reply.channelId !== channel.id) return text(t("route.refuse.no-seq"));
				seq = wake.reply.seq;
			}
			const message = (state.messages[channel.id] ?? []).find((item) => item.seq === seq);
			if (message === undefined) return text(t("route.refuse.missing", { seq, channel: channel.title }));

			const roster = await mentionRoster(deps);
			const targets: string[] = [];
			for (const raw of args.to) {
				const who = resolveMention(raw, roster) ?? raw.trim();
				if (who === slug) return text(t("route.refuse.self"));
				if (who === OWNER) return text(t("route.refuse.owner"));
				if (!channel.members.includes(who)) {
					return text(
						t("route.refuse.target", {
							name: raw,
							channel: channel.title,
							names: channel.members.filter((item) => item !== OWNER).join("、"),
						}),
					);
				}
				if (!targets.includes(who)) targets.push(who);
			}
			if (targets.length === 0) return text(t("route.refuse.empty"));

			/**
			 * 带 `goal` 才有板上的那一条：**先说上了板，再说交出去了**。
			 *
			 * 顺序是刻意反过来的（设计里「一次 commit 里既 push 消息又写任务」说的是 note
			 * 和任务，投递不在这笔事务里）：建任务能回滚，投递不能。先建、后转，最坏的结果是
			 * 「板上有活、人没被告知」——这一眼看得见、也补得回；反过来是「人被告知了、板上没有」，
			 * 那件活在系统里根本不存在。
			 *
			 * 建任务失败**不影响转交**：转交是这一轮的主事，别让一件附带的记账把它拦下来。
			 * 失败要说出来（否则板上凭空少一条），但话里要写明转交照旧发了。
			 */
			const goal = (args.goal ?? "").trim();
			const accept = (args.accept ?? "").trim();
			let goalLine = "";
			if (goal !== "") {
				const owner = targets[0];
				if (targets.length !== 1 || owner === undefined) {
					// 一件活只有一个负责人：交给好几个人时不知道归谁，不上板（转交照旧）。
					goalLine = t("route.goal.shared", { count: targets.length });
				} else {
					const alive = Object.values(tasksOf(state, channel.id)).find(
						(task) =>
							task.originSeq === message.seq &&
							task.owner === owner &&
							task.status !== "done" &&
							task.status !== "dropped",
					);
					if (alive !== undefined) {
						// 重试同一次转交时不该在板上再长一条：已有就算成了。
						goalLine = t("route.goal.exists", { id: alive.id });
					} else {
						const created = await commitTaskNote(
							{ harness: deps.harness },
							{
								channelId: channel.id,
								at: Date.now(),
								plan: (_current, _attempt, id): TaskNotePlan => {
									const task: Task = {
										id,
										title: goal,
										owner,
										...(accept === "" ? {} : { accept }),
										status: "open",
										channelId: channel.id,
										originSeq: message.seq,
										history: [],
									};
									return { task, what: "created", text: `${id}：建了一条：${goal}` };
								},
							},
							ctx,
						);
						goalLine = created.ok
							? t("route.goal.created", {
									id: created.task.id,
									owner: created.task.owner,
									title: created.task.title,
								})
							: t("route.goal.failed", { error: created.message });
					}
				}
			}

			// 先留一条隐藏痕：它是「这一轮已经把消息交出去了」的凭据，收尾据此不再补发
			// （`saidLast` 认 `route`）。界面不画它（`noteOf` 只有 `run` 会折成一行）。
			await appendToChannel(
				{ harness: deps.harness },
				{
					channelId: channel.id,
					from: slug,
					text: t("route.note", { seq, names: targets.join("、") }),
					at: Date.now(),
					kind: "note",
					noteOf: "route",
				},
				ctx,
			);

			const delivery = await deps.wiring.flow.forward(
				state,
				{ channelId: channel.id, seq, targets, routedBy: slug },
				ctx,
			);
			if (delivery.delivered.length === 0) {
				return text(join(t("route.done.none", { names: targets.join("、") }), goalLine));
			}
			return text(
				join(
					t("route.done", {
						seq,
						names: delivery.delivered.join("、"),
						failed:
							delivery.failed.length === 0
								? ""
								: t("route.done.failed", { names: delivery.failed.join("、") }),
					}),
					goalLine,
				),
			);
		},
	});
	return tool;
}
