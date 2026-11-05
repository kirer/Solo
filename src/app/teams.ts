/**
 * 「团队」的用例：一个团队的档案与记忆。
 *
 * 团队也是文件夹（`<userRoot>/teams/<slug>/`），事实只有两份：`README.md` 与 `memory.md`。
 * 界面要的东西全在这里拼好 —— 它不自己去读盘，也不认识 `teams/<slug>/` 这种路径。
 */
import { listTeamSkills } from "../core/documents/skills.ts";
import { readTeam } from "../core/documents/team/doc.ts";
import { readTeamMemory } from "../core/documents/team/memory.ts";
import type { ViewTeamProfile } from "../view/dto.ts";
import { AppError } from "./errors.ts";
import { memoryEntries } from "./project.ts";
import type { CoreServices } from "./types.ts";

export function createTeams(shell: CoreServices) {
	async function readTeamProfile(slug: string): Promise<ViewTeamProfile> {
		const doc = await readTeam(shell.layout.teamsRoot, slug);
		if (doc === undefined) throw new AppError("not-found", "没有这个团队");
		const source = (await readTeamMemory(shell.layout.teamsRoot, slug)) ?? "";
		return {
			slug: doc.slug,
			name: doc.name,
			status: doc.status,
			...(doc.doing === undefined ? {} : { doing: doc.doing }),
			body: doc.body,
			skills: (await listTeamSkills(shell.layout.teamsRoot, doc.slug)).map((skill) => ({
				name: skill.name,
				description: skill.description,
				scope: skill.scope,
				overrides: skill.overrides === true,
			})),
			// 团队记忆没有逐条的日志（`appendTeamMemory` 不写 journal），所以时间是 `null`。
			memory: { entries: memoryEntries(source) },
		};
	}

	return { readTeamProfile };
}
