/**
 * 记忆 = `agents/<slug>/memory.md`，一份人手写的 Markdown。
 *
 * 为什么不是数据库：记忆的价值在于**被改**。老板说「以后别这样」，agent 应该能把
 * 那条改掉或者划掉；写在 Markdown 里，它自己 `write_skill`/直接改文件都行，
 * 而一行行 insert 的日志它是改不动的。
 *
 * 为什么不全塞进提示词：记忆会一直长。全塞进去等于每轮都为历史付费（而且长到
 * 一定长度后，模型对中段的内容注意力最差）。所以提示词里只放**目录**（每条的
 * 小节标题），要用哪一条由 agent 自己 `recall`。
 */
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const MEMORY_FILE = "memory.md";

/** 提示词里最多列几条标题。超过就只给「还有 N 条」，让它自己 recall。 */
export const DIGEST_LIMIT = 12;

export type MemorySection = {
	/** 小节标题（`## ` 之后那一行）。 */
	readonly heading: string;
	readonly body: string;
};

/** 读全文；不存在时返回 undefined（**不**自动建文件 —— 没记过就是没记过）。 */
export async function readMemory(agentDir: string): Promise<string | undefined> {
	try {
		return await readFile(join(agentDir, MEMORY_FILE), "utf8");
	} catch {
		return undefined;
	}
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

/** 追加一条（带日期小节）。返回写入后的全文。 */
export async function appendMemory(agentDir: string, text: string, at: Date = new Date()): Promise<string> {
	const existing = (await readMemory(agentDir)) ?? "# 记忆\n";
	const stamp = at.toISOString().slice(0, 10);
	const next = `${existing.trimEnd()}\n\n## ${stamp}\n${text.trim()}\n`;
	await writeFile(join(agentDir, MEMORY_FILE), next, "utf8");
	return next;
}

/** 整篇替换（agent 想重写自己的记忆时用）。 */
export async function writeMemory(agentDir: string, source: string): Promise<void> {
	await writeFile(join(agentDir, MEMORY_FILE), source.trimEnd() + "\n", "utf8");
}

/**
 * 提示词里的记忆目录。
 *
 * 标题重复很常见（同一个日期记了三条），所以带上序号让 agent 知道有几条。
 * 空记忆返回 undefined —— 提示词里出现「你还没有记忆」只是噪音。
 */
export function memoryDigest(source: string): string | undefined {
	const sections = sectionsOf(source);
	if (sections.length === 0) return undefined;
	const shown = sections.slice(-DIGEST_LIMIT);
	const lines = shown.map((section, index) => {
		const first = section.body.split("\n").find((line) => line.trim() !== "") ?? "";
		return `${index + 1}. ${section.heading}${first === "" ? "" : ` — ${first.slice(0, 60)}`}`;
	});
	const hidden = sections.length - shown.length;
	if (hidden > 0) lines.unshift(`（还有 ${hidden} 条更早的没列出）`);
	return lines.join("\n");
}
