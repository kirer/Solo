/**
 * 公司的持久化文档定义。
 *
 * 组织关系是全局的，所以公司索引放在 session 级文档里（见 design.md 决策 2）。
 * 每个会话另有小档案记录它在组织里的位置。
 *
 * 所有 `checkpointWhen` 都返回 false：这些文档靠变更重放恢复，
 * 不需要存完整基线。注意底层要求这个字段必填。
 */
import { defineDoc } from "../runtime/index.ts";

/** 管理层岗位名。 */
export const MANAGEMENT_ROLES = ["ceo", "cto", "cfo", "cpo", "coo", "cmo", "chro"] as const;
export type ManagementRole = (typeof MANAGEMENT_ROLES)[number];

/** 岗位的中文显示名。 */
export const ROLE_LABELS: Record<ManagementRole, string> = {
	ceo: "CEO",
	cto: "CTO",
	cfo: "CFO",
	cpo: "CPO",
	coo: "COO",
	cmo: "CMO",
	chro: "CHRO",
};

/** 模型引用（provider + modelId），与底层结构一致但由本层拥有。 */
export type ModelRef = { readonly provider: string; readonly modelId: string };

/** 可分配模型的清单项，带价格以便 CHRO 判断成本。 */
export type ModelOption = {
	readonly id: string;
	readonly provider: string;
	readonly modelId: string;
	readonly label: string;
	/** 美元 / 百万输入 token。 */
	readonly inputPerMTok: number;
	/** 美元 / 百万输出 token。 */
	readonly outputPerMTok: number;
};

/** 项目状态。 */
export type ProjectStatus = "planning" | "active" | "paused" | "done" | "terminated" | "archived";

/** 项目索引项。 */
export type ProjectEntry = {
	readonly slug: string;
	readonly name: string;
	/** 工作空间绝对路径。 */
	readonly workspace: string;
	/** 项目负责人会话标识。 */
	readonly leader: number;
	/** 项目负责人的名字（显示用）。 */
	readonly leaderName: string;
	readonly status: ProjectStatus;
	/** 需求摘要。 */
	readonly brief: string;
	readonly createdAt: number;
	/** 终止记录：谁、为什么、什么时候。只有 status 为 terminated 时有。 */
	terminated?: {
		at: number;
		by: string;
		reason: string;
	};
};

/** 员工名册项。 */
export type StaffEntry = {
	/** 员工名（项目内唯一）。 */
	readonly name: string;
	/** 员工角色（产品 / 设计 / 开发 / 测试 …）。 */
	readonly role: string;
	readonly conversationId: number;
	/** 所属项目 slug。 */
	readonly project: string;
	/** 直属上级岗位。 */
	readonly manager: ManagementRole;
	/** 生效模型。 */
	readonly model: ModelRef;
	readonly hiredAt: number;
	readonly archived: boolean;
};

/** 公司索引：组织状态的唯一真相源。 */
export type CompanyState = {
	company: {
		name: string;
		createdAt: number;
	};
	/** 管理层岗位 → 会话标识。 */
	roles: Record<string, number>;
	/** 项目 slug → 项目。 */
	projects: Record<string, ProjectEntry>;
	/** `${project}/${name}` → 员工。 */
	staff: Record<string, StaffEntry>;
	/** 已归档的会话标识（底层无删除 API，用软删标记）。 */
	archived: number[];
	/** 公司默认模型。 */
	defaultModel: ModelRef;
	/** 项目工作空间的根目录。删除项目时用它校验路径，防止误删。 */
	workspaceRoot: string;
	/** 可分配模型清单。 */
	modelCatalog: ModelOption[];
};

/** 公司索引文档。 */
export const CompanyDoc = defineDoc<CompanyState>({
	kind: "app.company",
	version: 1,
	scope: "session",
	initial: () => ({
		company: { name: "", createdAt: 0 },
		roles: {},
		projects: {},
		staff: {},
		archived: [],
		defaultModel: { provider: "faux", modelId: "faux-1" },
		modelCatalog: [],
		workspaceRoot: "",
	}),
	checkpointWhen: () => false,
});

/** 会话在组织里的类型。 */
export type ConversationKind = "owner" | "role" | "project" | "staff" | "branch";

/** 会话档案：每个会话在组织里的位置。 */
export type ProfileState = {
	/** 显示名。 */
	title: string;
	kind: ConversationKind;
	/** 所属项目 slug（项目会话与员工会话有）。 */
	project?: string;
	/** 上级会话标识（员工指向项目负责人）。 */
	parent?: number;
	/** 工作空间绝对路径。 */
	workspace?: string;
	/** 岗位或角色名。 */
	role?: string;
};

/** 会话档案文档。fork 时继承分叉那一刻的档案（需要 rewindable 才能用 asOf）。 */
export const ProfileDoc = defineDoc<ProfileState>({
	kind: "app.profile",
	version: 1,
	scope: "conversation",
	history: "rewindable",
	fork: "asOf",
	initial: () => ({ title: "", kind: "branch" }),
	checkpointWhen: () => false,
});

/** 审计事件类型。 */
export type AuditEventType =
	| "hire"
	| "archive"
	| "project-create"
	| "escalate"
	| "decide"
	| "owner-decision"
	| "delegate";

/** 审计事件。 */
export type AuditEvent = {
	at: number;
	type: AuditEventType;
	from?: string;
	to?: string;
	note?: string;
	/** 关联标识（升级流程、派活等）。 */
	ref?: string;
};

/** 会话级审计文档。可回溯，便于重建历史。 */
export const AuditDoc = defineDoc<{ events: AuditEvent[] }>({
	kind: "app.audit",
	version: 1,
	scope: "conversation",
	history: "rewindable",
	fork: "initial",
	initial: () => ({ events: [] }),
	checkpointWhen: () => false,
});

/** 预算状态。 */
export type BudgetState = {
	/** 美元上限；0 表示不限。 */
	limitUsd: number;
	/** 已花美元（由成本聚合写入）。 */
	spentUsd: number;
};

/** 会话级预算文档。 */
export const BudgetDoc = defineDoc<BudgetState>({
	kind: "app.budget",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "initial",
	initial: () => ({ limitUsd: 0, spentUsd: 0 }),
	checkpointWhen: () => false,
});

/** 沟通记录类型（见 communication-trail 规格）。 */
export type TrailKind = "delegate" | "report" | "escalate" | "decide" | "hire" | "archive";

/** 一条沟通记录的数据。 */
export type TrailMessage = {
	readonly at: number;
	/** 发送方名（"self" 表示本会话发出）。 */
	readonly from: string;
	readonly to: string;
	readonly kind: TrailKind;
	readonly text?: string;
	/** 共同标识，用于把双方的记录对应起来。 */
	readonly ref: string;
	/** 所属项目 slug。 */
	readonly project?: string;
};

/** 公司级时间线：避免追溯时全量扫描会话（见 design.md 决策 6 与风险一节）。 */
export type TrailEdge = {
	at: number;
	kind: TrailKind;
	fromConversation: number;
	toConversation: number;
	from: string;
	to: string;
	ref: string;
	project?: string;
};

export type TrailState = {
	edges: TrailEdge[];
};

/** 公司级时间线文档。 */
export const TrailDoc = defineDoc<TrailState>({
	kind: "app.trail",
	version: 1,
	scope: "session",
	initial: () => ({ edges: [] }),
	checkpointWhen: () => false,
});
