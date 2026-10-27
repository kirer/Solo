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

export { DIGEST_LIMIT };
