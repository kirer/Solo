/**
 * 频道自己的接话规则（`Channel.responder`）。
 *
 * 守两件事：**不写规则时行为逐字节不变**（老的团队 / 全员频道一个字都不用改），
 * 以及 `@` 永远优先于规则 —— 规则只回答「没人 @ 时谁接」。
 */
import { describe, expect, test } from "vitest";
import { OWNER, type ChannelResponder, type ChannelState } from "../../src/core/channel/types.ts";
import { deliveryTargets, recipientsOf } from "../../src/core/channel/mentions.ts";
import { appendMessage, ensureChannel, speakerBefore } from "../../src/core/channel/rules.ts";

const roster = { owner: OWNER, agents: [{ slug: "知言", name: "知言" }, { slug: "林越", name: "林越" }] };

function empty(): ChannelState {
	return { channels: {}, messages: {}, nextSeq: {}, readMarks: {} };
}

/** 一个团队频道：成员 = 我 + 助理 + 干活的人；`wakeOnAll` 只有助理。 */
function team(): ChannelState {
	return ensureChannel(empty(), {
		id: "team:小恐龙",
		title: "小恐龙",
		members: [OWNER, "知言", "林越"],
		wakeOnAll: ["知言"],
		at: 1,
	});
}

function withResponder(state: ChannelState, id: string, responder: ChannelResponder): ChannelState {
	return { ...state, channels: { ...state.channels, [id]: { ...state.channels[id]!, responder } } };
}

function say(state: ChannelState, text: string, from: string = OWNER) {
	return appendMessage(state, "team:小恐龙", { from, text, at: 1, roster }).message;
}

function channelOf(state: ChannelState) {
	return state.channels["team:小恐龙"]!;
}

describe("没写规则：行为不变", () => {
	test("团队频道没人 @ → 助理；@ 了谁 → 只叫谁", () => {
		const state = team();
		expect(recipientsOf(channelOf(state), say(state, "记一下：以后用 8000 端口"), "林越")).toEqual(["知言"]);
		expect(recipientsOf(channelOf(state), say(state, "@林越 改一下端口"), "知言")).toEqual(["林越"]);
	});

	test("全员频道没人 @ → 接上一位说话的", () => {
		const all = ensureChannel(empty(), { id: "all", title: "全员", members: [OWNER, "知言", "林越"], at: 1 });
		const message = appendMessage(all, "all", { from: OWNER, text: "继续", at: 1, roster }).message;
		expect(recipientsOf(all.channels.all!, message, "林越")).toEqual(["林越"]);
	});
});

describe("mentions：没人 @ 就没人接", () => {
	test("我不 @ 人时什么都不叫；@ 了人照旧只叫被点名的", () => {
		const state = withResponder(team(), "team:小恐龙", { kind: "mentions" });
		expect(recipientsOf(channelOf(state), say(state, "大家看一下"))).toEqual([]);
		expect(recipientsOf(channelOf(state), say(state, "@知言 看一下"))).toEqual(["知言"]);
	});

	test("写了 @nobody（解析不出人）不落给规则：那是我叫错人了", () => {
		// 规则是 lead=林越；正文里有 @ 动作、却解析不出人 —— 走老路（团队频道叫助理），
		// 而不是「既然没人 @ 就交给林越」。否则我会以为刚才那句没人理，其实是被悄悄转走了。
		const state = withResponder(team(), "team:小恐龙", { kind: "lead", slug: "林越" });
		const message = say(state, "@不存在的人 在吗");
		expect(message.mentions).toEqual([]);
		expect(recipientsOf(channelOf(state), message)).toEqual(["知言"]);
	});
});

describe("everyone：房间里的人都接", () => {
	test("除发件人和我之外都叫；投递时把我减掉", () => {
		const state = withResponder(team(), "team:小恐龙", { kind: "everyone" });
		const message = say(state, "对一下方案", "林越");
		expect(recipientsOf(channelOf(state), message).sort()).toEqual([OWNER, "知言"].sort());
		expect(deliveryTargets(channelOf(state), message).sort()).toEqual(["知言"]);
	});
});

describe("lead：固定一个人接", () => {
	test("只叫他；@ 别人时仍然听 @ 的", () => {
		const state = withResponder(team(), "team:小恐龙", { kind: "lead", slug: "林越" });
		expect(recipientsOf(channelOf(state), say(state, "看一下"))).toEqual(["林越"]);
		expect(recipientsOf(channelOf(state), say(state, "@知言 你来做"))).toEqual(["知言"]);
	});

	test("lead 已经不在房间里：谁都不叫，不拿第一个人顶上", () => {
		const state = withResponder(team(), "team:小恐龙", { kind: "lead", slug: "周砚" });
		expect(recipientsOf(channelOf(state), say(state, "看一下"))).toEqual([]);
	});

	test("lead 就是发件人：不叫他自己", () => {
		const state = withResponder(team(), "team:小恐龙", { kind: "lead", slug: "林越" });
		expect(recipientsOf(channelOf(state), say(state, "我自己说一句", "林越"))).toEqual([]);
	});
});

describe("规则只回答「没人 @」：`speakerBefore` 不参与", () => {
	test("全员频道 + everyone 不会退化成「只有上一位」", () => {
		const all = ensureChannel(empty(), { id: "all", title: "全员", members: [OWNER, "知言", "林越"], at: 1 });
		const state = withResponder(all, "all", { kind: "everyone" });
		const message = appendMessage(state, "all", { from: OWNER, text: "都说说", at: 1, roster }).message;
		const last = speakerBefore(state, "all", message.seq);
		expect(recipientsOf(state.channels.all!, message, last).sort()).toEqual(["知言", "林越"].sort());
	});
});
