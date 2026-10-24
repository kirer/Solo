/**
 * 沟通留痕。
 *
 * 三层数据：
 * 1. 自定义 entry（`app.message`）—— 会话内不可变记录，任一端可追溯
 * 2. 公司时间线文档（`app.trail`）—— 跨会话索引，避免全量扫描
 * 3. 任务结构 —— 当前协作结构（谁在等谁），实时
 *
 * 为图形界面预留的形态见 organizationGraph()。
 */
import { BACKGROUND_CONTEXT, type Context, type CompanyRuntime } from "../runtime/index.ts";
import {
	AuditDoc,
	CompanyDoc,
	TrailDoc,
	type TrailEdge,
	type TrailKind,
	ROLE_LABELS,
	type ManagementRole,
} from "./docs.ts";

/** 关系图节点。 */
export type GraphNode = {
	readonly id: number;
	readonly label: string;
	readonly kind: "owner" | "role" | "project" | "staff";
	readonly parent?: number;
	readonly project?: string;
};

/** 关系图边。 */
export type GraphEdge = {
	readonly from: number;
	readonly to: number;
	readonly kind: TrailKind;
	readonly at: number;
	readonly ref: string;
	readonly text?: string;
};

/** 组织关系图。 */
export type OrganizationGraph = {
	readonly nodes: readonly GraphNode[];
	readonly edges: readonly GraphEdge[];
};

/** 活跃任务（当前协作结构）。 */
export type ActiveTask = {
	readonly taskId: string;
	readonly kind: string;
	readonly conversationId: number;
	readonly status: "running" | "waiting" | "sleeping" | "ready" | "blocked";
	/** 等待的对象（仅 waiting 状态有）。 */
	readonly waitingOn?: readonly string[];
	readonly blockedReason?: string;
};

/**
 * 记录一条沟通。
 *
 * 双向留痕：双方会话各写一条记录，并用同一个 `ref` 对应。
 */
export async function recordMessage(
	runtime: CompanyRuntime,
	input: {
		readonly from: string;
		readonly to: string;
		readonly fromConversationId: number;
		readonly toConversationId: number;
		readonly kind: TrailKind;
		readonly text?: string;
		readonly ref: string;
		readonly project?: string;
	},
	context: Context = BACKGROUND_CONTEXT,
): Promise<void> {
	await runtime.harness.commit(async (tx) => {
		// 1) 公司时间线
		const trail = await tx.doc(TrailDoc);
		const edge: TrailEdge = {
			at: Date.now(),
			kind: input.kind,
			fromConversation: input.fromConversationId,
			toConversation: input.toConversationId,
			from: input.from,
			to: input.to,
			ref: input.ref,
		};
		if (input.project !== undefined) edge.project = input.project;
		trail.edges.push(edge);

		// 2) 双方会话各写一条审计，使任一端都能追溯
		const pairs: Array<[number, string, string]> = [
			[input.fromConversationId, "self", input.to],
			[input.toConversationId, input.from, "self"],
		];
		for (const [conversationId, from, to] of pairs) {
			const audit = await tx.doc(AuditDoc, conversationId as never);
			audit.events.push({
				at: Date.now(),
				type: mapAuditType(input.kind),
				from,
				to,
				...(input.text === undefined ? {} : { note: input.text.slice(0, 200) }),
				ref: input.ref,
			});
		}
	}, context);
}

/** 读公司时间线，按时间排序。 */
export async function readTrail(
	runtime: CompanyRuntime,
	input: { readonly project?: string; readonly kinds?: readonly TrailKind[] } = {},
	context: Context = BACKGROUND_CONTEXT,
): Promise<readonly TrailEdge[]> {
	const state = await runtime.harness.snapshot(TrailDoc, context);
	let edges = state?.edges ?? [];

	if (input.project !== undefined) edges = edges.filter((edge) => edge.project === input.project);
	if (input.kinds !== undefined) {
		const kinds = new Set(input.kinds);
		edges = edges.filter((edge) => kinds.has(edge.kind));
	}

	return [...edges].sort((a, b) => a.at - b.at);
}

/** 按会话追溯：某个会话参与过的全部沟通。 */
export async function trailForConversation(
	runtime: CompanyRuntime,
	conversationId: number,
	context: Context = BACKGROUND_CONTEXT,
): Promise<readonly TrailEdge[]> {
	const edges = await readTrail(runtime, {}, context);
	return edges.filter(
		(edge) => edge.fromConversation === conversationId || edge.toConversation === conversationId,
	);
}

/** 重建某次升级/派活的完整链条。 */
export async function trailForRef(
	runtime: CompanyRuntime,
	ref: string,
	context: Context = BACKGROUND_CONTEXT,
): Promise<readonly TrailEdge[]> {
	const edges = await readTrail(runtime, {}, context);
	return edges.filter((edge) => edge.ref === ref);
}

/**
 * 组织关系图：节点是角色/项目/员工，边是沟通记录。
 *
 * 这是给图形界面用的数据形态——直接可渲染成力导向图。
 */
export async function organizationGraph(
	runtime: CompanyRuntime,
	context: Context = BACKGROUND_CONTEXT,
): Promise<OrganizationGraph> {
	const state = await runtime.harness.snapshot(CompanyDoc, context);
	const nodes: GraphNode[] = [];

	if (state !== undefined) {
		for (const [role, conversationId] of Object.entries(state.roles)) {
			nodes.push({
				id: conversationId,
				label: ROLE_LABELS[role as ManagementRole] ?? role,
				kind: role === "ceo" ? "owner" : "role",
			});
		}

		for (const project of Object.values(state.projects)) {
			nodes.push({
				id: project.leader,
				label: project.name,
				kind: "project",
				project: project.slug,
			});
		}

		for (const staff of Object.values(state.staff)) {
			const node: GraphNode = {
				id: staff.conversationId,
				label: staff.name,
				kind: "staff",
				project: staff.project,
				parent: state.projects[staff.project]?.leader ?? 0,
			};
			nodes.push(node);
		}
	}

	const trail = await readTrail(runtime, {}, context);
	const edges: GraphEdge[] = trail.map((edge) => {
		const result: GraphEdge = {
			from: edge.fromConversation,
			to: edge.toConversation,
			kind: edge.kind,
			at: edge.at,
			ref: edge.ref,
		};
		return result;
	});

	return { nodes, edges };
}

/**
 * 当前协作结构：全部活跃任务及归属。
 *
 * 与时间线互补：时间线是历史（不可变），这是「现在谁在等谁」（实时）。
 */
export async function activeTasks(
	runtime: CompanyRuntime,
	context: Context = BACKGROUND_CONTEXT,
): Promise<readonly ActiveTask[]> {
	const inspection = await runtime.harness.inspect(context);
	const result: ActiveTask[] = [];

	for (const task of inspection.tasks) {
		const state = task.state;
		const base = {
			taskId: String(task.record.id),
			kind: task.record.kind,
			conversationId: Number(task.record.conversationId),
		};

		switch (state.kind) {
			case "running":
				result.push({ ...base, status: "running" });
				break;
			case "ready":
				result.push({ ...base, status: "ready" });
				break;
			case "waiting":
				result.push({ ...base, status: "waiting", waitingOn: state.on.map(String) });
				break;
			case "sleeping":
				result.push({ ...base, status: "sleeping" });
				break;
			case "blocked":
				result.push({ ...base, status: "blocked", blockedReason: state.reason });
				break;
			default:
				break;
		}
	}

	return result;
}

// ── 内部 ────────────────────────────────────────────────────────────────────

/** 沟通类型 → 审计类型。 */
function mapAuditType(kind: TrailKind): "hire" | "archive" | "escalate" | "decide" | "delegate" | "owner-decision" {
	switch (kind) {
		case "delegate":
			return "delegate";
		case "report":
			return "decide";
		case "escalate":
			return "escalate";
		case "decide":
			return "decide";
		case "hire":
			return "hire";
		case "archive":
			return "archive";
	}
}
