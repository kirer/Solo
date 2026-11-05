/**
 * 频道 id：怎么造、怎么认。**唯一认识前缀的地方。**
 *
 * ```
 * all              全员频道（id 由装配层给，默认 `all`；不带前缀）
 * team:<slug>      团队频道：团队 README 是事实，频道是它的投影
 * group:<name>     任意组群：没有档案，只是「这些人一起说话」的房间（ADR-063）
 * dm:<a>-<b>       私聊：双方 slug 排序后拼，`a-b` 与 `b-a` 是同一间
 * ```
 *
 * 解析也只在这里。业务代码手写 `id.startsWith("team:")` + `slice` 时，前缀一改就得
 * 全仓库找一遍；漏一处就是「频道还在，但认不出它属于谁」—— 界面上看不出异常。
 *
 * 注意：`chatKind` 不在这里。它判的是「私聊还是群聊」，除了前缀还要看成员
 * （只有我 + 一个人的团队频道，形状和私聊一样），住在 `types.ts`。
 */

/** 私聊频道的命名规则。双方 slug 排序后拼接，保证 `a-b` 与 `b-a` 是同一个频道。 */
export function dmId(a: string, b: string): string {
	const [left, right] = [a, b].sort();
	return `dm:${left}-${right}`;
}

/** 团队频道的命名规则。 */
export function teamId(team: string): string {
	return `team:${team}`;
}

/**
 * 组群的命名规则。组群没有档案：它只是「这些人一起说话」的房间，
 * 团队才是有 README 的群（ADR-063）。
 */
export function groupId(name: string): string {
	return `group:${name}`;
}

/** 是不是私聊 id（只看前缀；真有几个人还要看成员）。 */
export function isDmChannel(channelId: string): boolean {
	return channelId.startsWith("dm:");
}

/** 团队频道吗；是的话给出团队 slug。 */
export function teamOfChannel(channelId: string): string | undefined {
	return channelId.startsWith("team:") ? channelId.slice("team:".length) : undefined;
}

/** 组群吗。 */
export function isGroupChannel(channelId: string): boolean {
	return channelId.startsWith("group:");
}
