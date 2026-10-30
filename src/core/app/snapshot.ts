/**
 * 快照：界面要的那几份状态的**采样**。
 *
 * 两件不同粒度的事都在这里：
 * - `channelSnapshot()`：只读「人 + 频道」。SSE 增量推送用它 —— 推一条消息完全用不到
 *   团队文档，旧版本却每条推送都去串行读一遍全部团队 README（审计 P1-4）。
 * - `snapshot()`：再加上团队文档推出的两张查表函数（谁负责、一句话现状）。
 *
 * 团队文档的短缓存也在这：`listTeams` 是一个团队一次 `readFile`、串行。agent 连续干活时
 * 「一次提交 × 每个活跃频道 × 每个团队」会把磁盘读放大成每秒几十次，而团队文档一秒内
 * 几乎不会变。按 `teams/` 目录 mtime + 250ms 窗口缓存，改了最迟 250ms 后生效。
 */
import { stat } from "node:fs/promises";
import { BACKGROUND_CONTEXT, type Context } from "../runtime/index.ts";
import { listTeams } from "../team/doc.ts";
import { ChannelDoc, type ChannelState } from "../channel/store.ts";
import type { DirectoryState } from "../agent/roster.ts";
import type { Identity } from "../agent/identity.ts";
import type { TeamDoingOf, TeamLeadOf } from "../view/dto.ts";
import { withLabels } from "./read.ts";
import type { CoreServices } from "./types.ts";

/** 团队文档缓存窗口（毫秒）。够合并连续提交，又不至于让界面看见旧数据。 */
const TEAM_CACHE_MS = 250;

/** 空频道状态（文档还没写过时用）。 */
export function emptyChannels(): ChannelState {
	return { channels: {}, messages: {}, nextSeq: {}, readMarks: {} };
}

export type ChannelSnapshot = {
	readonly identities: readonly Identity[];
	readonly directory: DirectoryState;
	readonly channels: ChannelState;
};

export type OrgSnapshot = ChannelSnapshot & {
	readonly teamLeadOf: TeamLeadOf;
	readonly teamDoingOf: TeamDoingOf;
};

export function createSnapshots(shell: CoreServices) {
	type Team = Awaited<ReturnType<typeof listTeams>>[number];
	let teamsCache: { at: number; stamp: number; value: readonly Team[] } | undefined;

	async function teamsNow(): Promise<readonly Team[]> {
		const stamp = await stat(shell.teamsRoot)
			.then((info) => info.mtimeMs)
			.catch(() => -1);
		const now = Date.now();
		if (teamsCache !== undefined && teamsCache.stamp === stamp && now - teamsCache.at < TEAM_CACHE_MS) {
			return teamsCache.value;
		}
		const value = [...(await listTeams(shell.teamsRoot))];
		teamsCache = { at: now, stamp, value };
		return value;
	}

	async function channelSnapshot(context: Context = BACKGROUND_CONTEXT): Promise<ChannelSnapshot> {
		const identities = await shell.identities();
		const directory = withLabels(shell.bindings(), identities);
		const channels = (await shell.harness.snapshot(ChannelDoc, context)) ?? emptyChannels();
		return { identities, directory, channels };
	}

	/**
	 * 组织快照：名册 + 身份 + 频道 + 团队管理员/现状表。界面的组织图与顶栏都吃这一份。
	 *
	 * 团队管理员的真相在团队 README 里，不在频道文档里。所以这里把它读成查表函数交给
	 * 视图层 —— 视图层只做投影，不猜谁负责。
	 */
	async function snapshot(context: Context = BACKGROUND_CONTEXT): Promise<OrgSnapshot> {
		const [{ identities, directory, channels }, teams] = await Promise.all([
			channelSnapshot(context),
			teamsNow(),
		]);
		const leads = new Map<string, string | undefined>(teams.map((team) => [team.slug, team.lead]));
		const teamLeadOf = (team: string) => leads.get(team);
		// 一句话现状与团队管理员同源（同一份团队文档），所以是同一个快照里的一张表。
		const doings = new Map<string, string | undefined>(teams.map((team) => [team.slug, team.doing]));
		const teamDoingOf = (team: string) => doings.get(team);
		return { identities, directory, channels, teamLeadOf, teamDoingOf };
	}

	return { channelSnapshot, snapshot, teamsNow };
}

export type Snapshots = ReturnType<typeof createSnapshots>;
