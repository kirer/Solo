/**
 * 记忆的写入日志：`members/<slug>/.memory-journal.jsonl`。
 *
 * 为什么需要它：`memory.md` 是**当前态**，只留最后一份。它可改是优点（记忆要被改得动），
 * 但「改了没痕迹」是缺点 —— agent 把密钥、一次性中间结论、错的判断写进去之后，
 * 现场只剩一坨文本，人只能肉眼找、手工删，还看不出是什么时候、被谁、从什么改成什么。
 *
 * 取舍：只记**最少能复盘**的四样（旧全文 / 新全文 / 谁写的 / 什么时候），不记 diff、
 * 不做回滚、不提供工具给模型读。它是给人事后查的东西，不是给模型看的第二份记忆。
 *
 * JSONL 而不是数组：写入是 append，不需要读全文再写回 —— 记忆写入是热路径，
 * 而且并发写数组会互相覆盖。
 */
import { join } from "node:path";
import { appendJsonLine } from "../runtime/io.ts";

export const JOURNAL_FILE = ".memory-journal.jsonl";

/** 日志文件路径。跟 `memory.md` 放在同一个目录，人一眼能找到。 @internal 仅测试 */
export function journalPath(dir: string): string {
	return join(dir, JOURNAL_FILE);
}

export type JournalEntry = {
	/** ISO 时间戳。 */
	readonly at: string;
	/** 谁的改动，例如 `remember` / `agent` / `human`。 */
	readonly by: string;
	/** 追加一条还是整篇重写。 */
	readonly op: "append" | "replace";
	/** 写入前的**整个**文件内容。 */
	readonly before: string;
	/** 写入后的整个文件内容。 */
	readonly after: string;
};

/**
 * 记一笔。**任何失败都只 warn，不抛** —— 日志是旁证，不能让它把主写入拖垮。
 *
 * 存全文而不是 diff：`memory.md` 有硬上限（见 `MEMORY_LIMITS`），一份几 KB，
 * 存全文的代价可以接受；换成 diff 就要自己算行、自己修，收益抵不上复杂度。
 */
export async function appendJournal(dir: string, entry: JournalEntry): Promise<void> {
	try {
		await appendJsonLine(journalPath(dir), entry);
	} catch (error) {
		console.warn(`[journal] 记忆留痕失败（不影响写入）：${error instanceof Error ? error.message : String(error)}`);
	}
}
