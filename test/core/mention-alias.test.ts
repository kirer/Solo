/**
 * `@` 别名解析。
 *
 * 守的事故：库里 980 个 mention token 有 573 个（58%）是垃圾，48 条消息写了 `@我`
 * 而**没有任何人被叫醒** —— 因为成员表里存的是 slug `owner`，`@我` / `@CEO` /
 * 真名在 `recipientsOf` 的成员过滤里被静默丢弃。
 */
import { describe, expect, test } from "vitest";
import { ChannelDoc, OWNER, type ChannelState } from "../../src/core/channel/types.ts";
import { EMPTY_ROSTER, mentionRosterOf, parseMentions, recipientsOf, resolveMention, type MentionAgent } from "../../src/core/channel/mentions.ts";
import { appendMessage, ensureChannel, speakerBefore } from "../../src/core/channel/rules.ts";

/** 一份贴近真实的名册：`members/` 里那几个人的头字段。 */
const people: readonly MentionAgent[] = [
	{ slug: "知言", name: "知言", title: "负责人", manager: OWNER },
	{ slug: "顾南雁", name: "顾南雁", title: "平台负责人", manager: "知言" },
	{ slug: "周砚", name: "周砚", title: "平台功能开发 / 修 bug", manager: "顾南雁" },
	{ slug: "林越", name: "林越", title: "团队管理员（小恐龙）", manager: "知言" },
];

const roster = mentionRosterOf(people);

function empty(): ChannelState {
	return { channels: {}, messages: {}, nextSeq: {}, readMarks: {} };
}

function channelWith(members: string[]): ChannelState {
	return ensureChannel(empty(), { id: "all", title: "全员", members, at: 1 });
}

describe("resolveMention：我", () => {
	test("owner / 我 指向我；历史别名 BOSS / boss / YOU 不认了", () => {
		for (const raw of ["owner", "我", " @我 ", "ＯＷＮＥＲ"]) {
			expect(resolveMention(raw, roster), raw).toBe(OWNER);
		}
		// V3 收窄到精确匹配：提示词和界面一律写「我」，不再猜历史叫法。
		for (const raw of ["BOSS", "boss", "YOU", "老板", "老大"]) {
			expect(resolveMention(raw, roster), raw).toBeUndefined();
		}
	});

	test("没有名册也能认出我（老数据里的 @我 靠这条复活）", () => {
		expect(resolveMention("我")).toBe(OWNER);
		expect(resolveMention("@我")).toBe(OWNER);
	});
});

describe("resolveMention：成员", () => {
	test("slug 本身", () => {
		expect(resolveMention("顾南雁", roster)).toBe("顾南雁");
	});

	test("身份名 / title / 拼音 都不认：V3 只认 slug 和显示名", () => {
		for (const raw of ["ceo", "CEO", "ＣＥＯ", "平台负责人", "平台功能开发", "xiangmu", "修"]) {
			expect(resolveMention(raw, roster), raw).toBeUndefined();
		}
	});

	test("真名", () => {
		expect(resolveMention("@知言", roster)).toBe("知言");
		expect(resolveMention(" 周砚 ", roster)).toBe("周砚");
	});


	test("找不到就是找不到，不瞎猜", () => {
		expect(resolveMention("@不存在的人", roster)).toBeUndefined();
		expect(resolveMention("", roster)).toBeUndefined();
	});
});

describe("parseMentions：垃圾 token 不再进 mentions", () => {
	test("@我 → owner；@CEO 这种身份名不认，直接丢弃", () => {
		expect(parseMentions("@我 看一下 @CEO 的活", roster)).toEqual([OWNER]);
	});

	test("解析到同一个人的两种叫法只算一次", () => {
		expect(parseMentions("@我 @owner BOSS", roster)).toEqual([OWNER]);
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

describe("频道文档 v2 迁移：老数据归一到两种 kind + 规范 slug", () => {
	test("旧 kind 归一；字面「我」归一成 owner", () => {
		const legacy = {
			channels: {},
			messages: {
				all: [
					{ seq: 1, from: "知言", at: 1, text: "@我 这件事要你定", mentions: ["我"], kind: "say" },
					{ seq: 2, from: "知言", at: 2, text: "跑测试", mentions: [], kind: "work" },
				],
			},
			nextSeq: { all: 3 },
			readMarks: {},
		};
		const migrated = ChannelDoc.definition.migrate?.(legacy, 1) as ChannelState;
		expect(migrated.messages.all?.map((message) => message.kind)).toEqual(["chat", "note"]);
		expect(migrated.messages.all?.[0]?.mentions).toEqual([OWNER]);
	});
});

describe("recipientsOf", () => {
	test("写带名册的 @ 时，落库就是规范 slug", () => {
		const state = channelWith([OWNER, "知言"]);
		const { message } = appendMessage(state, "all", {
			from: "知言",
			text: "@我 要不要加联机",
			at: 1,
			roster,
		});
		expect(message.mentions).toEqual([OWNER]);
		expect(message.text).toContain("@我"); // 正文原样保留：那是模型的嘴
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

describe("团队频道：@ 了谁就只叫谁，没人 @ 才到助理", () => {
	/** 团队频道：成员 = 我 + 助理 + 干活的人；`wakeOnAll` 只有助理。 */
	const team = () =>
		ensureChannel(empty(), {
			id: "team:小恐龙",
			title: "小恐龙",
			members: [OWNER, "知言", "林越"],
			wakeOnAll: ["知言"],
			at: 1,
		});
	const say = (state: ChannelState, text: string, from: string = OWNER) =>
		appendMessage(state, "team:小恐龙", { from, text, at: 1, roster }).message;
	const channelOf = (state: ChannelState) => state.channels["team:小恐龙"]!;

	test("@林越：只有林越，助理不插话（哪怕它总在听）", () => {
		const state = team();
		const message = say(state, "@林越 创建团队技能，随便做点儿什么");
		expect(message.mentions).toEqual(["林越"]);
		expect(recipientsOf(channelOf(state), message, "知言")).toEqual(["林越"]);
	});

	test("不 @ 人：只叫助理，不再叫上一位说话的", () => {
		const state = team();
		const message = say(state, "团队记录下，以后运行都使用 8000 端口。");
		expect(recipientsOf(channelOf(state), message, "林越")).toEqual(["知言"]);
	});

	test("成员不 @ 人说完一句：回到助理（它决定要不要转给谁）", () => {
		const state = team();
		const message = say(state, "做好了，地址是 192.168.1.71:8000", "林越");
		expect(recipientsOf(channelOf(state), message)).toEqual(["知言"]);
	});
});

describe("我（我的称呼）", () => {
	test("@我 解析成 owner，@我 也还认", () => {
		expect(resolveMention("@我", EMPTY_ROSTER)).toBe("owner");
		expect(resolveMention("我", EMPTY_ROSTER)).toBe("owner");
		expect(resolveMention("@我", EMPTY_ROSTER)).toBe("owner");
	});
});

describe("我自己发的话也过名册", () => {
	test("`@我` 落库时解析成 owner，而不是留成字面 token", () => {
		const state = ensureChannel(empty(), { id: "g", title: "群", members: [OWNER, "知言"], at: 1 });
		const { message } = appendMessage(state, "g", {
			from: OWNER,
			text: "@我 在吗",
			at: 1,
			roster: mentionRosterOf(people),
		});
		// 我 @ 自己会被收件人过滤掉，但 mentions 里必须已经是 slug，界面才画得出「谁被叫了」。
		expect(message.mentions).not.toContain("我");
		expect(parseMentions(message.text, mentionRosterOf(people))).toContain("owner");
	});
});

describe("我在跟谁说话（ADR-015）", () => {
	/** 我说一句，知言先接、顾南雁也接了。 */
	function conversation(): { state: ChannelState; seq: number } {
		let state = ensureChannel(empty(), { id: "all", title: "全员", members: [OWNER, "知言", "顾南雁"], at: 1 });
		state = appendMessage(state, "all", { from: OWNER, text: "接口先按 v1 做", at: 1 }).state;
		state = appendMessage(state, "all", { from: "知言", text: "好，我改", at: 2 }).state;
		const third = appendMessage(state, "all", { from: "顾南雁", text: "v1 我这边能接", at: 3 });
		return { state: third.state, seq: third.message.seq + 1 };
	}

	test("我不 @ 人时，叫醒的是**接我上一句话的那个人**，不是最后一个说话的", () => {
		const { state, seq } = conversation();
		const { message } = appendMessage(state, "all", { from: OWNER, text: "那就这么定", at: 4 });
		const speaker = speakerBefore(state, "all", seq);
		expect(speaker).toBe("知言");
		expect(recipientsOf(state.channels.all!, message, speaker)).toEqual(["知言"]);
		// 不给这条线索时退回老行为：第一个非我的成员。
		expect(recipientsOf(state.channels.all!, message)).toEqual(["知言"]);
	});

	test("中间夹一条沉淀报告（别的 agent 发的 report）也不改判：还是先接我话的那个人", () => {
		let state = ensureChannel(empty(), { id: "all", title: "全员", members: [OWNER, "知言", "顾南雁"], at: 1 });
		state = appendMessage(state, "all", { from: OWNER, text: "@顾南雁 改一下", at: 1 }).state;
		state = appendMessage(state, "all", { from: "顾南雁", text: "改完了", at: 2 }).state;
		// 真实服务里这一条就是团队管理员的沉淀报告，它挡在中间。
		state = appendMessage(state, "all", { from: "知言", text: "记了一条：……", at: 3, kind: "chat" }).state;
		const { message } = appendMessage(state, "all", { from: OWNER, text: "接着说", at: 4 });
		expect(speakerBefore(state, "all", message.seq)).toBe("顾南雁");
	});

	test("系统留痕不算接话", () => {
		let state = ensureChannel(empty(), { id: "all", title: "全员", members: [OWNER, "知言"], at: 1 });
		state = appendMessage(state, "all", { from: OWNER, text: "在吗", at: 1 }).state;
		state = appendMessage(state, "all", { from: "知言", text: "#1 没答上来", at: 2, kind: "note" }).state;
		const { message } = appendMessage(state, "all", { from: OWNER, text: "再看一眼", at: 3 });
		expect(speakerBefore(state, "all", message.seq)).toBeUndefined();
	});

	test("我还没说过话 / 紧接着是我自己 → 不算接谁的话，退回第一个成员", () => {
		let state = ensureChannel(empty(), { id: "all", title: "全员", members: [OWNER, "知言", "顾南雁"], at: 1 });
		state = appendMessage(state, "all", { from: "顾南雁", text: "做完了", at: 1 }).state;
		state = appendMessage(state, "all", { from: OWNER, text: "好", at: 2 }).state;
		const { message } = appendMessage(state, "all", { from: OWNER, text: "再看一下这个", at: 3 });
		expect(speakerBefore(state, "all", message.seq)).toBeUndefined();
		expect(recipientsOf(state.channels.all!, message, undefined)).toEqual(["知言"]);
	});

	test("接我话的人不在这个频道里就不算（换过成员的老频道）", () => {
		const { state } = conversation();
		const { message } = appendMessage(state, "all", { from: OWNER, text: "在吗", at: 4 });
		expect(recipientsOf(state.channels.all!, message, "周砚")).toEqual(["知言"]);
	});
});
