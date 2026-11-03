/**
 * 「派活」的领域形状：**一次会话来一个触发，一次接受立一张工单。**
 *
 * 这套词是照 dsh-superagent 的域模型搬过来的（Source → Trigger → Thread → Eval →
 * Mandate → Ticket → Assignment → Report → Attention），但**只搬概念，不搬存储**：
 *
 * - **Source / Thread 就是频道**。频道早就是一条不会断的消息流，再来一份「源」就是
 *   同一件事记两处。触发（`Trigger`）因此是**从消息派生**的，不落盘。
 * - **Eval 的判据写在 md 里**（`<userRoot>/policy.md`），代码只做机械的匹配与盖章。
 * - **Ticket 落盘**：它是「这个人答应要做的事」，必须活过一轮、活过重启。
 * - **Assignment 不是新东西**，它就是这个人的会话被叫醒。这里只记状态，不另起执行器。
 *
 * 一条要紧的分工：**只有接受能立工单**。消息满天飞不是活；被谁接受、按哪一版策略、
 * 用什么授权去做的，才是活。
 */
import { OWNER } from "../channel/types.ts";

/** 授权的强度：明说的，还是照规矩推出来的。 */
export type Strength = "explicit" | "inferred";

/**
 * 接受模式：推出来的活要不要真的干。
 *
 * - `off`：只认明说的（@ 我 / 私聊 / 跟着既有工单追问）。
 * - `observe`：推出来的只记录、不立工单（先看它想接什么）。
 * - `auto`：推出来的也照接。
 */
export type AcceptMode = "off" | "observe" | "auto";

/** 一条写在 `policy.md` 里的规矩。 */
export type Rule = {
	/** 小节标题。工单的授权里记的是它 —— 人改文案不改标题，授权就不失效。 */
	id: string;
	/** 正文：到底要求做什么。 */
	body: string;
};

/** 策略：整份 `policy.md` 解析出来的样子，外加一个内容版本。 */
export type Policy = {
	mode: AcceptMode;
	/** 内容版本（策略内容的短哈希）。改一个字就变；工单记的是它。 */
	version: string;
	/** 明着 @ 我 / 私聊派活，允许哪些人。`*` = 任何人。 */
	addressed: string[];
	/** 不 @ 也允许派活的人。只有他们的话会按规矩被「推出来」。 */
	inferred: string[];
	rules: Rule[];
};

/** 一个够格的触发：一条消息里「像是让我干活」的那部分事实。 */
export type Trigger = {
	/** `${channelId}#${seq}`：稳定、可读、能直接从消息算出来。 */
	id: string;
	channel: string;
	seq: number;
	/** 谁说的。我是 `owner`。 */
	from: string;
	/** 是不是人说的。agent 之间互相派活不算（它们没有授权）。 */
	human: boolean;
	/** 有没有点名找我：`mention` = @ 了我，`direct` = 私聊。 */
	addressed: "mention" | "direct" | undefined;
	at: number;
	text: string;
};

/** 闸门的结果。`accept` 才立工单；`observe` 只留痕；`ignore` 连痕迹都不必。 */
export type GateOutcome = "accept" | "observe" | "ignore";

export type Gate = {
	outcome: GateOutcome;
	/** 只有 `accept` / `observe` 有强度：明说的，还是推出来的。 */
	strength: Strength | undefined;
	/** 命中的规矩 id。挂进工单授权，重校验时按它判「这条约定还在不在」。 */
	rules: string[];
	/** 判的时候那版策略的版本号。立工单时原样盖章。 */
	policyVersion: string;
	/** 为什么是这个结果。给模型读的一句话。 */
	reason: string;
};

/** 授权：这张工单凭什么能做、能做什么。 */
export type Mandate = {
	/** 盖章那一刻的策略版本。 */
	policyVersion: string;
	strength: Strength;
	/** 范围：一句话说清这张工单能碰什么。越界要重新请示。 */
	scope: string;
	/** 命中的规矩 id。 */
	rules: string[];
	/** 谁派的。后续追问只认这个人。 */
	requester: string;
	/** 从哪条消息来的。 */
	trigger: string;
};

/** 一张工单的状态：`running` 之外的都是「等人」。 */
export type AssignmentState = "pending" | "running" | "ended";

/** 一次汇报。工单的历史就是这些汇报连起来。 */
export type ReportOutcome = "progress" | "waiting" | "ready" | "blocked" | "failed" | "dropped";

export type Report = {
	outcome: ReportOutcome;
	text: string;
	at: number;
};

/** 一个在等人回答的问题。有它，这张工单就停在「等人」。 */
export type Attention = {
	question: string;
	/** 要我选的选项（2–6 个）。没有选项 = 一个问题。 */
	options: string[];
	at: number;
};

export type Ticket = {
	/** `T1`、`T2`…会话内自增，可读、可抄进消息。 */
	id: string;
	title: string;
	/** 这条活发生在哪个频道（追问也在这里）。 */
	channel: string;
	mandate: Mandate;
	/** 谁来干。 */
	assignee: string;
	assignment: {
		state: AssignmentState;
		at: number;
		/** 试过几次（`retry` 加一）。 */
		attempts: number;
	};
	reports: Report[];
	/** 有它 = 停在「等人回答」。没有这个键 = 没在等问题。 */
	attention?: Attention;
	createdAt: number;
	/** 结束的时间与原因。没结束就不写这两个键（`undefined` 不是 JSON，文档存不下）。 */
	endedAt?: number;
	endedBy?: "completed" | "dropped" | "failed" | "human";
};

/** 闸门对一条触发留下的判断。留痕用：为什么没接，比接了什么更常被问。 */
export type Decision = {
	trigger: string;
	channel: string;
	outcome: GateOutcome;
	/** 推出来的是「按规矩」，明说的是「我说了就做」；`ignore` 不写。 */
	strength?: Strength;
	rules: string[];
	reason: string;
	/** 接出来的工单号（`observe` 没有）。 */
	ticket?: string;
	at: number;
};

export type WorkState = {
	tickets: Record<string, Ticket>;
	/** 只留最近 200 条：判断留痕是用来解释「刚才为什么没理你」的，不是账本。 */
	decisions: Decision[];
	nextTicket: number;
};

/** 留痕上限。超过就丢最老的 —— 这个文档是增量文档，不能无限长。 */
export const MAX_DECISIONS = 200;

/** 结束的工单最多留这么多张，再老就丢（没结束的一张都不丢）。 */
export const MAX_TICKETS = 200;

export function emptyWorkState(): WorkState {
	return { tickets: {}, decisions: [], nextTicket: 1 };
}

/**
 * 一条消息够不够格算「派活」。纯函数。
 *
 * 只看事实：谁说的、是不是人、有没有点名、在不在工单的追问里。**不做判断** ——
 * 该不该接是策略与模型的事，这里只负责把「不像派活」的先筛掉。
 */
export function triggerOf(
	channel: { readonly id: string; readonly members: readonly string[] },
	message: {
		readonly seq: number;
		readonly from: string;
		readonly at: number;
		readonly text: string;
		readonly mentions: readonly string[];
		readonly kind: string;
	},
	self: string,
): Trigger {
	const direct = channel.id.startsWith("dm:") && channel.members.length === 2;
	return {
		id: `${channel.id}#${message.seq}`,
		channel: channel.id,
		seq: message.seq,
		from: message.from,
		human: message.from === OWNER,
		addressed: message.mentions.includes(self) ? "mention" : direct ? "direct" : undefined,
		at: message.at,
		text: message.text,
	};
}
