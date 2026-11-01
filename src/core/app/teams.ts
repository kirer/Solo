/**
 * 「团队」的用例：一个团队的档案与记忆。
 *
 * 团队也是文件夹（`workspace/teams/<slug>/`），事实只有两份：`README.md` 与 `memory.md`。
 * 界面要的东西全在这里拼好 —— 它不自己去读盘，也不认识 `teams/<slug>/` 这种路径。
 */
import { listTeamSkills } from "../agent/skills.ts";
import { readTeam } from "../team/doc.ts";
import { readTeamMemory } from "../team/memory.ts";
import type { ViewTeamProfile } from "../view/dto.ts";
import { AppError } from "./errors.ts";
import { memoryEntries, memorySummary } from "./project.ts";
import type { CoreServices } from "./types.ts";

export function createTeams(shell: CoreServices) {
	async function readTeamProfile(slug: string): Promise<ViewTeamProfile> {
		const doc = await readTeam(shell.teamsRoot, slug);
		if (doc === undefined) throw new AppError("not-found", "没有这个团队");
		const source = (await readTeamMemory(shell.teamsRoot, slug)) ?? "";
		return {
			slug: doc.slug,
			name: doc.name,
			status: doc.status,
			...(doc.doing === undefined ? {} : { doing: doc.doing }),
			...(doc.lead === undefined ? {} : { lead: doc.lead }),
			leadLabel: doc.lead === undefined ? "" : shell.labelOf(doc.lead),
			body: doc.body,
			skills: (await listTeamSkills(shell.teamsRoot, doc.slug)).map((skill) => ({
				name: skill.name,
				description: skill.description,
				scope: skill.scope,
				overrides: skill.overrides === true,
			})),
			// 团队记忆没有逐条的日志（`appendTeamMemory` 不写 journal），所以时间是 `null`。
			memory: { ...memorySummary(source), entries: memoryEntries(source) },
		};
	}

	return { readTeamProfile };
}
