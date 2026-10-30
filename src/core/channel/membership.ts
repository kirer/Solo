/**
 * 频道成员从哪里来：全员频道只加不删，团队频道按团队文件精确重算。
 *
 * 这两条以前写在 `shell/assemble.ts` 里 —— 它们是**业务事实的投影**，不是装配步骤，
 * 所以住在 channel 里；外壳只负责在正确的时机调它们。`rescan`、`hire`、`file` 写
 * 团队 README 之后重投影，都走这里。
 */
import type { Context, Harness } from "../runtime/index.ts";
import { BACKGROUND_CONTEXT } from "../runtime/index.ts";
import { chainUp, readAllIdentities, readIdentity, type Identity } from "../agent/identity.ts";
import { ChannelDoc, OWNER, teamId, type ChannelState } from "./types.ts";
import { projectChannel } from "./rules.ts";
import { membersOfTeam, readTeam } from "../team/doc.ts";

export type MembershipDeps = {
	readonly harness: Harness;
	readonly agentsRoot: string;
	readonly teamsRoot: string;
	/** 全员频道 id（默认 `all`）。 */
	readonly allChannel: string;
};

/** 把人加进全员频道（幂等）。频道不存在时什么都不做 —— 它由播种建。 */
export async function addToAllChannel(
	deps: MembershipDeps,
	slugs: readonly string[],
	context: Context = BACKGROUND_CONTEXT,
): Promise<void> {
	if (slugs.length === 0) return;
	await deps.harness.commit(async (tx) => {
		const doc = (await tx.doc(ChannelDoc)) as ChannelState;
		const channel = doc.channels[deps.allChannel];
		if (channel === undefined) return;
		// 整体替换，不就地 push：读出来的是副本，就地改不产生 op。
		Object.assign(
			doc,
			projectChannel(doc, {
				id: deps.allChannel,
				title: channel.title,
				members: [...slugs],
				at: Date.now(),
				mode: "merge",
			}),
		);
	}, context);
}

/** 播种全员频道：不存在就建，存在就把缺的人补进去（`merge`，只加不删）。 */
export async function ensureAllChannel(
	deps: MembershipDeps,
	identities: readonly Identity[],
	context: Context = BACKGROUND_CONTEXT,
): Promise<void> {
	await deps.harness.commit(async (tx) => {
		const doc = (await tx.doc(ChannelDoc)) as ChannelState;
		const members = [OWNER, ...identities.map((item) => item.slug)];
		// 它就是个**普通群**：id 是 `all`、所有人自动进来，仅此而已。
		// `wakeOnAll` 只在建群那一刻写一次，之后只是普通字段。
		Object.assign(
			doc,
			projectChannel(doc, {
				id: deps.allChannel,
				title: "全员",
				members,
				wakeOnAll: [OWNER],
				at: Date.now(),
				mode: "merge",
			}),
		);
	}, context);
}

/** 把这个人拉进它所属团队的频道（幂等）。`identity.md` 没有 `team:` 就什么都不做。 */
export async function joinTeamChannel(
	deps: MembershipDeps,
	slug: string,
	context: Context = BACKGROUND_CONTEXT,
): Promise<void> {
	const identity = await readIdentity(deps.agentsRoot, slug);
	const team = identity?.team;
	if (team === undefined || team === "") return;
	await syncTeamChannel(deps, team, context);
}

/**
 * 按「团队文件写的事实」重建一个团队频道的成员表（幂等）。
 *
 * 成员 = 我 + 团队管理员 + 团队管理员的整条汇报线（向上到我）+ 所有 `identity.md` 里
 * `team:` 指向它的人。团队管理员在 `teams/<slug>/README.md` 的 `lead` 里 —— 那是文档的
 * 事实，代码照抄，不猜「谁该负责」。
 *
 * 成员表是事实的投影，所以用「精确重算后整体替换」（`replace`）而不是「只加不删」：
 * 只加不删会留下改名后的幽灵成员（实测过）。
 */
export async function syncTeamChannel(
	deps: MembershipDeps,
	team: string,
	context: Context = BACKGROUND_CONTEXT,
): Promise<void> {
	const [doc, all] = await Promise.all([
		readTeam(deps.teamsRoot, team),
		readAllIdentities(deps.agentsRoot),
	]);
	const lead = doc?.lead;
	const chain = lead === undefined || lead === "" ? [] : chainUp(all, lead);
	const members = Array.from(
		new Set([OWNER, ...(lead === undefined || lead === "" ? [] : [lead]), ...chain, ...membersOfTeam(all, team)]),
	);
	// 团队频道里**任何人说话都叫醒团队管理员**：这个频道只为这一个团队存在，
	// 不这样设，成员说「做完了」而没 @ 人，团队管理员就永远收不到（实测里 agent
	// 因此用 `run sleep 120` 轮询等进度，白烧一轮）。
	const wakeOnAll = lead === undefined || lead === "" ? [] : [lead];
	await deps.harness.commit(async (tx) => {
		const state = (await tx.doc(ChannelDoc)) as ChannelState;
		Object.assign(
			state,
			projectChannel(state, {
				id: teamId(team),
				title: doc?.name ?? team,
				members,
				wakeOnAll,
				at: Date.now(),
				mode: "replace",
			}),
		);
	}, context);
}
