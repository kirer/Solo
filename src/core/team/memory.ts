/**
 * 团队记忆 = `teams/<slug>/memory.md`。
 *
 * 与个人记忆（`members/<slug>/memory.md`）的区别只有**归属**，写法完全一样：
 * 个人记忆回答「我学到什么」，团队记忆回答「这个摊子上发生过什么」。
 *
 * 为什么必须有团队记忆：团队换人是很正常的（有人离开、有人换团队）。事实如果只写在
 * 某个人的记忆里，那个人一走就带走了。写在团队目录下，换谁接手都还在 —— 这是团队
 * 与「一堆私人笔记本」的根本区别。
 *
 * 谁能写：**这个团队的人能写**。判据是 `identity.md` 里的 `team: <slug>`，
 * 不是身份。理由：团队记忆的价值就在一线的人随手记，设审批等于把它变成汇报。
 *
 * 谁能读：全员。理由同上 —— 记忆是资产，藏起来只会重复踩坑。
 */
import { join } from "node:path";
import { entryProblem, memoryDigest, problemText, sectionsOf, type MemorySection } from "../md/memory.ts";
import { createSerialGate, readTextOrUndefined, writeTextAt } from "../runtime/io.ts";
import { assertTeamSlug } from "./doc.ts";
import { fill, type TextCatalog } from "../md/catalog.ts";

export const TEAM_MEMORY_FILE = "memory.md";

/** `teams/<slug>/memory.md` 的绝对路径。 */
export function teamMemoryPath(teamsRoot: string, team: string): string {
	return join(teamsRoot, assertTeamSlug(team), TEAM_MEMORY_FILE);
}

/** 读全文；不存在返回 undefined（没记过就是没记过，不自动建空文件）。 */
export async function readTeamMemory(teamsRoot: string, team: string): Promise<string | undefined> {
	// 与 `readTeam` 同一个口径：读是尽力而为，坏 slug 等于「这个团队没有记忆」。
	try {
		return await readTextOrUndefined(teamMemoryPath(teamsRoot, team));
	} catch {
		return undefined;
	}
}

/**
 * 写团队记忆的串行闸（与个人记忆同一个理由：`appendTeamMemory` 是「读全文 → 拼 → 写回」，
 * 两个 agent 同时追加就会丢一条。团队频道里本来就常有两个人同时被叫醒）。
 */
const serialized = createSerialGate();

/**
 * 追加一条。小节标题带日期**和记录人**：「2026-10-27 林越」。看到是谁写的，后来的争议才有地方追。
 ***超长/空/像密钥的条目直接拒写并抛错**，不做静默截断。
 *
 * 为什么本仓库要管长度：个人记忆早就有 300/4000 的两道闸，团队记忆一条都没有，实测
 * 某个团队的 `memory.md` 涨到 7524 字符、约 37 条 —— 而提示词里的目录只放得下十几条，
 * 后面的条目对模型形同不存在，同时又有两处半句话（写坏的截断）留在文件里。记忆没人管
 * 就会变成垃圾场：能写、能读、读不到重点。
 */
export async function appendTeamMemory(
	teamsRoot: string,
	team: string,
	input: { readonly text: string; readonly by?: string; readonly at?: Date; readonly catalog?: TextCatalog },
): Promise<string> {
	const problem = entryProblem(input.text);
	if (problem !== undefined) throw new Error(problemText(problem, input.text, input.catalog));
	// 写是拼路径：坏 slug 一律拒绝（`readTeamMemory` 的宽容只适用于读）。
	assertTeamSlug(team, input.catalog);
	return serialized(async () => {
		const path = teamMemoryPath(teamsRoot, team);
		const existing =
			(await readTeamMemory(teamsRoot, team)) ??
			`${fill(input.catalog, "org.memory.team-header", { team })}\n`;
		const stamp = (input.at ?? new Date()).toISOString().slice(0, 10);
		const who = input.by === undefined ? "" : ` ${input.by}`;
		const next = `${existing.trimEnd()}\n\n## ${stamp}${who}\n${input.text.trim()}\n`;
		// 目录可能还不存在：团队记忆可以先于 `README.md` 写下（先记一条再补说明是常见的）。
		await writeTextAt(path, next);
		return next;
	});
}

/**
 * 提示词里的团队记忆目录。
 *
 * 复用个人记忆的切段与摘要逻辑 —— 同一套格式，只是路径不同。**故意不合并**成
 * 一个函数，因为将来团队记忆可能要多一个「谁记的」维度，而个人记忆不需要。
 */
export function teamMemoryDigest(source: string, catalog?: TextCatalog): string | undefined {
	return memoryDigest(source, catalog);
}

/** 按 `## ` 切段（给 `read_history(scope=team)` 全文渲染用）。 */
export function teamMemorySections(source: string): readonly MemorySection[] {
	return sectionsOf(source);
}

