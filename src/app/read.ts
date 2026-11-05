/**
 * 读：把状态投影成界面要的那几份 JSON。
 *
 * 每一个都是「取一份快照 → 调 `project.ts` 的纯函数 → 返回 DTO」。这里不碰 request /
 * response，也不做序列化 —— 序列化是 `interface/http` 的事。这样同样的读法能被 SSE、
 * HTTP、以及将来任何别的入口共用一份。
 */
import { OWNER_SLUG } from "../core/agent/identity.ts";
import { chatKind } from "../core/channel/types.ts";
import { reasonText } from "../core/channel/unanswered.ts";
import { wakeOf } from "../core/agent/roster.ts";
import { BACKGROUND_CONTEXT, LiveDoc, type LiveState } from "../core/runtime/index.ts";
import type {
	AttentionItem,
	ViewActivity,
	ViewChannel,
	ViewChannelDetail,
	ViewLastFailure,
	ViewOrg,
	ViewTurn,
} from "../view/dto.ts";
import { AppError } from "./errors.ts";
import { attentionItems, channelDetail, channelList, idOf, orgView } from "./project.ts";
import type { Snapshots } from "./snapshot.ts";
import { buildTurn, groupsOf, triggerOf, withoutSteps } from "./trace.ts";
import type { CoreServices } from "./types.ts";

/** 频道列表 + 两个汇总数（侧栏顶部那两个红点）。 */
export type ChannelListResult = {
	readonly channels: ViewChannel[];
	readonly unread: { readonly total: number; readonly mentions: number };
};

/** 「能 @ 谁」的候选。 */
export type MentionCandidate = {
	readonly id: number;
	readonly label: string;
	readonly slug: string;
	readonly title: string;
};

export function createRead(shell: CoreServices, snapshots: Snapshots) {
	/** 组织快照。界面的组织图与顶栏都吃这一份。 */
	async function readOrg(): Promise<ViewOrg> {
		const { identities, directory, assistants } = await snapshots.snapshot();
		const org = orgView(identities, "Solo", assistants);
		const { activity, failure } = await liveMaps(directory);
		if (activity.size === 0 && failure.size === 0) return org;
		return {
			...org,
			people: org.people.map((actor) => {
				const live = activity.get(actor.slug);
				const lastFailure = failure.get(actor.slug);
				if (live === undefined && lastFailure === undefined) return actor;
				return {
					...actor,
					...(live === undefined ? {} : { activity: live }),
					...(lastFailure === undefined ? {} : { lastFailure }),
				};
			}),
		};
	}

	/**
	 * 谁此刻在干什么、谁最近没答上来。
	 *
	 * 出处只有一处：会话的 live 文档。`run` 在 = 忙；`generation` 在 = 在想；
	 * `tools` 里有 running 的调用 = 在做。`run` 不在而 `runFailure` 在 = 上一轮没答上来。
	 * **不读消息、不猜**（ADR-001）。
	 *
	 * `since` 用唤醒记录里那条消息的时间 —— 它是这一轮真正的开始，不是「刚刚看到」。
	 */
	async function liveMaps(
		directory: Awaited<ReturnType<Snapshots["snapshot"]>>["directory"],
	): Promise<{ activity: Map<string, ViewActivity>; failure: Map<string, ViewLastFailure> }> {
		const activity = new Map<string, ViewActivity>();
		const failure = new Map<string, ViewLastFailure>();
		const entries = Object.entries(directory.slugToConversation ?? {});
		if (entries.length === 0) return { activity, failure };
		await Promise.all(
			entries.map(async ([slug, id]) => {
				const live = await liveOf(id);
				if (live === undefined) return;
				const wake = wakeOf(directory, id);
				if (live.state !== undefined) {
					activity.set(slug, {
						state: live.state,
						since: wake?.reply.at ?? Date.now(),
						...(wake === undefined ? {} : { channelId: wake.reply.channelId }),
					});
				}
				if (live.failure !== undefined) {
					failure.set(slug, {
						reason: live.failure.reason,
						text: reasonText(live.failure.reason, shell.text),
						...(live.failure.detail === undefined ? {} : { detail: live.failure.detail }),
					});
				}
			}),
		);
		return { activity, failure };
	}

	/** 一个会话此刻在不在跑（跑在哪个阶段），以及上一轮失败的原因。 */
	async function liveOf(id: number): Promise<
		| { readonly state?: ViewActivity["state"]; readonly failure?: { readonly reason: string; readonly detail?: string } }
		| undefined
	> {
		let live: LiveState | undefined;
		try {
			live = await shell.harness.snapshot(LiveDoc, id as never, BACKGROUND_CONTEXT);
		} catch {
			return undefined;
		}
		if (live === undefined) return undefined;
		if (live.run === undefined) {
			const failed = live.runFailure;
			if (failed === undefined) return undefined;
			return {
				failure: { reason: failed.reason, ...(failed.detail === undefined ? {} : { detail: failed.detail }) },
			};
		}
		const tools = live.tools ?? [];
		if (tools.some((slot) => slot.status === "running")) return { state: "working" };
		if (live.generation !== undefined) return { state: "thinking" };
		// `run` 在、既没在生成也没有工具在跑 = 正在把结果写回频道。
		return { state: "working" };
	}

	async function readChannelList(): Promise<ChannelListResult> {
		const { directory, channels, teamDoingOf } = await snapshots.snapshot();
		const list = channelList(channels, directory, OWNER_SLUG, teamDoingOf);
		return {
			channels: list,
			unread: {
				total: list.reduce((sum, channel) => sum + channel.unread, 0),
				mentions: list.reduce((sum, channel) => sum + channel.mentions, 0),
			},
		};
	}

	/** 一个频道的详情（首屏一页消息 + 成员 + 是否还有更早的）。 */
	async function readChannelDetail(
		id: string,
		options: { readonly limit?: number | undefined; readonly before?: number | undefined } = {},
	): Promise<ViewChannelDetail> {
		const { directory, channels, assistants, teamDoingOf } = await snapshots.snapshot();
		const channel = channels.channels[id];
		if (channel === undefined) throw new AppError("not-found", "频道不存在或无权查看");
		const { limit, before } = options;
		return channelDetail(channels, channel, directory, {
			assistants,
			teamDoingOf,
			...(limit !== undefined && Number.isFinite(limit) && limit > 0 ? { limit } : {}),
			...(before !== undefined && Number.isFinite(before) && before > 0 ? { before } : {}),
		});
	}

	/** 「找我」：跨频道、需要我本人看一眼的消息。 */
	async function readAttention(): Promise<{ items: AttentionItem[]; unread: number }> {
		const { directory, channels } = await snapshots.snapshot();
		const items = attentionItems(channels, directory);
		return { items, unread: items.filter((item) => !item.read).length };
	}

	/** 这个频道能 @ 谁。频道不存在就是空列表（不是 404：侧栏还没加载完时会问一次）。 */
	async function readMentionable(id: string): Promise<{ candidates: MentionCandidate[] }> {
		const { identities, directory, channels } = await snapshots.snapshot();
		const channel = channels.channels[id];
		if (channel === undefined) return { candidates: [] };
		// `title` 取自 `identity.md` 的 title（与团队视图同源），让 @ 浮窗显示
		// 「名字 / 身份 / @slug」三层，我要的身份信息就在这里。
		const identityTitle = (slug: string): string => {
			const found = identities.find((item) => item.slug === slug);
			return found?.title ?? "";
		};
		return {
			candidates: channel.members
				.filter((slug) => slug !== OWNER_SLUG)
				.map((slug) => ({
					id: idOf(directory, slug),
					label: shell.labelOf(slug),
					slug,
					title: identityTitle(slug),
				})),
		};
	}

	/**
	 * 一段消息窗口里每一轮的轨迹（**不带步骤**）。
	 *
	 * 折叠态只要摘要：步数、时长、状态、一句话。展开时再按 `(seq, slug)` 拉完整版 ——
	 * 一屏十几轮，每轮八步，一次全带会把响应撑到几百 KB。
	 */
	async function readTurns(id: string, from: number, to: number, withSteps = false): Promise<{ turns: ViewTurn[] }> {
		return { turns: folded(await turnsOf(id, from, to), withSteps) };
	}

	/** 一轮的完整轨迹（带步骤）。找不到（没被叫醒 / 条目已被压缩）就是 `null`。 */
	async function readTurn(id: string, seq: number, slug: string): Promise<{ turn: ViewTurn | null }> {
		const turns = await turnsOf(id, seq, seq, slug);
		return { turn: turns[0] ?? null };
	}

	/**
	 * 一个人**在所有频道**里的轮次（私聊页的工作记录）。
	 *
	 * 与 `readTurns` 的区别只有一处：切轮时不按频道过滤 —— 他在团队频道干活、在私聊里
	 * 被插话，都是这个人的工作记录，按时间排在一起。每轮自带 `channelId`，界面按它显示
	 * 「这轮发生在哪个频道」。
	 */
	async function readPersonTurns(
		slug: string,
		from: number,
		to: number,
		withSteps = false,
		limit?: number,
	): Promise<{ turns: ViewTurn[] }> {
		const turns = await turnsOf(undefined, from, to, slug);
		// 面板要「最近 N 轮」：按发生时间倒着截，再交回正序（界面自己倒排）。
		const recent = limit === undefined ? turns : turns.slice(Math.max(0, turns.length - limit));
		return { turns: folded(recent, withSteps) };
	}

	/**
	 * 这个频道是私聊时，对面那个人是谁。
	 *
	 * 只有 `chatKind` 认的两人频道才算；群聊返回 `undefined`。SSE 用它决定推「这个频道
	 * 的轮次」还是「这个人的轮次」。
	 */
	async function personOfChannel(id: string): Promise<string | undefined> {
		const state = await shell.channels();
		const channel = state.channels[id];
		if (channel === undefined || chatKind(channel) !== "dm") return undefined;
		return channel.members.find((slug) => slug !== OWNER_SLUG);
	}

	/**
	 * 一轮的切分：会话条目里 `core.channel` 且 `data.channelId/seq` 对上的那条，
	 * 到**下一条** `core.channel` 之间。
	 *
	 * `channelId` 为 `undefined` 时切这个人的**所有**轮次（跨频道），每组自带它发生的频道。
	 */
	async function turnsOf(channelId: string | undefined, from: number, to: number, onlySlug?: string): Promise<ViewTurn[]> {
		const { directory, channels } = await snapshots.channelSnapshot();
		if (channelId !== undefined && channels.channels[channelId] === undefined) return [];

		// 回复可能落在别的频道（任务频道），所以按「所有频道的消息」找，不只看当前频道。
		const said: { channelId: string; seq: number; at: number; fromSlug: string }[] = [];
		for (const [id, list] of Object.entries(channels.messages ?? {})) {
			for (const message of list) {
				if (message.from !== "owner") said.push({ channelId: id, seq: message.seq, at: message.at, fromSlug: message.from });
			}
		}

		const people = Object.entries(directory.slugToConversation ?? {}).filter(
			([slug]) => onlySlug === undefined || slug === onlySlug,
		);

		const turns: ViewTurn[] = [];
		for (const [slug, conversationId] of people) {
			let view;
			try {
				const conversation = await shell.harness.conversation(conversationId as never, BACKGROUND_CONTEXT);
				if (conversation === undefined) continue;
				view = await conversation.context(BACKGROUND_CONTEXT);
			} catch {
				// 会话已回收 / 进程刚重启：这一轮就是看不到，不是错误。
				continue;
			}
			const groups = groupsOf(view.entries, from, to, channelId);
			const running = groups.length > 0 ? (await liveOf(conversationId))?.state !== undefined : false;
			/** 同一个频道里，这一组之后的那一组的 seq：回话只可能落在这之间。 */
			const nextSeqIn = (id: string, seq: number): number => {
				let next = Number.POSITIVE_INFINITY;
				for (const group of groups) {
					if (group.channelId === id && group.seq > seq && group.seq < next) next = group.seq;
				}
				return next;
			};
			for (const [index, group] of groups.entries()) {
				const id = group.channelId;
				const entries = view.entries.slice(group.start + 1, group.end);
				const trigger = (channels.messages[id] ?? []).find((message) => message.seq === group.seq);
				const startedAt = trigger?.at ?? 0;
				const nextStart = nextSeqIn(id, group.seq);
				const reply = said
					.filter((item) => item.fromSlug === slug && item.channelId === id && item.seq > group.seq && item.seq < nextStart)
					.sort((left, right) => left.seq - right.seq)[0];
				const channelTitle = channels.channels[id]?.title;
				const turn = buildTurn(entries, {
					channelId: id,
					...(channelTitle === undefined ? {} : { channelTitle }),
					seq: group.seq,
					slug,
					label: shell.labelOf(slug),
					startedAt,
					...(reply === undefined ? {} : { endedAt: reply.at, replySeq: reply.seq }),
					live: running && index === groups.length - 1,
				});
				turns.push(trigger === undefined ? turn : { ...turn, trigger: triggerOf(trigger) });
			}
		}
		// 单频道按 seq 排（seq 在频道内单调）；跨频道 seq 不可比，按发生时间排。
		if (channelId !== undefined) {
			return turns.sort((left, right) => left.seq - right.seq || left.slug.localeCompare(right.slug));
		}
		return turns.sort(
			(left, right) =>
				left.startedAt - right.startedAt ||
				left.channelId.localeCompare(right.channelId) ||
				left.seq - right.seq ||
				left.slug.localeCompare(right.slug),
		);
	}

	/** 档案页里「他在哪些频道」那一栏：成员表是真相，界面不用自己比。 */
	async function channelsOf(
		slug: string,
	): Promise<{ id: string; kind: "dm" | "group"; title: string; members: string[] }[]> {
		const state = await shell.channels();
		return Object.values(state.channels ?? {})
			.filter((channel) => channel.members.includes(slug))
			.map((channel) => ({
				id: channel.id,
				kind: chatKind(channel),
				title: channel.title,
				members: channel.members.filter((member) => member !== OWNER_SLUG),
			}));
	}

	return {
		readOrg,
		readChannelList,
		readChannelDetail,
		readAttention,
		readMentionable,
		channelsOf,
		readTurns,
		readTurn,
		readPersonTurns,
		personOfChannel,
	};
}

/** 折叠态只要摘要：一屏十几轮，每轮八步，一次全带会把响应撑到几百 KB。 */
function folded(turns: ViewTurn[], withSteps: boolean): ViewTurn[] {
	return withSteps ? turns : turns.map(withoutSteps);
}

export type Read = ReturnType<typeof createRead>;
