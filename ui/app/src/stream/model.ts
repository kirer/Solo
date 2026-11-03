/**
 * 消息 → 行模型。**纯函数**，输入是消息数组，输出是「屏幕上一行一行是什么」。
 *
 * 这个文件只做两件事：**真实消息怎么排**（时间分隔、一个人半分钟内连发算一段），以及
 * **正在跑的那一轮**（`live` 行）插在哪儿。系统留痕不画（ADR-047），只有后台命令那条
 * 折成一行。消息只有 `chat` / `note` 两种 kind —— 旧数据已在投影层归一（ADR-061）。
 *
 * 过程（思考 / 跑命令 / 改文件）**是回复的一部分**：每一轮在它的结论上面留一块折叠的
 * 过程块（`process` 行），答案照旧是一条消息。它们由轨迹派生，不是消息，不落第二份。
 * 正在跑的那一轮还在 `live` 行（ADR-046）；跑完 `process` 行接上。
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
	| {
			type: "say";
			key: string;
			message: Message;
			/** 同一人连发：不画头像和名字。 */
			grouped: boolean;
			/** 半分钟内的续话：气泡角连起来、时间不画。 */
			cont: boolean;
			need: boolean;
			/**
			 * 这一轮的过程（思考 / 命令 / 文件），画在气泡上面。
			 *
			 * 派生，不是消息：条目在库里，`steps` 展开时才拉。没有过程（0 步）就没有这个键。
			 */
			turn?: Turn;
	  }
	| { type: "note"; key: string; message: Message }
	/**
	 * 正在跑的一轮（派生，不是消息）：他在这个频道被叫醒、还没回话。
	 *
	 * 跑完就消失 —— 真实回复由 `create` 落进来，同一件事不画两条。
	 */
	| { type: "live"; key: string; turn: Turn };

export type BuildInput = {
	messages: readonly Message[];
	/** 这个频道里正在跑、还没回话的轮次（`status === "running"` 且没有 `replySeq`）。 */
	running?: readonly Turn[];
	/** 这个频道里已经回话的轮次：按 `replySeq` 挂到对应那条消息上面。 */
	settled?: readonly Turn[];
	now?: number;
};

/** 时间分隔上的字：今天只写时刻，昨天写「昨天 HH:MM」，更早写「M月D日」。 */
function dividerLabel(at: number, now: number): string {
	return `${dayLabel(at, now)} ${clockTime(at)}`;
}

export function buildRows({ messages, running = [], settled = [], now = Date.now() }: BuildInput): Row[] {
	const rows: Row[] = [];
	let previous: Message | undefined;
	let previousSay: Message | undefined;

	const divider = (message: Message): void => {
		rows.push({ type: "divider", key: `d-${message.seq}`, label: dividerLabel(message.at, now) });
		// 分隔之后不再算「同一段」：屏幕上已经断开了。
		previousSay = undefined;
	};

	// `replySeq` → 那一轮。同一轮只挂一次；有两条同 seq 的（理论上不会有）取最早的。
	const byReply = new Map<number, Turn>();
	for (const turn of [...settled].sort((left, right) => left.startedAt - right.startedAt)) {
		if (turn.replySeq === undefined || turn.stepCount === 0) continue;
		if (!byReply.has(turn.replySeq)) byReply.set(turn.replySeq, turn);
	}

	for (const message of messages) {
		// 系统留痕与沉淀账本不进聊天流（ADR-047）：报到、没答上来、看门狗、记忆记账都是
		// 灰字，一屏对话里插五六条，读起来像日志。数据还在库里、`chats` 读得到。
		// 后台命令跑完的留痕例外：它折成一行，点开才是输出。
		if (message.kind === "note" && message.noteOf !== "run") continue;

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

		// 过程属于这一轮：它画在回复的气泡上面，读者先看怎么做、再看结论。
		const turn = byReply.get(message.seq);
		if (turn !== undefined) previousSay = undefined;
		const gap = previousSay === undefined ? Number.NaN : message.at - previousSay.at;
		const grouped = previousSay !== undefined && previousSay.fromSlug === message.fromSlug && gap <= GROUP_MS && gap >= 0;
		rows.push({
			type: "say",
			key: `s-${message.seq}`,
			message,
			grouped,
			cont: grouped && gap <= CONT_MS,
			need: isNeed(message),
			...(turn === undefined ? {} : { turn }),
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
