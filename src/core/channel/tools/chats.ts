/** `chats`：列会话、读某个频道的历史，或者拉一个群。 */
import { BACKGROUND_CONTEXT, Type, defineTool } from "../../runtime/index.ts";
import { digestRows } from "../delivery.ts";
import { ChannelDoc, chatKind, type ChannelState } from "../types.ts";
import { channelsOf, markRead, unreadCount } from "../rules.ts";
import { createGroup } from "../membership.ts";
import { oneLine } from "../../md/oneline.ts";
import { actionOf, selfOrError, readState, text, type CoreToolDeps } from "./context.ts";
import { defaultChannel } from "./channel-choice.ts";
import { renderLine } from "./recall.ts";
import { fill } from "../../md/catalog.ts";

export function createChatsTool(deps: CoreToolDeps) {
	const t = (key: string, slots: Record<string, string | number | undefined> = {}): string =>
		fill(deps.text, key, slots);
	const tool = defineTool({
		name: "chats",
		description: t("chats.description"),
		parameters: Type.Object({
			action: Type.Optional(Type.String({ description: t("chats.param.action") })),
			channel: Type.Optional(Type.String({ description: t("chats.param.channel") })),
			since: Type.Optional(Type.Number({ description: t("chats.param.since") })),
			limit: Type.Optional(Type.Number({ description: t("chats.param.limit") })),
			title: Type.Optional(Type.String({ description: t("chats.param.title") })),
			members: Type.Optional(Type.Array(Type.String(), { description: t("chats.param.members") })),
		}),
		execute: async (args, api, context) => {
			const ctx = context ?? BACKGROUND_CONTEXT;
			const action = actionOf(args.action, ["list", "read", "create"], "list", "action", deps.text);
			if (typeof action !== "string") return text(action);
			const slug = await selfOrError(deps, Number(api.conversationId), ctx);
			if (typeof slug !== "string") return text(slug);
			const state = await readState(deps);

			if (action === "create") {
				try {
					const group = await createGroup(
						{
							harness: deps.harness,
							layout: deps.layout,
							...(deps.text === undefined ? {} : { text: deps.text }),
						},
						{
							title: (args.title ?? "").trim(),
							members: Array.isArray(args.members) ? args.members : [],
							creator: slug,
						},
						ctx,
					);
					return text(
						t("chats.create.done", {
							title: group.title,
							id: group.id,
							names: group.members.join("、"),
						}),
					);
				} catch (error) {
					return text(error instanceof Error ? error.message : String(error));
				}
			}

			if (action === "list") {
				const digest = digestRows(state, slug, 20).rows.join("\n");
				const rows = channelsOf(state, slug).map((channel) => {
					const unread = unreadCount(state, channel.id, slug);
					const list = state.messages[channel.id] ?? [];
					const last = list[list.length - 1];
					const preview =
						last === undefined ? t("chats.row.empty") : `${last.from}: ${oneLine(last.text, 60)}`;
					return t("chats.row", {
						id: channel.id,
						title: channel.title,
						kind: t(chatKind(channel) === "dm" ? "chats.row.kind.dm" : "chats.row.kind.group"),
						unread: unread === 0 ? "" : t("chats.row.unread", { count: unread }),
						count: channel.members.length,
						preview,
					});
				});
				const parts = [
					...(digest === "" ? [] : [t("chats.header.unread"), digest]),
					...(rows.length === 0 ? [t("chats.none")] : ["", t("chats.header.channels"), ...rows]),
				];
				return text(parts.join("\n"));
			}

			const target = await defaultChannel(deps, state, slug, Number(api.conversationId), args.channel, ctx);
			if ("error" in target) return text(target);
			const channel = state.channels[target.channelId];
			if (channel === undefined) return text(t("chats.channel.missing"));
			const limit = Math.min(Math.max(args.limit ?? 30, 1), 100);
			const list = state.messages[channel.id] ?? [];
			const pool =
				args.since === undefined ? list : list.filter((message) => message.seq > (args.since as number));
			const shown = pool.slice(Math.max(0, pool.length - limit));
			if (shown.length === 0) {
				return text(
					args.since === undefined
						? t("chats.empty", { title: channel.title })
						: t("chats.empty.since", { title: channel.title, since: args.since }),
				);
			}
			const last = shown[shown.length - 1];
			const lines = shown.map((message) => renderLine(message, deps.text));
			if (last !== undefined) {
				await deps.harness.commit(async (tx) => {
					const doc = (await tx.doc(ChannelDoc)) as ChannelState;
					// 走 `markRead` 而不是直接写 `readMarks`：它会**把 seq 夹到频道真实上界**。
					// 直接写的话，一条越界的请求就能声明「以后全已读」，红点从此再也不出现。
					const marked = markRead(doc, slug, channel.id, last.seq);
					if (marked !== doc) doc.readMarks = marked.readMarks;
				}, ctx);
			}
			return text(
				[
					t("chats.read.header", { title: channel.title, shown: shown.length, total: list.length }),
					...lines,
					"",
					t("chats.read.footer", { seq: last?.seq ?? 0 }),
				].join("\n"),
			);
		},
	});
	return tool;
}
