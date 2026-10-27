/**
 * 发言人：谁在说话。
 *
 * 契约第 3 节要求「每条消息都能显示发送者」——老板发的、别的 agent 派来的、
 * 助手回的，都要能标出人。这里把「会话标识 / 显示名 → ActorRef」的推导
 * 收在一处，feed、org-view、profile 三个出口共用同一套口径，
 * 避免同一个 CEO 在三个地方显示成三种名字。
 */
import { ROLE_LABELS, type CompanyState, type ManagementRole } from "../company/docs.ts";

/** 一个发言人。 */
export type ActorRef = {
	readonly conversationId?: number;
	/** 「CEO」「周牧」「老板」。 */
	readonly label: string;
	readonly kind: "owner" | "role" | "project" | "staff" | "system";
};

/** 老板本人。 */
export const OWNER_REF: ActorRef = { label: "老板", kind: "owner" };

/** 系统（没有具体人）。 */
export const SYSTEM_REF: ActorRef = { label: "系统", kind: "system" };

/**
 * 会话标识 → 发言人。
 *
 * 公司索引里没有的会话返回 undefined（例如历史遗留会话、已删除项目），
 * 调用方自行决定降级成什么。
 */
export function actorRefOf(state: CompanyState | undefined, conversationId: number): ActorRef | undefined {
	if (state === undefined) return undefined;

	for (const [role, id] of Object.entries(state.roles ?? {})) {
		if (id !== conversationId) continue;
		return {
			conversationId,
			label: ROLE_LABELS[role as ManagementRole] ?? role.toUpperCase(),
			// CEO 会话就是老板通道：助手是 CEO，会话类型沿用 feed 的 kind 语义
			kind: role === "ceo" ? "owner" : "role",
		};
	}
	for (const project of Object.values(state.projects ?? {})) {
		if (project.leader !== conversationId) continue;
		return { conversationId, label: project.leaderName ?? project.name, kind: "project" };
	}
	for (const person of Object.values(state.staff ?? {})) {
		if (person.conversationId !== conversationId) continue;
		return { conversationId, label: person.name, kind: "staff" };
	}
	return undefined;
}

/**
 * 显示名 → 发言人。
 *
 * 派活/留痕条目里只存了 `from: "CEO"` 这样的名字，没有会话标识。
 * 按公司索引反查一次，能补上 conversationId 就补上；补不上也要给个
 * 可读的名字，绝不能把消息显示成「未知」。
 *
 * ⚠️ `label` 的实际类型是 `string | undefined` **但在真实数据里不总成立**：
 * `app.channel` 条目（`deliver.ts` 投递时写的）把 `from` 存成**数字 conversationId**
 * （例：`{"from":0,"fromLabel":"老板"}`），而调用点把它直接传进来。
 * 原先这里直接 `(label ?? "").trim()`，于是整个 `/api/feed/:id` 对**所有会话**
 * 报 `(label ?? "").trim is not a function`（500），单会话流水一条都看不到。
 *
 * 处置：把入参类型放宽成 `unknown`，按「数字 → 按 conversationId 反查」归一下降，
 * 并把归一逻辑放在本函数入口（而不是每个调用点）——调用点有三个，漏一个就复发。
 */
export function refOfLabel(state: CompanyState | undefined, label: unknown): ActorRef {
	// 数字（实测 `app.channel` 的 186 条都是这一形态）：它的语义已经是会话标识，
	// 直接走 `actorRefOf` 反查，拿到什么算什么；反查不到就降级成可读文字。
	if (typeof label === "number") {
		if (!Number.isFinite(label)) return SYSTEM_REF;
		const ref = actorRefOf(state, label);
		if (ref !== undefined) return ref;
		// 老板会话恒为 0（`domain/channels.ts` 的 OWNER_ID），即使 state 缺失也能定。
		if (label === 0) return OWNER_REF;
		return { conversationId: label, label: `会话 ${label}`, kind: "system" };
	}
	// 只有字符串才有「显示名」语义；对象/布尔等非法形态一律降级，不让它把整个 feed 打挂。
	const name = typeof label === "string" ? label.trim() : "";
	if (name === "" || name === "系统" || name === "system" || name === "self") return SYSTEM_REF;
	if (name === "老板" || name === "owner" || name === "owner-decision") return OWNER_REF;
	if (state === undefined) return { label: name, kind: "system" };

	// 岗位：CEO / CTO / …
	for (const [role, id] of Object.entries(state.roles ?? {})) {
		const roleLabel = ROLE_LABELS[role as ManagementRole] ?? role.toUpperCase();
		if (roleLabel !== name && role.toUpperCase() !== name.toUpperCase()) continue;
		// 派活方在契约里一律是 role（「CEO 派来的」），不看它是不是老板通道
		return { conversationId: id, label: roleLabel, kind: "role" };
	}
	// 项目负责人：名字优先，其次是项目名
	for (const project of Object.values(state.projects ?? {})) {
		if (project.leaderName !== name && project.name !== name) continue;
		return { conversationId: project.leader, label: project.leaderName ?? project.name, kind: "project" };
	}
	// 员工
	for (const person of Object.values(state.staff ?? {})) {
		if (person.name !== name) continue;
		return { conversationId: person.conversationId, label: person.name, kind: "staff" };
	}

	// 认不出来的人：保留原名，标成 system 而不是硬塞成某个角色
	return { label: name, kind: "system" };
}

