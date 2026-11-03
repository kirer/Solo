/**
 * 频道成员从哪里来：全员频道只加不删，团队频道按团队文件精确重算。
 *
 * 这两条以前写在 `shell/assemble.ts` 里 —— 它们是**业务事实的投影**，不是装配步骤，
 * 所以住在 channel 里；外壳只负责在正确的时机调它们。`rescan`、`hire`、`file` 写
 * 团队 README 之后重投影，都走这里。
 */
import type { Context, Harness } from "../runtime/index.ts";
import { BACKGROUND_CONTEXT } from "../runtime/index.ts";
import { assistantsOf, readAllIdentities, readIdentity, type Identity } from "../agent/identity.ts";
import { ChannelDoc, OWNER, dmId, teamId, type ChannelState } from "./types.ts";
import { projectChannel } from "./rules.ts";
import { membersOfTeam, readTeam } from "../team/doc.ts";
import type { Layout } from "../layout.ts";

/**
 * 一个团队频道的成员：我 + 助理 + `identity.md` 里 `team:` 指向它的人。
 *
 * 没有负责人，也没有汇报线（ADR-058）：团队频道就是这个团队的房间，谁在这个团队谁在。
 * 助理在每一个团队频道里 —— 它是统筹者，要看得见每个团队在做什么。
 */
export function teamMembers(input: {
	readonly teammates: readonly string[];
	readonly assistants: readonly string[];
}): readonly string[] {
	return Array.from(new Set([OWNER, ...input.assistants, ...input.teammates]));
}

export type MembershipDeps = {
	readonly harness: Harness;
	/** 两个根：助理在 app 根、成员在用户根；团队在用户根。 */
	readonly layout: Layout;
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
	const identity = await readIdentity(deps.layout.agentRoots, slug);
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
	const identity = await readIdentity(deps.layout.agentRoots, slug);
	const team = identity?.team;
	if (team === undefined || team === "") return;
	await syncTeamChannel(deps, team, context);
}

/**
 * 按「团队文件写的事实」重建一个团队频道的成员表（幂等）。
 *
 * 成员 = 我 + 助理 + 所有 `identity.md` 里 `team:` 指向它的人。谁能进来只有一条判据：
 * 他的身份文件里写了这个团队。没有负责人，也就不存在「往负责人名下挂人」。
 *
 * 成员表是事实的投影，所以用「精确重算后整体替换」（`replace`）而不是「只加不删」：
 * 只加不删会留下改名后的幽灵成员（实测过）。
 *
 * **返回新进来的成员**（不含我和助理）。谁进频道了是这里唯一知道的事，报到的话由
 * 调用方去说（`assemble.ts` 用一条 `note` 叫醒他们）；这一层只管成员表，不碰消息。
 */
export async function syncTeamChannel(
	deps: MembershipDeps,
	team: string,
	context: Context = BACKGROUND_CONTEXT,
): Promise<readonly string[]> {
	const [doc, all] = await Promise.all([
		readTeam(deps.layout.teamsRoot, team),
		readAllIdentities(deps.layout.agentRoots),
	]);
	// README 还没写出来就不建频道：标题只有一个真名（README 的 `name`）。
	// 先按目录名建一次再改名，界面上就会先闪一段拼音/英文 slug（实测 `xiaokonglong`）。
	if (doc === undefined) return [];
	// 助理和我一样在每个团队频道里：它是统筹者，要看得见每个团队在做什么，团队里
	// 的人也随时能 @ 到它。报到这件事不叫它 —— 它不是被招来干活的。
	const assistants = assistantsOf(deps.layout, all);
	const members = teamMembers({ teammates: membersOfTeam(all, team), assistants });
	// 团队频道里**没人被 @ 时叫醒助理**：这个频道只为这一个团队存在，不这样设，
	// 成员说「做完了」而没 @ 人，就没人接（实测里 agent 因此用 `run sleep 120` 轮询
	// 等进度，白烧一轮）。接话的是助理，不是「负责人」—— 它本来就该在这里。
	const wakeOnAll = assistants;
	const notMe = new Set([OWNER, ...assistants]);
	const joined: string[] = [];
	await deps.harness.commit(async (tx) => {
		const state = (await tx.doc(ChannelDoc)) as ChannelState;
		const before = state.channels[teamId(team)]?.members ?? [];
		Object.assign(
			state,
			projectChannel(state, {
				id: teamId(team),
				title: doc.name,
				// 团队解散 = README 写 `status: archived`：频道归档，历史留着，列表里不再出现。
				...(doc.status === "archived" ? { archived: true } : {}),
				members,
				wakeOnAll,
				at: Date.now(),
				mode: "replace",
			}),
		);
		if (doc.status !== "archived") {
			for (const slug of members) {
				if (!before.includes(slug) && !notMe.has(slug)) joined.push(slug);
			}
		}
	}, context);
	return joined;
}
