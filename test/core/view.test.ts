/**
 * 视图层的约定：**界面看到的东西，必须是文件里的事实**。
 *
 * 这一层最容易出的错不是崩溃，而是「显示得像真的、其实不是」：
 * - 项目频道显示成「3 人」，但负责人不在成员表里 → 员工在项目里 @ 不到拍板的人；
 * - 个人频道和个人私聊混成一组 → 看不出「有人在向我汇报」和「我在找人说话」的区别。
 *
 * 所以这里逐个断言投影的字段，而不是断言「函数没抛错」。
 */
import { describe, expect, it } from "vitest";
import { channelDetail, channelList } from "../../src/core/shell/view.ts";
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

describe("频道列表的投影", () => {
	it("个人频道标成 personal，且给出是谁的个人频道", () => {
		const state = stateOf([lin]);
		const directory = directoryOf({ lin: "林越" });
		const [channel] = channelList(state, directory);
		expect(channel.kind).toBe("dm");
		// 靠成员表判断而不是靠 id 里的位置：`dmId` 会把成员排序，位置不可信。
		expect(channel.dmKind).toBe("personal");
		expect(channel.title).toBe("林越");
	});

	it("两人以上的 dm 是私聊，不是谁的个人频道", () => {
		const group = { id: "dm:a-b-c", title: "小群", members: ["owner", "lin", "shen"], wakeOnAll: [], createdAt: AT };
		const state = stateOf([group]);
		const [channel] = channelList(state, directoryOf({ lin: "林越", shen: "沈舟" }));
		expect(channel.dmKind).toBe("direct");
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
