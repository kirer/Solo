/** `remember`：记一条经验（个人记忆 / 团队记忆）。 */
import { join } from "node:path";
import { BACKGROUND_CONTEXT, Type, defineTool } from "../../runtime/index.ts";
import { readIdentity } from "../../agent/identity.ts";
import { appendMemory } from "../../agent/memory.ts";
import { redact } from "../../agent/secrets.ts";
import { assertTeamSlug, readTeam } from "../../team/doc.ts";
import { appendTeamMemory } from "../../team/memory.ts";
import { confirmedBy } from "../../team/settle.ts";
import { selfOrError, text, type CoreToolDeps } from "./context.ts";

export function createRememberTool(deps: CoreToolDeps) {
	const tool = defineTool({
		name: "remember",
		description: [
			"记一条经验。",
			"scope=personal（默认）写进你自己的记忆（agents/<我>/memory.md）；scope=team 写进所在团队的记忆（teams/<团队>/memory.md，带日期和你的名字）。",
			"该记什么见技能「记忆整理」。",
		].join(""),
		parameters: Type.Object({
			text: Type.String({ description: "要记的东西。一句话说清一条，几条就调几次。" }),
			scope: Type.Optional(Type.String({ description: "personal（默认，自己的记忆）或 team（团队记忆）" })),
			team: Type.Optional(Type.String({ description: "团队 slug；scope=team 时用。默认是我所在的团队" })),
		}),
		execute: async (args, api, context) => {
			const ctx = context ?? BACKGROUND_CONTEXT;
			const slug = await selfOrError(deps, Number(api.conversationId), ctx, "你还不在名册里。");
			if (typeof slug !== "string") return text(slug);
			// 密钥不能靠模型自觉：它写下来的时候并不觉得那是泄密。落盘前先把真值换掉。
			const body = redact(args.text, deps.workspaceRoot);
			if (args.scope === "team") {
				const self = await readIdentity(deps.agentsRoot, slug);
				const team = (args.team ?? self?.team)?.trim();
				if (team === undefined || team === "") return text("我不在任何团队里。要记团队的事，先说清是哪个团队。");
				// slug 会被拼成路径；成员资格决定「谁能写」——两者都不能只信入参。
				try {
					assertTeamSlug(team);
				} catch (error) {
					return text(error instanceof Error ? error.message : String(error));
				}
				const lead = (await readTeam(deps.teamsRoot, team))?.lead;
				if (self?.team !== team && lead !== slug) {
					return text(`你不在团队「${team}」里。团队记忆只能由这个团队的人写。`);
				}
				await appendTeamMemory(deps.teamsRoot, team, { text: body, by: slug });
				const confirmed = await confirmedBy(deps.harness, team, ctx);
				const tail = confirmed === 0 ? "" : `（已把 #${confirmed} 之前的结论标记为已沉淀）`;
				return text(`已记进团队「${team}」的记忆${tail}。下一条消息就会出现在这个团队的记忆目录里。`);
			}
			await appendMemory(join(deps.agentsRoot, slug), body, new Date(), "remember");
			return text("已记下。下一条消息的记忆目录里就会出现它。");
		},
	});
	return tool;
}
