/**
 * 视图层的约定：**界面看到的东西，必须是文件里的事实**。
 *
 * 这一层最容易出的错不是崩溃，而是「显示得像真的、其实不是」：
 * - 团队频道显示成「3 人」，但团队管理员不在成员表里 → 成员在团队里 @ 不到拍板的人；
 * - 私聊/群聊的区分必须按成员推 —— 看 id 前缀就会把「三人小群」显示成私聊。
 *
 * 所以这里逐个断言投影的字段，而不是断言「函数没抛错」。
 */
import { describe, expect, it } from "vitest";
import { channelDetail, channelList, messageView } from "../../src/core/app/project.ts";
import type { DirectoryState } from "../../src/core/agent/roster.ts";
import type { Channel, ChannelState } from "../../src/core/channel/store.ts";

const AT = 1_700_000_000_000;

function directoryOf(labels: Record<string, string>): DirectoryState {
	const slugToConversation: Record<string, number> = { owner: 0 };
	const conversationToSlug: Record<string, string> = { "0": "owner" };
	let next = 1;
	for (const slug of Object.keys(labels)) {
		if (slug === "owner") continue;
		slugToConversation[slug] = next;
		conversationToSlug[String(next)] = slug;
		next += 1;
	}
	return { slugToConversation, conversationToSlug, wake: {}, labels };
}

function stateOf(channels: Channel[], messages: Record<string, ChannelState["messages"][string]> = {}): ChannelState {
	return {
		channels: Object.fromEntries(channels.map((channel) => [channel.id, channel])),
		messages,
		nextSeq: {},
		readMarks: {},
	};
}

const lin = { id: "dm:lin-owner", title: "林越", members: ["owner", "lin"], wakeOnAll: [], createdAt: AT };
const team = { id: "team:坦克大战", title: "坦克大战", members: ["owner", "lin", "shen"], wakeOnAll: [], createdAt: AT };

describe("侧栏预览只取人说的话", () => {
	const msg = (seq: number, from: string, kind: string, text: string) =>
		({ seq, at: AT + seq, from, kind, text, mentions: [], read: true }) as never;

	it("最新一条是命令输出时，预览仍显示前一句人话", () => {
		// 实测现场的形态：林越说了句话，然后连着几条 `work` 记的是命令行。
		// 拿最后一条当预览，侧栏整列变成 `$ cd /Users/kirer/teams/...`。
		const state = stateOf([lin], {
			[lin.id]: [
				msg(1, "lin", "say", "前端三项改完了，正在收测试。"),
				msg(2, "lin", "work", "$ cd /Users/kirer/teams/solo && npm test"),
				msg(3, "lin", "tool", "run"),
			],
		});
		const [channel] = channelList(state, directoryOf({ lin: "林越" }));
		expect(channel.preview).toBe("前端三项改完了，正在收测试。");
	});

	it("只有过程投影时退回最后一条 —— 预览不能空着", () => {
		const state = stateOf([lin], { [lin.id]: [msg(1, "lin", "work", "跑测试")] });
		const [channel] = channelList(state, directoryOf({ lin: "林越" }));
		expect(channel.preview).toBe("跑测试");
	});

	it("系统告警永远不当预览，哪怕它是最新的一条", () => {
		const state = stateOf([lin], {
			[lin.id]: [msg(1, "lin", "say", "改完了"), msg(2, "owner", "note", "接力到上限（9 次）")],
		});
		const [channel] = channelList(state, directoryOf({ lin: "林越" }));
		expect(channel.preview).toBe("改完了");
	});
});

describe("频道列表的投影", () => {
	it("恰好两个人（我 + 一个人）就是私聊，标题是对方的名字", () => {
		const state = stateOf([lin]);
		const directory = directoryOf({ lin: "林越" });
		const [channel] = channelList(state, directory);
		expect(channel.kind).toBe("dm");
		expect(channel.title).toBe("林越");
	});

	it("三人就是群聊 —— 哪怕 id 写成 dm:", () => {
		const group = { id: "dm:a-b-c", title: "小群", members: ["owner", "lin", "shen"], wakeOnAll: [], createdAt: AT };
		const state = stateOf([group]);
		const [channel] = channelList(state, directoryOf({ lin: "林越", shen: "沈舟" }));
		expect(channel.kind).toBe("group");
	});

	it("没有我的两人频道也是群聊（只看成员，不看 id）", () => {
		const pair = { id: "dm:lin-shen", title: "对接", members: ["lin", "shen"], wakeOnAll: [], createdAt: AT };
		const [channel] = channelList(stateOf([pair]), directoryOf({ lin: "林越", shen: "沈舟" }), "lin");
		expect(channel.kind).toBe("group");
	});

	it("团队频道也是群聊，但仍然带上团队管理员（来自团队文件，不是频道文档）", () => {
		const state = stateOf([team]);
		const directory = directoryOf({ lin: "林越", shen: "沈舟" });
		const [channel] = channelList(state, directory, "owner", (slug) => (slug === "坦克大战" ? "shen" : undefined));
		expect(channel.kind).toBe("group");
		expect(channel.team).toBe("坦克大战");
		expect(channel.lead).toBe("shen");
		expect(channel.leadLabel).toBe("沈舟");
	});

	it("团队频道带上一句话现状 doing（来自团队文件）", () => {
		const state = stateOf([team]);
		const [channel] = channelList(
			state,
			directoryOf({ lin: "林越", shen: "沈舟" }),
			"owner",
			() => "shen",
			(slug) => (slug === "坦克大战" ? "沈舟在改 doing 链路" : undefined),
		);
		expect(channel.doing).toBe("沈舟在改 doing 链路");
	});

	it("没有 doing 时列表里不带这个键，非团队频道也不带", () => {
		const state = stateOf([team, lin]);
		const list = channelList(state, directoryOf({ lin: "林越" }), "owner", () => undefined, () => undefined);
		expect("doing" in list[0]!).toBe(false);
		const dm = list.find((channel) => channel.kind === "dm")!;
		expect("doing" in dm).toBe(false);
	});

	it("没有团队管理员的团队不编造一个", () => {
		const state = stateOf([team]);
		const [channel] = channelList(state, directoryOf({}), "owner", () => undefined);
		expect(channel.lead).toBeUndefined();
		expect(channel.leadLabel).toBeUndefined();
	});
});

describe("频道详情的投影", () => {
	it("团队成员的角色：我 / 团队管理员 / 成员三种", () => {
		const state = stateOf([team]);
		const detail = channelDetail(state, team, directoryOf({ lin: "林越", shen: "沈舟" }), {
			teamLeadOf: (slug) => (slug === "坦克大战" ? "shen" : undefined),
		});
		const roles = Object.fromEntries(detail.members.map((member) => [member.slug, member.role]));
		expect(roles).toEqual({ owner: "owner", lin: "member", shen: "lead" });
	});

	it("详情也带出 doing；没有就不带这个键", () => {
		const state = stateOf([team]);
		const withDoing = channelDetail(state, team, directoryOf({ lin: "林越", shen: "沈舟" }), {
			teamLeadOf: () => "shen",
			teamDoingOf: () => "沈舟在改 doing 链路",
		});
		expect(withDoing.channel.doing).toBe("沈舟在改 doing 链路");
		const withoutDoing = channelDetail(state, team, directoryOf({ lin: "林越", shen: "沈舟" }), {
			teamLeadOf: () => "shen",
		});
		expect("doing" in withoutDoing.channel).toBe(false);
	});

	it("团队管理员不在成员里时，没人被标成 lead", () => {
		const unbalanced = { ...team, members: ["owner", "lin"] };
		const state = stateOf([unbalanced]);
		const detail = channelDetail(state, unbalanced, directoryOf({ lin: "林越", shen: "沈舟" }), {
			teamLeadOf: () => "shen",
		});
		expect(detail.members.some((member) => member.role === "lead")).toBe(false);
		expect(detail.channel.lead).toBe("shen");
	});
});

describe("私聊里的 @ 红点：统一按未读与 mention 算，不再按消息 kind 特判", () => {
	const AT = 1_700_000_000_000;
	function withMessages(channelId: string, msgs: { from: string; text: string; kind?: string; at?: number; mentions?: string[] }[]) {
		const base = { id: channelId, title: channelId, members: ["owner", "gu"], wakeOnAll: [], createdAt: AT };
		const messages: Record<string, any[]> = {
			[channelId]: msgs.map((m, i) => ({
				seq: i + 1,
				from: m.from,
				at: m.at ?? AT + i,
				text: m.text,
				mentions: m.mentions ?? [],
				kind: m.kind ?? "chat",
			})),
		};
		return stateOf([base], messages);
	}

	it("私聊里 @ 我照样计数（历史库里残留的过程消息不再特判）", () => {
		const state = withMessages("dm:owner-gu", [
			{ from: "gu", text: "@owner 我在群里回你了", kind: "say", mentions: ["owner"] },
		]);
		const list = channelList(state, directoryOf({ gu: "顾南雁" }), "owner");
		const dm = list.find((c) => c.id === "dm:owner-gu")!;
		expect(dm.mentions).toBe(1);
		expect(dm.unread).toBe(1);
	});

	it("群频道里的 @ 我照常计数（与 013 无关的普通场景）", () => {
		const state = withMessages("all", [
			{ from: "gu", text: "@owner 群里叫你", kind: "chat", mentions: ["owner"] },
		]);
		const list = channelList(state, directoryOf({ gu: "顾南雁" }), "owner");
		const allChannel = list.find((c) => c.id === "all")!;
		expect(allChannel.mentions).toBe(1);
	});
});
