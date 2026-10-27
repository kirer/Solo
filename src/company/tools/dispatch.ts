/**
 * 派活工具（异步版）：`assign_task` / `ask_role`。
 *
 * 设计见 `docs/COMMS.md` §5.1 与 ADR-028。
 *
 * ── 为什么把四个工具合并成两个 ──
 *
 * 旧的一套是同步的，且语义重叠：
 * | 旧工具 | 问题 |
 * |---|---|
 * | `delegate_to_role` | 同步等 180s，跳过负责人 |
 * | `delegate_to_leader` | 同步等 180s |
 * | `delegate_to_staff` | 同步等 180s，绕过负责人 |
 * | `staff_assign` | 和 `delegate_to_staff` 实现完全一样，只是名字不同 |
 *
 * 四个工具做同一件事（把活交给某人并等它答），模型要在它们之间选，选错就出问题。
 *
 * 现在只有两个，语义按「有没有验收标准」区分：
 *
 * - **`assign_task`**：有验收标准 → 建任务，进看板，完成自动上报。
 *   用于「这件事要做完」。
 * - **`ask_role`**：没有验收标准，只是问一句 → 频道里 @ 对方。
 *   用于「帮我看一下 / 你觉得呢 / 这个字段叫什么」。
 *
 * 两个都**不等待**。对方干完会自己回报（任务）或在频道里回话（提问）。
 *
 * ── 越级约束保留 ──
 *
 * `assign_task` 仍然走 `canAssign()`（只能从上到下）。员工没有这个工具。
 * 但**管理层可以直接给项目员工建任务**——这是老板要的「派发只能从上到下」，
 * 而不是「必须经过负责人」。绕过负责人仍然是允许的（老板明确要求：
 * 层级是 我→CEO→管理层→负责人→职员，任务派发只能从上到下，
 * 也就是说上层可以给任何下层派，不必逐层转手）。
 */
import { BACKGROUND_CONTEXT, defineTool, Type, type CompanyRuntime} from "../../runtime/index.ts";
import { projectChannelId, OWNER_ID } from "../../domain/channels.ts";
import { canAssign, labelOf, personOf, type Org } from "../../domain/membership.ts";
import { TASK_PRIORITIES, type TaskPriority } from "../../domain/tasks.ts";
import { buildOrg } from "../org-model.ts";
import { CompanyDoc } from "../docs.ts";
import { postToChannel, readChannels } from "../channels.ts";
import { createTask } from "../tasks.ts";
import { readCompany } from "../org.ts";

/** 派活工具的依赖。 */
export type DispatchDeps = {
	readonly runtime: CompanyRuntime;
};

function text(value: string) {
	return { output: [{ type: "text" as const, text: value }] };
}

/** 解析「给谁」：人名 / 岗位名 / 负责人 / 项目名。 */
function resolveTarget(
	org: Org,
	raw: string,
	options: { readonly project?: string } = {},
): { readonly id: number; readonly label: string } | { readonly error: string } {
	const needle = raw.trim().replace(/^@/, "");
	if (needle === "") return { error: "要指定派给谁。" };

	// 老板
	if (needle === "老板" || needle === "owner") return { id: OWNER_ID, label: "老板" };

	// 岗位名
	const roleAlias: Record<string, string> = {
		ceo: "CEO", cto: "CTO", cfo: "CFO", cpo: "CPO", coo: "COO", cmo: "CMO", chro: "CHRO",
		CEO: "CEO", CTO: "CTO", CFO: "CFO", CPO: "CPO", COO: "COO", CMO: "CMO", CHRO: "CHRO",
	};
	if (roleAlias[needle] !== undefined) {
		const person = org.people.find((entry) => entry.label === roleAlias[needle]);
		if (person === undefined) return { error: `找不到岗位 ${needle}。` };
		return { id: person.conversationId, label: person.label };
	}

	// 「负责人」：项目负责人
	if (needle === "负责人" || needle === "leader") {
		const slug = options.project;
		const id = slug === undefined ? undefined : org.projectLeaders[slug];
		if (id === undefined) return { error: "不知道哪个项目的负责人：请同时给 project。" };
		return { id, label: labelOf(org, id) };
	}

	// 人名（先精确，再包含）
	const exact = org.people.find((entry) => entry.label === needle);
	if (exact !== undefined) return { id: exact.conversationId, label: exact.label };
	const partial = org.people.filter((entry) => entry.label.includes(needle));
	if (partial.length === 1) {
		const only = partial[0] as (typeof partial)[number];
		return { id: only.conversationId, label: only.label };
	}
	if (partial.length > 1) {
		return { error: `「${needle}」匹配到多个人：${partial.map((entry) => entry.label).join("、")}。请写全名。` };
	}
	return { error: `找不到「${needle}」。用 org_tree 看组织里都有谁。` };
}

/** 创建派活工具。 */
export function createDispatchTools(deps: DispatchDeps) {
	const { runtime } = deps;

	/**
	 * 建任务并派出去（**不等它做完**）。
	 *
	 * 与 `task_create` 的区别只是参数更宽松（可以给岗位名、可以省略 project
	 * 从目标人身上推）。语义完全相同。
	 */
	const assignTask = defineTool({
		name: "assign_task",
		description: [
			"给某人派一件**要做完的事**：必须给验收标准（acceptance），否则会被拒绝。",
			"**不会等待**：创建后立刻返回，对方做完会自动上报给你。",
			"只是让对方「看一下 / 讨论一下 / 问个问题」不要用这个 —— 用 ask_role 或 ask。",
			"任务派发只能从上到下：你是老板/CEO/管理层/项目负责人才能用；同级之间请用 ask。",
		].join(""),
		parameters: Type.Object({
			assignee: Type.String({ description: "派给谁：人名、岗位名（CTO/CHRO…）、或「负责人」" }),
			title: Type.String({ description: "一句话标题" }),
			acceptance: Type.String({ description: "验收标准：做到什么算做完（必须可验证）" }),
			brief: Type.Optional(Type.String({ description: "背景与具体要求" })),
			project: Type.Optional(Type.String({ description: "项目 slug；派给负责人/员工时必填" })),
			priority: Type.Optional(
				Type.Union(TASK_PRIORITIES.map((priority: TaskPriority) => Type.Literal(priority)), {
					description: "优先级，默认 normal",
				}),
			),
		}),
		execute: async (args, api, context) => {
			const conversationId = Number(api.conversationId);
			const ctx = context ?? BACKGROUND_CONTEXT;
			const company = await runtime.harness.snapshot(CompanyDoc, ctx);
			const org = buildOrg(company);

			const target = resolveTarget(org, args.assignee, {
				...(args.project === undefined ? {} : { project: args.project }),
			});
			if ("error" in target) return text(target.error);

			// 越级校验：只能从上到下
			if (!canAssign(org, conversationId, target.id)) {
				const me = labelOf(org, conversationId);
				return text(
					[
						`你不能给 ${target.label} 派任务：任务派发只能从上到下（老板 → CEO → 管理层 → 项目负责人 → 员工）。`,
						`你是 ${me}。如果要协作或提问，用 ask_role 或 ask（那是通信，不限方向）。`,
						`如果是你解决不了的事，用 escalate 交给上级。`,
					].join("\n"),
				);
			}

			// 项目：优先用显式给的，否则从目标人身上推
			const assigneePerson = personOf(org, target.id);
			const project = args.project ?? assigneePerson?.project;
			if (project === undefined) {
				return text(
					`任务必须属于某个项目。${target.label} 不在任何项目里，请显式给 project（先用 project_list 看现有项目）。`,
				);
			}

			const result = await createTask(
				runtime,
				{
					project,
					channelId: projectChannelId(project),
					title: args.title,
					brief: args.brief ?? "",
					acceptance: args.acceptance,
					assignee: target.id,
					assignedBy: conversationId,
					...(args.priority === undefined ? {} : { priority: args.priority }),
				},
				ctx,
			);
			if (!result.ok) return text(result.message);

			return text(
				[
					`已创建任务 ${result.task.id}「${result.task.title}」并派给 ${target.label}。`,
					`验收标准：${result.task.acceptance}`,
					"**不用等**：它做完会自动上报给你（done/blocked/review 都会报）。",
					"现在可以做别的，或者继续派下一件。",
				].join("\n"),
			);
		},
	});

	/**
	 * 找某人问一句 / 请它帮个忙（**不是任务**）。
	 *
	 * 通信不限方向：可以问上级、同级、下级。会 @ 对方并唤醒它。
	 */
	const askRole = defineTool({
		name: "ask_role",
		description: [
			"找某人问一句 / 请它帮忙（**不是任务**，没有验收标准）。",
			"通信不限方向：可以问上级、同级、下级。会 @ 对方并唤醒它。",
			"**不会等待**：问完立刻返回，对方的回答会出现在频道里。",
			"如果需要一件「做完有明确结果」的事，用 assign_task。",
		].join(""),
		parameters: Type.Object({
			to: Type.String({ description: "问谁：人名、岗位名（CTO/CHRO…）、或「负责人」" }),
			text: Type.String({ description: "要问什么 / 请它做什么，包含必要背景" }),
			project: Type.Optional(Type.String({ description: "在哪个项目的频道里问；不填按对方所在项目推" })),
			channel: Type.Optional(Type.String({ description: "显式指定频道（company / leadership / proj:slug / dm:编号）" })),
		}),
		execute: async (args, api, context) => {
			const conversationId = Number(api.conversationId);
			const ctx = context ?? BACKGROUND_CONTEXT;
			const company = await runtime.harness.snapshot(CompanyDoc, ctx);
			const org = buildOrg(company);
			// 频道可能还没建（旧库 / 测试直接 boot 没跑 ensureAllChannels）：
			// 先补齐，否则「找不到共同频道」会把一个正常请求变成失败。
			let channels = await readChannels(runtime, ctx);
			if (Object.keys(channels.channels).length === 0) {
				const { ensureAllChannels } = await import("../channels.ts");
				await ensureAllChannels(runtime, ctx);
				channels = await readChannels(runtime, ctx);
			}

			const target = resolveTarget(org, args.to, {
				...(args.project === undefined ? {} : { project: args.project }),
			});
			if ("error" in target) return text(target.error);
			if (target.id === conversationId) return text("不用问自己。");

			// 选频道：显式 > 项目群 > 领导层 > 公司群
			const targetPerson = personOf(org, target.id);
			const project = args.project ?? targetPerson?.project;
			const candidates = [
				args.channel,
				project === undefined ? undefined : projectChannelId(project),
				"leadership",
				"company",
			].filter((id): id is string => id !== undefined);

			let channelId: string | undefined;
			for (const id of candidates) {
				const channel = channels.channels[id];
				if (channel === undefined) continue;
				// 双方都得在频道里，否则对方读不到上下文
				if (channel.members[String(target.id)] === undefined) continue;
				if (channel.members[String(conversationId)] === undefined) continue;
				channelId = id;
				break;
			}
			if (channelId === undefined) {
				return text(
					[
						`你和 ${target.label} 没有共同的频道。`,
						"你可以：① 用 say 在你们共同的频道里说；② 如果是权限/资源问题，用 escalate 交给上级。",
					].join("\n"),
				);
			}

			const posted = await postToChannel(
				runtime,
				channelId,
				{
					from: conversationId,
					fromLabel: labelOf(org, conversationId),
					kind: "question",
					text: args.text,
					mentions: [target.id],
				},
				{ context: ctx },
			);

			return text(
				[
					`已在「${channels.channels[channelId]?.title ?? channelId}」问 ${target.label}（#${posted.message.seq}）。`,
					"**不用等**：对方已被唤醒，回答会出现在频道里。",
					"如果 10 分钟没回，系统会自动升级到它的上级并提醒。",
				].join("\n"),
			);
		},
	});

	/** 立项（保留，从 management-tools 迁过来）。 */
	const projectCreate = defineTool({
		name: "project_create",
		description: [
			"立项：建项目工作空间、写 PROJECT.md、创建项目负责人会话、建项目群。",
			"必须同时给中文显示名（name）与英文目录标识（slug）。",
			"同名项目已存在时复用，不重复建（幂等）。",
		].join(""),
		parameters: Type.Object({
			name: Type.String({ description: "项目显示名（可以是中文）" }),
			slug: Type.String({ description: "目录标识：小写拉丁字母、数字、连字符，例如 tank-battle" }),
			brief: Type.String({ description: "需求摘要：目标用户、核心功能、验收标准" }),
			leader: Type.Optional(Type.String({ description: "项目负责人名字，不填用默认" })),
		}),
		execute: async (args, api, context) => {
			const { createProject } = await import("../org.ts");
			const { ensureAllChannels } = await import("../channels.ts");
			const ctx = context ?? BACKGROUND_CONTEXT;
			const state = await readCompany(runtime, ctx);
			if (state === undefined) return text("公司尚未初始化。");

			// 幂等：同名项目已存在就复用
			const existing = Object.values(state.projects).find(
				(project) => project.slug === args.slug || project.name === args.name,
			);
			if (existing !== undefined) {
				return text(
					`项目已存在：${existing.name}（slug ${existing.slug}，负责人 ${existing.leaderName}，状态 ${existing.status}）。直接用它即可。`,
				);
			}

			const workspaceRoot = state.workspaceRoot;
			try {
				const { project } = await createProject(
					runtime,
					{
						name: args.name,
						slug: args.slug,
						brief: args.brief,
						workspaceRoot,
						...(args.leader === undefined ? {} : { leaderName: args.leader }),
					},
					ctx,
				);
				// 新项目立刻建项目群（否则负责人没地方说话）
				await ensureAllChannels(runtime, ctx);
				void api;
				return text(
					[
						`已立项：${project.name}（slug ${project.slug}）`,
						`工作空间：${project.workspace}`,
						`负责人：${project.leaderName}（会话 ${project.leader}）`,
						`项目群：proj:${project.slug}`,
						"",
						"下一步：让 CHRO 用这个 slug 配人，然后给负责人派任务。",
					].join("\n"),
				);
			} catch (error) {
				return text(`立项失败：${error instanceof Error ? error.message : String(error)}`);
			}
		},
	});

	return { assignTask, askRole, projectCreate };
}

/** 派活工具集类型。 */
export type DispatchToolset = ReturnType<typeof createDispatchTools>;
