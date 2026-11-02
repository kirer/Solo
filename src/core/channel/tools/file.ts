/** `file`：读 / 写工作区里的一个文件。 */
import { BACKGROUND_CONTEXT, Type, defineTool } from "../../runtime/index.ts";
import { OWNER_SLUG, managerOf, readAllIdentities, readIdentity } from "../../agent/identity.ts";
import { redact } from "../../agent/secrets.ts";
import { parseDoc, frontOf } from "../../md/doc.ts";
import { ensureDir, readTextOrUndefined, writeTextAt } from "../../runtime/io.ts";
import { teamWorkspace } from "../../layout.ts";
import { createTeamProblem, leadProblem, readTeam, teamSlugOfMemoryPath, teamSlugOfReadmePath } from "../../team/doc.ts";
import { confirmedBy } from "../../team/settle.ts";
import { actionOf, selfOf, text, type CoreToolDeps } from "./context.ts";
import { resolveInRoots } from "./guards.ts";
import { fill } from "../../md/catalog.ts";

/** `members/<slug>/identity.md` / `assistant/<slug>/identity.md` → slug。别的路径返回 undefined。 */
function agentSlugOfIdentityPath(path: string): string | undefined {
	const parts = path.split(/[\\/]/);
	if (parts.length !== 3 || parts[2] !== "identity.md") return undefined;
	return parts[0] === "members" || parts[0] === "assistant" ? parts[1] : undefined;
}

export function createFileTool(deps: CoreToolDeps) {
	const t = (key: string, slots: Record<string, string | number | undefined> = {}): string =>
		fill(deps.text, key, slots);
	const tool = defineTool({
		name: "file",
		description: t("file.description"),
		parameters: Type.Object({
			action: Type.Optional(Type.String({ description: t("file.param.action") })),
			path: Type.String({ description: t("file.param.path") }),
			content: Type.Optional(Type.String({ description: t("file.param.content") })),
			offset: Type.Optional(Type.Number({ description: t("file.param.offset") })),
			limit: Type.Optional(Type.Number({ description: t("file.param.limit") })),
		}),
		execute: async (args, api, context) => {
			const ctx = context ?? BACKGROUND_CONTEXT;
			const action = actionOf(args.action, ["read", "write"], "read", "action", deps.text);
			if (typeof action !== "string") return text(action);
			const target = resolveInRoots(deps.layout, args.path);
			if (target === undefined) return text(t("file.refuse.outside", { path: args.path }));
			// 密钥文件对 agent 不存在：读出来等于把 key 装进上下文，写回去会把
			// 人配好的值覆盖成脱敏后的马赛克。它要用 key，由人在 shell 里配、`run` 里用。
			if (target === deps.layout.secretsFile) return text(t("file.refuse.secret"));

			if (action === "write") {
				if (args.content === undefined) return text(t("file.refuse.no-content"));
				// 密钥一旦落进 identity.md / SKILL.md，就永久进了每一轮提示词的 system 段。
				const content = redact(args.content, deps.layout.appRoot);
				// 团队说明是事实，团队频道是它的投影：改了 README 立刻重算一次成员
				// （否则刚写进去的团队管理员在频道里不存在，成员 @ 不到他）。
				const team = teamSlugOfReadmePath(args.path);
				// 改身份里的 `team` 会换团队频道：新旧两个都要重算（只算新的，旧频道会留一个
				// 已经不属于它的人；只算旧的，新频道里没有他）。
				const movedSlug = agentSlugOfIdentityPath(args.path);
				const oldTeam = movedSlug === undefined ? undefined : (await readIdentity(deps.layout.agentRoots, movedSlug))?.team;
				const newTeam = movedSlug === undefined ? undefined : frontOf(parseDoc(args.path, content), "team");
				// 写团队 README 前先校验 `lead`：缺了、查无此人、或者写的是助理，都直接拒绝。
				// 校验必须在落盘之前 —— 写进去再报错，团队频道已经按一个不存在的管理员投影过了。
				if (team !== undefined) {
					const all = await readAllIdentities(deps.layout.agentRoots);
					const assistants = all
						.filter((identity) => managerOf(all, identity.slug) === OWNER_SLUG)
						.map((identity) => identity.slug);
					// 开一个新团队只有助理能做；已有团队的 README 谁都能改（改正文不是开摊子）。
					if ((await readTeam(deps.layout.teamsRoot, team)) === undefined) {
						const self = await selfOf(deps, Number(api.conversationId), ctx);
						const problem =
							self === undefined ? t("file.create.no-roster") : createTeamProblem({ self, assistants, ...(deps.text === undefined ? {} : { text: deps.text }) });
						if (problem !== undefined) return text(problem);
					}
					const problem = leadProblem({
						lead: frontOf(parseDoc(args.path, content), "lead"),
						slugs: all.map((identity) => identity.slug),
						assistants,
						...(deps.text === undefined ? {} : { text: deps.text }),
					});
					if (problem !== undefined) return text(problem);
				}
				// 新团队一有 README 就有自己的工作目录（团队任务在那儿跑，提示词里给了路径）。
				if (team !== undefined) await ensureDir(teamWorkspace(deps.layout, team));
				await writeTextAt(target, content);
				if (team !== undefined && deps.syncTeam !== undefined) {
					try {
						await deps.syncTeam(team, ctx);
					} catch (error) {
						// 写入已经成功，刷新失败不能反过来报「没写进去」—— 否则模型会重写一遍。
						return text(
							t("file.write.sync-failed", {
								path: args.path,
								length: content.length,
								error: error instanceof Error ? error.message : String(error),
							}),
						);
					}
				}
				if (movedSlug !== undefined && deps.syncTeam !== undefined) {
					for (const slug of new Set([oldTeam, newTeam].filter((item): item is string => item !== undefined && item !== ""))) {
						await deps.syncTeam(slug, ctx).catch(() => undefined);
					}
				}
				// 写团队记忆 = 显式确认这批消息沉淀过了：游标立刻推进，不用再等 mtime 变。
				// 失败只写 stderr —— 文件已经写进去了，不能反过来报「没写进去」。
				const settledTeam = teamSlugOfMemoryPath(args.path);
				if (settledTeam !== undefined) {
					await confirmedBy(deps.harness, settledTeam, BACKGROUND_CONTEXT).catch((error: unknown) => {
						process.stderr.write(
							`[沉淀] ${settledTeam} 的记忆已写入，但游标推进失败：${error instanceof Error ? error.message : String(error)}\n`,
						);
					});
				}
				return text(t("file.write.done", { path: args.path, length: content.length }));
			}

			const source = await readTextOrUndefined(target);
			if (source === undefined) return text(t("file.read.missing", { path: args.path }));
			const rows = source.split("\n");
			const offset = Math.max(Math.trunc(args.offset ?? 1), 1);
			const limit = Math.min(Math.max(Math.trunc(args.limit ?? 400), 1), 800);
			const shown = rows.slice(offset - 1, offset - 1 + limit);
			const head = shown.join("\n");
			// 行的尺度和字的尺度都要管：一行十万字的压缩包也是合法的。
			const clipped = head.length > 8000 ? `${head.slice(0, 8000)}\n${t("file.read.truncated")}` : head;
			const last = offset - 1 + shown.length;
			if (last >= rows.length && clipped.length === head.length) return text(clipped);
			const more = last < rows.length ? t("file.read.more", { next: last + 1 }) : "";
			return text(
				`${clipped}\n${t("file.read.footer", {
					rows: rows.length,
					chars: source.length,
					offset,
					more,
				})}`,
			);
		},
	});
	return tool;
}
