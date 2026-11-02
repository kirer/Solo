/** `hire`：招人 / 让人走 / 看能挑哪些模型。 */
import { BACKGROUND_CONTEXT, Type, defineTool } from "../../runtime/index.ts";
import { OWNER_SLUG, createAgent, readAllIdentities } from "../../agent/identity.ts";
import { redact } from "../../agent/secrets.ts";
import { moveAt } from "../../runtime/io.ts";
import { listTeams, readTeam } from "../../team/doc.ts";
import { ChannelDoc, dmId, type ChannelState } from "../types.ts";
import { actionOf, selfOf, text, type CoreToolDeps } from "./context.ts";
import { fill } from "../../md/catalog.ts";

/** 走的人留在 `<membersRoot>/.retired/` 里：**只移不删**，身份文件还能翻回来。 */
function retiredNameOf(slug: string): string {
	return `${slug}-${new Date().toISOString().replace(/[:.]/g, "-")}`;
}

export function createHireTool(deps: CoreToolDeps) {
	const t = (key: string, slots: Record<string, string | number | undefined> = {}): string =>
		fill(deps.text, key, slots);
	const tool = defineTool({
		name: "hire",
		description: t("hire.description"),
		parameters: Type.Object({
			action: Type.Optional(Type.String({ description: t("hire.param.action") })),
			name: Type.String({ description: t("hire.param.name") }),
			title: Type.Optional(Type.String({ description: t("hire.param.title") })),
			manager: Type.Optional(Type.String({ description: t("hire.param.manager") })),
			team: Type.Optional(Type.String({ description: t("hire.param.team") })),
			body: Type.Optional(Type.String({ description: t("hire.param.body") })),
			model: Type.Optional(Type.String({ description: t("hire.param.model") })),
		}),
		execute: async (args, api, context) => {
			const ctx = context ?? BACKGROUND_CONTEXT;
			const action = actionOf(args.action, ["create", "fire", "models"], "create", "action", deps.text);
			if (typeof action !== "string") return text(action);

			if (action === "models") {
				const choices = await deps.modelChoices?.();
				if (choices === undefined) return text(t("hire.no-models"));
				const rows = choices.models.map((ref) =>
					t("hire.models.row", {
						ref,
						default: ref === choices.default ? t("hire.models.default") : "",
					}),
				);
				return text(
					choices.models.length === 0
						? t("hire.models.none")
						: t("hire.models.list", { rows: rows.join("\n") }),
				);
			}

			const all = await readAllIdentities(deps.layout.agentRoots);

			if (action === "fire") {
				const slug = args.name.trim();
				const target = all.find((identity) => identity.slug === slug || identity.name === slug);
				if (target === undefined) {
					return text(
						t("hire.fire.missing", {
							name: slug,
							slugs: all.map((item) => item.slug).join("、") || t("hire.nobody"),
						}),
					);
				}
				if (target.slug === OWNER_SLUG) return text(t("hire.fire.owner"));
				if (target.dir.startsWith(deps.layout.assistantRoot)) return text(t("hire.fire.assistant"));
				const reports = all.filter((identity) => identity.manager === target.slug);
				if (reports.length > 0) {
					return text(
						t("hire.fire.reports", {
							name: target.name,
							slugs: reports.map((item) => item.slug).join("、"),
						}),
					);
				}
				const leading = await Promise.all(
					(await listTeams(deps.layout.teamsRoot)).map(async (team) => ((await readTeam(deps.layout.teamsRoot, team.slug))?.lead === target.slug ? team.slug : undefined)),
				);
				const teams = leading.filter((item): item is string => item !== undefined);
				if (teams.length > 0) {
					return text(t("hire.fire.leading", { name: target.name, teams: teams.join("、") }));
				}

				await moveAt(target.dir, `${deps.layout.membersRoot}/.retired/${retiredNameOf(target.slug)}`);
				// 从所有频道里移除，并归档我和他的私聊；团队频道再按文件重算一次。
				await deps.harness.commit(async (tx) => {
					const doc = (await tx.doc(ChannelDoc)) as ChannelState;
					for (const [id, channel] of Object.entries(doc.channels)) {
						const members = channel.members.filter((item) => item !== target.slug);
						const wakeOnAll = channel.wakeOnAll.filter((item) => item !== target.slug);
						const archive = id === dmId(OWNER_SLUG, target.slug);
						if (members.length === channel.members.length && wakeOnAll.length === channel.wakeOnAll.length && !archive) continue;
						doc.channels[id] = {
							...channel,
							members,
							wakeOnAll,
							...(archive ? { archived: true as const } : {}),
						};
					}
				}, ctx);
				await deps.saveDirectory((value) => {
					const conversation = value.slugToConversation[target.slug];
					const slugToConversation = { ...value.slugToConversation };
					delete slugToConversation[target.slug];
					const conversationToSlug = { ...value.conversationToSlug };
					if (conversation !== undefined) delete conversationToSlug[String(conversation)];
					const wake = { ...value.wake };
					if (conversation !== undefined) delete wake[String(conversation)];
					return { ...value, slugToConversation, conversationToSlug, wake };
				}, ctx);
				for (const identity of all) {
					if (identity.team === undefined) continue;
					await deps.syncTeam?.(identity.team, ctx).catch(() => undefined);
				}
				return text(t("hire.fire.done", { name: target.name, slug: target.slug }));
			}

			// create
			const manager = args.manager ?? (await selfOf(deps, Number(api.conversationId), ctx)) ?? OWNER_SLUG;
			const known = new Set(all.map((item) => item.slug));
			known.add(OWNER_SLUG);
			if (!known.has(manager)) {
				return text(t("hire.create.manager-missing", { manager, slugs: [...known].join("、") }));
			}
			const identity = await createAgent({
				root: deps.layout.membersRoot,
				name: args.name,
				...(args.title === undefined ? {} : { title: args.title }),
				manager,
				...(args.team === undefined ? {} : { team: args.team }),
				// 身份正文也会进每一轮提示词，跟 `file` 写盘走同一道脱敏。
				...(args.body === undefined ? {} : { body: redact(args.body, deps.layout.appRoot) }),
				...(deps.text === undefined ? {} : { text: deps.text }),
			}).catch((error: unknown) => (error instanceof Error ? error.message : String(error)));
			// slug 不合法（含 `.`、`.`、`..` 之类）是输入问题，回一句话让它改，别把工具打成异常。
			if (typeof identity === "string") return text(identity);
			// 私聊是「他干活的地方」，招到人就建好（幂等）；建失败不影响「人已经招到」。
			await deps.ensureDm?.(identity.slug, ctx).catch(() => undefined);
			let id: number | undefined;
			if (deps.openAgent !== undefined) {
				id = await deps.openAgent(identity.slug, ctx);
				await deps.saveDirectory((value) => ({
					...value,
					slugToConversation: { ...value.slugToConversation, [identity.slug]: id as number },
					conversationToSlug: { ...value.conversationToSlug, [String(id)]: identity.slug },
				}), ctx);
			}
			// 团队说明是事实，团队频道是它的投影（`建立团队` 技能的顺序就是先招人、再写 README）。
			const teamExists =
				identity.team !== undefined &&
				identity.team !== "" &&
				(await readTeam(deps.layout.teamsRoot, identity.team)) !== undefined;
			// 进团队的人自己报到（ADR-042）。频道还不存在时叫不到人 —— 建团队时会一起叫。
			if (teamExists) {
				await deps.announceJoin?.(identity.team as string, [identity.slug], ctx).catch(() => undefined);
			}
			// 按角色分模型：只认清单里的；写不进去也不影响人已经招到（回一句话说明）。
			let modelNote = "";
			if (args.model !== undefined && args.model.trim() !== "") {
				const assigned = await deps.setModel?.(identity.slug, args.model, ctx).catch((error: unknown) =>
					error instanceof Error ? error.message : String(error),
				);
				modelNote =
					assigned === undefined
						? t("hire.create.model-unsupported")
						: typeof assigned === "string"
							? t("hire.create.model-failed", { error: assigned })
							: t("hire.create.model-ok", { model: assigned.model });
			}
			const where = t("hire.create.where", { slug: identity.slug });
			// 团队说明是事实，团队频道是它的投影（`建立团队` 技能的顺序就是先招人、再写 README）。
			// 所以这里不拦，只把「频道还不存在」说清楚 —— 不说的话，模型会在一个不存在的频道里
			// `say`，失败只回到它自己，界面上什么都看不见。
			const teamNote =
				args.team === undefined || teamExists ? "" : t("hire.create.team-missing", { team: args.team });
			return text(
				id === undefined
					? t("hire.create.pending", { name: identity.name, slug: identity.slug, model: modelNote, where, teamNote })
					: t("hire.create.done", { name: identity.name, slug: identity.slug, id, model: modelNote, where, teamNote }),
			);
		},
	});
	return tool;
}
