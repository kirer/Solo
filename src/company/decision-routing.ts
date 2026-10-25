/**
 * 决策路由：一条待决问题该由谁拍（ADR-026 决策 2 / 决策 6，落地第 3 步）。
 *
 * ── 为什么需要这个模块 ──
 * 改造前，升级链的起点只由「发起人的直属上级」决定（`escalation.ts` 的 `ask-manager`），
 * 于是无论问题是什么性质，都只会沿着「直属上级 → CEO → 老板」这条线走。
 * 结果是：老板待办里堆满本该管理层自己拍的问题（技术选型、排期、员工调配……）。
 *
 * ADR-026 决策 2 的原话：「老板待办里应该只剩『立项 / 砍项目 / 超预算 / 对外』。
 * 管理层能答的问题还堆在老板那儿，说明路由没做，不是他们不该有权。」
 *
 * ── 授权只来自结构，不来自「重要性」 ──
 * 决策 2 明确写着：「『重要性』是主观的，模型会用它给自己授权。所以授权只来自结构。」
 * 因此本模块**只按事项类别**判定归属，类别由发起方显式给出（`DecisionTopic`），
 * 不做任何基于自由文本的猜测——猜错方向会让员工替老板砍项目。
 *
 * ── ADR-027 的约束 ──
 * 负责人引用是 `leader:<slug>` 字符串，判定与展示必须走 `managerLabelOf` /
 * `managerConversationOf` / `leaderSlugOf`，不要自己切字符串。
 */
import {
	MANAGEMENT_ROLES,
	type CompanyState,
	type ManagerRef,
	type ManagementRole,
	isLeaderManagerRef,
	isValidManagerRef,
	leaderSlugOf,
	managerConversationOf,
	managerLabelOf,
} from "./docs.ts";

/**
 * 事项类别（ADR-026 决策 2 的表格，逐行对应）。
 *
 * 由发起方显式声明；缺省视为 `unclassified`，按「谨慎侧」路由到上级，
 * 绝不默认成「管理层能自己拍」——授权宁可少给，不可多给。
 */
export type DecisionTopic =
	/** 立项 / 砍项目 / 预算上限 / 对外承诺 / 组织架构 → 老板独占 */
	| "company-level"
	/** 技术选型、需求优先级、预算内支出/招聘 → 本领域管理层，超阈值 → CEO */
	| "domain"
	/** 本项目内的排期、任务拆分、员工间调配、退回不合格产出 → 项目负责人 */
	| "project"
	/** 员工自己完全拍不了、也说不清归谁 → 沿汇报线上行 */
	| "unclassified";

/** 决策归属：谁能拍这条。 */
export type DecisionTarget =
	/** 老板。 */
	| { readonly kind: "owner" }
	/** 某管理层岗位。 */
	| { readonly kind: "role"; readonly role: ManagementRole }
	/** 某项目负责人（ADR-027：字符串引用）。 */
	| { readonly kind: "leader"; readonly ref: ManagerRef; readonly slug: string };

/** 判定所需的最小上下文。 */
export type DecisionContext = {
	/** 发起人的直属上级（管理层岗位或负责人引用）。缺省视作无上级。 */
	readonly manager?: ManagerRef;
	/** 发起人所在项目（slug）。 */
	readonly project?: string;
	/** 发起人在公司里的层级；用来决定「领域类」问题落到哪个岗位。 */
	readonly fromLevel?: string;
};

/** 管理层岗位 → 该岗位的领域关键词（用于 `unclassified` 时按发起人层级兜底，不猜文本）。 */
const DOMAIN_ROLE = (role: ManagementRole): DecisionTarget => ({ kind: "role", role });

/**
 * 判定一条待决问题的决策人。
 *
 * 纯函数：只看结构（topic + 汇报线），不看问题正文。可单测，也可在持久化前
 * 算一次存进 `PendingItem.decisionOwner`（这样历史数据不会被后来的规则变化改写）。
 */
export function decideOwner(
	state: CompanyState | undefined,
	topic: DecisionTopic,
	context: DecisionContext,
): DecisionTarget {
	switch (topic) {
		// ── 老板独占：决策 2 第一行 ──
		case "company-level":
			return { kind: "owner" };

		// ── 项目内事项：归本项目负责人 ──
		// 只有当发起人确实在某个项目里、且该项目有负责人引用时成立；
		// 否则退回汇报线（不能因为「没解析到」就把锅甩给老板）。
		case "project": {
			const slug = context.project;
			if (slug !== undefined) {
				const ref = `leader:${slug}` as ManagerRef;
				if (isValidManagerRef(state, ref, slug) && leaderSlugOf(ref) !== undefined) {
					return { kind: "leader", ref, slug };
				}
			}
			return routeUpLine(context);
		}

		// ── 本领域事项：归发起人所在领域的上级（管理层），没有则沿汇报线上行 ──
		//
		// 「本领域」由结构决定：发起人是某项目负责人 → 该项目负责人自己能拍（回退到 project）；
		// 发起人是某个管理层下属 → 归该管理层；
		// 发起人就是管理层自己 → 归它自己（它有权就是有权）。
		case "domain":
			return routeUpLine(context);

		// ── 没分类：谨慎侧，沿汇报线上行 ──
		case "unclassified":
			return routeUpLine(context);
	}
}

/**
 * 沿汇报线上行：直属上级 → CEO → 老板。
 *
 * 与改造前的行为一致（这一步**不改**既有的上行语义），只是现在只对
 * 「领域类 / 未分类」生效，而不是对一切生效。
 */
function routeUpLine(context: DecisionContext): DecisionTarget {
	const manager = context.manager;
	if (manager !== undefined) {
		// 负责人类上级（ADR-027）：用字符串引用，不自己解析
		if (isLeaderManagerRef(manager)) {
			const slug = leaderSlugOf(manager);
			if (slug !== undefined) return { kind: "leader", ref: manager, slug };
		}
		if (isManagementRole(manager)) {
			// 直属上级是 CEO 时，领域问题就到 CEO 为止（CEO 是管理层最高一级）
			return DOMAIN_ROLE(manager);
		}
	}
	// 没有直属上级：按发起人层级猜也不行，落到 CEO（公司里的「第一层」），
	// 由 CEO 决定是自拍还是递老板——**不直接甩给老板**。
	const fromLevel = context.fromLevel;
	if (fromLevel !== undefined && isManagementRole(fromLevel)) return DOMAIN_ROLE(fromLevel);
	return DOMAIN_ROLE("ceo");
}

/** `MANAGEMENT_ROLES` 的成员判定（保留类型收窄）。 */
export function isManagementRole(value: string): value is ManagementRole {
	return (MANAGEMENT_ROLES as readonly string[]).includes(value);
}

/** 决策归属翻成升级链用的 `level` 字符串（与 `PendingItem.level` 同一口径）。 */
export function levelOfTarget(target: DecisionTarget): string {
	switch (target.kind) {
		case "owner":
			return "owner";
		case "role":
			return target.role;
		case "leader":
			return target.ref;
	}
}

/** 决策归属的显示名（审计/留痕用）。走 ADR-027 的统一入口。 */
export function labelOfTarget(state: CompanyState | undefined, target: DecisionTarget): string {
	switch (target.kind) {
		case "owner":
			return "老板";
		case "role":
			return managerLabelOf(state, target.role);
		case "leader":
			return managerLabelOf(state, target.ref);
	}
}

/** 决策归属对应的会话；解析不到返回 undefined（此时只能公示、不能授权拍板）。 */
export function conversationOfTarget(state: CompanyState | undefined, target: DecisionTarget): number | undefined {
	switch (target.kind) {
		case "owner":
			return state?.roles.ceo;
		case "role":
			return managerConversationOf(state, target.role);
		case "leader":
			return managerConversationOf(state, target.ref);
	}
}

/**
 * 这个会话是不是这条问题的决策人。
 *
 * `conversationId` 是提问者的会话；`myLevel` 是 `levelOfConversation()` 的结果。
 * 用 level 精确比对（与既有 `pending_list` / `answer_pending` 口径一致），
 * 而不是靠显示名——ADR-027 的教训。
 */
export function isDecisionOwner(target: DecisionTarget, myLevel: string | undefined): boolean {
	if (myLevel === undefined) return false;
	return levelOfTarget(target) === myLevel;
}
