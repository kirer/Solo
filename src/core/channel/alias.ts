/**
 * `@` 别名解析：把「人话里的名字」翻译成 slug。
 *
 * 为什么要这一层：`parseMentions` 只从正文里抓 `@xxx`，抓到的就是字面 token，而频道
 * 成员表里存的是 slug。于是 `@老板`（48 条实测）、`@CEO`、`@知言`（真名的 slug 恰好
 * 相同才碰巧生效）写下去，`recipientsOf` 按成员过滤时统统丢弃 —— 库里 980 个 mention
 * token 有 573 个是这种「写了没人醒」的垃圾。
 *
 * 三条取舍：
 *
 * 1. **纯函数，喂一份名册**。这一层不许自己读盘：名册从 `agents/<slug>/identity.md`
 *    来，读盘是外壳和工具层的事。
 * 2. **只认名册里的人**。解析不出来的 token（`@import`、`@media`、`@x`）一律丢弃 ——
 *    它们不是人，留着只会让「谁被 @ 了」变成噪音。
 * 3. **老板的名字是静态表**。老数据里已经存着 `@老板`，没有名册也必须能认出来，
 *    所以 `resolveMention` 的缺省名册就能把老板的各种叫法翻成 `owner`。
 */

/** 名册里的一个人。字段全部可选（除了 slug）：缺什么就少一种叫法。 */
export type MentionAgent = {
	/** 目录名，唯一稳定标识。 */
	readonly slug: string;
	/** `identity.md` 的 `name`（真名，例如「周砚」）。 */
	readonly name?: string | undefined;
	/** 岗位名（`CEO` / `CTO` 这类缩写），大小写不敏感。 */
	readonly role?: string | undefined;
	/** `identity.md` 的 `title`（例如「平台负责人」）。 */
	readonly title?: string | undefined;
	/** 上级 slug。用来推导岗位名（直属老板的人就是 `ceo`）。 */
	readonly manager?: string | undefined;
};

/** 一份名册：老板的 slug + 全公司的人。 */
export type MentionRoster = {
	/** 老板的 slug，正常就是 `owner`。 */
	readonly owner: string;
	readonly agents: readonly MentionAgent[];
};

/** 老板的 slug。与 `state.ts` 的 `OWNER` 是同一个字面量（这里不能 import，会成环）。 */
const OWNER_SLUG = "owner";

/** 没有名册时的兜底：只认老板。老数据里的 `@老板` 靠它复活。 */
export const EMPTY_ROSTER: MentionRoster = { owner: OWNER_SLUG, agents: [] };

/**
 * 老板的各种叫法。故意短：每加一个词就多一条「谁都能被 @ 到」的路。
 *
 * `我` / `YOU` 是模型从正文视角抄下来的（「请 @我」），它们在真实数据里出现了 27 次，
 * 全都指向老板 —— 员工不会用第三人称叫自己。
 */
const OWNER_ALIASES: readonly string[] = ["owner", "老板", "boss", "我", "you", "你自己"];

/** 别名归一：去 `@`、去首尾空格、全角转半角（`ＣＥＯ` → `CEO`）、转小写。 */
export function normalizeAlias(raw: string): string {
	return raw
		.normalize("NFKC")
		.trim()
		.replace(/^@+/, "")
		.trim()
		.toLowerCase();
}

/** `title` 里头衔常常是「平台功能开发 / 修 bug」，拆开每一段都能被 @ 到。 */
function titleSegments(title: string): readonly string[] {
	return title
		.split(/[\s/、，,（）()]+/)
		.map((part) => normalizeAlias(part))
		.filter((part) => part !== "");
}

/**
 * 从一份身份清单建名册。
 *
 * 岗位名的来源只有一处：**直属老板的人就是 `ceo`**。`identity.md` 的 YAML 头只有
 * 4 个字段（`name`/`title`/`manager`/`project`），没有岗位缩写；而「老板唯一直接对话
 * 的人」是组织架构里的事实（见 `知言` 的正文），不需要再让人手填一遍。
 * 显式写了 `role` 的人以 `role` 为准。
 */
export function mentionRosterOf(agents: readonly MentionAgent[], owner: string = OWNER_SLUG): MentionRoster {
	return {
		owner,
		agents: agents.map((agent) =>
			agent.role !== undefined || agent.manager !== owner
				? agent
				: { ...agent, role: "ceo" },
		),
	};
}

/**
 * 把用户/模型写的 `@` 名字解析成真正的 slug。纯函数，喂一份名册。
 *
 * 顺序：slug 本身 → 老板的叫法 → 真名 → 岗位名 → title（整串或其中一段）。
 * 都匹配不上返回 `undefined`（调用方丢弃，不要瞎猜）。
 */
export function resolveMention(raw: string, roster: MentionRoster = EMPTY_ROSTER): string | undefined {
	const key = normalizeAlias(raw);
	if (key === "") return undefined;

	for (const agent of roster.agents) {
		if (normalizeAlias(agent.slug) === key) return agent.slug;
	}
	if (OWNER_ALIASES.includes(key)) return roster.owner;
	for (const agent of roster.agents) {
		if (agent.name !== undefined && normalizeAlias(agent.name) === key) return agent.slug;
	}
	for (const agent of roster.agents) {
		if (agent.role !== undefined && normalizeAlias(agent.role) === key) return agent.slug;
	}
	for (const agent of roster.agents) {
		if (agent.title === undefined) continue;
		if (normalizeAlias(agent.title) === key || titleSegments(agent.title).includes(key)) return agent.slug;
	}
	return undefined;
}
