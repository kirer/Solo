/**
 * 项目记忆的自动沉淀。
 *
 * 机制很短：**代码只负责发现「有哪些拍板/交付还没进记忆」，并把人叫来写；
 * 写什么由模型决定。**
 *
 * 为什么这样切：
 *
 * - 「哪句话是结论」是语义判断，代码判不了。旧核心写过一个自动摘要器，最后变成
 *   「把频道历史复述一遍」，项目记忆成了副本，等于没记。
 * - 「什么时候有人在项目频道里拍了板」是形状判断（`kind` 是 `decision` / `report`），
 *   代码判得准。
 *
 * 所以：形状 → 代码；语义 → 模型（通过 `remember_project`）。
 *
 * 游标存在 `SettleDoc` 里，是**幂等的下限**而不是真相：丢了只会重提一次，
 * 模型看到重复内容会说「没有需要沉淀的」，不会写出重复记忆。
 */
import { defineDoc } from "../runtime/index.ts";
import type { Conversation, Harness } from "../runtime/index.ts";
import { BACKGROUND_CONTEXT, type Context } from "../runtime/index.ts";
import { ChannelDoc, OWNER, type ChannelState } from "../channel/state.ts";
import { readAllIdentities, type Identity } from "../agent/identity.ts";
import { readProject, type ProjectDoc } from "./doc.ts";
import { renderSettlePrompt, settleCandidates, type SettleCandidate } from "./memory.ts";

/** 游标：`项目 slug` → 已经沉淀到第几条 seq。 */
export type SettleState = {
	cursors: Record<string, number>;
};

export const SettleDoc = defineDoc<SettleState>({
	kind: "core.settle",
	version: 1,
	scope: "session",
	initial: () => ({ cursors: {} }),
	// 一个项目一条数字，永远不会长大。
	checkpointWhen: () => false,
});

export type SettleDeps = {
	readonly harness: Harness;
	readonly agentsRoot: string;
	readonly projectsRoot: string;
	/** 频道 id → 消息（来自 `ChannelDoc`）。 */
	readonly channelState: () => Promise<ChannelState>;
	/** slug → 会话。返回 undefined 表示这个人现在没有会话（老板就是）。 */
	readonly conversationOf: (slug: string) => Promise<Conversation | undefined>;
};

export type SettleReport = {
	/** 实际被叫去写记忆的项目。 */
	readonly asked: { project: string; to: string; count: number }[];
	/** 有内容但找不到能写的人（项目组里没有 agent，或负责人的 identity 还没建）。 */
	readonly stranded: { project: string; count: number }[];
};

/**
 * 挑一个「该由谁来写这个项目记忆」的人。
 *
 * 优先 `README.md` 里写的负责人；否则项目频道里第一个非老板成员。
 * 不按职位判 —— 新核心里没有职位，只有归属与汇报线。
 */
export function settleTarget(
	project: ProjectDoc | undefined,
	members: readonly string[],
	identities: readonly Identity[],
): string | undefined {
	const bySlug = new Map(identities.map((item) => [item.slug, item]));
	const owner = project?.owner;
	if (owner !== undefined && bySlug.has(owner)) return owner;
	for (const slug of members) {
		if (slug === OWNER) continue;
		if (bySlug.has(slug)) return slug;
	}
	return undefined;
}

/** 一个项目的沉淀结果。`asked === undefined` 表示没东西可沉淀或有东西但没人能写。 */
export type ProjectSettleResult = {
	readonly asked?: { project: string; to: string; count: number };
	readonly stranded?: { project: string; count: number };
};

/**
 * 单个项目：把新出现的 decision/report 交给一个人去沉淀。
 *
 * 这是「一条消息刚落地」时该调的那个（见 `channel/tools.ts` 的 `afterPost`）：
 * 只检查刚说话的那个项目，不用把全公司的频道扫一遍。
 */
export async function settleProject(
	deps: SettleDeps,
	project: string,
	context: Context = BACKGROUND_CONTEXT,
): Promise<ProjectSettleResult> {
	const state = await deps.channelState();
	const channelId = `proj:${project}`;
	const channel = state.channels[channelId];
	if (channel === undefined) return {};

	const cursors = ((await deps.harness.snapshot(SettleDoc, context)) ?? { cursors: {} }).cursors;
	const candidates = settleCandidates(state.messages[channelId] ?? [], cursors[project] ?? 0);
	if (candidates.length === 0) return {};

	try {
		const [doc, identities] = await Promise.all([
			readProject(deps.projectsRoot, project).catch(() => undefined),
			readAllIdentities(deps.agentsRoot),
		]);
		const to = settleTarget(doc, channel.members, identities);
		if (to === undefined) return { stranded: { project, count: candidates.length } };
		const conversation = await deps.conversationOf(to);
		if (conversation === undefined) return { stranded: { project, count: candidates.length } };

		await askToSettle(conversation, project, candidates, context);
		await advance(deps, project, candidates[candidates.length - 1]?.seq ?? 0, context);
		return { asked: { project, to, count: candidates.length } };
	} catch (error) {
		process.stderr.write(
			`[沉淀失败] ${project}: ${error instanceof Error ? error.message : String(error)}\n`,
		);
		return {};
	}
}

/**
 * 走一遍所有项目频道。启动时与定时任务用这个。
 *
 * 逐项目 try/catch：一个项目出错不影响其余（同 `deliver`）。
 */
export async function settleProjects(
	deps: SettleDeps,
	context: Context = BACKGROUND_CONTEXT,
): Promise<SettleReport> {
	const state = await deps.channelState();
	const asked: { project: string; to: string; count: number }[] = [];
	const stranded: { project: string; count: number }[] = [];

	for (const channelId of Object.keys(state.channels)) {
		if (!channelId.startsWith("proj:")) continue;
		const slug = channelId.slice("proj:".length);
		const result = await settleProject(deps, slug, context);
		if (result.asked !== undefined) asked.push(result.asked);
		if (result.stranded !== undefined) stranded.push(result.stranded);
	}

	return { asked, stranded };
}

async function askToSettle(
	conversation: Conversation,
	project: string,
	candidates: readonly SettleCandidate[],
	context: Context,
): Promise<void> {
	await conversation.submit(
		{
			type: "input",
			content: renderSettlePrompt(project, candidates),
			// 同一个项目、同一批 seq 只提一次：崩溃重跑也不会重复打扰。
			requestId: `settle:${project}:${candidates[0]?.seq ?? 0}-${candidates[candidates.length - 1]?.seq ?? 0}`,
			entry: { kind: "core.settle", data: { project, count: candidates.length } },
			// 记忆是事后整理，不该打断手头正在做的事：忙时排在当前这轮之后。
			whenBusy: "followUp",
		},
		context,
	);
}

async function advance(deps: SettleDeps, project: string, seq: number, context: Context): Promise<void> {
	await deps.harness.commit(async (tx) => {
		const doc = (await tx.doc(SettleDoc)) as SettleState;
		// 整体赋值，不就地改：文档读出来的是副本，就地改不产生 op。
		doc.cursors = { ...doc.cursors, [project]: seq };
	}, context);
}
