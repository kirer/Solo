/**
 * 记忆被用到哪儿了：旁挂文件 `members/<slug>/.memory-use.json`。
 *
 * 为什么不写进 `memory.md`：轮次是**机器账**，每轮都变，写进记忆正文等于每轮改一次
 * 用户能看见的文件，还会顶掉种子账本的 hash。放旁边，坏了删掉重算就行 —— 最坏的结果
 * 是「都当没被取到过」，那只是多召回一条，不会丢东西。
 *
 * 三样东西：
 *
 * - `seen`：标题 → 上次被取到的轮次。20 轮没被取到的会被强制召回一条（只给标题）。
 * - `round`：走到第几轮。每渲染一次带记忆的提示词 +1。
 * - `none` / `closing`：收尾时写 `none` 的次数 / 收尾总次数。给 Solo 一周看一次 ——
 *   超过一半说明这条闸在被敷衍，该改判据，而不是让它变成一个随手填的字。
 */
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

export type MemoryUse = {
	readonly seen: Readonly<Record<string, number>>;
	readonly round: number;
	readonly none: number;
	readonly closing: number;
};

export const MEMORY_USE_FILE = ".memory-use.json";

export const EMPTY_MEMORY_USE: MemoryUse = { seen: {}, round: 0, none: 0, closing: 0 };

function num(value: unknown, fallback = 0): number {
	return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function seenOf(raw: unknown): Record<string, number> {
	if (raw === null || typeof raw !== "object") return {};
	const out: Record<string, number> = {};
	for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
		if (typeof value === "number" && Number.isFinite(value)) out[key] = value;
	}
	return out;
}

/** 读不到 / 坏了都当空的：这份账不能挡住提示词渲染。 */
export async function readMemoryUse(dir: string): Promise<MemoryUse> {
	try {
		const raw = JSON.parse(await readFile(join(dir, MEMORY_USE_FILE), "utf8")) as Record<string, unknown>;
		return {
			seen: seenOf(raw.seen),
			round: num(raw.round),
			none: num(raw.none),
			closing: num(raw.closing),
		};
	} catch {
		return EMPTY_MEMORY_USE;
	}
}

export async function writeMemoryUse(dir: string, use: MemoryUse): Promise<void> {
	await writeFile(join(dir, MEMORY_USE_FILE), `${JSON.stringify(use)}\n`, "utf8");
}

/** 这一轮真的进了提示词的标题，记成「第 round 轮见过」。 */
export function markUsed(use: MemoryUse, picked: readonly string[]): MemoryUse {
	if (picked.length === 0) return { ...use, round: use.round + 1 };
	const seen = { ...use.seen };
	for (const heading of picked) seen[heading] = use.round + 1;
	return { ...use, round: use.round + 1, seen };
}

/** 收尾那一句：`lesson` 写了 `none` 也算回答了，但要记进账里（这就是那个比例）。 */
export function recordClosing(use: MemoryUse, lesson: string): MemoryUse {
	return { ...use, closing: use.closing + 1, none: lesson.trim() === "none" ? use.none + 1 : use.none };
}
