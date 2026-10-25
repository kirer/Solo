/**
 * 公司的持久化文档定义。
 *
 * 组织关系是全局的，所以公司索引放在 session 级文档里（见 design.md 决策 2）。
 * 每个会话另有小档案记录它在组织里的位置。
 *
 * 所有 `checkpointWhen` 都返回 false：这些文档靠变更重放恢复，
 * 不需要存完整基线。注意底层要求这个字段必填。
 *
 * 2026-10-26：纯类型与纯函数已拆到 `src/domain/org-types.ts`（`domain/` 层不能
 * import 运行时库）。这里 re-export，调用方的 import 路径不变。
 */
import { defineDoc } from "../runtime/index.ts";
import type {
	CompanyState,
	ManagementRole,
	ManagerRef,
	ModelOption,
	ModelRef,
	ProjectEntry,
	ProjectStatus,
	StaffEntry,
} from "../domain/org-types.ts";

// 纯类型与纯函数：转发到 domain 层（唯一真相源在那里）
export * from "../domain/org-types.ts";

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
	| "project-status"
	| "staff-manager-change"
	| "staff-rename"
	| "escalate"
	| "decide"
	| "owner-decision"
	| "delegate"
	/**
	 * 待办被驳回 / 标记已解决（老板或对应决策人清理看板）。
	 *
	 * 为什么新开一个 kind 而不复用 `decide`：`decide` 是「给出了决定，工作继续往前走」，
	 * 而驳回/已解决是「这条待办到此为止，不再等人拍」。两者语义相反（一个产出答案、
	 * 一个终结问题），混在同一个 kind 里事后无法区分「他答了」与「他关掉了」。
	 * 具体是驳回还是已解决，记在同一条事件的 `note` 前缀与 `ref` 上（见 disposePending）。
	 */
	| "dispose";

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
