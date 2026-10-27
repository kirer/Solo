/**
 * 项目记忆 = `projects/<slug>/memory.md`。
 *
 * 与个人记忆（`agents/<slug>/memory.md`）的区别只有**归属**，写法完全一样：
 * 个人记忆回答「我学到什么」，项目记忆回答「这个摊子上发生过什么」。
 *
 * 为什么必须有项目记忆：项目换人是很正常的（负责人离职、员工调岗）。事实如果只写在
 * 某个人的记忆里，那个人一走就带走了。写在项目目录下，换谁接手都还在 —— 这是项目
 * 与「一堆私人笔记本」的根本区别。
 *
 * 谁能写：**这个项目的人能写**。判据是 `identity.md` 里的 `project: <slug>`，
 * 不是职位。理由：项目记忆的价值就在一线的人随手记，设审批等于把它变成汇报。
 *
 * 谁能读：全公司。理由同上 —— 记忆是资产，藏起来只会重复踩坑。
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DIGEST_LIMIT, memoryDigest, sectionsOf, type MemorySection } from "../agent/memory.ts";

export const PROJECT_MEMORY_FILE = "memory.md";

/** `projects/<slug>/memory.md` 的绝对路径。 */
export function projectMemoryPath(projectsRoot: string, project: string): string {
	return join(projectsRoot, project, PROJECT_MEMORY_FILE);
}

/** 读全文；不存在返回 undefined（没记过就是没记过，不自动建空文件）。 */
export async function readProjectMemory(projectsRoot: string, project: string): Promise<string | undefined> {
	try {
		return await readFile(projectMemoryPath(projectsRoot, project), "utf8");
	} catch {
		return undefined;
	}
}

/**
 * 追加一条。小节标题带日期**和记录人**：
 * 「2026-10-27 林越」。看到是谁写的，后来的争议才有地方追。
 */
export async function appendProjectMemory(
	projectsRoot: string,
	project: string,
	input: { readonly text: string; readonly by?: string; readonly at?: Date },
): Promise<string> {
	const path = projectMemoryPath(projectsRoot, project);
	const existing =
		(await readProjectMemory(projectsRoot, project)) ?? `# 项目记忆：${project}\n`;
	const stamp = (input.at ?? new Date()).toISOString().slice(0, 10);
	const who = input.by === undefined ? "" : ` ${input.by}`;
	const next = `${existing.trimEnd()}\n\n## ${stamp}${who}\n${input.text.trim()}\n`;
	// 目录可能还不存在：项目记忆可以先于 `README.md` 写下（先记一条再补说明是常见的）。
	await mkdir(join(projectsRoot, project), { recursive: true });
	await writeFile(path, next, "utf8");
	return next;
}

/** 整篇替换（谁都能改，改错了看 git / 看历史）。 */
export async function writeProjectMemory(projectsRoot: string, project: string, source: string): Promise<void> {
	await mkdir(join(projectsRoot, project), { recursive: true });
	await writeFile(projectMemoryPath(projectsRoot, project), source.trimEnd() + "\n", "utf8");
}

/**
 * 提示词里的项目记忆目录。
 *
 * 复用个人记忆的切段与摘要逻辑 —— 同一套格式，只是路径不同。**故意不合并**成
 * 一个函数，因为将来项目记忆可能要多一个「谁记的」维度，而个人记忆不需要。
 */
export function projectMemoryDigest(source: string): string | undefined {
	return memoryDigest(source);
}

/** 按 `## ` 切段（给 `read_project_memory` 全文渲染用）。 */
export function projectMemorySections(source: string): readonly MemorySection[] {
	return sectionsOf(source);
}

// ── 自动沉淀 ────────────────────────────────────────────────────────────

/**
 * 哪些消息值得进项目记忆。
 *
 * 判据只有两条，都是**形状**判据，不含语义判断：
 * 1. 消息在项目频道里（调用方保证）。
 * 2. `kind` 是 `decision` 或 `report` —— 也就是「拍板了」和「交付了」两类。
 *
 * 为什么不在代码里判语义（比如「这句话是不是结论」）：那是模型该干的事，代码判
 * 只会判错。代码能可靠判的只有「这本来就被标成了结论」。所以真正的沉淀动作由
 * 一个**周期任务**在模型侧完成：把新出现的 decision/report 交给它，它决定写什么。
 * 这里的函数只负责回答「有哪些还没沉淀」。
 */
export const SETTLE_KINDS: readonly string[] = ["decision", "report"];

/** 沉淀游标的键：`项目 slug` → 已经沉淀到第几条 seq。 */
export function settleKey(project: string): string {
	return `settle:${project}`;
}

/** 一条待沉淀的消息（已经过 `kind` 过滤）。 */
export type SettleCandidate = {
	readonly seq: number;
	readonly from: string;
	readonly text: string;
	readonly kind: string;
};

/**
 * 挑出还没沉淀的消息。纯函数，方便单测。
 *
 * `since` 是上次沉淀到的 seq；缺省 0 表示这个项目一条都没沉淀过。
 * 备注：**发件人是 `owner` 的也留着**——老板在项目频道拍板是最该进记忆的东西。
 */
export function settleCandidates(
	messages: readonly { readonly seq: number; readonly from: string; readonly text: string; readonly kind: string }[],
	since: number,
): readonly SettleCandidate[] {
	return messages
		.filter((message) => message.seq > since && SETTLE_KINDS.includes(message.kind))
		.map((message) => ({ seq: message.seq, from: message.from, text: message.text, kind: message.kind }));
}

/**
 * 给模型的沉淀指令。
 *
 * 明确要求「只写你确认的、能长期成立的事」，并给出反例 —— 否则模型会把每条消息
 * 都复述一遍，项目记忆立刻变成频道历史的副本（那等于没记）。
 */
export function renderSettlePrompt(project: string, candidates: readonly SettleCandidate[]): string {
	const lines = candidates.map(
		(item) => `- #${item.seq} [${item.kind}] ${item.from}：${item.text.replace(/\s+/g, " ").trim()}`,
	);
	return [
		`项目 \`${project}\` 的频道里出现了以下${candidates.length}条「拍板」或「交付」。`,
		"请挑出**能长期成立**的事实写进项目记忆（用 remember_project）：",
		"",
		...lines,
		"",
		"要求：",
		"1. 只写结论与约定，不写过程、不写谁在几点说了什么。",
		"2. 一条一句，能脱离上下文单独读懂。",
		"3. 过几天就失效的东西不要写（比如「今天先这样」）。",
		"4. 没有值得写的就不写，直接说「没有需要沉淀的」。",
	].join("\n");
}

export { DIGEST_LIMIT };
