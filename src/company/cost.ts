/**
 * 成本记账与聚合。
 *
 * 核心规则（ADR-003）：汇总成本**只能**读会话的用量文档，
 * 绝不能按历史消息求和——分叉会话的可见历史包含父会话的消息，
 * 但它的用量文档从零开始计，按消息求和会重复计账。
 */
import { BACKGROUND_CONTEXT, type Context, type CompanyRuntime, UsageDoc } from "../runtime/index.ts";
import { CompanyDoc, type ModelOption } from "./docs.ts";

/** 一个模型分桶的用量。 */
export type ModelUsage = {
	readonly input: number;
	readonly output: number;
	readonly cacheRead: number;
	readonly cacheWrite: number;
	readonly totalTokens: number;
	readonly costUsd: number;
};

/** 一个会话的用量汇总。 */
export type ConversationUsage = {
	readonly conversationId: number;
	readonly byModel: Record<string, ModelUsage>;
	readonly totalTokens: number;
	readonly costUsd: number;
};

/** 聚合结果。 */
export type UsageRollup = {
	readonly conversations: readonly ConversationUsage[];
	readonly totalTokens: number;
	readonly costUsd: number;
	/** 有 token 消耗但成本为零的模型 —— 提示宿主检查价格配置。 */
	readonly unpricedModels: readonly string[];
};

/**
 * 读单个会话的用量。
 *
 * 依据会话的用量文档（按 provider/model 分桶），不读历史消息。
 */
export async function conversationUsage(
	runtime: CompanyRuntime,
	conversationId: number,
	context: Context = BACKGROUND_CONTEXT,
): Promise<ConversationUsage> {
	const state = await runtime.harness.snapshot(UsageDoc, conversationId as never, context);

	const byModel: Record<string, ModelUsage> = {};
	let totalTokens = 0;
	let costUsd = 0;

	for (const [key, raw] of Object.entries(state?.models ?? {})) {
		const usage = raw as {
			input?: number;
			output?: number;
			cacheRead?: number;
			cacheWrite?: number;
			totalTokens?: number;
			cost?: { total?: number };
		};
		const entry: ModelUsage = {
			input: usage.input ?? 0,
			output: usage.output ?? 0,
			cacheRead: usage.cacheRead ?? 0,
			cacheWrite: usage.cacheWrite ?? 0,
			totalTokens: usage.totalTokens ?? 0,
			costUsd: usage.cost?.total ?? 0,
		};
		byModel[key] = entry;
		totalTokens += entry.totalTokens;
		costUsd += entry.costUsd;
	}

	return { conversationId, byModel, totalTokens, costUsd };
}

/**
 * 汇总全部会话的用量。
 */
export async function rollupAll(
	runtime: CompanyRuntime,
	context: Context = BACKGROUND_CONTEXT,
): Promise<UsageRollup> {
	const page = await runtime.harness.commit((tx) => tx.scanConversations({}, 1000), context);
	const conversations: ConversationUsage[] = [];

	for (const record of page.items) {
		const usage = await conversationUsage(runtime, Number(record.id), context);
		if (usage.totalTokens > 0 || usage.costUsd > 0) conversations.push(usage);
	}

	return summarize(conversations);
}

/** 按项目汇总。 */
export async function rollupProject(
	runtime: CompanyRuntime,
	project: string,
	context: Context = BACKGROUND_CONTEXT,
): Promise<UsageRollup> {
	const state = await runtime.harness.snapshot(CompanyDoc, context);
	const entry = state?.projects[project];
	if (entry === undefined) {
		return { conversations: [], totalTokens: 0, costUsd: 0, unpricedModels: [] };
	}

	// 项目 = 项目负责人 + 该项目全部员工（含已归档的，因为它们确实花过钱）
	const conversationIds = new Set<number>([entry.leader]);
	for (const staff of Object.values(state?.staff ?? {})) {
		if (staff.project === project) conversationIds.add(staff.conversationId);
	}

	const conversations: ConversationUsage[] = [];
	for (const id of conversationIds) {
		const usage = await conversationUsage(runtime, id, context);
		if (usage.totalTokens > 0 || usage.costUsd > 0) conversations.push(usage);
	}

	return summarize(conversations);
}

/** 按角色（管理层岗位）汇总。 */
export async function rollupRole(
	runtime: CompanyRuntime,
	role: string,
	context: Context = BACKGROUND_CONTEXT,
): Promise<UsageRollup> {
	const state = await runtime.harness.snapshot(CompanyDoc, context);
	const conversationId = state?.roles[role];
	if (conversationId === undefined) {
		return { conversations: [], totalTokens: 0, costUsd: 0, unpricedModels: [] };
	}

	const usage = await conversationUsage(runtime, conversationId, context);
	return summarize(usage.totalTokens > 0 || usage.costUsd > 0 ? [usage] : []);
}

/** 全公司成本报告（给 CFO 的工具用）。 */
export async function costReport(
	runtime: CompanyRuntime,
	input: { readonly project?: string },
	context: Context = BACKGROUND_CONTEXT,
): Promise<string> {
	const state = await runtime.harness.snapshot(CompanyDoc, context);
	const rollup =
		input.project === undefined
			? await rollupAll(runtime, context)
			: await rollupProject(runtime, input.project, context);

	const scope = input.project === undefined ? "全公司" : `项目 ${input.project}`;
	void scope;
	const lines = [
		`${scope} 成本：`,
		`  token 合计：${rollup.totalTokens.toLocaleString()}`,
		`  花费合计：$${rollup.costUsd.toFixed(4)}`,
	];

	// 按会话拆分
	if (rollup.conversations.length > 0) {
		lines.push("", "按会话：");
		for (const conversation of rollup.conversations) {
			lines.push(
				`  会话 ${conversation.conversationId}：${conversation.totalTokens.toLocaleString()} tokens / $${conversation.costUsd.toFixed(4)}`,
			);
		}
	}

	// 按项目拆分（全公司视角）
	if (input.project === undefined && state !== undefined) {
		const projects = Object.keys(state.projects);
		if (projects.length > 0) {
			lines.push("", "按项目：");
			for (const slug of projects) {
				const projectRollup = await rollupProject(runtime, slug, context);
				lines.push(
					`  ${slug}：${projectRollup.totalTokens.toLocaleString()} tokens / $${projectRollup.costUsd.toFixed(4)}`,
				);
			}
		}
	}

	// 成本可能为零的提醒
	if (rollup.unpricedModels.length > 0) {
		lines.push(
			"",
			`注意：以下模型有 token 消耗但成本为零，可能是模型提供方未声明价格：${rollup.unpricedModels.join(", ")}`,
		);
	}

	return lines.join("\n");
}

/**
 * 依据模型价格补算历史成本。
 *
 * token 数是准确的，所以只要拿到价格就能重算（见 cost-accounting 规格）。
 */
export function calculateCostFromCatalog(
	usage: ConversationUsage,
	catalog: readonly ModelOption[],
): number {
	let total = 0;
	for (const [key, modelUsage] of Object.entries(usage.byModel)) {
		// key 形如 "provider/modelId"
		const modelId = key.includes("/") ? key.slice(key.indexOf("/") + 1) : key;
		const option = catalog.find((item) => item.modelId === modelId || item.id === modelId);
		if (option === undefined) continue;
		total +=
			(modelUsage.input / 1_000_000) * option.inputPerMTok +
			(modelUsage.output / 1_000_000) * option.outputPerMTok;
	}
	return total;
}

// ── 内部 ────────────────────────────────────────────────────────────────────

/** 汇总一组会话用量。 */
function summarize(conversations: readonly ConversationUsage[]): UsageRollup {
	let totalTokens = 0;
	let costUsd = 0;
	const unpriced = new Set<string>();

	for (const conversation of conversations) {
		totalTokens += conversation.totalTokens;
		costUsd += conversation.costUsd;
		for (const [key, usage] of Object.entries(conversation.byModel)) {
			// 有 token 但零成本 → 提供方未声明价格
			if (usage.totalTokens > 0 && usage.costUsd === 0) unpriced.add(key);
		}
	}

	return { conversations, totalTokens, costUsd, unpricedModels: [...unpriced] };
}
