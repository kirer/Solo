/** `remember`：记一条经验（个人记忆 / 团队记忆）。 */
import { join } from "node:path";
import { BACKGROUND_CONTEXT, Type, defineTool } from "../../runtime/index.ts";
import { readIdentity } from "../../agent/identity.ts";
import { appendMemory } from "../../agent/memory.ts";
import { redact } from "../../agent/secrets.ts";
import { assertTeamSlug } from "../../team/doc.ts";
import { appendTeamMemory } from "../../team/memory.ts";
import { isAssistantDir } from "../../layout.ts";
import { selfOrError, text, type CoreToolDeps } from "./context.ts";
import { fill } from "../../md/catalog.ts";

export function createRememberTool(deps: CoreToolDeps) {
	const t = (key: string, slots: Record<string, string | number | undefined> = {}): string =>
		fill(deps.text, key, slots);
	const tool = defineTool({
		name: "remember",
		description: t("remember.description"),
		parameters: Type.Object({
			text: Type.String({ description: t("remember.param.text") }),
			scope: Type.Optional(Type.String({ description: t("remember.param.scope") })),
			team: Type.Optional(Type.String({ description: t("remember.param.team") })),
		}),
		execute: async (args, api, context) => {
			const ctx = context ?? BACKGROUND_CONTEXT;
			const slug = await selfOrError(deps, Number(api.conversationId), ctx);
			if (typeof slug !== "string") return text(slug);
			// 密钥不能靠模型自觉：它写下来的时候并不觉得那是泄密。落盘前先把真值换掉。
			const body = redact(args.text, deps.layout.appRoot);
			// 自己的目录可能是 app 根（助理）也可能是用户根（成员）：按 slug 现查一次。
			const self = await readIdentity(deps.layout.agentRoots, slug);
			if (args.scope === "team") {
				const team = (args.team ?? self?.team)?.trim();
				if (team === undefined || team === "") return text(t("remember.refuse.no-team"));
				// slug 会被拼成路径；成员资格决定「谁能写」——两者都不能只信入参。
				try {
					assertTeamSlug(team, deps.text);
				} catch (error) {
					return text(error instanceof Error ? error.message : String(error));
				}
				// 谁能写：这个团队的人，或者助理（它替所有团队记组织级的事）。
				const assistant = self !== undefined && isAssistantDir(deps.layout, self.dir);
				if (self?.team !== team && !assistant) {
					return text(t("remember.refuse.not-member", { team }));
				}
				await appendTeamMemory(deps.layout.teamsRoot, team, { text: body, by: slug, ...(deps.text === undefined ? {} : { catalog: deps.text }) });
				return text(t("remember.team.done", { team }));
			}
			await appendMemory(
				self?.dir ?? join(deps.layout.membersRoot, slug),
				body,
				new Date(),
				"remember",
				deps.text,
			);
			return text(t("remember.done"));
		},
	});
	return tool;
}
