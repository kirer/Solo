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
import { appendToChannel } from "../write.ts";
import { resolveMention } from "../mentions.ts";
import { defaultChannel } from "./channel-choice.ts";
import { mentionRoster, readState, selfOrError, text, type CoreToolDeps } from "./context.ts";
import { fill } from "../../documents/base/catalog.ts";

export function createRouteTool(deps: CoreToolDeps) {
	const t = (key: string, slots: Record<string, string | number | undefined> = {}): string =>
		fill(deps.text, key, slots);
	const tool = defineTool({
		name: "route",
		description: t("route.description"),
		parameters: Type.Object({
			to: Type.Array(Type.String(), { description: t("route.param.to") }),
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
				return text(t("route.done.none", { names: targets.join("、") }));
			}
			return text(
				t("route.done", {
					seq,
					names: delivery.delivered.join("、"),
					failed:
						delivery.failed.length === 0
							? ""
							: t("route.done.failed", { names: delivery.failed.join("、") }),
				}),
			);
		},
	});
	return tool;
}
