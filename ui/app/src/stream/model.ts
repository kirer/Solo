/**
 * 消息 → 行模型。**纯函数**，输入是消息数组，输出是「屏幕上一行一行是什么」。
 *
 * ADR-081 之后这个文件只剩一件事：**真实消息怎么排** —— 时间分隔、一个人半分钟内连发
 * 算一段（气泡角连起来）、系统 note 单独一行。过程投影（think/tool/work）、step 合并、
 * 占位、草稿、底部活动行都删掉了：数据模型里没有「他正在做什么」，界面也就不画。
 *
 * 两条来自我原话的规矩：
 * 1. **同一人半分钟内连发算一段** —— 气泡角连起来、时间只留第一个；
 * 2. **超过半小时（或跨天）插一条时间分隔**。
 */

import { isNeed } from "../rows.ts";
import type { Message, Turn } from "../api/types.ts";
import { clockTime, dayLabel, sameDay } from "../lib/format.ts";

/** 说人话的 kind 走 say 行。其余（含历史里的 think/tool/work）不走这一行。 */
const SAY_KINDS = new Set(["say", "chat", "report", "decision", "question"]);

/**
 * 历史库里还有的「过程行」kind（ADR-081 已停止产生，旧数据不清理）。
 *
 * 处理方式：**直接过滤掉**，不画成普通行。理由：这些是机器执行留痕（`$ ls`、
 * 「读了一个文件」），画成普通消息会被误读成「他说了这句话」，也正好是 ADR-081 要
 * 消除的噪音。它们仍然在库里、`chats(action=read)` 读得到，只是这一屏不显示。
 */
const LEGACY_PROCESS_KINDS = new Set(["think", "tool", "work", "step"]);

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
	  }
	| { type: "note"; key: string; message: Message }
	/**
	 * 私聊工作记录里的一轮（他在某个频道被叫醒、做了什么）。
	 *
	 * 群聊不画这一行：群聊只留结论，过程在他的私聊里看。
	 */
	| { type: "work"; key: string; turn: Turn; channelTitle: string };

export type BuildInput = {
	messages: readonly Message[];
	now?: number;
};

export type WorkInput = {
	messages: readonly Message[];
	/** 这个人在所有频道里的轮次（私聊页）。 */
	work: readonly Turn[];
	/** 频道 id → 标题：工作行要写「这轮发生在哪个频道」。 */
	titles: ReadonlyMap<string, string>;
	now?: number;
};

/** 时间分隔上的字：今天只写时刻，昨天写「昨天 HH:MM」，更早写「M月D日」。 */
function dividerLabel(at: number, now: number): string {
	return `${dayLabel(at, now)} ${clockTime(at)}`;
}

export function buildRows({ messages, now = Date.now() }: BuildInput): Row[] {
	const rows: Row[] = [];
	let previous: Message | undefined;
	let previousSay: Message | undefined;

	const divider = (message: Message): void => {
		rows.push({ type: "divider", key: `d-${message.seq}`, label: dividerLabel(message.at, now) });
		// 分隔之后不再算「同一段」：屏幕上已经断开了。
		previousSay = undefined;
	};

	for (const message of messages) {
		if (LEGACY_PROCESS_KINDS.has(message.kind)) continue;

		if (previous !== undefined) {
			const gap = message.at - previous.at;
			if (gap > DIVIDER_MS || !sameDay(previous.at, message.at)) divider(message);
		}
		previous = message;

		if (SAY_KINDS.has(message.kind)) {
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
			continue;
		}

		if (message.kind === "note") {
			rows.push({ type: "note", key: `n-${message.seq}`, message });
			previousSay = undefined;
			continue;
		}

		// 未命中的 kind：不画、不占高。（宁可少一行，也不添一种卡片。）
	}

	return rows;
}

/** 一行在时间轴上的位置（分隔行没有时刻）。 */
function atOf(row: Row): number | undefined {
	return row.type === "say" || row.type === "note" ? row.message.at : undefined;
}

/**
 * 私聊页的行模型：**私聊消息 + 这个人在所有频道里的工作轮次**，按时间合在一起。
 *
 * 群聊用 `buildRows`（只有消息）；私聊用这个 —— 他是在团队频道里被叫醒干活的，那几轮
 * 也要出现在这里，读者才不用为了看他干了什么再翻回群聊。
 *
 * 插入点按 `startedAt` 找第一条更晚的消息；紧贴在那条消息的时间分隔之前，分隔行才仍然
 * 属于它下面那条消息。
 */
export function buildWorkRows({ messages, work, titles, now = Date.now() }: WorkInput): Row[] {
	const rows = buildRows({ messages, now });
	for (const turn of [...work].sort((left, right) => left.startedAt - right.startedAt)) {
		// 只说了话、没做事的一轮不画 work 壳：说的话已经在消息流里，空壳会让人以为他干了件大事。
		if (turn.stepCount === 0) continue;
		const row: Row = {
			type: "work",
			key: `w-${turn.channelId}-${String(turn.seq)}-${turn.slug}`,
			turn,
			channelTitle: titles.get(turn.channelId) ?? turn.channelId,
		};
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
