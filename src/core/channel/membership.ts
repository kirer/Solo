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
import { ChannelDoc, OWNER, dmId, teamId, type ChannelState } from "./types.ts";
import { projectChannel } from "./rules.ts";
import { membersOfTeam, readTeam } from "../team/doc.ts";

/**
 * 一个团队频道的成员：我 + 团队管理员 + 他的整条汇报线 + `team:` 指向它的人 + 助理。
 *
 * 助理（`manager: owner`）不进汇报线也能看见每个团队：它是统筹者，不是任何人的上级。
 */
export function teamMembers(input: {
	readonly lead: string | undefined;
	readonly chain: readonly string[];
	readonly teammates: readonly string[];
	readonly assistants: readonly string[];
}): readonly string[] {
	const lead = input.lead === undefined || input.lead === "" ? [] : [input.lead];
	return Array.from(new Set([OWNER, ...lead, ...input.chain, ...input.teammates, ...input.assistants]));
}

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

/**
 * 保证「我 ↔ 这个人」的私聊存在（幂等）。
 *
 * 每个成员都有自己的私聊：**他的工作过程在那里看**，群聊只留结论。私聊仍然只是
 * 我们两个人的频道 —— 建它的是装配 / 招人，不是 agent 自己；agent 之间不能私下找人。
 *
 * 用 `dmId()` 算 id（它会排序），不要拼 `dm:owner-<slug>`：slug 排在 `owner` 前面时
 * 拼出来的 id 和 `dmId()` 不是同一个，界面上就会多出一个「同一个人」的私聊。
 */
export async function ensureOwnerDm(
	deps: MembershipDeps,
	slug: string,
	context: Context = BACKGROUND_CONTEXT,
): Promise<void> {
	if (slug === OWNER) return;
	const identity = await readIdentity(deps.agentsRoot, slug);
	if (identity === undefined) return;
	await deps.harness.commit(async (tx) => {
		const doc = (await tx.doc(ChannelDoc)) as ChannelState;
		Object.assign(
			doc,
			projectChannel(doc, {
				id: dmId(OWNER, slug),
				title: identity.name ?? slug,
				members: [OWNER, slug],
				wakeOnAll: [],
				at: Date.now(),
				mode: "create",
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
	const members = teamMembers({
		lead,
		chain,
		teammates: membersOfTeam(all, team),
		// 助理（直接向我汇报的人）和我一样在每个团队频道里：他是统筹者，要看得见每个
		// 团队在做什么，团队里的人也随时能 @ 到他。
		assistants: all.filter((identity) => identity.manager === OWNER).map((identity) => identity.slug),
	});
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
