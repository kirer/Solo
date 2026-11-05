/**
 * 团队频道的两句话：谁刚进来（报到）、谁的一轮被重启掐断了（留痕）。
 *
 * 两句都是**系统留痕**，不是发言：`from` 是我，`kind: "note"`。放在装配旁边单独
 * 一份，是因为它们的时机比内容重要 —— 一处只在运行时重投影之后叫，一处只在装配
 * 最后、频道都建好之后叫。
 */
import type { Context, Harness } from "../../core/runtime/index.ts";
import { labelsOf, readAllIdentities } from "../../core/documents/person/identity.ts";
import { DirectoryDoc, labelIn, type DirectoryState, type WakeRecord } from "../../core/channel/roster.ts";
import {
	ChannelDoc,
	OWNER,
	emptyChannelState,
	teamId,
	type ChannelState,
} from "../../core/channel/types.ts";
import { syncTeamChannel, type MembershipDeps } from "../../core/channel/membership.ts";
import { fill, type TextCatalog } from "../../core/documents/base/catalog.ts";
import type { ChannelFlow } from "../../core/channel/post.ts";

export type TeamWire = {
	/** 按团队文件重投影成员，并叫**新进来的人**自己报到（ADR-042）。 */
	sync(team: string, ctx: Context): Promise<void>;
	/** 叫这些人去团队频道报到：一条系统留痕 + 只叫他们，助理不发言。 */
	announce(team: string, slugs: readonly string[], ctx: Context): Promise<void>;
	/** 重启把某人的一轮掐断了：在**他当时干活的那个频道**留一句痕（ADR-044）。 */
	noteInterrupted(conversationId: number, ctx: Context): Promise<void>;
};

export function createTeamWire(deps: {
	readonly harness: Harness;
	readonly membership: MembershipDeps;
	readonly text: TextCatalog;
	readonly directory: DirectoryState;
	/** 人的目录：显示名以当下的 `identity.md` 为准（名册里的 `labels` 只做兜底）。 */
	readonly agentRoots: readonly string[];
	readonly flow: ChannelFlow;
	readonly wakeOf: (slug: string, ctx: Context) => Promise<WakeRecord | undefined>;
}): TeamWire {
	async function stateOf(ctx: Context): Promise<ChannelState> {
		return (await deps.harness.snapshot(ChannelDoc, ctx)) ?? emptyChannelState();
	}

	/**
	 * 显示名：`hire` 之后名册要等下一次 `rescan`，中间别让投递头退回 slug。
	 * 名册读**当下**那一份（落盘读不到时用装配期那份兜底），显示名以 `identity.md` 为准。
	 */
	async function labelOf(ctx: Context): Promise<(slug: string) => string> {
		const directory = (await deps.harness.snapshot(DirectoryDoc, ctx)) ?? deps.directory;
		const labels = { ...directory.labels, ...labelsOf(await readAllIdentities(deps.agentRoots)) };
		return (slug) => labelIn({ ...directory, labels }, slug);
	}

	async function announce(team: string, slugs: readonly string[], ctx: Context): Promise<void> {
		if (slugs.length === 0) return;
		const state = await stateOf(ctx);
		const channel = state.channels[teamId(team)];
		if (channel === undefined || channel.archived === true) return;
		await deps.flow.publish(
			state,
			{
				channelId: channel.id,
				from: OWNER,
				kind: "note",
				text: fill(deps.text, "membership.joined", { title: channel.title }),
				at: Date.now(),
				wakeTo: slugs,
			},
			ctx,
			await labelOf(ctx),
		);
	}

	async function sync(team: string, ctx: Context): Promise<void> {
		await announce(team, await syncTeamChannel(deps.membership, team, ctx), ctx);
	}

	async function noteInterrupted(conversationId: number, ctx: Context): Promise<void> {
		const slug = Object.entries(deps.directory.conversationToSlug).find(
			([id]) => Number(id) === conversationId,
		)?.[1];
		if (slug === undefined) return;
		const wake = await deps.wakeOf(slug, ctx);
		// 没有唤醒记录（不是被叫醒的）就不猜：宁可不写，也不乱写。
		if (wake === undefined) return;
		const state = await stateOf(ctx);
		const channel = state.channels[wake.task.channelId];
		if (channel === undefined || channel.archived === true || !channel.members.includes(slug)) return;
		await deps.flow.publish(
			state,
			{
				channelId: channel.id,
				from: OWNER,
				kind: "note",
				text: fill(deps.text, "turn.interrupted", {
					name: labelIn(deps.directory, slug),
					seq: wake.task.seq,
				}),
				at: Date.now(),
			},
			ctx,
			await labelOf(ctx),
		);
	}

	return { sync, announce, noteInterrupted };
}
