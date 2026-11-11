/**
 * 视图层的约定：**界面看到的东西，必须是文件里的事实**。
 *
 * 这一层最容易出的错不是崩溃，而是「显示得像真的、其实不是」：
 * - 团队频道显示成「3 人」，但成员表里没有助理 → 成员在团队里 @ 不到人；
 * - 私聊/群聊的区分必须按成员推 —— 看 id 前缀就会把「三人小群」显示成私聊。
 *
 * 所以这里逐个断言投影的字段，而不是断言「函数没抛错」。
 */
import { describe, expect, it } from "vitest";
import { channelDetail, channelList, messageView } from "../../src/app/project.ts";
import type { DirectoryState } from "../../src/core/channel/roster.ts";
import type { Channel, ChannelState } from "../../src/core/channel/types.ts";

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
	const msg = (seq: number, from: string, kind: "chat" | "note", text: string) =>
		({ seq, at: AT + seq, from, kind, text, mentions: [], read: true }) as never;

	it("最新一条是命令输出时，预览仍显示前一句人话", () => {
		// 实测现场的形态：林越说了句话，然后连着几条留痕记的是命令行。
		// 拿最后一条当预览，侧栏整列变成 `$ cd /Users/kirer/teams/...`。
		const state = stateOf([lin], {
			[lin.id]: [
				msg(1, "lin", "chat", "前端三项改完了，正在收测试。"),
				msg(2, "lin", "note", "$ cd /Users/kirer/teams/solo && npm test"),
				msg(3, "lin", "note", "run"),
			],
		});
		const [channel] = channelList(state, directoryOf({ lin: "林越" }));
		expect(channel.preview).toBe("前端三项改完了，正在收测试。");
	});

	it("只有留痕时没有预览 —— 机器输出不是人话", () => {
		const state = stateOf([lin], { [lin.id]: [msg(1, "lin", "note", "跑测试")] });
		const [channel] = channelList(state, directoryOf({ lin: "林越" }));
		expect(channel.preview).toBe("");
	});

	it("系统告警永远不当预览，哪怕它是最新的一条", () => {
		const state = stateOf([lin], {
			[lin.id]: [msg(1, "lin", "chat", "改完了"), msg(2, "owner", "note", "接力到上限（9 次）")],
		});
		const [channel] = channelList(state, directoryOf({ lin: "林越" }));
		expect(channel.preview).toBe("改完了");
	});

	it("投影只认两种 kind：chat 是发言，note 是留痕", () => {
		const directory = directoryOf({ lin: "林越" });
		const viewOf = (kind: "chat" | "note") => {
			const message = msg(1, "lin", kind, "一句话");
			return messageView(stateOf([lin], { [lin.id]: [message] }), lin, message, directory);
		};
		expect(viewOf("chat").kind).toBe("chat");
		expect(viewOf("note").kind).toBe("note");
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

	it("团队频道也是群聊，并带上团队 slug", () => {
		const state = stateOf([team]);
		const directory = directoryOf({ lin: "林越", shen: "沈舟" });
		const [channel] = channelList(state, directory, "owner");
		expect(channel.kind).toBe("group");
		expect(channel.team).toBe("坦克大战");
	});

	it("团队频道带上一句话现状 doing（来自团队文件）", () => {
		const state = stateOf([team]);
		const [channel] = channelList(
			state,
			directoryOf({ lin: "林越", shen: "沈舟" }),
			"owner",
			(slug) => (slug === "坦克大战" ? "沈舟在改 doing 链路" : undefined),
		);
		expect(channel.doing).toBe("沈舟在改 doing 链路");
	});

	it("没有 doing 时列表里不带这个键，非团队频道也不带", () => {
		const state = stateOf([team, lin]);
		const list = channelList(state, directoryOf({ lin: "林越" }), "owner", () => undefined);
		expect("doing" in list[0]!).toBe(false);
		const dm = list.find((channel) => channel.kind === "dm")!;
		expect("doing" in dm).toBe(false);
	});

	it("没有 doing 的团队不编造一个", () => {
		const state = stateOf([team]);
		const [channel] = channelList(state, directoryOf({}), "owner", () => undefined);
		expect("doing" in channel).toBe(false);
	});
});

describe("频道详情的投影", () => {
	it("团队成员的角色：我 / 助理 / 成员三种", () => {
		const state = stateOf([team]);
		const detail = channelDetail(state, team, directoryOf({ lin: "林越", shen: "沈舟" }), {
			assistants: ["shen"],
		});
		const roles = Object.fromEntries(detail.members.map((member) => [member.slug, member.role]));
		expect(roles).toEqual({ owner: "owner", lin: "member", shen: "assistant" });
	});

	it("详情也带出 doing；没有就不带这个键", () => {
		const state = stateOf([team]);
		const withDoing = channelDetail(state, team, directoryOf({ lin: "林越", shen: "沈舟" }), {
			teamDoingOf: () => "沈舟在改 doing 链路",
		});
		expect(withDoing.channel.doing).toBe("沈舟在改 doing 链路");
		const withoutDoing = channelDetail(state, team, directoryOf({ lin: "林越", shen: "沈舟" }), {});
		expect("doing" in withoutDoing.channel).toBe(false);
	});

	it("助理不在成员里时，没人被标成助理", () => {
		const unbalanced = { ...team, members: ["owner", "lin"] };
		const state = stateOf([unbalanced]);
		const detail = channelDetail(state, unbalanced, directoryOf({ lin: "林越", shen: "沈舟" }), {
			assistants: ["shen"],
		});
		expect(detail.members.some((member) => member.role === "assistant")).toBe(false);
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
			{ from: "gu", text: "@owner 我在群里回你了", kind: "chat", mentions: ["owner"] },
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

describe("按 seq 取一页（`around`）", () => {
	// 5000 条的频道：界面上只留最近几十条，老的那条在内存里但不在当前窗口。
	const many = Array.from({ length: 5000 }, (_, index) => ({
		seq: index + 1,
		at: AT + index,
		from: "lin",
		kind: "chat" as const,
		text: `第 ${String(index + 1)} 条`,
		mentions: [],
		read: true,
	}));

	it("目标在那一页中间，两边都带上下文", () => {
		const state = stateOf([team], { [team.id]: many as never });
		const detail = channelDetail(state, team, directoryOf({ lin: "林越" }), { around: 100, limit: 60 });
		const seqs = detail.messages.map((message) => message.seq);
		expect(seqs).toContain(100);
		expect(seqs).toHaveLength(60);
		// 60 条，目标在第 31 条附近 —— 上下各约半页。
		const at = seqs.indexOf(100);
		expect(at).toBeGreaterThan(25);
		expect(at).toBeLessThan(35);
		// 千万不要把整个频道搬回来：5000 条的频道，默认只给一页。
		expect(detail.messages.length).toBeLessThanOrEqual(60);
	});

	it("目标在最前 / 最后也不越界", () => {
		const state = stateOf([team], { [team.id]: many as never });
		const head = channelDetail(state, team, directoryOf({ lin: "林越" }), { around: 1, limit: 60 });
		expect(head.messages[0]?.seq).toBe(1);
		expect(head.messages).toHaveLength(60);
		expect(head.hasMoreAbove).toBe(false);
		const tail = channelDetail(state, team, directoryOf({ lin: "林越" }), { around: 5000, limit: 60 });
		expect(tail.messages[tail.messages.length - 1]?.seq).toBe(5000);
		expect(tail.messages).toHaveLength(60);
	});

	it("目标比整个频道还新：退化成最后一页，不给出空页", () => {
		const state = stateOf([team], { [team.id]: many as never });
		const detail = channelDetail(state, team, directoryOf({ lin: "林越" }), { around: 99_999, limit: 60 });
		expect(detail.messages).toHaveLength(60);
		expect(detail.messages[detail.messages.length - 1]?.seq).toBe(5000);
	});

	it("不带 `around` 时行为和以前一模一样（最近一页）", () => {
		const state = stateOf([team], { [team.id]: many as never });
		const detail = channelDetail(state, team, directoryOf({ lin: "林越" }), {});
		expect(detail.messages[detail.messages.length - 1]?.seq).toBe(5000);
		expect(detail.hasMoreAbove).toBe(true);
	});
});

describe("`around` 和 `before` 一起给", () => {
	it("以 `around` 为准，`before` 被忽略（不是两个都生效）", () => {
		const many = Array.from({ length: 200 }, (_, index) => ({
			seq: index + 1,
			at: AT + index,
			from: "lin",
			kind: "chat" as const,
			text: `第 ${String(index + 1)} 条`,
			mentions: [],
			read: true,
		}));
		const state = stateOf([team], { [team.id]: many as never });
		const both = channelDetail(state, team, directoryOf({ lin: "林越" }), { around: 50, before: 190, limit: 20 });
		const onlyAround = channelDetail(state, team, directoryOf({ lin: "林越" }), { around: 50, limit: 20 });
		// 这条锁住的是「有意识的选择」：两个一起给时不许变成两个都生效的混合页。
		expect(both.messages.map((message) => message.seq)).toEqual(onlyAround.messages.map((message) => message.seq));
		expect(both.messages.some((message) => message.seq === 50)).toBe(true);
	});
});
