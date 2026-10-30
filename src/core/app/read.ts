/**
 * 读：把状态投影成界面要的那几份 JSON。
 *
 * 每一个都是「取一份快照 → 调 `project.ts` 的纯函数 → 返回 DTO」。这里不碰 request /
 * response，也不做序列化 —— 序列化是 `interface/http` 的事。这样同样的读法能被 SSE、
 * HTTP、以及将来任何别的入口共用一份。
 */
import { OWNER_SLUG } from "../agent/identity.ts";
import { chatKind } from "../channel/store.ts";
import type { AttentionItem, ViewChannel, ViewChannelDetail, ViewOrg } from "../view/dto.ts";
import { AppError } from "./errors.ts";
import { attentionItems, channelDetail, channelList, idOf, orgView } from "./project.ts";
import type { Snapshots } from "./snapshot.ts";
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
		const { identities, directory } = await snapshots.snapshot();
		return orgView(identities, directory);
	}

	async function readChannelList(): Promise<ChannelListResult> {
		const { directory, channels, teamLeadOf, teamDoingOf } = await snapshots.snapshot();
		const list = channelList(channels, directory, OWNER_SLUG, teamLeadOf, teamDoingOf);
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
		const { directory, channels, teamLeadOf, teamDoingOf } = await snapshots.snapshot();
		const channel = channels.channels[id];
		if (channel === undefined) throw new AppError("not-found", "频道不存在或无权查看");
		const { limit, before } = options;
		return channelDetail(channels, channel, directory, {
			teamLeadOf,
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

	/** 档案页里「他在哪些频道」那一栏：成员表是真相，界面不用自己比。 */
	async function channelsOf(slug: string): Promise<{ id: string; kind: "dm" | "group"; title: string }[]> {
		const state = await shell.channels();
		return Object.values(state.channels ?? {})
			.filter((channel) => channel.members.includes(slug))
			.map((channel) => ({ id: channel.id, kind: chatKind(channel), title: channel.title }));
	}

	return { readOrg, readChannelList, readChannelDetail, readAttention, readMentionable, channelsOf };
}

export type Read = ReturnType<typeof createRead>;
