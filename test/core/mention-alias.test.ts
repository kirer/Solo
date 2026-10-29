/**
 * `@` 别名解析。
 *
 * 守的事故：库里 980 个 mention token 有 573 个（58%）是垃圾，48 条消息写了 `@老板`
 * 而**没有任何人被叫醒** —— 因为成员表里存的是 slug `owner`，`@老板` / `@CEO` /
 * 真名在 `recipientsOf` 的成员过滤里被静默丢弃。
 */
import { describe, expect, test } from "vitest";
import { EMPTY_ROSTER, mentionRosterOf, resolveMention, type MentionAgent } from "../../src/core/channel/alias.ts";
import {
	OWNER,
	appendMessage,
	ensureChannel,
	parseMentions,
	recipientsOf,
	type ChannelState,
} from "../../src/core/channel/state.ts";

/** 一份贴近真实的名册：`workspace/agents/` 里那几个人的头字段。 */
const people: readonly MentionAgent[] = [
	{ slug: "知言", name: "知言", title: "负责人", manager: OWNER },
	{ slug: "顾南雁", name: "顾南雁", title: "平台负责人", manager: "知言" },
	{ slug: "周砚", name: "周砚", title: "平台功能开发 / 修 bug", manager: "顾南雁" },
	{ slug: "林越", name: "林越", title: "项目负责人（小恐龙）", manager: "知言" },
];

const roster = mentionRosterOf(people);

function empty(): ChannelState {
	return { channels: {}, messages: {}, nextSeq: {}, readMarks: {} };
}

function channelWith(members: string[]): ChannelState {
	return ensureChannel(empty(), { id: "all", title: "公司", members, at: 1 });
}

describe("resolveMention：老板", () => {
	test("owner / 老板 / BOSS / 我 / YOU 都指向老板", () => {
		for (const raw of ["owner", "老板", "BOSS", " boss ", "我", "YOU", "@老板"]) {
			expect(resolveMention(raw, roster), raw).toBe(OWNER);
		}
	});

	test("没有名册也能认出老板（老数据里的 @老板 靠这条复活）", () => {
		expect(resolveMention("老板")).toBe(OWNER);
		expect(resolveMention("@老板")).toBe(OWNER);
	});
});

describe("resolveMention：同事", () => {
	test("slug 本身", () => {
		expect(resolveMention("顾南雁", roster)).toBe("顾南雁");
	});

	test("岗位名大小写 / 全半角不敏感", () => {
		// 直属老板的人就是 ceo（见 mentionRosterOf 的推导）。
		for (const raw of ["ceo", "CEO", "ＣＥＯ", "@Ceo"]) {
			expect(resolveMention(raw, roster), raw).toBe("知言");
		}
	});

	test("真名", () => {
		expect(resolveMention("@知言", roster)).toBe("知言");
		expect(resolveMention(" 周砚 ", roster)).toBe("周砚");
	});

	test("title 整串，或其中一段", () => {
		expect(resolveMention("@平台负责人", roster)).toBe("顾南雁");
		expect(resolveMention("@平台功能开发", roster)).toBe("周砚");
		expect(resolveMention("@修", roster)).toBe("周砚");
	});

	test("找不到就是找不到，不瞎猜", () => {
		expect(resolveMention("@不存在的人", roster)).toBeUndefined();
		expect(resolveMention("", roster)).toBeUndefined();
	});
});

describe("parseMentions：垃圾 token 不再进 mentions", () => {
	test("@老板 → owner，@CEO → 那个人", () => {
		expect(parseMentions("@老板 看一下 @CEO 的活", roster)).toEqual([OWNER, "知言"]);
	});

	test("解析到同一个人的两种叫法只算一次", () => {
		expect(parseMentions("@老板 @owner BOSS", roster)).toEqual([OWNER]);
	});

	test("@media / @import / 邮箱 / 代码里的 @x 都不是人", () => {
		const text = "import x from '@media'; a@b.com `@x` @import @media";
		expect(parseMentions(text, roster)).toEqual([]);
	});

	test("不传名册时保留旧行为（字面 token），老调用点不被打穿", () => {
		expect(parseMentions("@cto 看一下 @林越 的活")).toEqual(["cto", "林越"]);
		expect(parseMentions("hi@example.com 你好 @ 没有名字")).toEqual([]);
	});
});

describe("recipientsOf：老数据兜底", () => {
	test("成员表里是 owner，老消息里存的是「老板」→ 老板被叫醒", () => {
		const state = channelWith([OWNER, "知言"]);
		const { message } = appendMessage(state, "all", {
			from: "知言",
			text: "@老板 这件事要你定",
			at: 1,
		});
		// 这条模拟老数据：mentions 里存的是字面 token。
		const legacy = { ...message, mentions: ["老板"] };
		expect(recipientsOf(state.channels.all!, legacy)).toEqual([OWNER]);
	});

	test("写带名册的 @ 时，落库就是规范 slug", () => {
		const state = channelWith([OWNER, "知言"]);
		const { message } = appendMessage(state, "all", {
			from: "知言",
			text: "@老板 要不要加联机",
			at: 1,
			roster,
		});
		expect(message.mentions).toEqual([OWNER]);
		expect(message.text).toContain("@老板"); // 正文原样保留：那是模型的嘴
		expect(recipientsOf(state.channels.all!, message)).toEqual([OWNER]);
	});

	test("名册里没有的人写了也不叫醒（成员过滤规则不动）", () => {
		const state = channelWith([OWNER, "知言"]);
		const { message } = appendMessage(state, "all", {
			from: "知言",
			text: "@不存在的人 你好",
			at: 1,
			roster,
		});
		expect(recipientsOf(state.channels.all!, message)).toEqual([]);
	});
});

describe("老大（老板的称呼）", () => {
	test("@老大 解析成 owner，@老板 也还认", () => {
		expect(resolveMention("@老大", EMPTY_ROSTER)).toBe("owner");
		expect(resolveMention("老大", EMPTY_ROSTER)).toBe("owner");
		expect(resolveMention("@老板", EMPTY_ROSTER)).toBe("owner");
	});
});
