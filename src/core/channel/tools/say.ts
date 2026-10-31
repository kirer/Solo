/** `say`：在频道里说话。带 `mention` 就是提问并叫醒对方。 */
import { BACKGROUND_CONTEXT, Type, defineTool, type Context } from "../../runtime/index.ts";
import { OWNER } from "../types.ts";
import { parseMentions, resolveMention } from "../mentions.ts";
import { postMessage } from "../post.ts";
import { mentionRoster, postDeps, readState, selfOrError, text, type CoreToolDeps } from "./context.ts";
import { defaultChannel, othersAwoken } from "./channel-choice.ts";
import { SAY_LIMIT, isPass, monologueOpener } from "./guards.ts";

export function createSayTool(deps: CoreToolDeps) {
	const say = defineTool({
		name: "say",
		description:
			"在频道里说话。不带 mention 是一句普通发言（正文里写 @某人 才叫醒他）；带 mention 就一定会叫醒他。",
		parameters: Type.Object({
			text: Type.String({
				description: "要说的话。这一轮没有新东西就写 `[PASS]`（这一轮只有你被叫醒时会被拒）。",
			}),
			mention: Type.Optional(Type.String({ description: "@ 谁，写名字或 slug（`@我` 指我）。带上会叫醒他。" })),
			channel: Type.Optional(Type.String({ description: "频道 id，省略 = 我刚被叫醒的那个频道。不在那个频道里的人 @ 不到。" })),
			replyTo: Type.Optional(Type.Number({ description: "要引用回复的消息序号" })),
			kind: Type.Optional(
				Type.Union([Type.Literal("decision"), Type.Literal("report")], {
					description:
						"给这条消息打标签：decision = 拍了板（结论、定了怎么做）；report = 交付了什么。普通发言不要传。",
				}),
			),
		}),
		execute: async (args, api, context) => sayUnlocked(args, api, context ?? BACKGROUND_CONTEXT),
	});

	const sayUnlocked = async (
		args: { text: string; mention?: string; channel?: string; replyTo?: number; kind?: "decision" | "report" },
		api: { conversationId: string | number },
		ctx: Context,
	): Promise<ReturnType<typeof text>> => {
			const slug = await selfOrError(deps, Number(api.conversationId), ctx, "你还不在名册里。先看 agents/<你>/identity.md，或请上级重新登记你。");
			if (typeof slug !== "string") return text(slug);
			// 没有「私下发给谁」这个参数：私聊只能我开，agent 只能在已有的频道里说话。
			// 也不需要专门硬拦 ——「非成员发不进去」已经重定了这条边界。
			// 一条频道消息最多 1200 字。
			//
			// 线上见过 21,568 字的一条 `say` —— 那不是在说话，是把整个思考过程倒进频道。
			// 长内容有它的地方（团队文件、记忆、审查记录），频道里只放结论和路径。
			if (args.text.length > SAY_LIMIT) {
				return text(
					`太长了：${args.text.length} 字，一条消息最多 ${SAY_LIMIT} 字。频道里只放结论，` +
						"把过程或整份内容写进团队文件，再发一句结论加路径。",
				);
			}
			// 内心独白不是发言。
			//
			// 规矩里早写了「不用英文写内心独白」，但模型该写还是写（线上 46% 的发言是英文）。
			// 这一条必须由代码拦：贴出去的每一句都会出现在我眼前，靠自觉等于没拦。
			const monologue = monologueOpener(args.text);
			if (monologue !== undefined) {
				return text(
					`这条没发出去：它以「${monologue}」开头，英文占多数 —— 那是你的思考，不是对别人说的话。` +
						"思考用 think；要对人说话就用中文写结论（谁、做了什么、结果、下一步）。重写一遍。",
				);
			}
			let state = await readState(deps);

			// 「这一轮我不说」—— 但不是随时都能不说。
			//
			// 独享一个频道的人 PASS 掉，等于我问了一句什么都没收到：那不是安静，是断线。
			// 所以 PASS 只在「这一轮还有别的 agent 被同一条消息叫醒」时成立。
			if (isPass(args.text)) {
				const others = await othersAwoken(deps, state, Number(api.conversationId), slug, ctx);
				if (others.length === 0) {
					return text(
						"这一轮只有你被叫醒，没有别人接得住，所以不能 PASS。把结论写出来：" +
							"谁、做了什么、卡在哪、下一步。几十个字就够，不要写报告。",
					);
				}
				return text(`这一句不说了（这一轮还有 ${others.join("、")} 在）。`);
			}

			const conversationId = Number(api.conversationId);
			const target = await defaultChannel(deps, state, slug, conversationId, args.channel, ctx);
			if ("error" in target) return text(target);
			const roster = await mentionRoster(deps);
			const channelId = target.channelId;
			const targetChannel = state.channels[channelId];

			// 带 mention：验证成员、补 @ 前缀、默认 kind=question。
			// `@我` / `@CEO` 这类叫法要先解析成 slug，否则成员校验会直接报「没有这个人」。
			let messageText = args.text;
			let kind: string | undefined = args.kind;
			if (args.mention !== undefined && args.mention !== "") {
				const channel = targetChannel;
				const typed = args.mention.replace(/^@/, "");
				const who = resolveMention(typed, roster) ?? typed;
				if (channel === undefined || !channel.members.includes(who)) {
					const available = channel?.members.join("、") ?? "";
					return text(`「${channel?.title ?? target.channelId}」里没有「${typed}」。可以 @：${available}`);
				}
				messageText = parseMentions(args.text, roster).includes(who) ? args.text : `@${who} ${args.text}`;
				kind = args.kind ?? "question";
			}

			// 要我拍板只有一条路：**正文显式 @了我**（`@我` / `@owner` 已由 parseMentions 解析命中）。
			//
			// 曾经 `decision` 标签也会自动把我加进收件人（「没点别人就算找我」）。实测下来，
			// 助理几乎每条公告都打 decision，而它常在私聊里对着团队成员派活 —— 那些人不是私聊
			// 成员，「没点别人」就成立，于是每条通告都变成「需要你」（43 条私聊里 13 条）。
			// 拍板要我看见，就写 @我；标签不代劳（ADR-009）。
			const typedMentions = parseMentions(messageText, roster);
			const wakeOwner = typedMentions.includes(OWNER);

			const result = await postMessage(
				postDeps(deps, state, ctx),
				{
					channelId,
					from: slug,
					text: messageText,
					at: Date.now(),
					...(args.replyTo === undefined ? {} : { replyTo: args.replyTo }),
					...(kind === undefined ? {} : { kind }),
					roster,
					...((() => {
						const extra = wakeOwner ? [OWNER] : [];
						return extra.length === 0 ? {} : { mention: extra };
					})()),
				},
				ctx,
			);
			if (deps.afterPost !== undefined) await deps.afterPost(result.message, channelId, ctx);
			const woke = result.delivery.delivered;
			return text(
				`已发到「${result.channel.title}」#${result.message.seq}。${
					woke.length === 0 ? "没有人被唤醒（这只是一句话）。" : `已唤醒：${woke.join("、")}。`
				}`,
			);
		};
	return say;
}
