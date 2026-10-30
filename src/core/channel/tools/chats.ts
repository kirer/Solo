/** `chats`：列会话，或者读某个频道的历史。 */
import { BACKGROUND_CONTEXT, Type, defineTool } from "../../runtime/index.ts";
import { digestRows } from "../delivery.ts";
import { ChannelDoc, chatKind, type ChannelState } from "../types.ts";
import { channelsOf, markRead, unreadCount } from "../rules.ts";
import { oneLine } from "../../md/oneline.ts";
import { actionOf, selfOrError, readState, text, type CoreToolDeps } from "./context.ts";
import { defaultChannel } from "./channel-choice.ts";
import { renderLine } from "./recall.ts";

export function createChatsTool(deps: CoreToolDeps) {
	const tool = defineTool({
		name: "chats",
		description:
			"看会话。`action=list`（默认）列我在的会话：标题、群聊还是私聊、未读数、最后一条；`action=read` 读某个频道的历史消息（读完标已读）。",
		parameters: Type.Object({
			action: Type.Optional(Type.String({ description: "list（默认）列会话 / read 读消息" })),
			channel: Type.Optional(Type.String({ description: "频道 id。read 时省略 = 刚叫醒我的那个频道" })),
			since: Type.Optional(Type.Number({ description: "只要这个序号之后的消息（read）" })),
			limit: Type.Optional(Type.Number({ description: "最多几条，默认 30，上限 100" })),
		}),
		execute: async (args, api, context) => {
			const ctx = context ?? BACKGROUND_CONTEXT;
			const action = actionOf(args.action, ["list", "read"], "list");
			if (typeof action !== "string") return text(action);
			const slug = await selfOrError(deps, Number(api.conversationId), ctx, "你还不在名册里。");
			if (typeof slug !== "string") return text(slug);
			const state = await readState(deps);

			if (action === "list") {
				const digest = digestRows(state, slug, 20).rows.join("\n");
				const rows = channelsOf(state, slug).map((channel) => {
					const unread = unreadCount(state, channel.id, slug);
					const list = state.messages[channel.id] ?? [];
					const last = list[list.length - 1];
					const preview =
						last === undefined ? "（还没有消息）" : `${last.from}: ${oneLine(last.text, 60)}`;
					return [
						`- ${channel.id}「${channel.title}」${chatKind(channel) === "dm" ? "私聊" : "群聊"}` +
							`${unread === 0 ? "" : ` · ${unread} 条未读`}（${channel.members.length} 人）`,
						`  ${preview}`,
					].join("\n");
				});
				const parts = [
					...(digest === "" ? [] : ["未读消息：", digest]),
					...(rows.length === 0 ? ["你不在任何频道里。"] : ["", "你的频道：", ...rows]),
				];
				return text(parts.join("\n"));
			}

			const target = await defaultChannel(deps, state, slug, Number(api.conversationId), args.channel, ctx);
			if ("error" in target) return text(target);
			const channel = state.channels[target.channelId];
			if (channel === undefined) return text("没有这个频道。");
			const limit = Math.min(Math.max(args.limit ?? 30, 1), 100);
			const list = state.messages[channel.id] ?? [];
			const pool =
				args.since === undefined ? list : list.filter((message) => message.seq > (args.since as number));
			const shown = pool.slice(Math.max(0, pool.length - limit));
			if (shown.length === 0) {
				return text(
					args.since === undefined
						? `「${channel.title}」里还没有消息。`
						: `「${channel.title}」在 #${args.since} 之后没有新消息。`,
				);
			}
			const last = shown[shown.length - 1];
			const lines = shown.map((message) => renderLine(message));
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
					`「${channel.title}」最近 ${shown.length} 条（共 ${list.length} 条）：`,
					...lines,
					"",
					`（已标记到 #${last?.seq ?? 0} 为已读）`,
				].join("\n"),
			);
		},
	});
	return tool;
}
