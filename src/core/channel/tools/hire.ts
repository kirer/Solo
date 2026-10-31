/** `hire`：新建一个 agent（写一个文件夹）。 */
import { BACKGROUND_CONTEXT, Type, defineTool } from "../../runtime/index.ts";
import { OWNER_SLUG, createAgent, readAllIdentities } from "../../agent/identity.ts";
import { redact } from "../../agent/secrets.ts";
import { selfOf, text, type CoreToolDeps } from "./context.ts";

export function createHireTool(deps: CoreToolDeps) {
	const tool = defineTool({
		name: "hire",
		description: [
			"新建一个 agent（在 agents/ 下建一个文件夹并写 identity.md）。",
			"写法见技能「招人」。建完它立刻存在，下一条消息就能 @ 它。",
		].join(""),
		parameters: Type.Object({
			name: Type.String({ description: "姓名。" }),
			title: Type.Optional(Type.String({ description: "身份标签，纯展示用" })),
			manager: Type.Optional(Type.String({ description: "上级的 slug，必须是名册里已有的人；不确定就不传，缺省是你自己" })),
			team: Type.Optional(Type.String({ description: "所在团队 slug" })),
			body: Type.Optional(
				Type.String({
					description:
						"identity.md 的正文：①负责什么 ②不做什么 ③怎么汇报 ④做得好是什么样。",
				}),
			),
		}),
		execute: async (args, api, context) => {
			const ctx = context ?? BACKGROUND_CONTEXT;
			const self = await selfOf(deps, Number(api.conversationId), ctx);
			const manager = args.manager ?? self ?? OWNER_SLUG;
			const known = new Set((await readAllIdentities(deps.agentsRoot)).map((item) => item.slug));
			known.add(OWNER_SLUG);
			if (!known.has(manager)) {
				return text(`没有这个上级：${manager}。现有 slug：${[...known].join("、")}。不传 manager 就是你自己（${self ?? OWNER_SLUG}）。`);
			}
			const identity = await createAgent({
				root: deps.agentsRoot,
				name: args.name,
				...(args.title === undefined ? {} : { title: args.title }),
				manager,
				...(args.team === undefined ? {} : { team: args.team }),
				// 身份正文也会进每一轮提示词，跟 `file` 写盘走同一道脱敏。
				...(args.body === undefined ? {} : { body: redact(args.body, deps.workspaceRoot) }),
			}).catch((error: unknown) => (error instanceof Error ? error.message : String(error)));
			// slug 不合法（含 `.`、`.`、`..` 之类）是输入问题，回一句话让它改，别把工具打成异常。
			if (typeof identity === "string") return text(identity);
			// 私聊是「他干活的地方」，招到人就建好（幂等）；建失败不影响「人已经招到」。
			await deps.ensureDm?.(identity.slug, ctx).catch(() => undefined);
			if (deps.openAgent !== undefined) {
				const id = await deps.openAgent(identity.slug, ctx);
				await deps.saveDirectory((value) => ({
					...value,
					slugToConversation: { ...value.slugToConversation, [identity.slug]: id },
					conversationToSlug: { ...value.conversationToSlug, [String(id)]: identity.slug },
				}), ctx);
				return text(`已新建 ${identity.name}（slug: ${identity.slug}），会话 ${id} 已就绪。它的身份在 agents/${identity.slug}/identity.md。`);
			}
			return text(`已新建 ${identity.name}（slug: ${identity.slug}）。身份在 agents/${identity.slug}/identity.md，重启或外壳扫描后它会开会话。`);
		},
	});
	return tool;
}
