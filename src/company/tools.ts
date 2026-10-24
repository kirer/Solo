/**
 * 管理层的能力工具。
 *
 * 这些工具**只装在管理层与项目负责人的能力包里**，员工的能力包里一个都没有——
 * 这是「员工无法越级」的结构性保证（ADR-004）。
 *
 * 每个工具都只做一件事，并且返回值是给模型看的自然语言（output），
 * 不是给程序用的结构化数据。
 */
import { defineExtension, defineTool, Type, type Extension } from "../runtime/index.ts";
import type { ManagementRole } from "./docs.ts";
import { COMMON_GUIDE, ROLE_DEFINITIONS } from "./roles.ts";

/** 工具集合：由装配层注入实际实现，避免业务模块之间循环依赖。 */
export type ManagementToolset = {
	/** 查看组织架构。 */
	readonly orgTree: ReturnType<typeof defineTool>;
	/** 向上转一个问题。 */
	readonly escalate: ReturnType<typeof defineTool>;
	/** 自己拍板。 */
	readonly decide: ReturnType<typeof defineTool>;
	/** 立项。 */
	readonly projectCreate: ReturnType<typeof defineTool>;
	/** 写项目计划。 */
	readonly projectPlan: ReturnType<typeof defineTool>;
	/** 列出项目。 */
	readonly projectList: ReturnType<typeof defineTool>;
	/** 终止项目。 */
	readonly projectTerminate: ReturnType<typeof defineTool>;
	/** 彻底删除项目。 */
	readonly projectDelete: ReturnType<typeof defineTool>;
	/** 招聘员工。 */
	readonly staffHire: ReturnType<typeof defineTool>;
	/** 列出员工。 */
	readonly staffList: ReturnType<typeof defineTool>;
	/** 给员工派活。 */
	readonly staffAssign: ReturnType<typeof defineTool>;
	/** 归档员工。 */
	readonly staffArchive: ReturnType<typeof defineTool>;
	/** 查预算。 */
	readonly budgetCheck: ReturnType<typeof defineTool>;
	/** 成本报告。 */
	readonly costReport: ReturnType<typeof defineTool>;
	/** 技术评审。 */
	readonly reviewArchitecture: ReturnType<typeof defineTool>;
	/** 给员工派活。 */
	readonly delegateToStaff: ReturnType<typeof defineTool>;
	/** 转交另一位管理层。 */
	readonly delegateToRole: ReturnType<typeof defineTool>;
};

/** 工具名 → 工具实例。 */
export type ToolName = keyof ManagementToolset;

/** 把角色声明里的能力名映射到实际工具。 */
const CAPABILITY_TO_TOOL: Record<string, ToolName> = {
	org_tree: "orgTree",
	escalate: "escalate",
	decide: "decide",
	review_architecture: "reviewArchitecture",
	delegate_to_staff: "delegateToStaff",
	delegate_to_role: "delegateToRole",
	project_create: "projectCreate",
	project_plan: "projectPlan",
	project_list: "projectList",
	project_terminate: "projectTerminate",
	project_delete: "projectDelete",
	staff_hire: "staffHire",
	staff_list: "staffList",
	staff_assign: "staffAssign",
	staff_archive: "staffArchive",
	budget_check: "budgetCheck",
	cost_report: "costReport",
};

/**
 * 为某个岗位创建能力包，注入它的工具集合。
 *
 * 只装该岗位声明里列出的工具，其余一律不装。
 */
export function createRoleExtensionWithTools(role: ManagementRole, tools: ManagementToolset): Extension {
	const definition = ROLE_DEFINITIONS[role];
	if (definition === undefined) throw new Error(`未知岗位：${role}`);

	const selected = definition.capabilityNames
		.map((name) => CAPABILITY_TO_TOOL[name])
		.filter((name): name is ToolName => name !== undefined)
		.map((name) => tools[name]);

	return defineExtension({
		name: definition.extensionName,
		sections: [
			// 纯函数：不含时间戳（ADR-007）
			(() => {
				const charter = definition.charter;
				return { key: "role", tag: false, render: () => charter };
			})(),
			(() => {
				const guide = COMMON_GUIDE;
				return { key: "guide", tag: false, render: () => guide };
			})(),
		],
		tools: selected,
	});
}

/** 创建全部岗位的能力包（带工具）。 */
export function createAllRoleExtensionsWithTools(tools: ManagementToolset): Extension[] {
	return (Object.keys(ROLE_DEFINITIONS) as ManagementRole[]).map((role) =>
		createRoleExtensionWithTools(role, tools),
	);
}

/**
 * 员工能力包：只有执行类工具，没有任何管理能力。
 *
 * **名字必须唯一**（用员工名派生）。底层按名字存会话的能力包选择，
 * 所有员工共用一个名字会导致后招聘的覆盖前面的——表现是某些员工
 * 莫名其妙没有任何工具。
 *
 * @param employeeId 员工标识（项目内唯一），用于生成能力包名
 * @param employeeTools 该员工的执行类工具
 */
export function createEmployeeExtension(
	employeeId: string,
	employeeTools: readonly ReturnType<typeof defineTool>[],
): Extension {
	return defineExtension({
		name: `role-employee:${employeeId}`,
		sections: [
			{
				key: "employee",
				tag: false,
				render: () => "你是项目员工。只做被指派的工作，遇到不确定的事上报直属上级，不越级。",
			},
		],
		tools: employeeTools,
	});
}

/** 供测试与诊断：某个岗位声明了哪些能力名。 */
export function capabilitiesOf(role: ManagementRole): readonly string[] {
	return ROLE_DEFINITIONS[role].capabilityNames;
}
