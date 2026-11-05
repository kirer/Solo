/**
 * `@` 解析与「谁会被叫醒」：频道里最容易写错、也最需要单测的一段纯函数。
 *
 * 判据只有名字（slug / name / 我），没有模糊别名 —— 谁都能被 @ 到的代价是
 * 一个词撞上某人的 title 就把消息投给他（见文件末尾那段说明）。
 */
import { OWNER, type Channel, type Message } from "./types.ts";

/**
 * 从正文里解析 `@slug`。slug 允许字母、数字、中文、`-`、`_`。
 *
 * 前面不能紧跟 **ASCII** 字母数字或邮箱里会出现的符号（`._%+-`）：否则
 * `hi@example.com` 会被解析成 `@example`，一个从来不存在的 agent 就凭空多了一条
 * 唤醒记录。这个 lookbehind 是唯一让邮箱不被误认的办法 —— 事后过滤只会漏。
 *
 * 这里**不能**用 `\p{L}`：中文不写空格，「麻烦@林越」「请@我 拍板」是日常写法，
 * 排除所有字母会把最常见的写法整类漏掉（实测解析为空，漏唤醒）。
 */
const MENTION = /(?<![A-Za-z0-9._%+-])@([\p{L}\p{N}_-]+)/gu;

/**
 * 从正文里解析 `@` 名字，返回**解析后的 slug**（`@我` → `owner`，`@CEO` → 那个人）。
 *
 * 传了 `roster` 就按名册严格解析：解析不出来的 token（`@import` / `@media` / `@x`）
 * **丢弃**，因为它们在成员表里不存在，留着只是噪音。
 *
 * 不传 `roster` 时保留字面 token —— 只用于不需要投递的调用点（系统留痕）。会决定
 * 「叫醒谁」的发言一律传名册，落库的 `mentions` 因此永远是规范 slug。
 */
export function parseMentions(text: string, roster?: MentionRoster): string[] {
	const out: string[] = [];
	for (const match of text.matchAll(MENTION)) {
		const raw = match[1];
		if (raw === undefined) continue;
		const slug = roster === undefined ? raw : resolveMention(raw, roster);
		if (slug !== undefined && !out.includes(slug)) out.push(slug);
	}
	return out;
}

/**
 * 正文里有没有「@某人」这个动作（不管叫不叫得应）。
 *
 * 与 `MENTION` 用同一套字符判断（lookbehind 也一致）：邮箱里的 `hi@example.com`
 * 不算「叫了人」。
 */
const MENTION_TOKEN = /(?<![A-Za-z0-9._%+-])@[\p{L}\p{N}_-]+/u;

function hasMentionToken(text: string): boolean {
	return MENTION_TOKEN.test(text);
}

export function recipientsOf(channel: Channel, message: Message, lastSpeaker?: string): string[] {
	const targets = new Set<string>();
	const members = new Set(channel.members);

	// `mentions` 落库时已经是规范 slug（写的时候按名册解析，老数据由频道文档 v2 迁移归一）。
	// 成员过滤规则本身**不动** —— 不是这个房间的人照样 @ 不到（防止拿到别人房间的上下文）。
	for (const mention of message.mentions) {
		if (members.has(mention)) targets.add(mention);
	}
	// 「我没 @ 人」才让第一个成员接。**判据看正文里有没有 @，不看解析结果**：
	// 过名册之后 `@nobody` 会解析成空数组，若按 mentions.length 判就会把「你叫了一个
	// 不存在的人」变成「叫了房间里第一个人」—— 我会以为刚才那句没人理。
	if (message.from === OWNER && message.mentions.length === 0 && !hasMentionToken(message.text)) {
		// 接上一位说话的：我不 @ 人时叫醒**刚在说话的那个人**，而不是成员表里的第一个。
		// 这是 dsh「订阅直通」在单会话里的等价物 —— 一件事谁在办，后续就直通给他；
		// 固定第一个成员的话，我在跟成员乙聊，下一句没 @ 就掉给了成员表里的第一个人（ADR-015）。
		const previous =
			lastSpeaker !== undefined && lastSpeaker !== message.from && channel.members.includes(lastSpeaker)
				? lastSpeaker
				: undefined;
		const target = previous ?? channel.members.find((slug) => slug !== OWNER);
		if (target !== undefined) targets.add(target);
	}
	for (const slug of channel.wakeOnAll) {
		if (members.has(slug)) targets.add(slug);
	}
	targets.delete(message.from);
	return [...targets];
}

/**
 * 真正要**投递**给谁：`recipientsOf` 减去我。
 *
 * 我没有会话 —— 它是人，不是 agent。这个减法以前在三处各写一遍（投递、投递正文、
 * 独白检测），任何一处漏了，我就会出现在「这条会叫醒：」的名单里。
 */
export function deliveryTargets(channel: Channel, message: Message, lastSpeaker?: string): string[] {
	return recipientsOf(channel, message, lastSpeaker).filter((slug) => slug !== OWNER);
}

// ── `@` 解析（原 `alias.ts`）──────────────────────────────────────────────
//
// V2 有一层模糊别名：拼音、简称、身份名（`CEO`）、title 的每一段都能 @ 到人。实测它
// 确实救回了老消息里的 `@老板`，代价是「谁都能被 @ 到」—— 一个词撞上某个人的 title
// 就会把消息投给他。V3 只认三种精确写法，其余一律丢弃：
//
// 1. `slug`（目录名，唯一稳定标识）；
// 2. `name`（`identity.md` 的显示名）；
// 3. `我` / `owner` —— **必须保留**：`rules.md` 每轮都告诉模型「要让我拍板就用 `@我`」，
//    这条映射没了，拍板会静默丢失（没人被叫醒、也不报错）。
//
// 解析不出来的 token（`@import`、`@x`）丢弃：它们不是人，留着只是噪音。

/** 名册里的一个人。字段全部可选（除了 slug）：缺什么就少一种叫法。 */
export type MentionAgent = {
	/** 目录名，唯一稳定标识。 */
	readonly slug: string;
	/** `identity.md` 的 `name`（真名，例如「周砚」）。 */
	readonly name?: string | undefined;
};

/** 一份名册：我的 slug + 全员的人。 */
export type MentionRoster = {
	/** 我的 slug，正常就是 `owner`。 */
	readonly owner: string;
	readonly agents: readonly MentionAgent[];
};

/** 没有名册时的兜底：只认我。 */
export const EMPTY_ROSTER: MentionRoster = { owner: OWNER, agents: [] };

/**
 * 我的叫法。只剩两个：`owner` 是 slug，`我` 是提示词里那个写法。
 *
 * 「老大」「老板」「boss」这些是历史别名，V3 不认 —— 提示词和界面一律用「我」。
 */
const OWNER_ALIASES: readonly string[] = [OWNER, "我"];

/** 归一：去 `@`、去首尾空格、全角转半角（`ＯＷＮＥＲ` → `owner`）、转小写。 */
function normalizeAlias(raw: string): string {
	return raw
		.normalize("NFKC")
		.trim()
		.replace(/^@+/, "")
		.trim()
		.toLowerCase();
}

/** 从一份身份清单建名册。只带 `slug` 和 `name` —— 没有 role / title 匹配了。 */
export function mentionRosterOf(
	agents: readonly { readonly slug: string; readonly name?: string | undefined }[],
	owner: string = OWNER,
): MentionRoster {
	return { owner, agents: agents.map((agent) => ({ slug: agent.slug, ...(agent.name === undefined ? {} : { name: agent.name }) })) };
}

/**
 * 把 `@` 后面的字解析成 slug。纯函数，喂一份名册。
 *
 * 顺序：slug → 我 → 显示名。都匹配不上返回 `undefined`（调用方丢弃，不瞎猜）。
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
	return undefined;
}
