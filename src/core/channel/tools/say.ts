/** `say`：在频道里说话。带 `mention` 就是提问并叫醒对方。 */
import { BACKGROUND_CONTEXT, Type, defineTool, type Context } from "../../runtime/index.ts";
import { assistantsOf, readAllIdentities } from "../../documents/member/identity.ts";
import { OWNER, chatKind } from "../types.ts";
import { parseMentions, resolveMention } from "../mentions.ts";
import { mentionRoster, readState, selfOrError, text, type CoreToolDeps } from "./context.ts";
import { defaultChannel, othersAwoken } from "./channel-choice.ts";
import { isPass, monologueOpener, sayLimitOf } from "./guards.ts";
import { fill } from "../../documents/base/catalog.ts";
import { entryProblem, problemText } from "../../documents/base/memory.ts";
import { readIdentity } from "../../documents/member/identity.ts";
import { appendMemory } from "../../documents/member/memory.ts";
import { readMemoryUse, recordClosing, writeMemoryUse } from "../../documents/member/memory-use.ts";
import { redact } from "../../secrets.ts";
import { join } from "node:path";
import type { Slots } from "../../documents/base/slots.ts";

export function createSayTool(deps: CoreToolDeps) {
	const t = (key: string, slots: Slots = {}): string => fill(deps.text, key, slots);
	const say = defineTool({
		name: "say",
		description: t("say.description"),
		parameters: Type.Object({
			text: Type.String({ description: t("say.param.text") }),
			mention: Type.Optional(Type.String({ description: t("say.param.mention") })),
			channel: Type.Optional(Type.String({ description: t("say.param.channel") })),
			replyTo: Type.Optional(Type.Number({ description: t("say.param.replyTo") })),
			options: Type.Optional(
				Type.Array(Type.String(), {
					description: t("say.param.options"),
				}),
			),
			needs: Type.Optional(Type.String({ description: t("say.param.needs") })),
			closing: Type.Optional(Type.Boolean({ description: t("say.param.closing") })),
			lesson: Type.Optional(Type.String({ description: t("say.param.lesson") })),
		}),
		execute: async (args, api, context) => sayUnlocked(args, api, context ?? BACKGROUND_CONTEXT),
	});

	const sayUnlocked = async (
		args: {
			text: string;
			mention?: string;
			channel?: string;
			replyTo?: number;
			options?: readonly string[];
			needs?: string;
			closing?: boolean;
			lesson?: string;
		},
		api: { conversationId: string | number },
		ctx: Context,
	): Promise<ReturnType<typeof text>> => {
			const slug = await selfOrError(deps, Number(api.conversationId), ctx, "say.self.missing");
			if (typeof slug !== "string") return text(slug);
			// 没有「私下发给谁」这个参数：私聊只能我开，agent 只能在已有的频道里说话。
			// 也不需要专门硬拦 ——「非成员发不进去」已经重定了这条边界。
			// 内心独白不是发言。
			//
			// 规矩里早写了「不用英文写内心独白」，但模型该写还是写（线上 46% 的发言是英文）。
			// 这一条必须由代码拦：贴出去的每一句都会出现在我眼前，靠自觉等于没拦。
			const monologue = monologueOpener(args.text);
			if (monologue !== undefined) {
				return text(t("say.refuse.monologue", { opener: monologue }));
			}
			let state = await readState(deps);

			// 「这一轮我不说」—— 但不是随时都能不说。
			//
			// 独享一个频道的人 PASS 掉，等于我问了一句什么都没收到：那不是安静，是断线。
			// 所以 PASS 只在「这一轮还有别的 agent 被同一条消息叫醒」时成立。
			if (isPass(args.text)) {
				const others = await othersAwoken(deps, state, Number(api.conversationId), slug, ctx);
				if (others.length === 0) return text(t("say.refuse.pass"));
				return text(t("say.pass.ok", { others: others.join("、") }));
			}

			const conversationId = Number(api.conversationId);
			const target = await defaultChannel(deps, state, slug, conversationId, args.channel, ctx);
			if ("error" in target) return text(target);
			const roster = await mentionRoster(deps);
			const channelId = target.channelId;
			const targetChannel = state.channels[channelId];

			// 一条消息的长度上限**看频道**：群聊只放结论（600 字），私聊可以多说两句（1200）。
			//
			// 线上见过 21,568 字的一条 `say` —— 那不是在说话，是把整个思考过程倒进频道。
			// 长内容有它的地方（团队文件、记忆、审查记录），频道里只放结论和路径。
			const limit = sayLimitOf(targetChannel === undefined ? "group" : chatKind(targetChannel));
			if (args.text.length > limit) {
				return text(
					t("say.refuse.long", {
						length: args.text.length,
						channel: targetChannel?.title ?? channelId,
						limit,
					}),
				);
			}

			// 要我选：2–6 个、去空白、不重复。带选项就一定会叫醒我
			// （回答就是普通消息 + replyTo，界面按最后一条没人答过的 options 画选项卡）。
			const options = (args.options ?? []).map((item) => item.trim()).filter((item) => item !== "");
			if (args.options !== undefined) {
				if (options.length < 2 || options.length > 6) {
					return text(t("say.refuse.options.count", { count: options.length }));
				}
				if (new Set(options).size !== options.length) return text(t("say.refuse.options.dup"));
			}
			const choosing = options.length > 0;

			// 拍板是助理的事（`seed/rules.md`：拍不了板的 @助理，它自己拍不了再 @我）。
			// 成员直接带选项问，等于把原始问题甩到我面前 —— 2026-11-07 实测：祁远在团队频道
			// 甩来四个走法让我挑，而这件事本该由助理汇总成一句话再问我（ADR-112）。
			let assistantsCache: readonly string[] | undefined;
			const assistantsNow = async (): Promise<readonly string[]> => {
				assistantsCache ??= assistantsOf(deps.layout, await readAllIdentities(deps.layout.agentRoots));
				return assistantsCache;
			};
			if (choosing) {
				const assistants = await assistantsNow();
				if (assistants.length > 0 && !assistants.includes(slug)) {
					return text(t("say.refuse.options.member", { assistant: assistants.join("、") }));
				}
			}

			// 「这条在等他拍板」：显式动作，不是靠正文口气猜。
			//
			// 和 `options` 分开是因为它要的答案不一样 —— `options` 等他挑一个（进选项卡），
			// `needs` 等他一句「行 / 不行」，可能不回。所以它落库成一个待办（`Message.needs`），
			// 由 `decisions` 列出来、一条条清掉。不清就一直在，这才挡得住「七十条没人看」。
			const needs = args.needs?.trim();
			const deciding = needs === "decision";
			if (needs !== undefined && needs !== "") {
				if (!deciding) return text(t("say.refuse.needs.value", { value: needs }));
				if (choosing) return text(t("say.refuse.needs.options"));
				const assistants = await assistantsNow();
				if (assistants.length > 0 && !assistants.includes(slug)) {
					return text(t("say.refuse.needs.member", { assistant: assistants.join("、") }));
				}
			}

			// 收尾闸：交付、验收这类**结论句**必须回答一句「这次有什么能复用」。
			//
			// 为什么不新造一个 `finish` 动作：产品里没有「交付」这个显式状态，成员收工就是在
			// 频道里说一句结论。挂在收尾这一句上，是唯一不需要模型额外记一步的位置。
			// 拒发话术里必须明说「想不到就写 none 也算回答」—— 不写，模型会卡在那儿编一条。
			const closing = args.closing === true;
			const lesson = args.lesson?.trim();
			if (closing) {
				if (lesson === undefined || lesson === "") return text(t("say.refuse.closing.lesson"));
				if (lesson !== "none") {
					const problem = entryProblem(lesson);
					if (problem !== undefined) return text(problemText(problem, lesson, deps.text));
				}
			}

			// 带 mention：验证成员、补 @ 前缀。
			// `@我` / `@CEO` 这类叫法要先解析成 slug，否则成员校验会直接报「没有这个人」。
			let messageText = args.text;
			if (args.mention !== undefined && args.mention !== "") {
				const channel = targetChannel;
				const typed = args.mention.replace(/^@/, "");
				const who = resolveMention(typed, roster) ?? typed;
				if (channel === undefined || !channel.members.includes(who)) {
					return text(
						t("say.refuse.mention", {
							channel: channel?.title ?? target.channelId,
							name: typed,
							available: channel?.members.join("、") ?? "",
						}),
					);
				}
				messageText = parseMentions(args.text, roster).includes(who) ? args.text : `@${who} ${args.text}`;
			}

			// 要我拍板只有一条路：**正文显式 @了我**（`@我` / `@owner` 已由 parseMentions 解析命中）。
			// 不按「没点别人就算找我」推算：助理常在私聊里对着团队成员派活，那些人不是私聊
			// 成员，「没点别人」就成立，于是每条通告都变成「需要你」（实测 43 条私聊里 13 条）。
			// 拍板要我看见，就写 @我（ADR-009）。
			const typedMentions = parseMentions(messageText, roster);
			const wakeOwner = typedMentions.includes(OWNER);

			// 带选项的消息画的是**我的**选项卡（`ui/app/src/composer/choice.ts`），而且一定会叫醒我。
			// 点的是别人就别带：发出去只会变成「老板，你定」。2026-11-07 实测：周砚生
			// 「@Solo 方向要你定」带三个选项，选项卡弹到了我这儿。
			if (choosing && typedMentions.length > 0 && !wakeOwner) {
				return text(t("say.refuse.options.others", { names: typedMentions.join("、") }));
			}

			const result = await deps.wiring.flow.publish(
				state,
				{
					channelId,
					from: slug,
					text: messageText,
					at: Date.now(),
					...(choosing ? { options } : {}),
					...(deciding ? { needs: "decision" } : {}),
					...(args.replyTo === undefined ? {} : { replyTo: args.replyTo }),
					roster,
					...((() => {
						const extra = wakeOwner || choosing || deciding ? [OWNER] : [];
						return extra.length === 0 ? {} : { mention: extra };
					})()),
				},
				ctx,
			);
			// 发出去了才写记忆：这句话的价值先在频道里，记忆丢了不该让它发不出去。
			if (closing && lesson !== undefined) {
				const self = await readIdentity(deps.layout.agentRoots, slug);
				const dir = self?.dir ?? join(deps.layout.membersRoot, slug);
				try {
					const use = await readMemoryUse(dir);
					if (lesson !== "none") {
						await appendMemory(dir, redact(lesson, deps.layout.appRoot), new Date(), "closing", deps.text);
					}
					await writeMemoryUse(dir, recordClosing(use, lesson));
				} catch {
					// 记忆是旁挂账，写不进去不影响这句结论。
				}
			}
			const woke = result.delivery.delivered;
			return text(
				t("say.done", {
					title: result.channel.title,
					seq: result.message.seq,
					woken: woke.length === 0 ? t("say.done.nobody") : t("say.done.woken", { names: woke.join("、") }),
				}),
			);
		};
	return say;
}
