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
import { ChannelDoc, OWNER, teamId, type ChannelState } from "../channel/state.ts";
import { appendNote } from "../channel/post.ts";
import { deliveryPrompt, renderReplyRules } from "../channel/deliver.ts";
import { wake } from "../channel/wake.ts";
import { renderUnanswered } from "../channel/unanswered.ts";
import { readAllIdentities, type Identity } from "../agent/identity.ts";
import { readTeam, type TeamDoc } from "./doc.ts";
import { teamMemoryPath, renderSettlePrompt, settleCandidates } from "./memory.ts";
import { oneLine } from "../oneline.ts";

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

type SettleDeps = {
	readonly harness: Harness;
	readonly agentsRoot: string;
	readonly teamsRoot: string;
	readonly channelState: () => Promise<ChannelState>;
	readonly conversationOf: (slug: string) => Promise<Conversation | undefined>;
	/** 提示词模板目录（`<workspace>/prompt`）：沉淀也要贴回话规矩，和投递同一个来源。 */
	readonly promptDir?: string;
	/** 合并唤醒：和投递同一条路，别让同一个会话排两个唤醒。 */
	readonly coalesceQueue?: (conversationId: number, keepRequestId: string) => Promise<number>;
	/** 显示名（留痕用）。 */
	readonly labelOf?: (slug: string) => string;
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
): Promise<{
	asked?: { team: string; to: string; count: number; delivered: boolean };
	skipped?: { team: string; count: number };
}> {
	const state = await deps.channelState();
	const channel = state.channels[`team:${team}`];
	if (channel === undefined) return {};

	let settle = (await deps.harness.snapshot(SettleDoc, context)) ?? { cursors: {} };
	const waiting = settle.waiting?.[team];
	if (waiting !== undefined) {
		// 记忆文件变了才算这批被真写过；没变就是还没写（被打断、或者写砸了），不催也不推进。
		const stamp = await memoryStamp(deps.teamsRoot, team);
		if (stamp === null || stamp === waiting.stamp) return {};
		await writeSettle(deps.harness, team, context, { cursor: waiting.seq, waiting: null });
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
			await writeSettle(deps.harness, team, context, { cursor: lastSeq, waiting: null });
			return { skipped: { team, count: candidates.length } };
		}
		const conversation = await deps.conversationOf(to);
		if (conversation === undefined) {
			// 有团队管理员但没会话：游标照常推进，下次团队管理员醒来读团队频道能看到。
			await writeSettle(deps.harness, team, context, { cursor: lastSeq, waiting: null });
			return { skipped: { team, count: candidates.length } };
		}

		const stamp = await memoryStamp(deps.teamsRoot, team);
		// 回话规矩从模板现读一次（不缓存）：沉淀这条路上以前什么都没有 —— 裸提示词、
		// 没留痕、没合并。现在和投递走同一个 `wake()`，两段规矩也一起贴。
		const prompt = await deliveryPrompt(deps.promptDir);
		if (prompt.settle.trim() === "") {
			// 模板缺了就别问：问出去也是一句「按技能整理」，模型既没判据也没被要求读技能
			// —— 这一刀之前的 11/12 就是这么来的。游标不推进，等模板补上下次再问。
			console.warn(`[core] 没有沉淀模板（prompt/95-settle.md）：团队 ${team} 这批消息这次不问`);
			return { skipped: { team, count: candidates.length } };
		}
		const label = deps.labelOf?.(to) ?? to;
		const body = [
			renderSettlePrompt(prompt.settle, team, candidates),
			renderReplyRules({ template: prompt.reply, woken: [to], viewer: to, colleagues: [] }),
		]
			.filter((part) => part.trim() !== "")
			.join("\n");
		const woken = await wake(
			{
				conversationOf: deps.conversationOf,
				...(deps.coalesceQueue === undefined ? {} : { coalesceQueue: deps.coalesceQueue }),
				noteUnanswered: async (note) => {
					await appendTeamNote(deps, team, renderUnanswered(note.seq, note.label, note.reason), context);
				},
			},
			{
				slug: to,
				requestId: `settle:${team}:${lastSeq}`,
				coalesce: true,
				whenBusy: "followUp",
				bodyOf: () => body,
				entry: { kind: "core.settle", data: { team, count: candidates.length } },
				note: { channelId: channel.id, seq: lastSeq, label },
			},
			context,
		);
		await writeSettle(deps.harness, team, context, { waiting: { seq: lastSeq, stamp } });
		return { asked: { team, to, count: candidates.length, delivered: woken.status === "delivered" } };
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
	return oneLine(reason, 120) || "未知原因";
}

/**
 * 往团队频道追加一条系统留痕（`kind: "note"`，不唤醒人）。
 *
 * 写盘本身是 `channel/post.ts` 的 `appendNote`（同一个「唯一写入口」）。这里只多一层
 * try：沉淀已经在处理异常了，留痕再抛就是二次失败，所以失败只写 stderr。
 */
async function appendTeamNote(deps: SettleDeps, team: string, text: string, context: Context): Promise<void> {
	try {
		await appendNote(deps, teamId(team), text, Date.now(), context);
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

/** 游标改动的形状：`undefined` = 这个字段不动，`null` = 清掉。 */
type SettlePatch = {
	readonly cursor?: number;
	readonly waiting?: { readonly seq: number; readonly stamp: number | null } | null;
};

/**
 * 游标的**唯一写入口**（以前是 `parkWaiting` / `advanceCursor` / `confirmedBy` 三段各自
 * 「读 → 改一个字段 → commit」，同一个文档三种写法，加一个字段要改三处）。
 */
async function writeSettle(harness: Harness, team: string, context: Context, patch: SettlePatch): Promise<void> {
	await harness.commit(async (tx) => {
		const doc = (await tx.doc(SettleDoc)) as SettleState;
		const current = doc.cursors[team] ?? 0;
		if (patch.cursor !== undefined && patch.cursor > current) {
			doc.cursors = { ...doc.cursors, [team]: patch.cursor };
		}
		if (patch.waiting === undefined) return;
		const before = doc.waiting?.[team];
		if (before === patch.waiting) return;
		const next = { ...(doc.waiting ?? {}) };
		if (patch.waiting === null) delete next[team];
		else next[team] = patch.waiting;
		doc.waiting = next;
	}, context);
}

/**
 * `remember(scope=team)` 落盘成功后推进游标。
 * 游标正常由 `settleTeam` 在确认后推进，这里兜底：记忆已经写下了，就不该再把同一批消息问一遍。
 */
export async function confirmedBy(
	harness: Harness,
	team: string,
	context: Context = BACKGROUND_CONTEXT,
): Promise<number> {
	const state = (await harness.snapshot(ChannelDoc, context)) as ChannelState | undefined;
	// 只算会进候选的消息：`note` 是系统留痕，游标不该因为「系统报过一次错」而前进。
	const latest = (state?.messages[teamId(team)] ?? []).reduce(
		(max, message) => (message.kind === "note" ? max : Math.max(max, message.seq)),
		0,
	);
	const settle = (await harness.snapshot(SettleDoc, context)) as SettleState | undefined;
	if (latest <= (settle?.cursors[team] ?? 0)) return 0;
	await writeSettle(harness, team, context, { cursor: latest, waiting: null });
	return latest;
}
