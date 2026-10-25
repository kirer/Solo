/**
 * 从 `CompanyDoc` 推导组织结构（`domain/membership.ts` 的 `Org`）。
 *
 * 为什么单独一个文件：`domain/` 层不能 import 运行时库，所以它只认 `Org`
 * 这个最小视图。这里是唯一把「持久化的公司索引」翻译成「权限判定能用的结构」
 * 的地方——所有权限判定都从这一个函数拿输入，不会出现两处口径不一致。
 *
 * 三处硬规则：
 * 1. 老板恒在（conversationId = 0），且没有上级
 * 2. 管理层的上级恒为 CEO
 * 3. 项目负责人的上级 = 该项目对应的管理层（由 `staff` 里员工的 manager 推导，
 *    没有员工时回落到 CEO）；员工的上级 = `StaffEntry.manager`
 */
import { OWNER_ID, type MemberRole } from "../domain/channels.ts";
import type { Org, OrgPerson } from "../domain/membership.ts";

export type { Org, OrgPerson } from "../domain/membership.ts";
import {
	MANAGEMENT_ROLES,
	ROLE_LABELS,
	managerConversationOf,
	type CompanyState,
	type ManagementRole,
	type ManagerRef,
} from "../domain/org-types.ts";

/** 空组织（公司还没初始化时）。 */
export function emptyOrg(): Org {
	return { people: [], projectLeaders: {}, ceoId: 0 };
}

/**
 * 把公司索引翻译成组织结构。
 *
 * 注意：这里**不做权限判断**，只描述「谁是谁的上级、谁在哪个项目」。
 * 判断在 `domain/membership.ts` 的纯函数里。
 */
export function buildOrg(state: CompanyState | undefined): Org {
	if (state === undefined || state.company.name === "") return emptyOrg();

	const ceoId = Number(state.roles.ceo ?? 0);
	const people: OrgPerson[] = [];

	// 1) 老板（不在 roles 里，但必须在 people 里，否则 @ 不到他）
	people.push({ conversationId: OWNER_ID, label: "老板", role: "owner" });

	// 2) CEO
	if (ceoId > 0) {
		people.push({
			conversationId: ceoId,
			label: ROLE_LABELS.ceo,
			role: "ceo",
			managerId: OWNER_ID,
		});
	}

	// 3) 其余管理层：上级恒为 CEO
	for (const role of MANAGEMENT_ROLES) {
		if (role === "ceo") continue;
		const id = state.roles[role];
		if (id === undefined) continue;
		people.push({
			conversationId: Number(id),
			label: ROLE_LABELS[role],
			role: "management",
			...(ceoId > 0 ? { managerId: ceoId } : {}),
		});
	}

	// 4) 项目负责人 + 员工
	const projectLeaders: Record<string, number> = {};
	for (const project of Object.values(state.projects)) {
		if (project.status === "terminated" || project.status === "archived") continue;
		projectLeaders[project.slug] = project.leader;
	}

	// 负责人的上级：从本项目员工的 manager 推导（第一个能解析到管理层的就用它），
	// 否则回落到 CEO。这样「负责人向 CTO 汇报」这种配置能自动继承。
	const leaderManager = new Map<number, number>();
	for (const person of Object.values(state.staff)) {
		const slug = person.project;
		const leader = state.projects[slug]?.leader;
		if (leader === undefined) continue;
		const managerId = managerConversationOf(state, person.manager as ManagerRef);
		if (managerId === undefined || managerId === leader) continue;
		// 只认管理层岗位，不认「另一个项目的负责人」（跨项目汇报是非法的）
		if (!leaderManager.has(leader) && isManagementConversation(state, managerId)) {
			leaderManager.set(leader, managerId);
		}
	}

	for (const project of Object.values(state.projects)) {
		if (project.status === "terminated" || project.status === "archived") continue;
		const managerId = leaderManager.get(project.leader) ?? (ceoId > 0 ? ceoId : undefined);
		people.push({
			conversationId: project.leader,
			label: project.leaderName !== "" ? project.leaderName : project.name,
			role: "leader",
			project: project.slug,
			...(managerId === undefined ? {} : { managerId }),
		});
	}

	for (const person of Object.values(state.staff)) {
		if (person.project === undefined) continue;
		// 已终止/已删除项目下的员工不进组织图
		const project = state.projects[person.project];
		if (project === undefined) continue;
		if (project.status === "terminated" || project.status === "archived") continue;
		const managerId = managerConversationOf(state, person.manager as ManagerRef);
		people.push({
			conversationId: person.conversationId,
			label: person.name,
			role: "staff",
			project: person.project,
			...(managerId === undefined ? {} : { managerId }),
			...(person.archived ? { archived: true } : {}),
		});
	}

	return { people, projectLeaders, ceoId };
}

/** 某个会话是不是管理层岗位（含 CEO）。 */
function isManagementConversation(state: CompanyState, conversationId: number): boolean {
	for (const role of MANAGEMENT_ROLES) {
		if (Number(state.roles[role]) === conversationId) return true;
	}
	return false;
}

/** 某个会话的成员层级（频道成员用）。 */
export function memberRoleOf(org: Org, conversationId: number): MemberRole {
	const person = org.people.find((entry) => entry.conversationId === conversationId);
	return person?.role ?? "staff";
}

/** 管理层的显示名（审计/留痕用）。 */
export function managementLabel(role: ManagementRole): string {
	return ROLE_LABELS[role];
}

/**
 * 某人在组织里的上级展示名（组织图 / 档案页用）。
 *
 * 为什么需要它：`org-view.ts` 和 `profile.ts` 曾经把项目负责人的 `parent`
 * 硬编码成 `"CEO"`，而 `buildOrg()` 允许负责人的上级是 CTO（由本项目员工的
 * manager 推导）——同一家公司，组织图和档案页给出两条不同的汇报线。
 *
 * 老板返回空串（他没有上级，界面不显示）。
 */
export function managerLabelInOrg(org: Org, conversationId: number): string {
	const person = org.people.find((entry) => entry.conversationId === conversationId);
	if (person === undefined || person.managerId === undefined) return "";
	if (person.managerId === OWNER_ID) return "老板";
	return org.people.find((entry) => entry.conversationId === person.managerId)?.label ?? "";
}
