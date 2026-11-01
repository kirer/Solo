/** `read_history`：翻自己的对话（含被压缩的），或者翻记忆。 */
import { BACKGROUND_CONTEXT, Type, defineTool, type Cursor, type EntryRecord } from "../../runtime/index.ts";
import { redact } from "../../agent/secrets.ts";
import { actionOf, selfOrError, text, type CoreToolDeps } from "./context.ts";
import { recallText } from "./recall.ts";

/** 历史条目里一条消息的收窄视图（结构上只用得到这几个字段）。 */
type HistoryBlock = { readonly type?: string; readonly text?: string };
type HistoryModel = {
	readonly content?: string | readonly HistoryBlock[];
	readonly timestamp?: unknown;
};

/** 只取正文块：思考块不是「说过的话」，工具调用参数是过程不是结论。 */
function historyText(model: HistoryModel | undefined): string {
	if (model === undefined) return "";
	if (typeof model.content === "string") return model.content.replace(/\s+/g, " ").trim();
	const parts: string[] = [];
	for (const block of model.content ?? []) {
		if (block.type === "text" && typeof block.text === "string") parts.push(block.text);
	}
	return parts.join(" ").replace(/\s+/g, " ").trim();
}

/** 相对时间。模型要判断「这件事是刚说的还是很久以前」，绝对时间戳帮不上忙。 */
function agoOf(timestamp: unknown, now: number): string {
	const at =
		typeof timestamp === "number" ? timestamp : typeof timestamp === "string" ? Date.parse(timestamp) : Number.NaN;
	if (!Number.isFinite(at)) return "时间未知";
	const minutes = Math.round((now - at) / 60_000);
	if (minutes < 1) return "刚刚";
	if (minutes < 60) return `${minutes} 分钟前`;
	const hours = Math.round(minutes / 60);
	if (hours < 24) return `${hours} 小时前`;
	const days = Math.round(hours / 24);
	if (days < 30) return `${days} 天前`;
	return new Date(at).toISOString().slice(0, 10);
}

	/** 一行最多多少字、一次最多回多少字。与 `clip` 同一个理由：宁可多翻一次，不要一次塞爆上下文。 */
	const HISTORY_LINE = 400;
	const HISTORY_BUDGET = 8000;
	const HISTORY_PAGE = 64;
	const HISTORY_PAGES = 8;

/**
 * `read_history`：翻过去的话 —— 对话历史，或者记忆。
 *
 * 为什么必须有对话那一半：上下文压缩是 pi-durable 的默认行为，压成 `pi.compaction`
 * 条目之后，原文还在 storage 里，但**模型再也看不见了，也没任何办法读回**。
 * 于是它只能凭记忆补路径、补数字、补原话 —— 看起来很像，可能是错的，而且
 * 错得无法被发现。这把记忆能不能查询变成了可以查询。
 *
 * 分页从新往回扇：一次 64 条。记忆那一半见 `recallText`。
 */
export function createHistoryTool(deps: CoreToolDeps) {
	const tool = defineTool({
		name: "read_history",
		description: [
			"翻历史。`scope=channel`（默认）查我自己这个会话（上下文被压缩掉的部分也查得到）；",
			"`scope=memory`（或 personal / team 简写）翻记忆全文，可以只筛包含某个词的段落。",
		].join(""),
		parameters: Type.Object({
			scope: Type.Optional(
				Type.String({ description: "channel（默认，对话历史）/ memory（我的记忆）/ team（团队记忆；也可以先写 memory 再给 team）" }),
			),
			query: Type.Optional(Type.String({ description: "关键词（不区分大小写），只留包含它的条目 / 段落" })),
			team: Type.Optional(Type.String({ description: "团队 slug，默认是我所在的团队（scope=team / memory 且要看团队时用）" })),
			around: Type.Optional(Type.Number({ description: "条目 id（每行开头的 #号）。从这条往前翻（只看对话历史）" })),
			limit: Type.Optional(Type.Number({ description: "最多几条，默认 12，上限 50（只看对话历史）" })),
		}),
		execute: async (args, api, context) => {
			const ctx = context ?? BACKGROUND_CONTEXT;
			const wanted = actionOf(args.scope, ["channel", "memory", "personal", "team"], "channel", "scope");
			if (typeof wanted !== "string") return text(wanted);

			// 记忆那一半：入参是「谁的记忆 / 哪个团队 / 只留含某词的段落」。
			if (wanted !== "channel") {
				const slug = await selfOrError(deps, Number(api.conversationId), ctx, "你还不在名册里。");
				if (typeof slug !== "string") return text(slug);
				const keyword = (args.query ?? "").trim();
				if (wanted === "team") return recallText(deps, slug, args.team, keyword);
				if (wanted === "personal") return recallText(deps, slug, undefined, keyword);
				// scope=memory：给了 team 就看团队，否则看自己。
				return recallText(deps, slug, args.team, keyword);
			}

			const limit = Math.min(Math.max(Math.trunc(args.limit ?? 12), 1), 50);
			const keyword = (args.query ?? "").trim().toLowerCase();
			const conversation = await deps.harness.conversation(Number(api.conversationId) as never, ctx);
			if (conversation === undefined) return text("这个会话还没有任何记录。");
			const now = Date.now();
			const found: { id: number; line: string }[] = [];
			let cursor: Cursor | undefined;
			let exhausted = false;
			let enough = false;
			// 多取一条：只有拿到「第 limit+1 条」才知道后面确实还有更早的。
			for (let index = 0; index < HISTORY_PAGES && found.length <= limit; index += 1) {
				const page = await conversation.entries(
					{
						order: "descending",
						...(args.around === undefined ? {} : { maxEntryId: (args.around - 1) as never }),
					},
					HISTORY_PAGE,
					cursor,
					ctx,
				);
				if (page === undefined || page.items.length === 0) break;
				for (const entry of page.items as readonly EntryRecord[]) {
					if (entry.kind !== "pi.user" && entry.kind !== "pi.assistant" && entry.kind !== "pi.compaction") continue;
					const model = entry.model?.[0] as HistoryModel | undefined;
					const body = historyText(model);
					if (body === "") continue;
					const speaker = entry.kind === "pi.compaction" ? "[压缩摘要]" : entry.kind === "pi.user" ? "对方" : "你";
					const clipped = body.length > HISTORY_LINE ? `${body.slice(0, HISTORY_LINE)}…` : body;
					const line = `[#${entry.id} ${agoOf(model?.timestamp, now)}] ${speaker}: ${clipped}`;
					if (keyword !== "" && !line.toLowerCase().includes(keyword)) continue;
					found.push({ id: Number(entry.id), line });
					if (found.length > limit) {
						// 够数了：这一页没扫完，也就不能断言「没有更早的了」。
						enough = true;
						break;
					}
				}
				if (enough || page.next === undefined) {
					exhausted = page.next === undefined && !enough;
					break;
				}
				cursor = page.next;
			}
			if (found.length === 0) return text("这个会话里没有匹配的记录。");
			// 新→旧累加，超预算就停：给的是「最近的一段」，不是「全部」——
			// 历史的价值在于能接着往前翻，不在于一次全拿出来。
			const lines: string[] = [];
			let used = 0;
			for (const item of found) {
				if (lines.length >= limit || used + item.line.length + 1 > HISTORY_BUDGET) break;
				lines.push(item.line);
				used += item.line.length + 1;
			}
			const oldest = found[lines.length - 1];
			const more = found.length > lines.length || (lines.length >= limit && !exhausted);
			const tail = more && oldest !== undefined ? `\n\n还有更早的，用 around=${oldest.id} 继续往前。` : "";
			return text(redact(`${lines.join("\n")}${tail}`, deps.layout.appRoot));
		},
	});
	return tool;
}
