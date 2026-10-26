/**
 * 公司的持久化文档定义。
 *
 * 组织关系是全局的，所以公司索引放在 session 级文档里（见 design.md 决策 2）。
 * 每个会话另有小档案记录它在组织里的位置。
 *
 * `checkpointWhen` 决定「什么时候把当前值压成一个完整基线」。
 *
 * 本文件里的文档**全部返回 false**：靠变更重放恢复，不存完整基线。
 * 注意底层要求这个字段必填。
 *
 * 为什么不全用「每 N 条 delta 压一次」（`ChannelDoc` / `TaskDoc` 是
 * `deltasSinceBase >= 64`）：`src/company/channels-doc.ts` 的频道文档单条 delta
 * 就有几十 KB（一次 append 会带上整个频道数组），按计数压基等于每 64 次写就
 * 重写一份完整文档。而这里这几个文档（公司索引、审计、留痕、待办、会议）
 * 是**只增不改**的：压基写的是同样大小的完整快照，收益只有冷启动重放变快。
 * 它们的增长点在 `events` / `edges` / `items` 数组上，正确做法是按**语义**
 * 判基（数组长度超过阈值、或处置归档后），而不是按 delta 计数。
 * 待办与审计的裁剪策略见 `docs/COMMS.md`。
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

/**
 * 只增数组的压基策略：每长 N 条压一次完整基线。
 *
 * 为什么不用 `deltasSinceBase >= 64`：那是**按写入次数**判基，与文档实际大小无关。
 * 只增文档（审计、留痕、待办、会议纪要）的 delta 大小和条目数成正比，
 * 按次数判基会让「小文档压得太勤、大文档压得太晚」。
 * 按**条目数**判基，重放链长度就被条目数钉住：最多重放 N 条 append。
 *
 * N = 512：这些条目都只有几十到几百字节，压一份完整基线几 KB，
 * 而 512 条 delta 的重放成本明显更高。频道消息不适用这条（单条 delta 几十 KB），
 * 它有自己的策略，见 `src/company/channels-doc.ts`。
 */
function everyNItems<T>(count: (value: Readonly<T>) => number, n = 512) {
	return (value: Readonly<T>, _ops: readonly unknown[]): boolean => count(value) >= n;
}

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
	// 审计事件只增不改：每 512 条压一次基线，重放链不会无限长。
	checkpointWhen: everyNItems<{ events: readonly unknown[] }>((value) => value.events.length),
});

/**
 * 「我最近是被哪条频道消息叫醒的」。
 *
 * 为什么需要它：`say` / `ask` 不传 `channel` 时要自己推断「我在哪发言」，
 * 而推断只按角色（员工→项目群、管理层→领导层群）——**完全不知道叫醒自己的
 * 是哪条消息**。于是老板在 `dm:13` 私聊 CFO，CFO 一开口却跑去了领导层群
 * （老板实测的「私聊不回复、跑到群里去了」）。
 *
 * 投递时（`deliver.ts`）明明把 `channelId` 写进了 `app.channel` 条目，但那是
 * 会话流里的 entry，工具读不到。这里把同一份信息落成**会话级文档**，工具
 * 用 `api.snapshot` 直接读，不需要翻会话历史。
 */
export type ReplyContextState = {
	/** 最近一次被频道消息叫醒时所在的频道标识。 */
	channelId?: string;
	/** 那条消息的序号。 */
	seq?: number;
	/** 谁发的（会话标识）。 */
	from?: number;
	/** 发送者显示名。 */
	fromLabel?: string;
	/** 这条消息是否 @ 了我。 */
	mentioned?: boolean;
	/** 记录时间。 */
	at?: number;
};

/**
 * 会话级「回复上下文」。
 *
 * `history: "latest"`：只关心最新一次，不需要回溯；`fork: "initial"`：
 * 分叉出来的会话不该继承「我刚被谁叫醒」——那是别人的对话现场。
 */
export const ReplyContextDoc = defineDoc<ReplyContextState>({
	kind: "app.reply-context",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "initial",
	initial: () => ({}),
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
	checkpointWhen: everyNItems<{ edges: readonly unknown[] }>((value) => value.edges.length),
});
