/**
 * 频道的纯规则测试。
 *
 * 这些函数决定「谁会醒」，是整套系统里最容易写错的一段，所以规则逐条测。
 */
import { describe, expect, test } from "vitest";
import {
	OWNER,
	appendMessage,
	channelsOf,
	dmId,
	ensureChannel,
	markRead,
	parseMentions,
	projectId,
	recipientsOf,
	tail,
	unreadCount,
	type ChannelState,
} from "../../src/core/channel/state.ts";

function empty(): ChannelState {
	return { channels: {}, messages: {}, nextSeq: {}, readMarks: {} };
}

function withChannels(...channels: Parameters<typeof ensureChannel>[1][]): ChannelState {
	return channels.reduce((state, input) => ensureChannel(state, input), empty());
}

describe("@ 解析", () => {
	test("只认 slug 字符，中文可以", () => {
		expect(parseMentions("@cto 看一下 @林越 的活")).toEqual(["cto", "林越"]);
	});
	test("去重、保序", () => {
		expect(parseMentions("@a @b @a")).toEqual(["a", "b"]);
	});
	test("邮箱与裸 @ 不算", () => {
		expect(parseMentions("hi@example.com 你好 @ 没有名字")).toEqual([]);
	});
});

describe("频道 id", () => {
	test("私聊与双方顺序无关", () => {
		expect(dmId("cto", "owner")).toBe("dm:cto-owner");
		expect(dmId("owner", "cto")).toBe("dm:cto-owner");
	});
	test("项目频道", () => {
		expect(projectId("alpha")).toBe("proj:alpha");
	});
});

describe("收件人规则", () => {
	const channel = {
		id: "general",
		title: "全员",
		members: ["owner", "cto", "cfo"],
		wakeOnAll: [] as string[],
		createdAt: 1,
	};

	test("@ 到谁就叫醒谁", () => {
		const state = withChannels({ ...channel, id: "x" });
		const { message } = appendMessage(state, "x", { from: "cto", text: "@cfo 看下账", at: 1 });
		expect(recipientsOf(state.channels.x!, message)).toEqual(["cfo"]);
	});

	test("@ 一个不在这个房间的人无效", () => {
		const state = withChannels(channel);
		const { message } = appendMessage(state, "general", { from: "cto", text: "@stranger 你好", at: 1 });
		expect(recipientsOf(state.channels.general!, message)).toEqual([]);
	});

	test("老板不 @ 时叫醒第一个非老板成员", () => {
		const state = withChannels(channel);
		const { message } = appendMessage(state, "general", { from: OWNER, text: "有人吗", at: 1 });
		expect(recipientsOf(state.channels.general!, message)).toEqual(["cto"]);
	});

	test("非老板不 @ 时谁也不叫醒", () => {
		const state = withChannels(channel);
		const { message } = appendMessage(state, "general", { from: "cfo", text: "记录一下", at: 1 });
		expect(recipientsOf(state.channels.general!, message)).toEqual([]);
	});

	test("wakeOnAll 让私聊双方都醒（除了发件人）", () => {
		const state = withChannels({
			id: dmId("owner", "cto"),
			title: "私聊",
			members: ["owner", "cto"],
			wakeOnAll: ["owner", "cto"],
			at: 1,
		});
		const id = dmId("owner", "cto");
		const { message } = appendMessage(state, id, { from: "cto", text: "好了", at: 1 });
		expect(recipientsOf(state.channels[id]!, message)).toEqual(["owner"]);
	});

	test("发件人自己永远不在收件人里", () => {
		const state = withChannels({ ...channel, wakeOnAll: ["cto", "cfo"] });
		const { message } = appendMessage(state, "general", { from: "cto", text: "@cto 自言自语", at: 1 });
		expect(recipientsOf(state.channels.general!, message)).toEqual(["cfo"]);
	});
});

describe("引用回复", () => {
	test("引用等于 @ 作者", () => {
		let state = withChannels({
			id: "general",
			title: "全员",
			members: ["owner", "cto", "cfo"],
			wakeOnAll: [],
			at: 1,
		});
		const first = appendMessage(state, "general", { from: "cto", text: "我做完了", at: 1 });
		state = first.state;
		const second = appendMessage(state, "general", {
			from: "cfo",
			text: "收到",
			at: 2,
			replyTo: first.message.seq,
		});
		expect(second.message.mentions).toContain("cto");
		expect(recipientsOf(second.state.channels.general!, second.message)).toEqual(["cto"]);
	});

	test("引用自己不会把自己加进收件人", () => {
		let state = withChannels({
			id: "general",
			title: "全员",
			members: ["owner", "cto"],
			wakeOnAll: [],
			at: 1,
		});
		const first = appendMessage(state, "general", { from: "cto", text: "A", at: 1 });
		state = first.state;
		const second = appendMessage(state, "general", {
			from: "cto",
			text: "B",
			at: 2,
			replyTo: first.message.seq,
		});
		expect(second.message.mentions).toEqual([]);
	});

	test("引用一条不存在的 seq 时忽略", () => {
		const state = withChannels({
			id: "general",
			title: "全员",
			members: ["owner", "cto"],
			wakeOnAll: [],
			at: 1,
		});
		const { message } = appendMessage(state, "general", { from: "cto", text: "x", at: 1, replyTo: 99 });
		expect(message.mentions).toEqual([]);
		expect(message.replyTo).toBe(99);
	});
});

describe("未读与已读", () => {
	test("未读只算别人发的、且非 note", () => {
		let state = withChannels({ id: "general", title: "t", members: ["owner", "cto"], wakeOnAll: [], at: 1 });
		state = appendMessage(state, "general", { from: "owner", text: "1", at: 1 }).state;
		state = appendMessage(state, "general", { from: "owner", text: "2", at: 2 }).state;
		state = appendMessage(state, "general", { from: "cto", text: "3", at: 3 }).state;
		state = appendMessage(state, "general", { from: "owner", text: "留痕", at: 4, kind: "note" }).state;
		expect(unreadCount(state, "general", "cto")).toBe(2);
	});

	test("已读位置只前进不后退", () => {
		let state = withChannels({ id: "general", title: "t", members: ["cto"], wakeOnAll: [], at: 1 });
		state = markRead(state, "cto", "general", 5);
		state = markRead(state, "cto", "general", 3);
		expect(unreadCount(state, "general", "x")).toBe(0);
		expect(tail(state, "general", 10)).toEqual([]);
	});

	test("tail 取最近 N 条，老的在前", () => {
		let state = withChannels({ id: "g", title: "t", members: ["a"], wakeOnAll: [], at: 1 });
		for (let i = 0; i < 5; i += 1) {
			state = appendMessage(state, "g", { from: "a", text: `m${i}`, at: i }).state;
		}
		expect(tail(state, "g", 2).map((item) => item.text)).toEqual(["m3", "m4"]);
	});
});

describe("可见性", () => {
	test("只返回自己所在且未归档的频道", () => {
		const state = withChannels(
			{ id: "a", title: "A", members: ["cto"], wakeOnAll: [], at: 1 },
			{ id: "b", title: "B", members: ["cfo"], wakeOnAll: [], at: 2 },
		);
		expect(channelsOf(state, "cto").map((item) => item.id)).toEqual(["a"]);
	});

	test("建频道幂等", () => {
		const state = withChannels({ id: "a", title: "旧", members: ["cto"], wakeOnAll: [], at: 1 });
		const again = ensureChannel(state, { id: "a", title: "新", members: ["cfo"], at: 2 });
		expect(again.channels.a?.title).toBe("旧");
	});
});

describe("这一轮从什么时候开始（ADR-072）", () => {
	test("startedAt 原样落库；不传就不写这个键", () => {
		const state = withChannels({ id: "g", title: "t", members: ["a"], wakeOnAll: [], at: 1 });
		const withHint = appendMessage(state, "g", {
			from: "a",
			text: "开始处理…",
			at: 5_000,
			status: "pending",
			processing: true,
			startedAt: 3_000,
		}).message;
		expect(withHint.startedAt).toBe(3_000);
		const plain = appendMessage(state, "g", { from: "a", text: "普通", at: 6 }).message;
		// 「没有」和「0」是两件事：键不存在，界面才会退回第一条过程行的 at。
		expect("startedAt" in plain).toBe(false);
	});
});
