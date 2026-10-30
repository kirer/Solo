/**
 * 团队记忆的自动沉淀。
 *
 * 机制极简：团队频道来了新消息，叫团队管理员按公司技能「记忆整理」整理。
 * 写什么由模型决定（规则在技能里），代码只管「叫谁」「游标走到哪」。
 *
 * 单游标：`cursors[团队]` = **已确认**沉淀到第几条 seq。
 * 推进规则：**不是问完就推进**。问完只记一笔 `waiting`（seq + 提问那一刻记忆文件的
 * 印章），等记忆文件真的变了、或者 `remember(scope=team)` 落地了，才推进。团队管理员
 * 被别的事打断、或者写砸了，这批消息下次还会被看到，不会永久漏掉。
 */
import { stat } from "node:fs/promises";
import { defineDoc } from "../runtime/index.ts";
import type { Conversation, Harness } from "../runtime/index.ts";
import { BACKGROUND_CONTEXT, type Context } from "../runtime/index.ts";
import { ChannelDoc, OWNER, appendMessage, teamId, type ChannelState, type Message } from "../channel/state.ts";
import { readAllIdentities, type Identity } from "../agent/identity.ts";
import { readTeam, type TeamDoc } from "./doc.ts";
import { teamMemoryPath, renderSettlePrompt, settleCandidates } from "./memory.ts";

export type SettleState = {
	/** `团队 slug` → 已确认沉淀到第几条 seq。 */
	cursors: Record<string, number>;
	/** `团队 slug` → 已问过、等确认：问到的 seq + 提问那一刻记忆文件的 mtime（没有文件 = `null`）。 */
	waiting?: Record<string, { readonly seq: number; readonly stamp: number | null }>;
};

export const SettleDoc = defineDoc<SettleState>({
	kind: "core.settle",
	version: 1,
	scope: "session",
	initial: () => ({ cursors: {} }),
	// 沉淀游标也是只增的增量文档，同样要有回收上界（见 `roster.ts` 的说明）。
	checkpointWhen: (_value, _ops, info) => info.deltasSinceBase >= 64,
});

export type SettleDeps = {
	readonly harness: Harness;
	readonly agentsRoot: string;
	readonly teamsRoot: string;
	readonly channelState: () => Promise<ChannelState>;
	readonly conversationOf: (slug: string) => Promise<Conversation | undefined>;
};

/** 挑一个「该由谁来写这个团队记忆」的人。优先 README.md 里的 lead。 */
export function settleTarget(
	team: TeamDoc | undefined,
	members: readonly string[],
	identities: readonly Identity[],
): string | undefined {
	const bySlug = new Map(identities.map((item) => [item.slug, item]));
	const lead = team?.lead;
	if (lead !== undefined && bySlug.has(lead)) return lead;
	for (const slug of members) {
		if (slug === OWNER) continue;
		if (bySlug.has(slug)) return slug;
	}
	return undefined;
}

/** 单个团队：把新消息交给团队管理员去整理；上一批确认过了才推进游标。 */
export async function settleTeam(
	deps: SettleDeps,
	team: string,
	context: Context = BACKGROUND_CONTEXT,
): Promise<{ asked?: { team: string; to: string; count: number }; skipped?: { team: string; count: number } }> {
	const state = await deps.channelState();
	const channel = state.channels[`team:${team}`];
	if (channel === undefined) return {};

	let settle = (await deps.harness.snapshot(SettleDoc, context)) ?? { cursors: {} };
	const waiting = settle.waiting?.[team];
	if (waiting !== undefined) {
		// 记忆文件变了才算这批被真写过；没变就是还没写（被打断、或者写砸了），不催也不推进。
		const stamp = await memoryStamp(deps.teamsRoot, team);
		if (stamp === null || stamp === waiting.stamp) return {};
		await advanceCursor(deps.harness, team, waiting.seq, context);
		settle = (await deps.harness.snapshot(SettleDoc, context)) ?? settle;
	}

	try {
		const [doc, identities] = await Promise.all([
			readTeam(deps.teamsRoot, team).catch(() => undefined),
			readAllIdentities(deps.agentsRoot),
		]);
		const to = settleTarget(doc, channel.members, identities);
		// 排除团队管理员自己说的话：他要整理的是别人说的东西。
		const candidates = settleCandidates(state.messages[channel.id] ?? [], settle.cursors[team] ?? 0, to);
		if (candidates.length === 0) return {};

		const lastSeq = candidates[candidates.length - 1]?.seq ?? 0;
		if (to === undefined) {
			// 没人能写：游标照常推进，这批不再重复打扰。
			await advanceCursor(deps.harness, team, lastSeq, context);
			return { skipped: { team, count: candidates.length } };
		}
		const conversation = await deps.conversationOf(to);
		if (conversation === undefined) {
			// 有团队管理员但没会话：游标照常推进，下次团队管理员醒来读团队频道能看到。
			await advanceCursor(deps.harness, team, lastSeq, context);
			return { skipped: { team, count: candidates.length } };
		}

		const stamp = await memoryStamp(deps.teamsRoot, team);
		await conversation.submit(
			{
				type: "input",
				content: renderSettlePrompt(team, candidates),
				requestId: `settle:${team}:${lastSeq}`,
				entry: { kind: "core.settle", data: { team, count: candidates.length } },
				whenBusy: "followUp",
			},
			context,
		);
		await parkWaiting(deps.harness, team, lastSeq, stamp, context);
		return { asked: { team, to, count: candidates.length } };
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		process.stderr.write(`[沉淀失败] ${team}: ${reason}\n`);
		// 只写 stderr 等于没发生：我和团队管理员只看频道，日志里那一行没人读。所以往团队频道
		// 留一条 `note`（不唤醒、不计未读），文案要说清「下次再试」—— 游标没推进，真的会再试。
		await appendTeamNote(deps, team, `团队记忆整理失败（${brief(reason)}）。这批消息下次再试。`, context);
		return {};
	}
}

/** 失败原因只要一句话：频道里的留痕是给人看的，“堆栈那一坨”没人读。 */
function brief(reason: string): string {
	const oneLine = reason.replace(/\s+/g, " ").trim();
	return oneLine.length > 120 ? `${oneLine.slice(0, 120)}…` : oneLine || "未知原因";
}

/**
 * 往团队频道追加一条系统留痕（`kind: "note"`，不唤醒人）。
 *
 * 与 `channel/post.ts` 的 `appendNote` 同形，但那里没导出、而且 `post.ts` 不接受
 * 「只记一笔」这种一次性用途（它会算接力、算投递）。沉淀已经在处理异常了，
 * 这里再抛就是二次失败，所以整段包在 try 里，失败只写 stderr。
 */
async function appendTeamNote(deps: SettleDeps, team: string, text: string, context: Context): Promise<void> {
	const channelId = teamId(team);
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
async function memoryStamp(teamsRoot: string, team: string): Promise<number | null> {
	try {
		return (await stat(teamMemoryPath(teamsRoot, team))).mtimeMs;
	} catch {
		return null;
	}
}

/** 记一笔「这批问过了」，等记忆文件变了再推进游标。 */
async function parkWaiting(
	harness: Harness,
	team: string,
	seq: number,
	stamp: number | null,
	context: Context,
): Promise<void> {
	await harness.commit(async (tx) => {
		const doc = (await tx.doc(SettleDoc)) as SettleState;
		doc.waiting = { ...(doc.waiting ?? {}), [team]: { seq, stamp } };
	}, context);
}

/** 推进游标到指定 seq（并清掉这一项的「等确认」）。 */
async function advanceCursor(harness: Harness, team: string, seq: number, context: Context): Promise<void> {
	await harness.commit(async (tx) => {
		const doc = (await tx.doc(SettleDoc)) as SettleState;
		const current = doc.cursors[team] ?? 0;
		if (seq > current) doc.cursors = { ...doc.cursors, [team]: seq };
		if (doc.waiting !== undefined && doc.waiting[team] !== undefined) {
			const rest = { ...doc.waiting };
			delete rest[team];
			doc.waiting = rest;
		}
	}, context);
}

/**
 * `remember(scope=team)` 落盘成功后推进游标（兼容旧调用点）。
 * 游标正常由 `settleTeam` 在确认后推进，这里兜底：记忆写入的 seq 比游标新就补推进。
 */
export async function confirmedBy(
	harness: Harness,
	team: string,
	context: Context = BACKGROUND_CONTEXT,
): Promise<number> {
	const state = (await harness.snapshot(ChannelDoc, context)) as ChannelState | undefined;
	// 只算会进候选的消息：`note` 是系统留痕，游标不该因为「系统报过一次错」而前进。
	const maxSeq = (state?.messages[`team:${team}`] ?? []).reduce(
		(max, m) => (m.kind === "note" ? max : Math.max(max, m.seq)),
		0,
	);
	const settle = (await harness.snapshot(SettleDoc, context)) as SettleState | undefined;
	if (maxSeq <= (settle?.cursors[team] ?? 0)) return 0;
	await advanceCursor(harness, team, maxSeq, context);
	return maxSeq;
}
