/**
 * 内置收尾策略：**答完了，就把结论放进频道**。
 *
 * 病根：`say` 是 agent 唯一能把话送进频道的手段，而模型经常在**最后一个回合**里
 * 直接把结论写成正文、然后结束 —— 一次 `say` 都不调。实测（2026-10-29）会话 2 的
 * transcript 里躺着最终回答，可 `all` 频道里一个字都没有，我那边看到的就是「问了没人理」。
 *
 * 这里只做**判断**（纯函数 + `defaultSettler`），写盘与补发在 `flow/settle.ts`：
 * 1. 取这一轮的答案条目与最后一段正文；
 * 2. 按两层唤醒记录挑频道（正常一轮回 `reply`，插话一轮可能回 `task`）；
 * 3. 说过话且只是复述 → 不补；说完又干了活 → 照补；
 * 4. 同一句已经在频道里 → 不补（多条提交各结算一次，只补一次）。
 */
import type { Context, EntryRecord } from "../../runtime/index.ts";
import type { ChannelState, Message } from "../../channel/types.ts";
import type { WakeRecord, WakeTarget } from "../../channel/turn/record.ts";
import { isPass } from "../../channel/tools/guards.ts";
import type { Settler } from "../ports.ts";
import type { AnswerEntry, EntryReader, SettleDecision, SettleFacts } from "../types.ts";

/** 从一条 `pi.assistant` 里取出「最终正文」——最后一个 text 块。 */
export function finalTextOf(entry: EntryRecord | undefined): string | undefined {
	if (entry === undefined) return undefined;
	let said: string | undefined;
	for (const message of entry.model ?? []) {
		if (message.role !== "assistant") continue;
		for (const block of message.content) {
			if (block.type !== "text" || block.text.trim().length === 0) continue;
			said = block.text;
		}
	}
	return said;
}

/**
 * 这条唤醒之后，他在这个频道里说过话吗？`note` 也算 —— 留痕是**他**发出来的。
 *
 * 以前这里不认 `note`。结果实测踩了两次：
 * 他自己写的一条留痕被当成「没说话」，收尾把同一句又补发一遍，频道里并排两条一样的话
 * （2026-11-02 周野的自我介绍）。别人的留痕（系统报到、我的通知）`from` 不是他，本来就不算。
 */
export function spokeAfterWake(list: readonly Message[], slug: string, sinceSeq: number): boolean {
	return list.some((item) => item.seq > sinceSeq && item.from === slug);
}

/**
 * 从会话里取出结算给的那个条目。
 *
 * `Conversation` 没有「按 id 取条目」，但能倒序翻最近的条目；答案一定是最近的那几条之一
 * （结算就发生在它之后）。找不到就是 `undefined`，收尾跳过。
 */
export async function answerEntry(
	conversation: EntryReader,
	answer: unknown,
	context: Context,
): Promise<AnswerEntry> {
	const page = await conversation.entries({ order: "descending" }, 30, undefined, context);
	return { entry: page.items.find((item) => String(item.id) === String(answer)), page: page.items };
}

/**
 * 这一轮的**最后一个动作**是不是已经交付了。
 *
 * `say` 与 `route` 都算：说话就是交付；`route` 是把消息交给了该看的人，
 * 频道里不该再多出一段「我把这条转给了谁」（ADR-063）。
 *
 * 是 → 最后那段正文就是那句话换了个说法（模型收工时爱把说过的再说一遍），不再补。
 * 不是 → 他说完之后又干了活（跑命令、写文件），最后那段是**新的结论**，得补。
 *
 * 只认「说过话没有」会把这种结论一起吞掉：实测 2026-11-02，陈默被叫醒只是报个到，
 * 他顺手把整个游戏写完了，频道里却只有开头那句自我介绍 —— 验收的人什么都不知道。
 */
export function saidLast(page: readonly EntryRecord[], answer: EntryRecord | undefined): boolean {
	const at = answer === undefined ? -1 : page.findIndex((item) => String(item.id) === String(answer.id));
	for (const entry of at === -1 ? page : page.slice(at)) {
		for (const message of entry.model ?? []) {
			if (message.role !== "assistant") continue;
			for (const block of [...message.content].reverse()) {
				if (block.type === "toolCall") return block.name === "say" || block.name === "route";
			}
		}
	}
	return false;
}

/**
 * 挑这次正文该落到哪个频道。
 *
 * 返回 `undefined` = 不需要补（已经在目标频道说过话，或那个频道进不去）。
 *
 * `restated` = 最后那段正文只是他刚说过那句的复述（见 `saidLast`）。不是复述就说明
 * 他答完之后又干了活，最后那段是新结论 —— 这时「说过话」不构成不补的理由。
 */
export function turnTarget(
	state: ChannelState,
	slug: string,
	wake: WakeRecord,
	restated = true,
): WakeTarget | undefined {
	// 「这一轮说过话没有」的起点是**这次**唤醒，不是 `task` 记的那个 seq：插话一轮继承的
	// `task` 可能是很多条之前的（ADR-099），拿它当起点会把上一轮的答案当成这一轮已经汇报过，
	// 于是这一轮的结论被吞掉（实测 2026-11-02：林越交了地址，频道里一个字都没有）。
	const since = (target: WakeTarget): number => Math.max(target.seq, wake.reply.seq);
	const spoke = (target: WakeTarget): boolean =>
		spokeAfterWake(state.messages[target.channelId] ?? [], slug, since(target));
	// 说过了，而且最后这段就是那句话的复述：不补。
	const said = (target: WakeTarget): boolean => spoke(target) && restated;
	// 任务频道已经汇报过：这段正文不是结论，不补。
	if (said(wake.task)) return undefined;
	// 插话一轮里，私聊已经答过 → 最后这段是任务本身的结论，回任务频道。
	if (wake.task.channelId !== wake.reply.channelId && spoke(wake.reply)) return wake.task;
	// 正常一轮：私聊答过就不再补；没答过就替他答进`reply`。
	return said(wake.reply) ? undefined : wake.reply;
}

/** 内置收尾策略：照上面四条判断，给出补发提议。 */
export function defaultSettler(): Settler {
	return {
		async decide(facts: SettleFacts): Promise<SettleDecision> {
			if (facts.text === undefined) return { kind: "silent", reason: "no-entry" };
			// 短回答照补：他对「你在吗」只答了个「在。」，吞掉就是频道里一片沉默。
			// 只吞哨兵（`[PASS]`）和空正文；重复的那一份由下面的同文判据挡。
			if (facts.text.length === 0 || isPass(facts.text)) return { kind: "silent", reason: "pass" };

			const target = turnTarget(facts.state, facts.slug, facts.wake, facts.saidLast);
			if (target === undefined) return { kind: "silent", reason: "no-target" };
			const channel = facts.state.channels[target.channelId];
			// 频道不存在或他不在里面：不替他往进不去的地方说话。
			if (channel === undefined || !channel.members.includes(facts.slug)) {
				return { kind: "silent", reason: "not-member" };
			}

			// 同一条答案会被**多条提交**各结算一次（报到 + 投递、投递 + 后台命令跑完），
			// 每一次收尾都看到同一个条目 —— 只补一次。实测 2026-11-02：频道里并排两条
			// 一模一样的话（周岚 #11/#12、沈舟 #15/#16），1 毫秒之隔，就是两次收尾。
			const duplicate = (facts.state.messages[target.channelId] ?? []).some(
				(item) => item.from === facts.slug && item.text.trim() === facts.text,
			);
			if (duplicate) return { kind: "silent", reason: "duplicate" };

			return { kind: "repost", channelId: target.channelId, text: facts.text };
		},
	};
}
