/**
 * 记忆 = `members/<slug>/memory.md`，一份人手写的 Markdown。
 *
 * 为什么不是数据库：记忆的价值在于**被改**。我说「以后别这样」，agent 应该能把
 * 那条改掉或者划掉；写在 Markdown 里，它自己 `skills(action=write)`/直接改文件都行，
 * 而一行行 insert 的日志它是改不动的。
 *
 * 为什么不全塞进提示词：记忆会一直长。全塞进去等于每轮都为历史付费（而且长到
 * 一定长度后，模型对中段的内容注意力最差）。所以提示词里只放**目录**（每条的
 * 小节标题），要用哪一条由 agent 自己 `read_history(scope=memory)`。
 *
 * 切段、长度上限、密钥形状、目录预算这些**格式**的事在 `../base/memory.ts` —— 团队记忆
 * （`teams/<slug>/memory.md`）用的是同一份格式，不该由这个文件垄断。
 * 这里只剩「一个人怎么读写自己的记忆」：追加 / 整篇重写 / 留痕 / 时间线。
 */
import { join } from "node:path";
import { readTextOrUndefined } from "../../runtime/io.ts";
import { appendJournal } from "./journal.ts";
import { fill, type TextCatalog } from "../base/catalog.ts";
import {
	alreadyRecorded,
	appendOrExtendLastSection,
	dayOf,
	entryProblem,
	problemText,
	sectionsOf,
} from "../base/memory.ts";
import { createMemoryStore, type MemoryUpdate } from "../base/memory-store.ts";

export const MEMORY_FILE = "memory.md";

/** 一次写入的结果。`changed: false` 不是错误，是「这条已经有了」。 */
export type MemoryWrite = {
	readonly changed: boolean;
	/** 给人看的一句话（`remember` 直接转述给模型）。 */
	readonly message: string;
	/** 写入后的全文（没写就是写入前的全文）。 */
	readonly source: string;
};

/**
 * 写操作串成一条链。
 *
 * 读 → 拼 → 写 不是原子的：两个工具调用并发跑，后写的那个会用旧的 `existing` 覆盖
 * 掉前一个刚追加的条目（丢了，而且没有任何迹象）。链只保证顺序，不保证跨进程。
 */
const store = createMemoryStore();

/** 读全文；不存在时返回 undefined（**不**自动建文件 —— 没记过就是没记过）。 */
export async function readMemory(agentDir: string): Promise<string | undefined> {
	return store.read(join(agentDir, MEMORY_FILE));
}

/**
 * 追加一条（带日期小节）。`by` 是「谁写的」，只进 journal，不进正文。
 *
 * 同一天的第二条并进当天那个小节，不再新开一个同名 `## 日期`：提示词里的记忆目录
 * 是**按小节**列的，一天开一堆小节，12 条的窗口几天就用完了。
 */
export async function appendMemory(
	agentDir: string,
	text: string,
	at: Date = new Date(),
	by = "agent",
	catalog?: TextCatalog,
): Promise<MemoryWrite> {
	const fallback = `${fill(catalog, "org.memory.header")}\n`;
	return store.update(
		join(agentDir, MEMORY_FILE),
		(beforeSource): MemoryUpdate<MemoryWrite> => {
			const before = beforeSource ?? fallback;
			// 底线在写入这一层强制执行，而不是只靠调用方自觉：`remember` 是模型写的，
			// 它随时会用别的方式写文件；只要落盘的路只有这一条，规矩就守得住。
			const problem = entryProblem(text);
			if (problem !== undefined) {
				return {
					next: undefined,
					result: { changed: false, message: problemText(problem, text, catalog), source: before },
				};
			}
			if (alreadyRecorded(before, text)) {
				return {
					next: undefined,
					result: { changed: false, message: fill(catalog, "org.memory.duplicate"), source: before },
				};
			}
			const next = appendOrExtendLastSection(before, dayOf(at), text);
			return { next, result: { changed: true, message: fill(catalog, "org.memory.saved"), source: next } };
		},
		({ before, after }) =>
			appendJournal(agentDir, { at: at.toISOString(), by, op: "append", before: before ?? fallback, after }),
	);
}

/** 整篇替换（agent 想重写自己的记忆时用）。 */
export async function writeMemory(
	agentDir: string,
	source: string,
	by = "agent",
	catalog?: TextCatalog,
): Promise<MemoryWrite> {
	return store.update(
		join(agentDir, MEMORY_FILE),
		() => {
			const next = `${source.trimEnd()}\n`;
			return { next, result: { changed: true, message: fill(catalog, "org.memory.rewritten"), source: next } };
		},
		({ before, after }) =>
			appendJournal(agentDir, { at: new Date().toISOString(), by, op: "replace", before: before ?? "", after }),
	);
}

/* ── 时间线：这条记忆是什么时候、被谁、怎么进来的 ─────────────────────── */

/** 一条记忆的来历。`op` 是它最近一次变化是「新加的」还是「改过的」。 */
export type MemoryStamp = {
	/** ISO 时间。 */
	readonly at: string;
	/** 谁写的：`remember`（工具）/ `agent`（整篇重写）/ `human`（界面）。 */
	readonly by: string;
	readonly op: "add" | "edit";
};

/**
 * 从 `.memory-journal.jsonl` 反推出「每个小节最后一次变化」。
 *
 * 为什么能反推：日志每行都存了写入前后的**全文**（见 `journal.ts` 的取舍说明）。
 * 把相邻两行的 `before`/`after` 各切一次段，就能知道哪一节是新出现的、哪一节正文变了。
 *
 * 为什么要「最后一次」而不是全部历史：界面上一行记忆只需要一句「10-27 记下 · 我改过」，
 * 展开整条历史是调试需求，不是我的需求。历史本身还在日志里，要查直接看文件。
 *
 * 返回 `Map<heading, MemoryStamp>`。读不到日志、某行坏了都跳过 —— 时间线是旁证，
 * 缺了它记忆照常显示。
 */
export async function memoryTimeline(agentDir: string): Promise<ReadonlyMap<string, MemoryStamp>> {
	const stamps = new Map<string, MemoryStamp>();
	const raw = (await readTextOrUndefined(join(agentDir, ".memory-journal.jsonl"))) ?? "";
	if (raw === "") return stamps;
	for (const line of raw.split("\n")) {
		if (line.trim() === "") continue;
		let entry: { at?: unknown; by?: unknown; before?: unknown; after?: unknown };
		try {
			entry = JSON.parse(line) as typeof entry;
		} catch {
			continue;
		}
		const at = typeof entry.at === "string" ? entry.at : "";
		const by = typeof entry.by === "string" ? entry.by : "agent";
		const before = typeof entry.before === "string" ? entry.before : "";
		const after = typeof entry.after === "string" ? entry.after : "";
		if (at === "") continue;
		const previous = new Map(sectionsOf(before).map((section) => [section.heading, section.body]));
		for (const section of sectionsOf(after)) {
			const had = previous.get(section.heading);
			if (had === section.body) continue;
			stamps.set(section.heading, { at, by, op: had === undefined ? "add" : "edit" });
		}
		// 被删掉的小节不该继续留着时间戳：同名的标题以后再出现，应当算「新加的」。
		const kept = new Set(sectionsOf(after).map((section) => section.heading));
		for (const heading of [...stamps.keys()]) if (!kept.has(heading)) stamps.delete(heading);
	}
	return stamps;
}
