/**
 * 记忆文件的**格式**：怎么切段、一条多长、什么不能写、提示词里给多少目录。
 *
 * 个人记忆（`members/<slug>/memory.md`）和团队记忆（`teams/<slug>/memory.md`）是同一份
 * Markdown 格式，只是归属不同 —— 所以这一层不认识「谁」，只认识文本。读写在哪里、
 * 给谁记、什么时候沉淀，分别住在 `member/memory.ts` 与 `team/memory.ts`。
 *
 * 放在 `documents/base/`：这里只有 Markdown 的机械事（`##` 切段、目录预算、密钥形状），
 * 零 IO、零业务；上面两份实现共用它，但不互相 import。
 *
 * ## 机器守的三条底线
 *
 * 模型判断不了这三件事，所以写在代码里（其余都交给它自己）：一条不能太长（否则
 * 一条记忆吃掉整个目录预算）、不能是密钥、目录要截断。密钥那条最要紧 —— 记忆会被
 * 拼进每一轮提示词，一条 key 写进来就是永久泄露（`core/secrets.ts` 是最后一道网，
 * 这里是最前面那道）。
 */
import { fill, type TextCatalog } from "./catalog.ts";

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

/** 规范化：去首尾空白 + 折叠内部空白。去重只关心「说的是不是同一件事」。 */
function normalized(text: string): string {
	return text.trim().replace(/\s+/g, " ");
}

/**
 * 这条内容是不是已经记过了。
 *
 * 既比整段（一条记忆一个正文）也比每一行（同一天的几条并在一个小节里）。
 * 重复记忆的代价不是磁盘，是**挤掉一条真正不同的**：目录只有那么点预算。
 */
export function alreadyRecorded(source: string, text: string): boolean {
	const target = normalized(text);
	return sectionsOf(source).some(
		(section) =>
			normalized(section.body) === target || section.body.split("\n").some((line) => normalized(line) === target),
	);
}

/**
 * 本地日历日（`YYYY-MM-DD`），记忆小节的标题用它。
 *
 * 不能用 `toISOString().slice(0, 10)`：那是 UTC 日，东八区 0–8 点记下的一条会落到
 * 昨天的小节里（凌晨写记忆 → 标题显示前一天）。
 */
export function dayOf(at: Date): string {
	const month = String(at.getMonth() + 1).padStart(2, "0");
	const day = String(at.getDate()).padStart(2, "0");
	return `${at.getFullYear()}-${month}-${day}`;
}

/** 新开一节（团队记忆：每条都带日期和记录人，永远新开）。 */
export function appendNewSection(source: string, heading: string, body: string): string {
	return `${source.trimEnd()}\n\n## ${heading}\n${body.trim()}\n`;
}

/**
 * 最后一节同名时接在它后面，否则新开（个人记忆：同一天的第二条并进当天小节）。
 *
 * 提示词里的记忆目录是**按小节**列的，一天开一堆小节，12 条的窗口几天就用完了。
 */
export function appendOrExtendLastSection(source: string, heading: string, body: string): string {
	const sections = sectionsOf(source);
	const last = sections[sections.length - 1];
	const text = body.trim();
	return last !== undefined && last.heading === heading
		? `${source.trimEnd()}\n${text}\n`
		: `${source.trimEnd()}\n\n## ${heading}\n${text}\n`;
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

/** 这条记忆为什么不能写（机械判据，不带文案）。`undefined` = 能写。 */
export type MemoryProblem = "empty" | "too-long" | "secret";

/** 这条记忆能不能写。 */
export function entryProblem(text: string): MemoryProblem | undefined {
	const trimmed = text.trim();
	if (trimmed === "") return "empty";
	if (trimmed.length > MEMORY_LIMITS.entry) return "too-long";
	if (SECRET_SHAPES.some((shape) => shape.test(trimmed))) return "secret";
	return undefined;
}

/** 判据 → 一句人话（给模型/界面）。文案在 `seed/text/tools.md`。 */
export function problemText(problem: MemoryProblem, text: string, catalog?: TextCatalog): string {
	const key = `org.memory.${problem}`;
	const message = fill(catalog, key, { limit: MEMORY_LIMITS.entry, length: text.trim().length });
	return message === "" ? `memory: ${problem}` : message;
}

/**
 * 提示词里的记忆目录。三段拼：
 *
 * 1. **相关**：按当前任务命中（中文二元组 + 英文单词）打分，命中的给标题 + 正文首行一小段。
 *    命中 0 的不进 —— 无关的任务不该被一堆旧经验灌满。
 * 2. **新近保底**：最近 3 条无论如何给标题，否则「刚记的东西看不见」。
 * 3. **强制召回**：连续 20 轮没被取到过的那条（最久没想起的，最多一条），只给一行标题。
 *
 * `query` 拿不到时（老机器的唤醒记录里没有任务正文）退回旧取法：从新往旧最多 12 条。
 * 这条降级路径必须有 —— 宁可按老办法给，也不要在没线索时把记忆整个关掉。
 */
export type MemoryDigestOptions = {
	/** 当前任务的正文（从唤醒记录里取，见 `AgentPaths.task`）。空 = 退回旧取法。 */
	readonly query?: string;
	/** 标题 → 上次被取到的轮次（旁挂 `members/<slug>/.memory-use.json`）。 */
	readonly used?: Readonly<Record<string, number>>;
	/** 当前轮次。 */
	readonly round?: number;
};

export type MemoryDigestPlan = {
	readonly text: string;
	/** 这次真的进了提示词的标题。调用方据此更新「上次被取到的轮次」。 */
	readonly picked: readonly string[];
};

/** 最近几条保底。 */
export const DIGEST_RECENT = 3;
/** 连续多少轮没被取到就强制召回一条。 */
export const DIGEST_STALE = 20;
/** 相关命中时正文给多少字。 */
const DIGEST_RELATED = 200;

/**
 * 任务正文切成可匹配的词：中文取连续二元组（「音色 迁移」也能对上「音色迁移」），
 * 英文 / 数字取 3 个字符以上的词。返回空表示没有可用线索。
 */
export function queryTerms(query: string): readonly string[] {
	const lower = query.toLowerCase();
	const terms = new Set<string>();
	for (const word of lower.match(/[a-z0-9][a-z0-9_-]{2,}/g) ?? []) terms.add(word);
	for (const run of lower.match(/[\u4e00-\u9fa5]+/g) ?? []) {
		for (let index = 0; index + 2 <= run.length; index += 1) terms.add(run.slice(index, index + 2));
	}
	return [...terms];
}

/** 这一节能被匹配到的材料：标题 + 正文前 200 字。 */
function materialOf(section: MemorySection): string {
	return `${section.heading}\n${section.body.slice(0, DIGEST_RELATED)}`;
}

function termsHit(material: string, terms: readonly string[]): number {
	let hits = 0;
	for (const term of terms) if (material.includes(term)) hits += 1;
	return hits;
}

/** 旧取法：从最新往回，条数和字符各有一道上限。`query` 拿不到时用它。 */
function recentDigest(source: string, catalog?: TextCatalog): string | undefined {
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
	if (hidden > 0) lines.unshift(fill(catalog, "org.memory.more", { count: hidden }));
	return lines.join("\n");
}

export function planMemoryDigest(
	source: string,
	catalog?: TextCatalog,
	options: MemoryDigestOptions = {},
): MemoryDigestPlan | undefined {
	const sections = sectionsOf(source);
	if (sections.length === 0) return undefined;
	const terms = queryTerms(options.query ?? "");
	if (terms.length === 0) {
		const fallback = recentDigest(source, catalog);
		return fallback === undefined ? undefined : { text: fallback, picked: [] };
	}

	const round = options.round ?? 0;
	const used = options.used ?? {};
	const lineOf = new Map<number, string>();
	let usedChars = 0;
	const note = (index: number, line: string): boolean => {
		const existing = lineOf.get(index);
		if (existing !== undefined) return existing.length >= line.length;
		if (lineOf.size >= DIGEST_LIMIT) return false;
		if (lineOf.size > 0 && usedChars + line.length > MEMORY_LIMITS.main) return false;
		lineOf.set(index, line);
		usedChars += line.length + 1;
		return true;
	};
	const lineFor = (index: number, chars: number): string | undefined => {
		const section = sections[index];
		if (section === undefined) return undefined;
		const first = section.body.split("\n").find((line) => line.trim() !== "") ?? "";
		return `${section.heading}${first === "" ? "" : ` — ${first.slice(0, chars)}`}`;
	};

	// 一、相关：命中多的先给，同分取更新的。
	const scored = sections
		.map((section, index) => ({ index, score: termsHit(materialOf(section), terms) }))
		.filter((item) => item.score > 0)
		.sort((a, b) => b.score - a.score || b.index - a.index);
	for (const item of scored) {
		const line = lineFor(item.index, DIGEST_RELATED);
		if (line === undefined) continue;
		if (!note(item.index, line)) break;
	}

	// 二、新近保底：最近 3 条。满了就停，别把保底挤掉相关命中。
	for (let index = sections.length - 1; index >= Math.max(0, sections.length - DIGEST_RECENT); index -= 1) {
		const line = lineFor(index, 60);
		if (line === undefined) continue;
		note(index, line);
	}

	// 三、强制召回：最久没被取到的一条，只给标题一行。
	const stale = sections
		.map((section, index) => ({ index, last: used[section.heading] ?? 0 }))
		.filter((item) => !lineOf.has(item.index) && round - item.last >= DIGEST_STALE)
		.sort((a, b) => a.last - b.last)[0];
	if (stale !== undefined) {
		const section = sections[stale.index];
		if (section !== undefined) note(stale.index, section.heading);
	}

	const indexes = [...lineOf.keys()].sort((a, b) => a - b);
	const lines = indexes.map((index, order) => `${order + 1}. ${lineOf.get(index) ?? ""}`);
	const hidden = sections.length - indexes.length;
	if (hidden > 0) lines.unshift(fill(catalog, "org.memory.more", { count: hidden }));
	return {
		text: lines.join("\n"),
		picked: indexes.map((index) => sections[index]?.heading ?? "").filter((heading) => heading !== ""),
	};
}

export function memoryDigest(source: string, catalog?: TextCatalog, options?: MemoryDigestOptions): string | undefined {
	return planMemoryDigest(source, catalog, options)?.text;
}
