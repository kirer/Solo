/**
 * 项目记忆的自动沉淀。
 *
 * 机制极简：一条 decision/report 落地后，叫负责人来写。
 * 写什么由模型决定，代码只管「叫谁」。
 *
 * 单游标：`cursors[项目]` = 已处理到第几条 seq。
 * 推进规则：`settleProject` 问完一批后推进到「这批最后一条的 seq」，
 * 不等 `remember(scope=project)` —— 负责人说「没有需要沉淀的」也算处理过了。
 */
import { defineDoc } from "../runtime/index.ts";
import type { Conversation, Harness } from "../runtime/index.ts";
import { BACKGROUND_CONTEXT, type Context } from "../runtime/index.ts";
import { ChannelDoc, OWNER, type ChannelState } from "../channel/state.ts";
import { readAllIdentities, type Identity } from "../agent/identity.ts";
import { readProject, type ProjectDoc } from "./doc.ts";
import { renderSettlePrompt, settleCandidates } from "./memory.ts";

export type SettleState = {
	/** `项目 slug` → 已处理到第几条 seq。 */
	cursors: Record<string, number>;
};

export const SettleDoc = defineDoc<SettleState>({
	kind: "core.settle",
	version: 1,
	scope: "session",
	initial: () => ({ cursors: {} }),
	checkpointWhen: () => false,
});

export type SettleDeps = {
	readonly harness: Harness;
	readonly agentsRoot: string;
	readonly projectsRoot: string;
	readonly channelState: () => Promise<ChannelState>;
	readonly conversationOf: (slug: string) => Promise<Conversation | undefined>;
};

/** 挑一个「该由谁来写这个项目记忆」的人。优先 README.md 里的 owner。 */
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

/** 单个项目：把新出现的 decision/report 交给负责人去沉淀，然后推进游标。 */
export async function settleProject(
	deps: SettleDeps,
	project: string,
	context: Context = BACKGROUND_CONTEXT,
): Promise<{ asked?: { project: string; to: string; count: number }; skipped?: { project: string; count: number } }> {
	const state = await deps.channelState();
	const channel = state.channels[`proj:${project}`];
	if (channel === undefined) return {};

	const settle = (await deps.harness.snapshot(SettleDoc, context)) ?? { cursors: {} };
	const candidates = settleCandidates(state.messages[channel.id] ?? [], settle.cursors[project] ?? 0);
	if (candidates.length === 0) return {};

	const lastSeq = candidates[candidates.length - 1]?.seq ?? 0;

	try {
		const [doc, identities] = await Promise.all([
			readProject(deps.projectsRoot, project).catch(() => undefined),
			readAllIdentities(deps.agentsRoot),
		]);
		const to = settleTarget(doc, channel.members, identities);
		if (to === undefined) {
			// 没人能写：游标照常推进，这批不再重复打扰。
			await advanceCursor(deps.harness, project, lastSeq, context);
			return { skipped: { project, count: candidates.length } };
		}
		const conversation = await deps.conversationOf(to);
		if (conversation === undefined) {
			// 有负责人但没会话：游标照常推进，下次负责人醒来读项目频道能看到。
			await advanceCursor(deps.harness, project, lastSeq, context);
			return { skipped: { project, count: candidates.length } };
		}

		await conversation.submit(
			{
				type: "input",
				content: renderSettlePrompt(project, candidates),
				requestId: `settle:${project}:${lastSeq}`,
				entry: { kind: "core.settle", data: { project, count: candidates.length } },
				whenBusy: "followUp",
			},
			context,
		);
		// 问完即推进：负责人说「没有需要沉淀的」也算处理过，不会重复打扰。
		await advanceCursor(deps.harness, project, lastSeq, context);
		return { asked: { project, to, count: candidates.length } };
	} catch (error) {
		process.stderr.write(`[沉淀失败] ${project}: ${error instanceof Error ? error.message : String(error)}\n`);
		return {};
	}
}

/** 推进游标到指定 seq。 */
async function advanceCursor(harness: Harness, project: string, seq: number, context: Context): Promise<void> {
	await harness.commit(async (tx) => {
		const doc = (await tx.doc(SettleDoc)) as SettleState;
		const current = doc.cursors[project] ?? 0;
		if (seq > current) doc.cursors = { ...doc.cursors, [project]: seq };
	}, context);
}

/**
 * `remember(scope=project)` 落盘成功后推进游标（兼容旧调用点）。
 * 现在游标已在 `settleProject` 里推进，这里只做兜底：如果记忆写入的 seq 比游标新，补推进。
 */
export async function confirmedBy(
	harness: Harness,
	project: string,
	context: Context = BACKGROUND_CONTEXT,
): Promise<number> {
	let advanced = 0;
	await harness.commit(async (tx) => {
		const doc = (await tx.doc(SettleDoc)) as SettleState;
		const state = (await harness.snapshot(ChannelDoc, context)) as ChannelState | undefined;
		const messages = state?.messages[`proj:${project}`] ?? [];
		const maxSeq = messages.reduce((max, m) => Math.max(max, m.seq), 0);
		const current = doc.cursors[project] ?? 0;
		if (maxSeq > current) {
			doc.cursors = { ...doc.cursors, [project]: maxSeq };
			advanced = maxSeq;
		}
	}, context);
	return advanced;
}
