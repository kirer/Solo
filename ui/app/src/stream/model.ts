/**
 * 消息 → 行模型。**纯函数**，输入是消息数组，输出是「屏幕上一行一行是什么」。
 *
 * 这个文件只做两件事：**真实消息怎么排**（时间分隔、一个人半分钟内连发算一段），以及
 * **正在跑的那一轮**（`live` 行）插在哪儿。系统留痕不画（ADR-047），只有后台命令那条
 * 折成一行。消息只有 `chat` / `note` 两种 kind —— 旧数据已在投影层归一（ADR-061）。
 *
 * 过程（思考 / 跑命令 / 改文件）只进「后台任务」面板，不进聊天流（ADR-062）：这里
 * 不接轨迹，屏幕上只有说出口的话和一条正在跑的占位。
 *
 * 两条来自我原话的规矩：
 * 1. **同一人半分钟内连发算一段** —— 气泡角连起来、时间只留第一个；
 * 2. **超过半小时（或跨天）插一条时间分隔**。
 */

import { isNeed } from "../rows.ts";
import type { Message, Turn } from "../api/types.ts";
import { clockTime, dayLabel, sameDay } from "../lib/format.ts";

/** 同一个人连续发言：超过这个间隔就不再算「同一段」（头像与名字重画一次）。 */
const GROUP_MS = 2 * 60 * 1000;
/** 半分钟内连着说的几句算一段：气泡角连起来。 */
const CONT_MS = 30 * 1000;
/** 超过这个间隔（或跨天）插一条时间分隔。 */
const DIVIDER_MS = 30 * 60 * 1000;

export type Row =
	| { type: "divider"; key: string; label: string }
	/**
	 * 「以下是新的」：进这一屏之前没读过的那些消息的起点。
	 *
	 * 它和 `divider` 分开，是因为它要能被「跳到未读」认出来（`data-row="unread"`），
	 * 而且文案与样式都不是时间分隔。
	 */
	| { type: "unread"; key: string; count: number }
	| {
			type: "say";
			key: string;
			message: Message;
			/** 同一人连发：不画头像和名字。 */
			grouped: boolean;
			/** 半分钟内的续话：气泡角连起来、时间不画。 */
			cont: boolean;
			need: boolean;
	  }
	| { type: "note"; key: string; message: Message }
	/**
	 * 正在跑的一轮（派生，不是消息）：他在这个频道被叫醒、还没回话。
	 *
	 * 跑完就消失 —— 真实回复由 `create` 落进来，同一件事不画两条。
	 */
	| { type: "live"; key: string; turn: Turn }
	/**
	 * 占位行：这一页还在路上，先占住它在 `seq` 序列里的位置（设计 §3.4）。
	 *
	 * **实体，不是虚拟的**：`visibility:hidden` 那种「看不见的占位」按不通过处理
	 * （Solo 2026-11-11）。它是真的行、真的高度、真的进 `offsetOf`，用户看得到它在那儿等着。
	 * 一页 = 一屏 = N 条定高：`count` 就是这一页要补多少条。
	 */
	| { type: "placeholder"; key: string; count: number; failed: boolean }
	/**
	 * 「到最上面了」：真的到第 1 条了（`hasMore === false`）。
	 *
	 * 验收第 21 条：到了底再往上滚，**不许和卡死看起来一样**。它和占位行占同一个位置
	 * （一页的位置，也就是列表最上面），所以「补不上的那一下」和「已经没有更早的了」
	 * 在屏幕上长得是两句话，不是一片空白。
	 */
	| { type: "ceiling"; key: string };

export type BuildInput = {
	messages: readonly Message[];
	/** 这个频道里正在跑、还没回话的轮次（`status === "running"` 且没有 `replySeq`）。 */
	running?: readonly Turn[];
	now?: number;
	/**
	 * 还在路上的那一页（设计 §3.4）：给条数就在这一屏最上面插占位行。
	 *
	 * `null` = 没有在补的页；`failed` = 上一次补页失败了，占位行换成「没加载出来 · 重试」。
	 */
	pending?: { count: number; failed: boolean } | null;
	/**
	 * 真的到头了：不再有更早的消息了（验收第 21 条）。
	 *
	 * 和 `pending` 互斥 —— 一个说「正在补」，一个说「没得补了」，同时出现只会让人看不懂。
	 */
	atCeiling?: boolean;
	/**
	 * 进这一屏时的未读起点：`seq` 大于它的第一条消息之前插一条「以下是新的」。
	 *
	 * 由调用方在切频道那一刻定住（不是每帧算）—— 否则读着读着线就往下跑，
	 * 变成「永远有新消息」。
	 */
	unreadBefore?: number;
};

/** 时间分隔上的字：今天只写时刻，昨天写「昨天 HH:MM」，更早写「M月D日」。 */
function dividerLabel(at: number, now: number): string {
	return `${dayLabel(at, now)} ${clockTime(at)}`;
}

export function buildRows({
	messages,
	running = [],
	now = Date.now(),
	unreadBefore,
	pending = null,
	atCeiling = false,
}: BuildInput): Row[] {
	const rows: Row[] = [];
	// 到头了：列表最上面那一句「到最上面了」。和占位行占同一个位置，二者不会同时出现。
	if (atCeiling && pending === null) rows.push({ type: "ceiling", key: "ceiling" });
	// 占位行在最前面：它占的是「比这一屏所有消息都早」的那段 `seq`（设计 §3.4）。
	if (pending !== null && pending.count > 0) {
		for (let index = 0; index < pending.count; index += 1) {
			rows.push({ type: "placeholder", key: `ph-${String(index)}`, count: pending.count, failed: pending.failed });
		}
	}
	let previous: Message | undefined;
	let previousSay: Message | undefined;
	let unreadPlaced = false;

	const divider = (message: Message): void => {
		rows.push({ type: "divider", key: `d-${message.seq}`, label: dividerLabel(message.at, now) });
		// 分隔之后不再算「同一段」：屏幕上已经断开了。
		previousSay = undefined;
	};

	for (const message of messages) {
		// 系统留痕与沉淀账本不进聊天流（ADR-047）：报到、没答上来、看门狗、记忆记账都是
		// 灰字，一屏对话里插五六条，读起来像日志。数据还在库里、`chats` 读得到。
		// 后台命令跑完的留痕例外：它折成一行，点开才是输出。
		if (message.kind === "note" && message.noteOf !== "run") continue;

		// 「以下是新的」只插一次，插在第一条真正没读过的消息前面。
		// 未读的条数按「seq 大于起点、且不是系统留痕」算，和列表里那个徽章同口径。
		if (unreadBefore !== undefined && unreadPlaced === false && message.seq > unreadBefore) {
			unreadPlaced = true;
			const count = messages.filter((item) => item.seq > unreadBefore && !(item.kind === "note" && item.noteOf !== "run")).length;
			rows.push({ type: "unread", key: `u-${message.seq}`, count });
		}

		if (previous !== undefined) {
			const gap = message.at - previous.at;
			if (gap > DIVIDER_MS || !sameDay(previous.at, message.at)) divider(message);
		}
		previous = message;

		if (message.kind === "note") {
			rows.push({ type: "note", key: `n-${message.seq}`, message });
			previousSay = undefined;
			continue;
		}

		const gap = previousSay === undefined ? Number.NaN : message.at - previousSay.at;
		const grouped = previousSay !== undefined && previousSay.fromSlug === message.fromSlug && gap <= GROUP_MS && gap >= 0;
		rows.push({
			type: "say",
			key: `s-${message.seq}`,
			message,
			grouped,
			cont: grouped && gap <= CONT_MS,
			need: isNeed(message),
		});
		previousSay = message;
	}

	return insertLive(rows, messages, running);
}

/**
 * 把 `live` 行插进消息流：位置就是回复将来会落的地方。
 *
 * 收掉的判据有两条，缺一不可：
 * 1. `replySeq` 出现了（服务端认了这一轮已经回话）；
 * 2. 同一个人在这条触发消息之后**已经说过话** —— `trace` 的结算帧比 `create` 慢半拍时，
 *    没有这一条就会同时看到占位和真回复。
 */
function insertLive(rows: Row[], messages: readonly Message[], running: readonly Turn[]): Row[] {
	const live = [...running]
		.filter((turn) => turn.replySeq === undefined)
		.filter(
			(turn) =>
				!messages.some(
					(message) => message.fromSlug === turn.slug && message.seq > turn.seq && message.kind !== "note",
				),
		)
		.sort((left, right) => left.startedAt - right.startedAt);
	if (live.length === 0) return rows;

	for (const turn of live) {
		const row: Row = { type: "live", key: `l-${turn.channelId}-${String(turn.seq)}-${turn.slug}`, turn };
		let at = rows.findIndex((item) => {
			const time = atOf(item);
			return time !== undefined && time > turn.startedAt;
		});
		if (at === -1) at = rows.length;
		else if (at > 0 && rows[at - 1]!.type === "divider") at -= 1;
		rows.splice(at, 0, row);
	}
	return rows;
}

/** 一行在时间轴上的位置（分隔行没有时刻）。 */
function atOf(row: Row): number | undefined {
	return row.type === "say" || row.type === "note" ? row.message.at : undefined;
}
