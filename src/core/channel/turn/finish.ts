/**
 * 一轮的收尾：**答完了，就把结论放进频道**。
 *
 * 病根：`say` 是 agent 唯一能把话送进频道的手段，而模型经常在**最后一个回合**里
 * 直接把结论写成正文、然后结束 —— 一次 `say` 都不调。实测（2026-10-29）会话 2 的
 * transcript 里躺着最终回答，可 `all` 频道里一个字都没有，我那边看到的就是「问了没人理」。
 *
 * V3 之前靠一张安全网：订阅会话提交、看到正文就等 6 秒、再判断「他是不是还在跑」。
 * 那套有三个问题 —— 定时器猜时间、忙闲靠再查一次、结论该回哪个频道只能猜一个。
 * 现在提交结算本身就是信号（`done` 带 `answer`），所以收尾改成**结算驱动**：
 *
 * 1. 结算 `unanswered` → 频道里留一行痕（`unanswered.ts`）；
 * 2. 结算 `done` → 取出这次回答的条目，把最后一段正文按唤醒记录说出去。
 *
 * 唤醒记录是两层的（`turn/record.ts`）：私聊插话只改 `reply`，不动 `task`。所以：
 * - 正常一轮：结论回 `reply`；
 * - 插话一轮：先答私聊；如果私聊已经答过、任务频道还没汇报，这段正文就是
 *   任务的结论，回 `task`。
 *
 * 已经在目标频道说过话就不补（他调了 `say`，不需要替他重复）。
 */
import type { Conversation, EntryRecord, Harness } from "../../runtime/index.ts";
import { BACKGROUND_CONTEXT, type Context } from "../../runtime/index.ts";
import { ChannelDoc, emptyChannelState, type ChannelState, type Message } from "../types.ts";
import type { WakeRecord, WakeTarget } from "./record.ts";
import { postMessage, type PostDeps } from "../post.ts";
import { isPass } from "../tools/guards.ts";

/** 太短的不补：`好的`、`收到` 之类的残句补进频道只会更吵。 */
const TURN_MIN_CHARS = 6;

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
 * 这条唤醒之后，他在这个频道里说过话吗？`note` 是系统留痕，一般不算。
 *
 * `includeNotes` 给安静的一轮用（团队记忆沉淀）：那一轮的「话」**就是**留痕，不认它
 * 就会把同一句再补发一遍，频道里出现两条一模一样的账本。
 */
export function spokeAfterWake(
	list: readonly Message[],
	slug: string,
	sinceSeq: number,
	includeNotes = false,
): boolean {
	return list.some((item) => item.seq > sinceSeq && item.from === slug && (includeNotes || item.kind !== "note"));
}

/** 收尾要做的一切（拍平后方便测）。 */
export type FinishTurnInfo = {
	readonly slug: string;
	readonly conversation: Conversation;
	readonly answer: unknown;
	readonly wake: WakeRecord;
};

export type FinishTurn = (info: FinishTurnInfo, context?: Context) => Promise<void>;

/**
 * 从会话里取出结算给的那个条目。
 *
 * `Conversation` 没有「按 id 取条目」，但能倒序翻最近的条目；答案一定是最近的那几条之一
 * （结算就发生在它之后）。找不到就是 `undefined`，收尾跳过。
 */
async function answerEntry(
	conversation: Conversation,
	answer: unknown,
	context: Context,
): Promise<EntryRecord | undefined> {
	const page = await conversation.entries({ order: "descending" }, 30, undefined, context);
	return page.items.find((item) => String(item.id) === String(answer));
}

type TurnDeps = {
	readonly harness: Harness;
	readonly promptDir?: string | undefined;
	readonly conversationOf: PostDeps["conversationOf"];
	readonly rememberWake?: PostDeps["rememberWake"];
	readonly labelOf?: PostDeps["labelOf"];
	readonly wakeOf?: PostDeps["wakeOf"];
};

/**
 * 挑这次正文该落到哪个频道。
 *
 * 返回 `undefined` = 不需要补（已经在目标频道说过话，或那个频道进不去）。
 */
export function turnTarget(state: ChannelState, slug: string, wake: WakeRecord): WakeTarget | undefined {
	const spoke = (target: WakeTarget): boolean =>
		spokeAfterWake(state.messages[target.channelId] ?? [], slug, target.seq, wake.quiet === true);
	// 任务频道已经汇报过：这段正文不是结论，不补。
	if (spoke(wake.task)) return undefined;
	// 插话一轮里，私聊已经答过 → 最后这段是任务本身的结论，回任务频道。
	if (wake.task.channelId !== wake.reply.channelId && spoke(wake.reply)) return wake.task;
	// 正常一轮：私聊答过就不再补；没答过就替他答进`reply`。
	return spoke(wake.reply) ? undefined : wake.reply;
}

/**
 * 造一个收尾器。投递、我说话、沉淀三条路共用同一份 —— 收尾的行为只在这里写一次。
 */
export function createTurnFinisher(deps: TurnDeps): FinishTurn {
	return async (info, context = BACKGROUND_CONTEXT) => {
		const state = (await deps.harness.snapshot(ChannelDoc, context)) ?? emptyChannelState();
		const target = turnTarget(state, info.slug, info.wake);
		if (target === undefined) return;
		const channel = state.channels[target.channelId];
		// 频道不存在或他不在里面：不替他往进不去的地方说话。
		if (channel === undefined || !channel.members.includes(info.slug)) return;

		const entry = await answerEntry(info.conversation, info.answer, context);
		const text = finalTextOf(entry)?.trim();
		if (text === undefined || text.length < TURN_MIN_CHARS || isPass(text)) return;

		let written: Awaited<ReturnType<typeof postMessage>>;
		try {
			written = await postMessage(
				{
					harness: deps.harness,
					state,
					conversationOf: deps.conversationOf,
					...(deps.labelOf === undefined ? {} : { labelOf: deps.labelOf }),
					...(deps.promptDir === undefined ? {} : { promptDir: deps.promptDir }),
					...(deps.rememberWake === undefined ? {} : { rememberWake: deps.rememberWake }),
					...(deps.wakeOf === undefined ? {} : { wakeOf: deps.wakeOf }),
				},
				{
					channelId: target.channelId,
					from: info.slug,
					text,
					at: Date.now(),
					// 安静的一轮（团队记忆沉淀）：补发也走留痕，不刷群、不叫醒人。
					kind: info.wake.quiet === true ? "note" : "say",
					wake: false,
				},
				context,
			);
		} catch (error) {
			// 补发失败 = 内容丢了（他没 `say`，正文只在这个条目里）。必须留一行能被 live 数到的日志。
			console.warn(
				`[turn] ${info.slug} 答在会话里但补发失败：${error instanceof Error ? error.message : String(error)}`,
			);
			return;
		}
		// 留一行日志：这一条是系统替它发的，不是它自己说的。查「谁替我回了」时靠这行定位。
		console.log(
			`[turn] ${info.slug} 答在会话里但没说出来，已补发到 ${target.channelId}（唤醒自 #${info.wake.reply.seq}；落成 #${written.message.seq}「${written.message.text.slice(0, 20)}」）`,
		);
	};
}
