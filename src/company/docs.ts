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
	version: 3,
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
	/**
	 * v1 → v2：员工从「角色名决定能力」改成「招聘时显式声明 tools / duty」。
	 *
	 * 老名册项没有 `tools` 与 `duty` 两个字段。不补会直接崩：
	 * `staffCharterOf()` 里 `input.duty.trim()` 拿到 `undefined`（档案页一打开就
	 * 500），`employeeToolsFor()` 拿到 `undefined` 会一路传到 `toolsForNames()`。
	 *
	 * 老员工的 tools 按**旧表**推出来，而不是一律给空：那时能力确实来自
	 * `STAFF_TOOLSETS[role]`，照着推等于保住他们现在的行为；给空则是悄悄
	 * 卸掉所有执行工具——正是本次要消灭的那类静默变化。旧表里没有的角色
	 * （当年那些被静默变只读的「前端」「backend」）推出来的就是 `["read"]`，
	 * 与它们此刻的真实能力一致。
	 *
	 * v2 → v3：工具名多了一段可选的目录范围（`write:src/`，见 ADR-035）。
	 * 这一步**不需要动数据**：没有冒号的老名字就是「整个工作空间」，语义不变。
	 * 于是老的 `tools: ["read","write","edit","bash"]` 原样留在 v3 里。
	 * 为什么不顺手给老员工加上范围（比如把 `write` 收成 `write:src/`）：
	 * **收紧权限会让已派出的任务突然失败**——他们昨天还在写 `ui/`、`docs/`，
	 * 今天就会撞上「不能写」。收权是一次显式的组织决定（重新招聘或改档案），
	 * 不该是迁移的副作用。
	 */
	migrate: (value, fromVersion) => {
		if (fromVersion >= 2) return value as unknown as CompanyState;
		const state = value as unknown as CompanyState;
		const staff: Record<string, StaffEntry> = {};
		for (const [key, person] of Object.entries(state.staff ?? {})) {
			staff[key] = {
				...person,
				// 老记录只有 role：按当年的表反推，保证「迁移不改行为」。
				tools: (person as { tools?: string[] }).tools ?? legacyToolsOf(person.role),
				duty: (person as { duty?: string }).duty ?? legacyDutyOf(person.role),
			};
		}
		return { ...state, staff };
	},
	checkpointWhen: () => false,
});

/**
 * 迁移专用：v1 时代的「角色 → 执行工具」表，已经被删掉，只留这一份给迁移用。
 *
 * 为什么留在 `src/company/` 而不是删干净：删了就没法把老库迁到新语义
 * （新语义里能力是招聘时写下的名字，老库里没写，只能从旧规则推一次）。
 * 这份表**没有生产调用方**，只被 `CompanyDoc.migrate` 引用。
 */
const LEGACY_STAFF_TOOLSETS: Record<string, readonly string[]> = {
	产品: ["read", "write", "edit"],
	设计: ["read", "write", "edit"],
	开发: ["read", "write", "edit", "bash"],
	测试: ["read", "write", "edit", "bash"],
	运营: ["read"],
};

/** v1 时代未知角色的默认值：只读。 */
const LEGACY_DEFAULT_TOOLS: readonly string[] = ["read"];

/** 迁移用：按 v1 的规则推出老员工的工具名。 */
function legacyToolsOf(role: string): string[] {
	return [...(LEGACY_STAFF_TOOLSETS[role] ?? LEGACY_DEFAULT_TOOLS)];
}

/**
 * 迁移用：按 v1 的角色模板推出老员工的职责文本。
 *
 * 文案照抄 v1 的 `STAFF_ROLE_TEMPLATES`，这样迁移后员工收到的提示词与迁移前
 * 逐字相同——迁移不该顺手改人的职责。
 */
function legacyDutyOf(role: string): string {
	const templates: Record<string, string> = {
		产品: "你是产品经理。负责需求分析、撰写 PRD、定义验收标准。不要写代码。遇到需求冲突上报 CPO。",
		设计: "你是 UI/UX 设计师。负责交互方案与视觉方向。输出设计说明与原型描述。遇到技术限制上报 CTO。",
		开发: "你是开发工程师。负责编码实现与单元测试。遇到技术选型问题上报 CTO。不要改动需求定义。",
		测试: "你是测试工程师。负责用例设计、执行验证、编写缺陷报告。不要修改产品代码。遇到标准不清上报 CPO。",
		运营: "你是运营。负责推进节奏与交付跟进。遇到排期冲突上报 COO。",
	};
	return templates[role] ?? `你是${role}。只做被指派的工作，遇到不确定的事上报。`;
}

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
