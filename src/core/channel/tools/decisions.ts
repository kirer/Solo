/**
 * `decisions`：把「在等他拍板的」列出来，一条条清掉。
 *
 * 为什么需要这个工具：老板那边积压过七十条没人看 —— 全是「结论 + 可能要你定」混在
 * 同一个私聊里，看完了也看不出哪条真在等他。`say` 的 `needs: "decision"` 把「这条在
 * 等他拍板」变成一个**显式动作**，这个工具给它一个**能清掉的位置**：不清就一直挂着。
 *
 * 两条清掉的路径，都会让这条从清单里消失：
 *
 * 1. **他自己回了** —— 同频道里有一条 `from: owner`、`replyTo` 指向它的消息。回复本身就是
 *    答案，不该再要求谁去点一下。这是他实际会用的那条路。
 * 2. **助理替他关** —— `action=close`，写 `decidedAt` / `decidedBy`。他说「不用你管了」
 *    「这件事撤了」的时候用；也是「点掉」在工具侧的入口（界面复用同一个字段）。
 *
 * 谁清得动：助理，或者老板自己（他的回复走路径 1）。成员清不了别人的待办 —— 那等于
 * 替老板把一件事划掉。
 */
import { BACKGROUND_CONTEXT, Type, defineTool } from "../../runtime/index.ts";
import { assistantsOf, readAllIdentities } from "../../documents/member/identity.ts";
import { ChannelDoc, OWNER, type ChannelState, type Message } from "../types.ts";
import { actionOf, readState, selfOrError, text, type CoreToolDeps } from "./context.ts";
import { fill } from "../../documents/base/catalog.ts";

/** 一条还挂着的待拍板。 */
type OpenDecision = {
	readonly channelId: string;
	readonly title: string;
	readonly message: Message;
};

/** 正文在清单里最多给多少字：一行一条，看不完的用 `chats` 翻回去。 */
const CLIP = 80;

/**
 * 还挂着的有哪些（按频道、再按 seq 排序）。
 *
 * 「老板回过了」这条判据放在这里而不是落盘时改写消息：回复是一条普通消息，写它的时候
 * 不该顺手改另一条；读的时候算一次就够，也不怕历史数据漏标。
 */
export function openDecisions(state: ChannelState, slug: string, assistant: boolean): readonly OpenDecision[] {
	const out: OpenDecision[] = [];
	for (const [channelId, channel] of Object.entries(state.channels)) {
		if (channel.archived === true) continue;
		// 助理看它管的频道（它都在），成员只看自己在的。
		if (!assistant && !channel.members.includes(slug)) continue;
		const list = state.messages[channelId] ?? [];
		const answered = new Set(
			list.filter((item) => item.from === OWNER && item.replyTo !== undefined).map((item) => item.replyTo as number),
		);
		for (const message of list) {
			if (message.needs !== "decision") continue;
			if (message.decidedAt !== undefined) continue;
			if (answered.has(message.seq)) continue;
			out.push({ channelId, title: channel.title, message });
		}
	}
	return out.sort((a, b) => a.message.at - b.message.at);
}

export function createDecisionsTool(deps: CoreToolDeps) {
	const t = (key: string, slots: Record<string, string | number | undefined> = {}): string =>
		fill(deps.text, key, slots);
	const tool = defineTool({
		name: "decisions",
		description: t("decisions.description"),
		parameters: Type.Object({
			action: Type.Optional(Type.String({ description: t("decisions.param.action") })),
			seq: Type.Optional(Type.Number({ description: t("decisions.param.seq") })),
			channel: Type.Optional(Type.String({ description: t("decisions.param.channel") })),
		}),
		execute: async (args, api, context) => {
			const ctx = context ?? BACKGROUND_CONTEXT;
			const action = actionOf(args.action, ["list", "close"], "list", "action", deps.text);
			if (typeof action !== "string") return text(action);
			const slug = await selfOrError(deps, Number(api.conversationId), ctx);
			if (typeof slug !== "string") return text(slug);
			const assistants = assistantsOf(deps.layout, await readAllIdentities(deps.layout.agentRoots));
			const assistant = assistants.includes(slug);

			if (action === "list") {
				const state = await readState(deps);
				const open = openDecisions(state, slug, assistant);
				if (open.length === 0) return text(t("decisions.list.empty"));
				const lines = open.map((entry, index) => {
					const who = entry.message.from === OWNER ? t("decisions.list.owner") : entry.message.from;
					const body = entry.message.text.replace(/\s+/g, " ").trim();
					const clipped = body.length > CLIP ? `${body.slice(0, CLIP)}…` : body;
					return t("decisions.list.line", {
						n: index + 1,
						channel: entry.title,
						seq: entry.message.seq,
						who,
						text: clipped,
					});
				});
				return text([t("decisions.list.header", { count: open.length }), ...lines, t("decisions.list.footer")].join("\n"));
			}

			// close：先定位是哪一条。seq 是频道内序号，跨频道会撞，所以给了 channel 就用它，
			// 没给就要求 seq 在所有频道里唯一 —— 撞了就报错让调用方指名频道，不猜。
			const seq = args.seq;
			if (seq === undefined || !Number.isInteger(seq)) return text(t("decisions.refuse.seq"));
			const state = await readState(deps);
			const open = openDecisions(state, slug, assistant);
			const named = args.channel?.trim();
			const hits = open.filter((entry) => {
				if (entry.message.seq !== seq) return false;
				if (named === undefined || named === "") return true;
				return entry.channelId === named || entry.title === named;
			});
			const one = hits.length === 1 ? hits[0] : undefined;
			if (one === undefined) {
				return text(hits.length === 0 ? t("decisions.refuse.missing", { seq }) : t("decisions.refuse.ambiguous", { seq }));
			}
			if (!assistant) return text(t("decisions.refuse.member", { assistant: assistants.join("、") }));
			await deps.harness.commit(async (tx) => {
				const doc = (await tx.doc(ChannelDoc)) as ChannelState;
				const list = doc.messages[one.channelId] ?? [];
				// 整体替换这个频道的消息数组：就地改 `message.decidedAt` 不产生文档 op（改的是副本）。
				doc.messages[one.channelId] = list.map((item) =>
					item.seq === one.message.seq && item.needs === "decision"
						? { ...item, decidedAt: Date.now(), decidedBy: slug }
						: item,
				);
			}, ctx);
			return text(t("decisions.close.done", { seq, channel: one.title }));
		},
	});
	return tool;
}
