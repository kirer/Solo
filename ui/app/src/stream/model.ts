/**
 * 消息 → 行模型。**纯函数**，输入是消息数组，输出是「屏幕上一行一行是什么」。
 *
 * 为什么单独抽出来：上一个版本把这件事混在「造 DOM 结点」的流程里，
 * 于是顺序、分组、占位填充、时间分隔各自散在几百行命令式代码中，
 * 表现为「过程行跑到头像上面」「同一段活画成两组」「刷新后少了几句」等等。
 * 抽成纯函数之后，这些规矩可以单独测（`test/ui/stream-model.test.ts`），
 * React 只负责把模型画出来。
 *
 * 三条来自老板原话的规矩：
 * 1. **过程行归属它后面那句话** —— 先看见结论，想知道细节再展开；
 * 2. **同一段活只画一个组头** —— 一个人干一件事能留十几条 think/tool；
 * 3. **同一人半分钟内连发算一段** —— 气泡角连起来、时间只留第一个。
 */

import {
	eventLabel,
	groupHeader,
	isEventKind,
	isExpiredPlaceholder,
	isStalePlaceholder,
	isNeed,
	runStartAt,
	shouldOpenByDefault,
} from "../rows.ts";
import type { Message } from "../api/types.ts";
import { dayLabel, relTime, sameDay } from "../lib/format.ts";

/** 说人话的 kind 走 say 行。其余（think/tool/work/note）各有归宿，未命中的不画。 */
const SAY_KINDS = new Set(["say", "chat", "report", "decision", "question"]);

/** 同一个人连续发言：超过这个间隔就不再算「同一段」。 */
const GROUP_MS = 2 * 60 * 1000;
/** 半分钟内连着说的几句算一段：气泡角连起来。与后端 `STEP_MERGE_MS` 同数。 */
const CONT_MS = 30 * 1000;
/** 超过这个间隔（或跨天）插一条时间分隔。 */
const DIVIDER_MS = 30 * 60 * 1000;

export type EventGroupRow = {
	type: "events";
	key: string;
	slug: string;
	label: string;
	entries: Message[];
	/** 这一段还在跑吗（决定展开态与是否显示计时）。 */
	running: boolean;
	startAt: number;
	endAt: number;
	/** 「想 3 · 命令 8」那半句。 */
	mix: string;
	/** 读屏与 tooltip 用的完整描述（带名字和用时）。 */
	describe: string;
	defaultOpen: boolean;
};

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
	| { type: "processing"; key: string; message: Message; startAt: number }
	| EventGroupRow;

export type BuildInput = {
	messages: readonly Message[];
	channelKind: string;
	/** 正在跑的那个 slug（来自 presence 推导）。用来判定组头要不要显示计时。 */
	runningSlug?: string | undefined;
	now?: number;
};

export type BuildOutput = {
	rows: Row[];
	/** 底部那行「正在执行 · 12s」。没有在跑就是 null。 */
	activity: { key: string; phrase: string; startAt: number; slug: string; label: string } | null;
};

/** 时间分隔上的字：今天只写时刻，昨天写「昨天 HH:MM」，更早写「M月D日」。 */
function dividerLabel(at: number, now: number): string {
	const day = dayLabel(at, now);
	const time = new Date(at).toLocaleTimeString("zh-CN", { hour12: false, hour: "2-digit", minute: "2-digit" });
	return `${day} ${time}`;
}

function mixOf(entries: readonly Message[]): string {
	const counts = new Map<string, number>();
	for (const entry of entries) {
		const label = eventLabel(entry);
		counts.set(label, (counts.get(label) ?? 0) + 1);
	}
	// 多的在前，同数按出现顺序 —— 稳定，不随 Map 迭代顺序漂。
	const ordered = [...counts.entries()].sort((left, right) => right[1] - left[1]);
	return ordered.map(([label, count]) => `${label} ${count}`).join(" · ");
}

export function buildRows({ messages, channelKind, runningSlug, now = Date.now() }: BuildInput): BuildOutput {
	const rows: Row[] = [];
	let previous: Message | undefined;
	let previousSay: Message | undefined;
	/** 每个人攒着的过程行：等他说出那句话之后才画出来。 */
	const buffers = new Map<string, Message[]>();

	const flush = (slug: string, running: boolean): void => {
		const entries = buffers.get(slug);
		if (entries === undefined || entries.length === 0) return;
		buffers.delete(slug);
		const last = entries[entries.length - 1];
		if (last === undefined) return;
		const startAt = runStartAt(messages, entries);
		const endAt = last.at;
		rows.push({
			type: "events",
			key: `ev-${slug}-${last.seq}`,
			slug,
			label: last.fromLabel,
			entries,
			running,
			startAt,
			endAt,
			mix: mixOf(entries),
			describe: groupHeader({ name: last.fromLabel, running, startAt, endAt, now }),
			defaultOpen: shouldOpenByDefault({ channelKind, running, isLast: false }),
		});
	};

	const flushAll = (): void => {
		for (const slug of [...buffers.keys()]) flush(slug, false);
	};

	messages.forEach((message, index) => {
		if (previous !== undefined) {
			const gap = message.at - previous.at;
			// 时间分隔只在「两条消息之间」才成立。刚 flush 完过程组再插一条分隔，
			// 屏幕上会变成「查看过程 / 今天 03:46 / 同一句话」，读起来像重复。
			const last = rows[rows.length - 1];
			if ((gap > DIVIDER_MS || !sameDay(previous.at, message.at)) && last?.type !== "events") {
				flushAll();
				rows.push({ type: "divider", key: `d-${message.seq}`, label: dividerLabel(message.at, now) });
			}
		}
		previous = message;

		// 占位：过期（放了太久）或失效（他自己后来又说了一句）都不再画。
		if (message.processing === true) {
			if (isExpiredPlaceholder(message, now) || isStalePlaceholder(message, messages, index)) return;
			flushAll();
			rows.push({
				type: "processing",
				key: `p-${message.seq}`,
				message,
				startAt: message.startedAt ?? message.at,
			});
			return;
		}

		if (isEventKind(message.kind)) {
			const list = buffers.get(message.fromSlug) ?? [];
			list.push(message);
			buffers.set(message.fromSlug, list);
			return;
		}

		if (SAY_KINDS.has(message.kind)) {
			const grouped =
				previousSay !== undefined &&
				previousSay.fromSlug === message.fromSlug &&
				message.at - previousSay.at <= GROUP_MS &&
				message.at - previousSay.at >= 0;
			const cont = grouped && previousSay !== undefined && message.at - previousSay.at <= CONT_MS;
			rows.push({
				type: "say",
				key: `s-${message.seq}`,
				message,
				grouped,
				cont,
				need: isNeed(message),
			});
			// 过程行画在**这句话后面**：先给结论，细节收进可展开的组里。
			flush(message.fromSlug, false);
			previousSay = message;
			return;
		}

		if (message.kind === "note") {
			flushAll();
			rows.push({ type: "note", key: `n-${message.seq}`, message });
			previousSay = undefined;
			return;
		}

		// 未命中的 kind：不画、不占高。（旧前端也是这个口径：宁可少一行，不添一种卡片。）
	});

	// 结尾还攒着过程行 = 这一轮还没说完，或者他正在干。这两者都该看得见。
	const runningSlugOfTail = runningSlug;
	const tailSlugs = [...buffers.keys()];
	for (const slug of tailSlugs) {
		const running = slug === runningSlugOfTail || (runningSlugOfTail === undefined && slug === tailSlugs[tailSlugs.length - 1]);
		const entries = buffers.get(slug) ?? [];
		const before = rows.length;
		flush(slug, running);
		// 「私聊里最后一段默认展开」需要知道它是不是最后一段 —— flush 里拿不到，这里改。
		const last = rows[rows.length - 1];
		if (rows.length > before && last !== undefined && last.type === "events") {
			rows[rows.length - 1] = { ...last, defaultOpen: shouldOpenByDefault({ channelKind, running, isLast: true }) };
		}
		if (running && entries.length > 0) {
			const head = entries[entries.length - 1];
			if (head !== undefined) {
				const startAt = runStartAt(messages, entries);
				return {
					rows,
					activity: {
						key: `a-${head.seq}`,
						phrase: activityPhraseOf(head),
						startAt,
						slug,
						label: head.fromLabel,
					},
				};
			}
		}
	}

	return { rows, activity: null };
}

/** 底部活动行那句话：在想 / 在跑什么命令。 */
function activityPhraseOf(message: Message): string {
	if (message.kind === "think") return "在想事情";
	if (message.kind === "work") {
		const text = String(message.text ?? "").trim();
		if (text.startsWith("$")) return text.replace(/^\$\s*/, "").split(/\r?\n/)[0] ?? "执行命令";
		return "执行命令";
	}
	return "在使用工具";
}

/** 相对时间（列表里用）。抽在这里是为了让测试能传固定的 now。 */
export const relativeTime = relTime;
