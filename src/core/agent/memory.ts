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
 * ## 机器守的三条底线
 *
 * 模型判断不了这三件事，所以写在代码里（其余都交给它自己）：一条不能太长（否则
 * 一条记忆吃掉整个目录预算）、不能重复、不能是密钥。密钥那条最要紧 —— 记忆会被
 * 拼进每一轮提示词，一条 key 写进来就是永久泄露（`secrets.ts` 是最后一道网，
 * 这里是最前面那道）。
 */
import { join } from "node:path";
import { createSerialGate, readTextOrUndefined, writeTextAt } from "../runtime/io.ts";
import { appendJournal } from "./journal.ts";

export const MEMORY_FILE = "memory.md";

/** 提示词里最多列几条标题。超过就只给「还有 N 条」，让它自己 read_history。 */
export const DIGEST_LIMIT = 12;

/**
 * 硬上限（字符）。`entry` 是**一条**，`main` 是记忆目录在提示词里的预算（不是文件上限）。
 *
 * 为什么不是文件上限：文件写超了只能拒写，而拒写意味着「这条经验丢了」。目录预算
 * 收窄则是无损的 —— 条目还在文件里，`read_history` / `file` 仍读得到。
 */
export const MEMORY_LIMITS = { entry: 300, main: 4_000 } as const;

export type MemorySection = {
	/** 小节标题（`## ` 之后那一行）。 */
	readonly heading: string;
	readonly body: string;
};

/** 一次写入的结果。`changed: false` 不是错误，是「这条已经有了」。 */
export type MemoryWrite = {
	readonly changed: boolean;
	/** 给人看的一句话（`remember` 直接转述给模型）。 */
	readonly message: string;
	/** 写入后的全文（没写就是写入前的全文）。 */
	readonly source: string;
};

/** 读全文；不存在时返回 undefined（**不**自动建文件 —— 没记过就是没记过）。 */
export async function readMemory(agentDir: string): Promise<string | undefined> {
	return readTextOrUndefined(join(agentDir, MEMORY_FILE));
}

/**
 * 按 `## ` 切段。第一段（文件开头到第一个 `##` 之前）是标题/导语，不算一条记忆。
 */
export function sectionsOf(source: string): readonly MemorySection[] {
	const out: MemorySection[] = [];
	const lines = source.split("\n");
	let heading: string | undefined;
	let buffer: string[] = [];
	const flush = (): void => {
		if (heading === undefined) return;
		out.push({ heading, body: buffer.join("\n").trim() });
	};
	for (const line of lines) {
		if (line.startsWith("## ")) {
			flush();
			heading = line.slice(3).trim();
			buffer = [];
			continue;
		}
		if (heading !== undefined) buffer.push(line);
	}
	flush();
	return out;
}

/**
 * 删掉一节记忆，重建整篇；没有这一节返回 undefined。
 *
 * 为什么不用「找到标题那一行、把它到下一节之间的行切掉」（旧做法）：那样要求调用方
 * 自己再拼一遍剩余内容，实测把**删中间一节**写成了「后面的节被吞掉」和「同一节出现
 * 两次」两种坏文件 —— 记忆是模型长期唯一的上下文，写坏一次就是永久丢事实。
 *
 * 所以这里只认一个口径：`sectionsOf` 怎么分段，就怎么重建。序言（第一个 `## ` 之前
 * 的标题/导语）原样保留，剩下的节按原顺序拼回。标题按 `trim()` 后比较，与
 * `sectionsOf` 一致 —— 否则「标题带尾随空格」的那节永远删不掉。
 */
export function removeSection(source: string, heading: string): string | undefined {
	const wanted = heading.trim();
	if (wanted === "") return undefined;
	const sections = sectionsOf(source);
	if (!sections.some((section) => section.heading === wanted)) return undefined;
	const lines = source.split("\n");
	const firstHeading = lines.findIndex((line) => line.startsWith("## "));
	const preamble = (firstHeading < 0 ? lines : lines.slice(0, firstHeading)).join("\n").trimEnd();
	const kept = sections.filter((section) => section.heading !== wanted).map((section) => `## ${section.heading}\n${section.body}`);
	return [preamble, ...kept].filter((part) => part.trim() !== "").join("\n\n").trimEnd();
}

/** 长得像密钥的东西。宁可误报（让它换个说法），不可漏报（一条 key 写进提示词就撤不回了）。 */
const SECRET_SHAPES = [
	/\b(sk-[A-Za-z0-9_-]{16,}|ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{16}|xox[baprs]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{30,}|sk_live_[A-Za-z0-9]{10,}|hf_[A-Za-z0-9]{20,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.)/,
	// 中文里「这是密码：xxxxxxxxxxxx」这种写法：词之后跟 12 位以上不带空白的连续串。
	/(?:密码|密钥|私钥|口令|token|api[ _-]?key)\s*[:：=＝是]?\s*[^\s]{12,}/i,
];

/**
 * 这条记忆能不能写。返回人话错误，或 undefined（能写）。
 *
 * 文案是给模型看的：说清「什么不对」和「怎么改」，别只说「invalid」。
 */
export function entryProblem(text: string): string | undefined {
	const trimmed = text.trim();
	if (trimmed === "") return "这条记忆是空的。";
	if (trimmed.length > MEMORY_LIMITS.entry) {
		return `这条记忆 ${MEMORY_LIMITS.entry} 字上限，现在 ${trimmed.length} 字。请说得更短，或拆成两条。`;
	}
	if (SECRET_SHAPES.some((shape) => shape.test(trimmed))) {
		return "这看起来是密钥或密码，绝对不能写进记忆。记忆会被拼进每一轮提示词。";
	}
	return undefined;
}

/** 规范化：去首尾空白 + 折叠内部空白。去重只关心「说的是不是同一件事」，不关心怎么换行。 */
function normalized(text: string): string {
	return text.trim().replace(/\s+/g, " ");
}

/**
 * 这条内容是不是已经记过了。
 *
 * 既比整段（一条记忆一个正文）也比每一行（同一天的几条并在一个小节里）。
 * 重复记忆的代价不是磁盘，是**挤掉一条真正不同的**：目录只有那么点预算。
 */
function alreadyRecorded(source: string, text: string): boolean {
	const target = normalized(text);
	return sectionsOf(source).some(
		(section) =>
			normalized(section.body) === target || section.body.split("\n").some((line) => normalized(line) === target),
	);
}

/**
 * 写操作串成一条链。
 *
 * 读 → 拼 → 写 不是原子的：两个工具调用并发跑，后写的那个会用旧的 `existing` 覆盖
 * 掉前一个刚追加的条目（丢了，而且没有任何迹象）。链只保证顺序，不保证跨进程。
 */
const serialized = createSerialGate();

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
): Promise<MemoryWrite> {
	return serialized(async () => {
		const before = (await readMemory(agentDir)) ?? "# 记忆\n";
		// 底线在写入这一层强制执行，而不是只靠调用方自觉：`remember` 是模型写的，
		// 它随时会用别的方式写文件；只要落盘的路只有这一条，规矩就守得住。
		const problem = entryProblem(text);
		if (problem !== undefined) return { changed: false, message: problem, source: before };
		if (alreadyRecorded(before, text)) {
			return { changed: false, message: "这条记忆已经有了。", source: before };
		}
		const body = text.trim();
		const stamp = at.toISOString().slice(0, 10);
		const sections = sectionsOf(before);
		const last = sections[sections.length - 1];
		const next =
			last !== undefined && last.heading === stamp
				? `${before.trimEnd()}\n${body}\n`
				: `${before.trimEnd()}\n\n## ${stamp}\n${body}\n`;
		await writeTextAt(join(agentDir, MEMORY_FILE), next);
		await appendJournal(agentDir, { at: at.toISOString(), by, op: "append", before, after: next });
		return { changed: true, message: "已记下。", source: next };
	});
}

/** 整篇替换（agent 想重写自己的记忆时用）。 */
export async function writeMemory(agentDir: string, source: string, by = "agent"): Promise<MemoryWrite> {
	return serialized(async () => {
		const before = (await readMemory(agentDir)) ?? "";
		const next = `${source.trimEnd()}\n`;
		await writeTextAt(join(agentDir, MEMORY_FILE), next);
		await appendJournal(agentDir, { at: new Date().toISOString(), by, op: "replace", before, after: next });
		return { changed: true, message: "已重写。", source: next };
	});
}

/**
 * 提示词里的记忆目录。
 *
 * 标题重复很常见（同一个日期记了几条），所以带上序号让 agent 知道有几条。
 * 空记忆返回 undefined —— 提示词里出现「你还没有记忆」只是噪音。
 *
 * 取法：从最新往回拿，条数和字符各有一道上限。条数上限防「一百条一行」，字符
 * 上限防「十二条长文」—— 只有一道的活，总有一种记忆能把它打穿。
 */
export function memoryDigest(source: string): string | undefined {
	const sections = sectionsOf(source);
	if (sections.length === 0) return undefined;
	const lines: string[] = [];
	let used = 0;
	for (let index = sections.length - 1; index >= 0; index -= 1) {
		const section = sections[index];
		if (section === undefined) break;
		const first = section.body.split("\n").find((line) => line.trim() !== "") ?? "";
		const line = `${lines.length + 1}. ${section.heading}${first === "" ? "" : ` — ${first.slice(0, 60)}`}`;
		// 最新那条无论如何要给出去，否则目录会只剩一句「还有 N 条」。
		if (lines.length > 0 && (lines.length >= DIGEST_LIMIT || used + line.length > MEMORY_LIMITS.main)) break;
		lines.unshift(line);
		used += line.length + 1;
	}
	const hidden = sections.length - lines.length;
	if (hidden > 0) lines.unshift(`（还有 ${hidden} 条更早的没列出）`);
	return lines.join("\n");
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
