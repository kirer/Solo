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


/**
 * 按会话追溯：某个会话参与过的全部沟通。
 *
 * 从**双方各自的审计日志**（`AuditDoc`，`scope: "conversation"`）读，不读 `TrailDoc`。
 * 理由：`TrailDoc` 是一张跨会话索引，它的写入者是 `recordMessage`——同步派活删除后
 * 生产路径上已经没有调用者了。而审计日志是 `recordMessage` 真正落「双向留痕」的地方，
 * 也是这个能力当年承诺的东西（「任一端都能追溯」）。读审计日志，追溯就不依赖那张
 * 越来越空的索引表。
 */
export async function trailForConversation(
	runtime: CompanyRuntime,
	conversationId: number,
	context: Context = BACKGROUND_CONTEXT,
): Promise<readonly TrailEdge[]> {
	const state = await runtime.harness.snapshot(AuditDoc, conversationId as never, context);
	const events = state?.events ?? [];
	return events
		.filter((event) => event.ref !== undefined)
		.map((event) => ({
			at: event.at,
			kind: auditTypeToTrailKind(event.type),
			fromConversation: conversationId,
			toConversation: conversationId,
			from: event.from ?? "",
			to: event.to ?? "",
			ref: event.ref as string,
		}));
}

/** 重建某次升级/派活的完整链条：按 `ref` 从公司时间线取。 */
export async function trailForRef(
	runtime: CompanyRuntime,
	ref: string,
	context: Context = BACKGROUND_CONTEXT,
): Promise<readonly TrailEdge[]> {
	const edges = await readTrail(runtime, {}, context);
	return edges.filter((edge) => edge.ref === ref);
}

/**
 * 实时沟通边：派活/转交正在发生时，先挂一条临时边，让界面能立刻画线。
 *
 * 历史边只在答完后由 recordMessage 落库，所以如果只读 TrailDoc，
 * 「正在干活」的那段时间是没有任何连线的。这个注册表补上这一段。
 * 进程内存在，不持久化；释放时删除；超过 TTL 自动清理（防调用方异常）。
 */
export type LiveTrailEdge = {
	readonly from: string;
	readonly to: string;
	readonly fromConversation: number;
	readonly toConversation: number;
	readonly kind: TrailKind;
	readonly project?: string;
	readonly startedAt: number;
};

const LIVE_TTL_MS = 30 * 60_000;
let liveSeq = 0;
const liveEdges = new Map<string, LiveTrailEdge>();

/** 挂一条实时边，返回释放函数（幂等）。 */
export function beginLiveTrail(input: Omit<LiveTrailEdge, "startedAt">): () => void {
	liveSeq += 1;
	const edge: LiveTrailEdge = { ...input, startedAt: Date.now() };
	const key = `${edge.kind}:${edge.fromConversation}:${edge.toConversation}:${liveSeq}`;
	liveEdges.set(key, edge);
	let released = false;
	return () => {
		if (released) return;
		released = true;
		liveEdges.delete(key);
	};
}

/** 读当前仍有效的实时边。 */
export function readLiveTrail(now = Date.now()): readonly LiveTrailEdge[] {
	for (const [key, edge] of liveEdges) {
		if (now - edge.startedAt > LIVE_TTL_MS) liveEdges.delete(key);
	}
	return [...liveEdges.values()].sort((a, b) => a.startedAt - b.startedAt);
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

/** 审计类型 → 沟通类型（`trailForConversation` 用）。 */
function auditTypeToTrailKind(type: string): TrailKind {
	switch (type) {
		case "delegate":
			return "delegate";
		case "escalate":
			return "escalate";
		case "hire":
			return "hire";
		case "archive":
			return "archive";
		default:
			return "decide";
	}
}

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
