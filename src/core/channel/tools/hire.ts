/** `hire`：招人 / 让人走 / 看能挑哪些模型。 */
import { BACKGROUND_CONTEXT, Type, defineTool } from "../../runtime/index.ts";
import { OWNER_SLUG, createAgent, readAllIdentities } from "../../agent/identity.ts";
import { redact } from "../../agent/secrets.ts";
import { moveAt } from "../../runtime/io.ts";
import { listTeams, readTeam } from "../../team/doc.ts";
import { ChannelDoc, dmId, type ChannelState } from "../types.ts";
import { actionOf, selfOf, text, type CoreToolDeps } from "./context.ts";

/** 走的人留在 `<membersRoot>/.retired/` 里：**只移不删**，身份文件还能翻回来。 */
function retiredNameOf(slug: string): string {
	return `${slug}-${new Date().toISOString().replace(/[:.]/g, "-")}`;
}

export function createHireTool(deps: CoreToolDeps) {
	const tool = defineTool({
		name: "hire",
		description: [
			"`action=create`（默认）招一个人：在 members/ 下建文件夹、写 identity.md、给他自己的工作目录。",
			"`action=fire` 让一个人离开：目录移到 members/.retired/，从频道与名册里移除，私聊归档。",
			"`action=models` 列出现在能挑的模型（招人前先看一眼，按角色分：协调/汇总用便宜的，复杂开发用强的）。",
			"写法见技能「招人」。",
		].join(""),
		parameters: Type.Object({
			action: Type.Optional(Type.String({ description: "create（默认）/ fire / models" })),
			name: Type.String({ description: "姓名（create 必填）" }),
			title: Type.Optional(Type.String({ description: "身份标签，纯展示用" })),
			manager: Type.Optional(Type.String({ description: "上级的 slug，必须是名册里已有的人；不确定就不传，缺省是你自己" })),
			team: Type.Optional(Type.String({ description: "所在团队 slug" })),
			body: Type.Optional(
				Type.String({
					description: "identity.md 的正文：①负责什么 ②不做什么 ③怎么汇报 ④做得好是什么样。",
				}),
			),
			model: Type.Optional(
				Type.String({ description: "他用的模型，写成 提供商/模型。只能从 action=models 列出的里面挑；不传就跟默认。" }),
			),
		}),
		execute: async (args, api, context) => {
			const ctx = context ?? BACKGROUND_CONTEXT;
			const action = actionOf(args.action, ["create", "fire", "models"], "create");
			if (typeof action !== "string") return text(action);

			if (action === "models") {
				const choices = await deps.modelChoices?.();
				if (choices === undefined) return text("这一份装配没有模型清单。");
				const lines = choices.models.map((ref) => `- ${ref}${ref === choices.default ? "（默认）" : ""}`);
				return text(
					choices.models.length === 0
						? "还没配任何模型：设置 → 模型，或写应用目录里的 settings.json。"
						: `能挑的模型：\n${lines.join("\n")}\n\n按角色分：协调、汇总、写文档用便宜的；复杂开发、攻坚用强的。`,
				);
			}

			const all = await readAllIdentities(deps.layout.agentRoots);

			if (action === "fire") {
				const slug = args.name.trim();
				const target = all.find((identity) => identity.slug === slug || identity.name === slug);
				if (target === undefined) return text(`没有这个人：${slug}。现有：${all.map((item) => item.slug).join("、") || "（没有人）"}`);
				if (target.slug === OWNER_SLUG) return text("那是我，不能开除。");
				if (target.dir.startsWith(deps.layout.assistantRoot)) return text("它是助理，不能开除。");
				const reports = all.filter((identity) => identity.manager === target.slug);
				if (reports.length > 0) {
					return text(`${target.name} 手下还有人（${reports.map((item) => item.slug).join("、")}），先把他们改派给别人。`);
				}
				const leading = await Promise.all(
					(await listTeams(deps.layout.teamsRoot)).map(async (team) => ((await readTeam(deps.layout.teamsRoot, team.slug))?.lead === target.slug ? team.slug : undefined)),
				);
				const teams = leading.filter((item): item is string => item !== undefined);
				if (teams.length > 0) {
					return text(`${target.name} 是团队管理员（${teams.join("、")}），先把团队的 lead 交给别人，再让人走。`);
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
				return text(`已让 ${target.name}（${target.slug}）离开：目录移到 members/.retired/，频道与名册里都不再有他。`);
			}

			// create
			const manager = args.manager ?? (await selfOf(deps, Number(api.conversationId), ctx)) ?? OWNER_SLUG;
			const known = new Set(all.map((item) => item.slug));
			known.add(OWNER_SLUG);
			if (!known.has(manager)) {
				return text(`没有这个上级：${manager}。现有 slug：${[...known].join("、")}。不传 manager 就是你自己。`);
			}
			const identity = await createAgent({
				root: deps.layout.membersRoot,
				name: args.name,
				...(args.title === undefined ? {} : { title: args.title }),
				manager,
				...(args.team === undefined ? {} : { team: args.team }),
				// 身份正文也会进每一轮提示词，跟 `file` 写盘走同一道脱敏。
				...(args.body === undefined ? {} : { body: redact(args.body, deps.layout.appRoot) }),
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
			// 按角色分模型：只认清单里的；写不进去也不影响人已经招到（回一句话说明）。
			let modelNote = "";
			if (args.model !== undefined && args.model.trim() !== "") {
				const assigned = await deps.setModel?.(identity.slug, args.model, ctx).catch((error: unknown) =>
					error instanceof Error ? error.message : String(error),
				);
				modelNote =
					assigned === undefined
						? "（这一份装配不支持指定模型）"
						: typeof assigned === "string"
							? `（模型没换成：${assigned}）`
							: `，模型 ${assigned.model}`;
			}
			const where = `身份在 members/${identity.slug}/identity.md，工作目录在 members/${identity.slug}/workspace/`;
			return text(
				id === undefined
					? `已新建 ${identity.name}（slug: ${identity.slug}）${modelNote}。${where}；重启或外壳扫描后它会开会话。`
					: `已新建 ${identity.name}（slug: ${identity.slug}），会话 ${id} 已就绪${modelNote}。${where}。`,
			);
		},
	});
	return tool;
}
