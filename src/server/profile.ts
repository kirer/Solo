/**
 * 职工档案：这位职工是谁、被交代了什么、手上有什么技能。
 *
 * 数据来源（契约第 4 节）：**只从公司索引与角色定义推导**，不去读底层会话配置。
 * 理由：会话配置是 experimental 接口，而且拿不全——真正的角色提示词在
 * `ROLE_DEFINITIONS` / `PROJECT_LEADER_CHARTER` / 员工能力包里，是纯函数，
 * 读它们既稳定又与模型实际收到的内容一致。
 */
import { BACKGROUND_CONTEXT, type CompanyRuntime, type Context } from "../runtime/index.ts";
import { staffCharterOf } from "../company/prompts.ts";
import { ROLE_LABELS, managerLabelOf, type ManagementRole } from "../company/docs.ts";
import { COMMON_GUIDE, ROLE_DEFINITIONS } from "../company/roles.ts";
import { employeeToolsFor, employeeUniversalTools, readCompany } from "../company/org.ts";
import { buildOrg, managerLabelInOrg } from "../company/org-model.ts";
import {
	createEmployeeExtension,
	createProjectLeaderExtension,
	createRoleExtensionWithTools,
	PROJECT_LEADER_CHARTER,
} from "../company/tools.ts";
import { createManagementTools } from "../company/management-tools.ts";

/** 一个职工/角色的档案（契约第 4 节）。 */
export type ActorProfile = {
	readonly conversationId: number;
	readonly label: string;
	readonly kind: "owner" | "role" | "project" | "staff";
	/** 一句话职责。 */
	readonly subtitle: string;
	/** 员工角色（名册上的标签；能力与提示词都不再按它推断）。 */
	readonly role?: string;
	/** 员工的职责（招聘时上级写下的一段话）。 */
	readonly duty?: string;
	/** 所属项目名。 */
	readonly project?: string;
	/** 上级显示名。 */
	readonly parent?: string;
	/** provider/modelId。 */
	readonly model: string;
	/** 角色预制提示词（纯文本，可能多段，用 \n 分隔）。 */
	readonly charter: string;
	/** 通用工作准则。 */
	readonly guide?: string;
	/** 该会话实际可用的技能/工具。 */
	readonly tools: readonly { readonly name: string; readonly description: string }[];
};

/** 档案查询结果：找不到时给一句能显示的原因。 */
export type ProfileResult = { readonly profile: ActorProfile } | { readonly error: string };

/**
 * 读一个会话的档案。
 *
 * 返回 `{ error }` 的三种情况：会话不在组织索引里、会话根本不存在、
 * 索引缺了这个岗位。前端都降级成「暂无档案」。
 */
export async function readProfile(
	runtime: CompanyRuntime,
	conversationId: number,
	context: Context = BACKGROUND_CONTEXT,
): Promise<ProfileResult> {
	const state = await readCompany(runtime, context);
	if (state === undefined) return { error: "公司尚未初始化，没有档案" };

	// 工具集只用来读「这个能力包实际装了什么」，不触发任何业务动作
	const toolset = createManagementTools({
		runtime,
		workspaceRoot: state.workspaceRoot === "" ? process.cwd() : state.workspaceRoot,
	});

	// ① 老板通道 / 管理层岗位
	for (const [role, id] of Object.entries(state.roles ?? {})) {
		if (id !== conversationId) continue;
		const roleKey = role as ManagementRole;
		const definition = ROLE_DEFINITIONS[roleKey];
		if (definition === undefined) return { error: `未知岗位：${role}` };
		return {
			profile: {
				conversationId,
				label: definition.label,
				kind: roleKey === "ceo" ? "owner" : "role",
				subtitle: definition.summary,
				parent: roleKey === "ceo" ? "老板" : "CEO",
				model: modelOf(state.defaultModel),
				charter: definition.charter,
				guide: COMMON_GUIDE,
				tools: describeTools(createRoleExtensionWithTools(roleKey, toolset).tools),
			},
		};
	}

	// ② 项目负责人
	for (const project of Object.values(state.projects ?? {})) {
		if (project.leader !== conversationId) continue;
		return {
			profile: {
				conversationId,
				label: project.leaderName ?? project.name,
				kind: "project",
				subtitle: `${project.name} 项目负责人`,
				project: project.name,
				// 从 buildOrg 取，不要硬编码 "CEO"（负责人的上级可能是 CTO）
				parent: managerLabelInOrg(buildOrg(state), project.leader) || "CEO",
				model: modelOf(state.defaultModel),
				charter: [`你是「${project.name}」项目的负责人。`, PROJECT_LEADER_CHARTER].join("\n"),
				guide: COMMON_GUIDE,
				tools: describeTools(createProjectLeaderExtension(toolset).tools),
			},
		};
	}

	// ③ 员工
	for (const person of Object.values(state.staff ?? {})) {
		if (person.conversationId !== conversationId) continue;
		const project = state.projects[person.project];
		const tools = employeeToolsFor(runtime, person.tools ?? []);
		return {
			profile: {
				conversationId,
				label: person.name,
				kind: "staff",
				subtitle: `${person.role} · ${project?.name ?? person.project}`,
				role: person.role,
				duty: person.duty,
				project: project?.name ?? person.project,
				parent: managerLabelOf(state, person.manager),
				model: modelOf(person.model),
				// 员工实际收到的提示词 = 职责（招聘时上级写的那段）+ 汇报关系
				charter: staffCharterOf({
					duty: person.duty,
					projectName: project?.name ?? person.project,
					managerLabel: managerLabelOf(state, person.manager),
				}),
				guide: COMMON_GUIDE,
				// 第三参不能漏：漏了档案页展示的工具清单就比员工实际拿到的少 7 个
				// （whoami/say/ask/read_channel/inbox/task_list/task_update）。
				// 招聘、重启自愈、改名三处都传了，只有这里曾漏掉。
				tools: describeTools(
					createEmployeeExtension(`${person.project}/${person.name}`, tools, employeeUniversalTools(runtime)).tools,
				),
			},
		};
	}

	return { error: `会话 ${conversationId} 不在组织里，没有档案` };
}

/** provider/modelId。 */
function modelOf(model: { readonly provider: string; readonly modelId: string } | undefined): string {
	if (model === undefined) return "?";
	return `${model.provider}/${model.modelId}`;
}

/** 能力包里的工具 → 名称与说明。 */
function describeTools(
	tools: readonly { readonly name: string; readonly description: string }[] | undefined,
): readonly { readonly name: string; readonly description: string }[] {
	return (tools ?? []).map((tool) => ({ name: tool.name, description: tool.description }));
}
