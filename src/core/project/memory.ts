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
import { DIGEST_LIMIT, entryProblem, memoryDigest, sectionsOf, type MemorySection } from "../agent/memory.ts";

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
/**
 * 写项目记忆的串行闸。
 *
 * 与个人记忆同一个理由：`appendProjectMemory` 是「读全文 → 拼 → 写回」，两个 agent 同时
 * 追加就会丢一条。项目频道里本来就常有两个人同时被叫醒，这条不是理论风险。
 */
let writing: Promise<unknown> = Promise.resolve();

function serialized<T>(operation: () => Promise<T>): Promise<T> {
	const next = writing.then(operation, operation);
	writing = next.catch(() => undefined);
	return next;
}

/**
 * 追加一条。**超长/空/像密钥的条目直接拒写并抛错**，不做静默截断。
 *
 * 为什么本项目要管长度：个人记忆早就有 300/4000 的两道闸，项目记忆一条都没有，实测
 * 某个项目的 `memory.md` 涨到 7524 字符、约 37 条 —— 而提示词里的目录只放得下十几条，
 * 后面的条目对模型形同不存在，同时又有两处半句话（写坏的截断）留在文件里。记忆没人管
 * 就会变成垃圾场：能写、能读、读不到重点。
 */
export async function appendProjectMemory(
	projectsRoot: string,
	project: string,
	input: { readonly text: string; readonly by?: string; readonly at?: Date },
): Promise<string> {
	const problem = entryProblem(input.text);
	if (problem !== undefined) throw new Error(problem);
	return serialized(async () => {
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
	});
}

/** 整篇替换（谁都能改，改错了看 git / 看历史）。 */
export async function writeProjectMemory(projectsRoot: string, project: string, source: string): Promise<void> {
	// 整篇替换不做逐条校验（那是「把文件改小」的合法路径），但要走同一条串行闸，
	// 否则它可能和 append 交错，把刚追加的一条覆盖掉。
	return serialized(async () => {
		await mkdir(join(projectsRoot, project), { recursive: true });
		await writeFile(projectMemoryPath(projectsRoot, project), source.trimEnd() + "\n", "utf8");
	});
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

/** 按 `## ` 切段（给 `recall(scope=project)` 全文渲染用）。 */
export function projectMemorySections(source: string): readonly MemorySection[] {
	return sectionsOf(source);
}

// ── 自动沉淀 ────────────────────────────────────────────────────────────

/**
 * 哪些消息值得进项目记忆：**所有还没看过的新消息**，代码不按 `kind` 也不按语义过滤。
 *
 * 判据只剩两条**形状**判据：
 * 1. 消息在项目频道里（调用方保证）。
 * 2. `seq > since`，且不是「即将被问的那个人」自己说的（把他的话再发回给他没意义）。
 *
 * 为什么去掉「只看 decision/report」：项目频道里大量结论是普通发言，那些永远不会
 * 被沉淀。什么值得写进记忆是模型的判断，代码判只会判错 —— 那条规则写在公司技能
 * 「记忆整理」里，人和 agent 都能改、都能迭代，改它不用改代码。
 * 这里的函数只负责回答「有哪些还没沉淀」。
 */

/** 沉淀游标的键：`项目 slug` → 已经沉淀到第几条 seq。 */
export function settleKey(project: string): string {
	return `settle:${project}`;
}

/** 一条待沉淀的消息。 */
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
 * `exclude` = 这次要去整理的人；他自己说的话不用再念给他听。
 */
export function settleCandidates(
	messages: readonly { readonly seq: number; readonly from: string; readonly text: string; readonly kind: string }[],
	since: number,
	exclude?: string,
): readonly SettleCandidate[] {
	return messages
		.filter((message) => message.seq > since && message.from !== exclude)
		.map((message) => ({ seq: message.seq, from: message.from, text: message.text, kind: message.kind }));
}

/**
 * 给模型的沉淀指令。
 *
 * 判断规则（什么该记、什么不该记、什么时候记、记完怎么回话）**不在代码里**，
 * 写在公司技能「记忆整理」里 —— 那是给模型看的判断规则，人和 agent 都要能改。
 * 这里只做机械的事：把候选消息排成列表、说清记到哪个文件、回哪个频道。
 */
export function renderSettlePrompt(project: string, candidates: readonly SettleCandidate[]): string {
	const lines = candidates.map(
		(item) => `- #${item.seq} [${item.kind}] ${item.from}：${item.text.replace(/\s+/g, " ").trim()}`,
	);
	return [
		`项目 \`${project}\` 的频道里有 ${candidates.length} 条新消息还没整理进项目记忆：`,
		"",
		...lines,
		"",
		`按公司技能「记忆整理」的规矩整理这批消息（\`read_skill\` 读那份技能：该记什么、不该记什么、记完怎么回话，都在里面），结论写进 \`projects/${project}/memory.md\`（用 remember(scope=project)）。`,
		`一句话把「记了什么」回在项目频道 \`proj:${project}\`（say 时传 channel: "proj:${project}"）。`,
	].join("\n");
}

export { DIGEST_LIMIT };
