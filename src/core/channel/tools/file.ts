/** `file`：读 / 写工作区里的一个文件。 */
import { BACKGROUND_CONTEXT, Type, defineTool } from "../../runtime/index.ts";
import { assistantsOf, readAllIdentities, readIdentity } from "../../documents/member/identity.ts";
import { redact } from "../../secrets.ts";
import { parseDoc, frontOf } from "../../documents/base/doc.ts";
import { ensureDir, readTextOrUndefined, sizeOrUndefined, writeTextAtomic } from "../../runtime/io.ts";
import { teamWorkspace } from "../../layout.ts";
import { createTeamProblem, readTeam, teamSlugOfReadmePath } from "../../documents/team/doc.ts";
import { actionOf, selfOf, text, type CoreToolDeps } from "./context.ts";
import { resolveInRoots } from "./guards.ts";
import { fill } from "../../documents/base/catalog.ts";

/**
 /** `members/<slug>/identity.md` / `assistant/<slug>/identity.md` → slug。别的路径返回 undefined。 */
function agentSlugOfIdentityPath(path: string): string | undefined {
	const parts = path.split(/[\\/]/);
	if (parts.length !== 3 || parts[2] !== "identity.md") return undefined;
	return parts[0] === "members" || parts[0] === "assistant" ? parts[1] : undefined;
}

export function createFileTool(deps: CoreToolDeps) {
	const t = (key: string, slots: Record<string, string | number | undefined> = {}): string =>
		fill(deps.text, key, slots);

	/**
	 * 回执里的「原 N → 现 M 字节」。
	 *
	 * 报字节而不是字数：界面上看不出来的差别（少了个换行、中文变成半角），字节数会立刻对不上。
	 * 新文件不写「原 0」，写「新建」—— 「原 0」看着像「原来是空的」，那是另一回事。
	 * 文案走 `text` 而不是写死在这儿：这些字会原样回给模型看，要能改、要能被测试钉住。
	 */
	const sizesOf = (wrote: { before: number | undefined; after: number }): string =>
		wrote.before === undefined
			? t("file.size.created", { after: wrote.after })
			: t("file.size.rewritten", { before: wrote.before, after: wrote.after });
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
			// 带了正文就是写：模型漏写 action 却给了 content 时，按读处理会报「文件不存在」，
			// 它会以为工具坏了、改用 `run` 里的 shell 去写 —— 那条路绕过频道投影（实测丢过一个团队频道）。
			const action = actionOf(args.action, ["read", "write"], args.content === undefined ? "read" : "write", "action", deps.text);
			if (typeof action !== "string") return text(action);
			const target = resolveInRoots(deps.layout, args.path);
			if (target === undefined) return text(t("file.refuse.outside", { path: args.path }));
			// 密钥文件对 agent 不存在：读出来等于把 key 装进上下文，写回去会把
			// 人配好的值覆盖成脱敏后的马赛克。它要用 key，由人在 shell 里配、`run` 里用。
			if (target === deps.layout.secretsFile) return text(t("file.refuse.secret"));

			if (action === "write") {
				if (args.content === undefined) return text(t("file.refuse.no-content"));
				// 空正文 + 目标已有内容 = 一次静默的清空。「传空正文」是模型漏参数和手误最常见的形状，
				// 而写空文件本身几乎没有人真的需要 —— 真需要就显式删，那条路径有记录。
				// 目标不存在或本来是空文件时放行：那时写空是真的在「建一个空文件」。
				if (args.content === "" && (await sizeOrUndefined(target)) !== undefined) {
					const was = await sizeOrUndefined(target);
					if (was !== undefined && was > 0) {
						return text(t("file.refuse.empty-overwrite", { path: args.path, size: t("file.size.value", { bytes: was }) }));
					}
				}
				// 密钥一旦落进 identity.md / SKILL.md，就永久进了每一轮提示词的 system 段。
				const content = redact(args.content, deps.layout.appRoot);
				// 团队说明是事实，团队频道是它的投影：改了 README 立刻重算一次成员
				// （否则新团队的频道不会出现，改了成员也没人进得来）。
				const team = teamSlugOfReadmePath(args.path);
				// 改身份里的 `team` 会换团队频道：新旧两个都要重算（只算新的，旧频道会留一个
				// 已经不属于它的人；只算旧的，新频道里没有他）。
				const movedSlug = agentSlugOfIdentityPath(args.path);
				const oldTeam = movedSlug === undefined ? undefined : (await readIdentity(deps.layout.agentRoots, movedSlug))?.team;
				const newTeam = movedSlug === undefined ? undefined : frontOf(parseDoc(args.path, content), "team");
				// 新团队只有助理能开：校验必须在落盘之前 —— 写进去再报错，频道已经建出来了。
				if (team !== undefined) {
					const all = await readAllIdentities(deps.layout.agentRoots);
					const assistants = assistantsOf(deps.layout, all);
					// 开一个新团队只有助理能做；已有团队的 README 谁都能改（改正文不是开摊子）。
					if ((await readTeam(deps.layout.teamsRoot, team)) === undefined) {
						const self = await selfOf(deps, Number(api.conversationId), ctx);
						const problem =
							self === undefined ? t("file.create.no-roster") : createTeamProblem({ self, assistants, text: deps.text });
						if (problem !== undefined) return text(problem);
					}
				}
				// 新团队一有 README 就有自己的工作目录（团队任务在那儿跑，提示词里给了路径）。
				if (team !== undefined) await ensureDir(teamWorkspace(deps.layout, team));
				// 原子替换 + 读回核对：写坏了当场知道，不留半截文件。原文在 rename 之前一直完好。
				const wrote = await writeTextAtomic(target, content).catch((error: unknown) => error as Error);
				if (wrote instanceof Error) {
					return text(
						t("file.write.broken", {
							path: args.path,
							error: wrote.message,
						}),
					);
				}
				if (team !== undefined) {
					try {
						await deps.syncTeam(team, ctx);
					} catch (error) {
						// 写入已经成功，刷新失败不能反过来报「没写进去」—— 否则模型会重写一遍。
						return text(
							t("file.write.sync-failed", {
								path: args.path,
								length: content.length,
								sizes: sizesOf(wrote),
								error: error instanceof Error ? error.message : String(error),
							}),
						);
					}
				}
				// 身份里的 `team` 改了：新旧两个团队都要重算。失败说清楚 —— 旧频道里会留一个
				// 已经不属于它的人，界面上看不出来。
				const warnings: string[] = [];
				if (movedSlug !== undefined) {
					for (const slug of new Set([oldTeam, newTeam].filter((item): item is string => item !== undefined && item !== ""))) {
						try {
							await deps.syncTeam(slug, ctx);
						} catch (error) {
							warnings.push(
								t("file.write.team-sync-failed", {
									team: slug,
									error: error instanceof Error ? error.message : String(error),
								}),
							);
						}
					}
				}
				return text(
					t("file.write.done", { path: args.path, length: content.length, sizes: sizesOf(wrote) }) +
						(warnings.length === 0 ? "" : `\n${warnings.join("\n")}`),
				);
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
