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
 * 已经在目标频道说过话、而且最后那段就是那句话的复述，就不补（他调了 `say`，不需要
 * 替他重复）。说完之后又干了活的，最后那段是新结论，照补（`saidLast`）。
 */
import type { Conversation, EntryRecord, Harness } from "../../runtime/index.ts";
import { BACKGROUND_CONTEXT, type Context } from "../../runtime/index.ts";
import { createSerialGate } from "../../runtime/io.ts";
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
 * 这条唤醒之后，他在这个频道里说过话吗？`note` 也算 —— 留痕是**他**发出来的。
 *
 * 以前这里不认 `note`，只有安静的一轮（团队记忆沉淀）才认。结果实测踩了两次：
 * 他自己写的一条留痕被当成「没说话」，收尾把同一句又补发一遍，频道里并排两条一样的话
 * （2026-11-02 周野的自我介绍）。别人的留痕（系统报到、我的通知）`from` 不是他，本来就不算。
 */
export function spokeAfterWake(list: readonly Message[], slug: string, sinceSeq: number): boolean {
	return list.some((item) => item.seq > sinceSeq && item.from === slug);
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
): Promise<{ readonly entry: EntryRecord | undefined; readonly page: readonly EntryRecord[] }> {
	const page = await conversation.entries({ order: "descending" }, 30, undefined, context);
	return { entry: page.items.find((item) => String(item.id) === String(answer)), page: page.items };
}

/**
 * 这一轮的**最后一个动作**是不是 `say`。
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
				if (block.type === "toolCall") return block.name === "say";
			}
		}
	}
	return false;
}

type TurnDeps = {
	readonly harness: Harness;
	readonly promptDir?: string | undefined;
	readonly text?: PostDeps["text"];
	readonly conversationOf: PostDeps["conversationOf"];
	readonly rememberWake?: PostDeps["rememberWake"];
	readonly labelOf?: PostDeps["labelOf"];
	readonly wakeOf?: PostDeps["wakeOf"];
};

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

/**
 * 造一个收尾器。投递、我说话、沉淀三条路共用同一份 —— 收尾的行为只在这里写一次。
 */
export function createTurnFinisher(deps: TurnDeps): FinishTurn {
	// 两条提交同时结算会**并发**跑两次收尾（相隔 1 毫秒）：两次都快照到「频道里还没有这句」，
	// 于是同一句话发两遍（实测 2026-11-02 周楠 #15/#16）。整段串起来，后一次才看得见前一次。
	const serial = createSerialGate();
	return (info, context = BACKGROUND_CONTEXT) => serial(() => finishOnce(deps, info, context));
}

async function finishOnce(deps: TurnDeps, info: FinishTurnInfo, context: Context): Promise<void> {
	const state = (await deps.harness.snapshot(ChannelDoc, context)) ?? emptyChannelState();
	const { entry, page } = await answerEntry(info.conversation, info.answer, context);
	const target = turnTarget(state, info.slug, info.wake, saidLast(page, entry));
	if (target === undefined) return;
	const channel = state.channels[target.channelId];
	// 频道不存在或他不在里面：不替他往进不去的地方说话。
	if (channel === undefined || !channel.members.includes(info.slug)) return;

	const text = finalTextOf(entry)?.trim();
	if (text === undefined || text.length < TURN_MIN_CHARS || isPass(text)) return;

	// 同一条答案会被**多条提交**各结算一次（报到 + 投递、投递 + 后台命令跑完），
	// 每一次收尾都看到同一个条目 —— 只补一次。实测 2026-11-02：频道里并排两条
	// 一模一样的话（周岚 #11/#12、沈舟 #15/#16），1 毫秒之隔，就是两次收尾。
	const duplicate = (state.messages[target.channelId] ?? []).some(
		(item) => item.from === info.slug && item.text.trim() === text,
	);
	if (duplicate) return;

	let written: Awaited<ReturnType<typeof postMessage>>;
	try {
		written = await postMessage(
			{
				harness: deps.harness,
				state,
				conversationOf: deps.conversationOf,
				...(deps.labelOf === undefined ? {} : { labelOf: deps.labelOf }),
				...(deps.promptDir === undefined ? {} : { promptDir: deps.promptDir }),
				...(deps.text === undefined ? {} : { text: deps.text }),
				...(deps.rememberWake === undefined ? {} : { rememberWake: deps.rememberWake }),
				...(deps.wakeOf === undefined ? {} : { wakeOf: deps.wakeOf }),
			},
			{
				channelId: target.channelId,
				from: info.slug,
				text,
				at: Date.now(),
				// 安静的一轮（团队记忆沉淀）：补发也走留痕，不刷群、不叫醒人
				// （`note` 本来就不叫人）。正常一轮的补发**要照常叫醒** —— 他说的是
				// 「@周岚 请验收」，不叫醒等于把结论发进一个没人看的房间。
				// 实测 2026-11-02：沈舟的交付结论就是这么落进频道的，周岚没醒，团队停摆。
				kind: info.wake.quiet === true ? "note" : "say",
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
}
