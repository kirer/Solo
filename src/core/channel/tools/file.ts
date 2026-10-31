/** `file`：读 / 写工作区里的一个文件。 */
import { join } from "node:path";
import { BACKGROUND_CONTEXT, Type, defineTool } from "../../runtime/index.ts";
import { OWNER_SLUG, managerOf, readAllIdentities } from "../../agent/identity.ts";
import { SECRETS_FILE, redact } from "../../agent/secrets.ts";
import { parseDoc, frontOf } from "../../md/doc.ts";
import { readTextOrUndefined, writeTextAt } from "../../runtime/io.ts";
import { createTeamProblem, leadProblem, readTeam, teamSlugOfMemoryPath, teamSlugOfReadmePath } from "../../team/doc.ts";
import { confirmedBy } from "../../team/settle.ts";
import { actionOf, selfOf, text, type CoreToolDeps } from "./context.ts";
import { resolveInWorkspace } from "./guards.ts";

export function createFileTool(deps: CoreToolDeps) {
	const tool = defineTool({
		name: "file",
		description: [
			"工作区里的一个文件。`action=read`（默认）读它；`action=write` 写它（大段代码、配置、文档走这个，不经过 shell 转义）。",
			"路径相对工作区根，`../` 会被拒；读写不了工作区以外的东西。",
			"写 `teams/<团队>/README.md` 会顺手刷新那个团队的频道成员（改完不用再单独同步）。",
		].join(""),
		parameters: Type.Object({
			action: Type.Optional(Type.String({ description: "read（默认）/ write" })),
			path: Type.String({ description: "文件路径（相对工作区根）" }),
			content: Type.Optional(Type.String({ description: "write 必填：文件内容" })),
			offset: Type.Optional(Type.Number({ description: "read 从第几行开始（1 起），默认 1" })),
			limit: Type.Optional(Type.Number({ description: "read 最多几行，默认 400" })),
		}),
		execute: async (args, api, context) => {
			const ctx = context ?? BACKGROUND_CONTEXT;
			const action = actionOf(args.action, ["read", "write"], "read");
			if (typeof action !== "string") return text(action);
			const target = resolveInWorkspace(deps.workspaceRoot, args.path);
			if (target === undefined) return text(`路径在工作区之外：${args.path}`);
			// 密钥文件对 agent 不存在：读出来等于把 key 装进上下文，写回去会把
			// 人配好的值覆盖成脱敏后的马赛克。它要用 key，由人在 shell 里配、`run` 里用。
			if (target === join(deps.workspaceRoot, SECRETS_FILE)) return text("这个文件不开放。");

			if (action === "write") {
				if (args.content === undefined) return text("write 要带 content（写什么）。只想读文件用 action=read。");
				// 密钥一旦落进 identity.md / SKILL.md，就永久进了每一轮提示词的 system 段。
				const content = redact(args.content, deps.workspaceRoot);
				// 团队说明是事实，团队频道是它的投影：改了 README 立刻重算一次成员
				// （否则刚写进去的团队管理员在频道里不存在，成员 @ 不到他）。
				const team = teamSlugOfReadmePath(args.path);
				// 写团队 README 前先校验 `lead`：缺了、查无此人、或者写的是助理，都直接拒绝。
				// 校验必须在落盘之前 —— 写进去再报错，团队频道已经按一个不存在的管理员投影过了。
				if (team !== undefined) {
					const all = await readAllIdentities(deps.agentsRoot);
					const assistants = all
						.filter((identity) => managerOf(all, identity.slug) === OWNER_SLUG)
						.map((identity) => identity.slug);
					// 开一个新团队只有助理能做；已有团队的 README 谁都能改（改正文不是开摊子）。
					if ((await readTeam(deps.teamsRoot, team)) === undefined) {
						const self = await selfOf(deps, Number(api.conversationId), ctx);
						const problem =
							self === undefined ? "你还不在名册里，建不了团队。" : createTeamProblem({ self, assistants });
						if (problem !== undefined) return text(problem);
					}
					const problem = leadProblem({
						lead: frontOf(parseDoc(args.path, content), "lead"),
						slugs: all.map((identity) => identity.slug),
						assistants,
					});
					if (problem !== undefined) return text(problem);
				}
				await writeTextAt(target, content);
				if (team !== undefined && deps.syncTeam !== undefined) {
					try {
						await deps.syncTeam(team, ctx);
					} catch (error) {
						// 写入已经成功，刷新失败不能反过来报「没写进去」—— 否则模型会重写一遍。
						return text(
							`已写入 ${args.path}（${content.length} 字），但团队频道刷新失败：${
								error instanceof Error ? error.message : String(error)
							}`,
						);
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
				return text(`已写入 ${args.path}（${content.length} 字）`);
			}

			const source = await readTextOrUndefined(target);
			if (source === undefined) return text(`文件不存在：${args.path}`);
			const rows = source.split("\n");
			const offset = Math.max(Math.trunc(args.offset ?? 1), 1);
			const limit = Math.min(Math.max(Math.trunc(args.limit ?? 400), 1), 800);
			const shown = rows.slice(offset - 1, offset - 1 + limit);
			const head = shown.join("\n");
			// 行的尺度和字的尺度都要管：一行十万字的压缩包也是合法的。
			const clipped = head.length > 8000 ? `${head.slice(0, 8000)}\n…（已截断）` : head;
			const last = offset - 1 + shown.length;
			if (last >= rows.length && clipped.length === head.length) return text(clipped);
			const more = last < rows.length ? `，还有，用 offset=${last + 1} 继续` : "";
			return text(`${clipped}\n（共 ${rows.length} 行、${source.length} 字；这里从第 ${offset} 行起${more}）`);
		},
	});
	return tool;
}
