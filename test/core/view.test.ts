/**
 * 视图层的约定：**界面看到的东西，必须是文件里的事实**。
 *
 * 这一层最容易出的错不是崩溃，而是「显示得像真的、其实不是」：
 * - 项目频道显示成「3 人」，但负责人不在成员表里 → 员工在项目里 @ 不到拍板的人；
 * - dm 频道统一为一类 → 个人频道即工作台，不区分「个人」和「私聊」。
 *
 * 所以这里逐个断言投影的字段，而不是断言「函数没抛错」。
 */
import { describe, expect, it } from "vitest";
import { channelDetail, channelList, messageView } from "../../src/core/shell/view.ts";
import type { DirectoryState } from "../../src/core/agent/roster.ts";
import type { Channel, ChannelState } from "../../src/core/channel/state.ts";

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
const project = { id: "proj:坦克大战", title: "坦克大战", members: ["owner", "lin", "shen"], wakeOnAll: [], createdAt: AT };

describe("侧栏预览只取人说的话", () => {
	const msg = (seq: number, from: string, kind: string, text: string) =>
		({ seq, at: AT + seq, from, kind, text, mentions: [], read: true }) as never;

	it("最新一条是命令输出时，预览仍显示前一句人话", () => {
		// 实测现场的形态：林越说了句话，然后连着几条 `work` 记的是命令行。
		// 拿最后一条当预览，侧栏整列变成 `$ cd /Users/kirer/projects/...`。
		const state = stateOf([lin], {
			[lin.id]: [
				msg(1, "lin", "say", "前端三项改完了，正在收测试。"),
				msg(2, "lin", "work", "$ cd /Users/kirer/projects/ai-company && npm test"),
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
	it("个人频道标成 personal，且给出是谁的个人频道", () => {
		const state = stateOf([lin]);
		const directory = directoryOf({ lin: "林越" });
		const [channel] = channelList(state, directory);
		expect(channel.kind).toBe("dm");
		expect(channel.title).toBe("林越");
	});

	it("两人以上的 dm 仍然是 dm 类型", () => {
		const group = { id: "dm:a-b-c", title: "小群", members: ["owner", "lin", "shen"], wakeOnAll: [], createdAt: AT };
		const state = stateOf([group]);
		const [channel] = channelList(state, directoryOf({ lin: "林越", shen: "沈舟" }));
		expect(channel.kind).toBe("dm");
	});

	it("项目频道带上负责人（来自项目文件，不是频道文档）", () => {
		const state = stateOf([project]);
		const directory = directoryOf({ lin: "林越", shen: "沈舟" });
		const [channel] = channelList(state, directory, "owner", (slug) => (slug === "坦克大战" ? "shen" : undefined));
		expect(channel.kind).toBe("project");
		expect(channel.project).toBe("坦克大战");
		expect(channel.owner).toBe("shen");
		expect(channel.ownerLabel).toBe("沈舟");
	});

	it("项目频道带上一句话现状 doing（来自项目文件）", () => {
		const state = stateOf([project]);
		const [channel] = channelList(
			state,
			directoryOf({ lin: "林越", shen: "沈舟" }),
			"owner",
			() => "shen",
			(slug) => (slug === "坦克大战" ? "沈舟在改 doing 链路" : undefined),
		);
		expect(channel.doing).toBe("沈舟在改 doing 链路");
	});

	it("没有 doing 时列表里不带这个键，非项目频道也不带", () => {
		const state = stateOf([project, lin]);
		const list = channelList(state, directoryOf({ lin: "林越" }), "owner", () => undefined, () => undefined);
		expect("doing" in list[0]!).toBe(false);
		const dm = list.find((channel) => channel.kind === "dm")!;
		expect("doing" in dm).toBe(false);
	});

	it("没有负责人的项目不编造一个", () => {
		const state = stateOf([project]);
		const [channel] = channelList(state, directoryOf({}), "owner", () => undefined);
		expect(channel.owner).toBeUndefined();
		expect(channel.ownerLabel).toBeUndefined();
	});
});

describe("频道详情的投影", () => {
	it("项目成员的角色：老板 / 负责人 / 成员三种", () => {
		const state = stateOf([project]);
		const detail = channelDetail(state, project, directoryOf({ lin: "林越", shen: "沈舟" }), {
			projectOwnerOf: (slug) => (slug === "坦克大战" ? "shen" : undefined),
		});
		const roles = Object.fromEntries(detail.members.map((member) => [member.slug, member.role]));
		expect(roles).toEqual({ owner: "owner", lin: "member", shen: "lead" });
	});

	it("详情也带出 doing；没有就不带这个键", () => {
		const state = stateOf([project]);
		const withDoing = channelDetail(state, project, directoryOf({ lin: "林越", shen: "沈舟" }), {
			projectOwnerOf: () => "shen",
			projectDoingOf: () => "沈舟在改 doing 链路",
		});
		expect(withDoing.channel.doing).toBe("沈舟在改 doing 链路");
		const withoutDoing = channelDetail(state, project, directoryOf({ lin: "林越", shen: "沈舟" }), {
			projectOwnerOf: () => "shen",
		});
		expect("doing" in withoutDoing.channel).toBe(false);
	});

	it("负责人不在成员里时，没人被标成 lead", () => {
		const unbalanced = { ...project, members: ["owner", "lin"] };
		const state = stateOf([unbalanced]);
		const detail = channelDetail(state, unbalanced, directoryOf({ lin: "林越", shen: "沈舟" }), {
			projectOwnerOf: () => "shen",
		});
		expect(detail.members.some((member) => member.role === "lead")).toBe(false);
		expect(detail.channel.owner).toBe("shen");
	});
});

describe("T-013：个人频道的投影镜像不点亮 @ 红点，真实私聊 @ 仍计数", () => {
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

	it("群回复被投影进个人频道（kind=say）时，老板的个人频道 mentions 不计", () => {
		const state = withMessages("dm:owner-gu", [
			{ from: "gu", text: "@owner 我在群里回你了", kind: "say", mentions: ["owner"] },
		]);
		const list = channelList(state, directoryOf({ gu: "顾南雁" }), "owner");
		const dm = list.find((c) => c.id === "dm:owner-gu")!;
		expect(dm.mentions).toBe(0);
		// 但 unread 仍计入（老板确实没读这条投影）
		expect(dm.unread).toBe(1);
	});

	it("真实在私聊里 @ 老板（kind=chat）仍计数，口径 A 不倒退", () => {
		const state = withMessages("dm:owner-gu", [
			{ from: "gu", text: "@owner 老板看这条", kind: "chat", mentions: ["owner"] },
		]);
		const list = channelList(state, directoryOf({ gu: "顾南雁" }), "owner");
		const dm = list.find((c) => c.id === "dm:owner-gu")!;
		expect(dm.mentions).toBe(1);
	});
	it("B 处理中占位：messageView 把 processing 透传给前端（私聊助理场景）", () => {
		const channel = { id: "dm:owner-lin", title: "林越", members: ["owner", "lin"], wakeOnAll: [], createdAt: AT };
		const state = stateOf([channel], {
			"dm:owner-lin": [
				{ seq: 1, from: "owner", at: AT, text: "在吗", kind: "chat", mentions: [] },
				{ seq: 2, from: "lin", at: AT + 1, text: "开始处理…", kind: "chat", status: "pending", pendingFor: "lin", processing: true, mentions: [] },
			],
		});
		const view = messageView(state, channel, state.messages["dm:owner-lin"][1], directoryOf({ lin: "林越" }), "owner");
		expect(view.processing).toBe(true);
		expect(view.pendingFor).toBe("lin");
	});


	it("群频道里的 @ 老板照常计数（与 013 无关的普通场景）", () => {
		const state = withMessages("all", [
			{ from: "gu", text: "@owner 群里叫你", kind: "chat", mentions: ["owner"] },
		]);
		const list = channelList(state, directoryOf({ gu: "顾南雁" }), "owner");
		const company = list.find((c) => c.id === "all")!;
		expect(company.mentions).toBe(1);
	});
});
