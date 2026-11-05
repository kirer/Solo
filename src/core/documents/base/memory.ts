/**
 * 记忆文件的**格式**：怎么切段、一条多长、什么不能写、提示词里给多少目录。
 *
 * 个人记忆（`members/<slug>/memory.md`）和团队记忆（`teams/<slug>/memory.md`）是同一份
 * Markdown 格式，只是归属不同 —— 所以这一层不认识「谁」，只认识文本。读写在哪里、
 * 给谁记、什么时候沉淀，分别住在 `person/memory.ts` 与 `team/memory.ts`。
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
 * 提示词里的记忆目录。
 *
 * 标题重复很常见（同一个日期记了几条），所以带上序号让 agent 知道有几条。
 * 空记忆返回 undefined —— 提示词里出现「你还没有记忆」只是噪音。
 *
 * 取法：从最新往回拿，条数和字符各有一道上限。条数上限防「一百条一行」，字符
 * 上限防「十二条长文」—— 只有一道的活，总有一种记忆能把它打穿。
 */
export function memoryDigest(source: string, catalog?: TextCatalog): string | undefined {
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
