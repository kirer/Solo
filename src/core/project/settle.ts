/**
 * 项目记忆的自动沉淀。
 *
 * 机制极简：项目频道来了新消息，叫负责人按公司技能「记忆整理」整理。
 * 写什么由模型决定（规则在技能里），代码只管「叫谁」「游标走到哪」。
 *
 * 单游标：`cursors[项目]` = **已确认**沉淀到第几条 seq。
 * 推进规则：**不是问完就推进**。问完只记一笔 `waiting`（seq + 提问那一刻记忆文件的
 * 印章），等记忆文件真的变了、或者 `remember(scope=project)` 落地了，才推进。负责人
 * 被别的事打断、或者写砸了，这批消息下次还会被看到，不会永久漏掉。
 */
import { stat } from "node:fs/promises";
import { defineDoc } from "../runtime/index.ts";
import type { Conversation, Harness } from "../runtime/index.ts";
import { BACKGROUND_CONTEXT, type Context } from "../runtime/index.ts";
import { ChannelDoc, OWNER, appendMessage, projectId, type ChannelState, type Message } from "../channel/state.ts";
import { readAllIdentities, type Identity } from "../agent/identity.ts";
import { readProject, type ProjectDoc } from "./doc.ts";
import { projectMemoryPath, renderSettlePrompt, settleCandidates } from "./memory.ts";

export type SettleState = {
	/** `项目 slug` → 已确认沉淀到第几条 seq。 */
	cursors: Record<string, number>;
	/** `项目 slug` → 已问过、等确认：问到的 seq + 提问那一刻记忆文件的 mtime（没有文件 = `null`）。 */
	waiting?: Record<string, { readonly seq: number; readonly stamp: number | null }>;
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

/** 单个项目：把新消息交给负责人去整理；上一批确认过了才推进游标。 */
export async function settleProject(
	deps: SettleDeps,
	project: string,
	context: Context = BACKGROUND_CONTEXT,
): Promise<{ asked?: { project: string; to: string; count: number }; skipped?: { project: string; count: number } }> {
	const state = await deps.channelState();
	const channel = state.channels[`proj:${project}`];
	if (channel === undefined) return {};

	let settle = (await deps.harness.snapshot(SettleDoc, context)) ?? { cursors: {} };
	const waiting = settle.waiting?.[project];
	if (waiting !== undefined) {
		// 记忆文件变了才算这批被真写过；没变就是还没写（被打断、或者写砸了），不催也不推进。
		const stamp = await memoryStamp(deps.projectsRoot, project);
		if (stamp === null || stamp === waiting.stamp) return {};
		await advanceCursor(deps.harness, project, waiting.seq, context);
		settle = (await deps.harness.snapshot(SettleDoc, context)) ?? settle;
	}

	try {
		const [doc, identities] = await Promise.all([
			readProject(deps.projectsRoot, project).catch(() => undefined),
			readAllIdentities(deps.agentsRoot),
		]);
		const to = settleTarget(doc, channel.members, identities);
		// 排除负责人自己说的话：他要整理的是别人说的东西。
		const candidates = settleCandidates(state.messages[channel.id] ?? [], settle.cursors[project] ?? 0, to);
		if (candidates.length === 0) return {};

		const lastSeq = candidates[candidates.length - 1]?.seq ?? 0;
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

		const stamp = await memoryStamp(deps.projectsRoot, project);
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
		await parkWaiting(deps.harness, project, lastSeq, stamp, context);
		return { asked: { project, to, count: candidates.length } };
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		process.stderr.write(`[沉淀失败] ${project}: ${reason}\n`);
		// 只写 stderr 等于没发生：老板和负责人只看频道，日志里那一行没人读。所以往项目频道
		// 留一条 `note`（不唤醒、不计未读），文案要说清「下次再试」—— 游标没推进，真的会再试。
		await appendProjectNote(deps, project, `项目记忆整理失败（${brief(reason)}）。这批消息下次再试。`, context);
		return {};
	}
}

/** 失败原因只要一句话：频道里的留痕是给人看的，“堆栈那一坨”没人读。 */
function brief(reason: string): string {
	const oneLine = reason.replace(/\s+/g, " ").trim();
	return oneLine.length > 120 ? `${oneLine.slice(0, 120)}…` : oneLine || "未知原因";
}

/**
 * 往项目频道追加一条系统留痕（`kind: "note"`，不唤醒人）。
 *
 * 与 `channel/post.ts` 的 `appendNote` 同形，但那里没导出、而且 `post.ts` 不接受
 * 「只记一笔」这种一次性用途（它会算接力、算投递）。沉淀已经在处理异常了，
 * 这里再抛就是二次失败，所以整段包在 try 里，失败只写 stderr。
 */
async function appendProjectNote(deps: SettleDeps, project: string, text: string, context: Context): Promise<void> {
	const channelId = projectId(project);
	try {
		await deps.harness.commit(async (tx) => {
			const doc = (await tx.doc(ChannelDoc)) as ChannelState;
			if (doc.channels[channelId] === undefined) return;
			const next = appendMessage(doc, channelId, { from: OWNER, text, at: Date.now(), kind: "note" });
			const list = doc.messages[channelId];
			if (list === undefined) doc.messages[channelId] = [next.message];
			else (list as Message[]).push(next.message);
			doc.nextSeq[channelId] = next.message.seq + 1;
		}, context);
	} catch (error) {
		process.stderr.write(`[沉淀失败] 留痕也失败：${error instanceof Error ? error.message : String(error)}\n`);
	}
}

/** 记忆文件的印章（mtime）。没有记忆文件 = `null`。 */
async function memoryStamp(projectsRoot: string, project: string): Promise<number | null> {
	try {
		return (await stat(projectMemoryPath(projectsRoot, project))).mtimeMs;
	} catch {
		return null;
	}
}

/** 记一笔「这批问过了」，等记忆文件变了再推进游标。 */
async function parkWaiting(
	harness: Harness,
	project: string,
	seq: number,
	stamp: number | null,
	context: Context,
): Promise<void> {
	await harness.commit(async (tx) => {
		const doc = (await tx.doc(SettleDoc)) as SettleState;
		doc.waiting = { ...(doc.waiting ?? {}), [project]: { seq, stamp } };
	}, context);
}

/** 推进游标到指定 seq（并清掉这一项的「等确认」）。 */
async function advanceCursor(harness: Harness, project: string, seq: number, context: Context): Promise<void> {
	await harness.commit(async (tx) => {
		const doc = (await tx.doc(SettleDoc)) as SettleState;
		const current = doc.cursors[project] ?? 0;
		if (seq > current) doc.cursors = { ...doc.cursors, [project]: seq };
		if (doc.waiting !== undefined && doc.waiting[project] !== undefined) {
			const rest = { ...doc.waiting };
			delete rest[project];
			doc.waiting = rest;
		}
	}, context);
}

/**
 * `remember(scope=project)` 落盘成功后推进游标（兼容旧调用点）。
 * 游标正常由 `settleProject` 在确认后推进，这里兜底：记忆写入的 seq 比游标新就补推进。
 */
export async function confirmedBy(
	harness: Harness,
	project: string,
	context: Context = BACKGROUND_CONTEXT,
): Promise<number> {
	const state = (await harness.snapshot(ChannelDoc, context)) as ChannelState | undefined;
	// 只算会进候选的消息：`note` 是系统留痕，游标不该因为「系统报过一次错」而前进。
	const maxSeq = (state?.messages[`proj:${project}`] ?? []).reduce(
		(max, m) => (m.kind === "note" ? max : Math.max(max, m.seq)),
		0,
	);
	const settle = (await harness.snapshot(SettleDoc, context)) as SettleState | undefined;
	if (maxSeq <= (settle?.cursors[project] ?? 0)) return 0;
	await advanceCursor(harness, project, maxSeq, context);
	return maxSeq;
}
