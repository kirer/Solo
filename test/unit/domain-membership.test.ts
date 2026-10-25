/**
 * 成员关系与权限（纯函数，无数据库）。
 *
 * 覆盖 `docs/design/COMMS-REFACTOR.md` §5 的关键区分：
 * **通信不限方向，派任务只能从上到下，上报只能从下到上。**
 */
import { describe, expect, test } from "vitest";
import {
	appendMessage,
	createChannel,
	emptyChannelState,
	member,
	OWNER_ID,
	type Channel,
	type ChannelState,
} from "../../src/domain/channels.ts";
import {
	canAssign,
	canEscalate,
	canMention,
	canView,
	companyMembers,
	labelOf,
	leadershipMembers,
	mentionable,
	ownerOfChannel,
	projectMembers,
	visibleChannels,
	type Org,
	type OrgPerson,
} from "../../src/domain/membership.ts";

/**
 * 测试用组织：
 *
 *   老板(0)
 *     └─ CEO(10)
 *          ├─ CTO(11)          ├─ CFO(12)
 *          │    └─ leader:alpha(20)
 *          │         ├─ 林越(21) 开发
 *          │         └─ 周野(22) 测试
 *          └─ leader:beta(30)
 *               └─ 阿岚(31)
 */
const ORG: Org = {
	ceoId: 10,
	projectLeaders: { alpha: 20, beta: 30 },
	people: [
		{ conversationId: 10, label: "CEO", role: "ceo", managerId: undefined },
		{ conversationId: 11, label: "CTO", role: "management", managerId: 10 },
		{ conversationId: 12, label: "CFO", role: "management", managerId: 10 },
		{ conversationId: 20, label: "许砚舟", role: "leader", managerId: 11, project: "alpha" },
		{ conversationId: 21, label: "林越", role: "staff", managerId: 20, project: "alpha" },
		{ conversationId: 22, label: "周野", role: "staff", managerId: 20, project: "alpha" },
		{ conversationId: 30, label: "沈迟", role: "leader", managerId: 11, project: "beta" },
		{ conversationId: 31, label: "阿岚", role: "staff", managerId: 30, project: "beta" },
	],
};

function channelOf(state: ChannelState, id: string): Channel {
	return state.channels[id] as Channel;
}

/** 建好三个频道。 */
function setup(): ChannelState {
	let state = emptyChannelState();
	state = createChannel(state, {
		id: "company", kind: "company", title: "公司大群",
		members: companyMembers(ORG).map((id) => member(id, "staff", 1)),
		at: 1,
	});
	state = createChannel(state, {
		id: "leadership", kind: "leadership", title: "领导层",
		members: leadershipMembers(ORG).map((id) => member(id, "management", 1)),
		at: 1,
	});
	state = createChannel(state, {
		id: "proj:alpha", kind: "project", title: "Alpha", project: "alpha",
		members: projectMembers(ORG, "alpha").map((id) => member(id, "staff", 1)),
		at: 1,
	});
	// 另一个项目的群：用来验证「看不到别人的项目群」
	state = createChannel(state, {
		id: "proj:beta", kind: "project", title: "Beta", project: "beta",
		members: projectMembers(ORG, "beta").map((id) => member(id, "staff", 1)),
		at: 1,
	});
	state = createChannel(state, {
		id: "dm:21", kind: "dm", title: "与林越的私聊",
		members: [member(OWNER_ID, "owner", 1), member(21, "staff", 1)],
		at: 1,
	});
	state = createChannel(state, {
		id: "log:21", kind: "log", title: "林越的工作记录",
		members: [member(21, "staff", 1)],
		at: 1,
	});
	return state;
}

describe("频道成员构成", () => {
	test("公司大群包含所有员工（老板要求）", () => {
		const ids = companyMembers(ORG);
		expect(ids).toContain(OWNER_ID);
		for (const person of ORG.people) expect(ids).toContain(person.conversationId);
	});

	test("领导层群只有老板 + CEO + 管理层", () => {
		expect(leadershipMembers(ORG).sort()).toEqual([OWNER_ID, 10, 11, 12].sort());
	});

	test("项目群 = 老板 + 负责人 + 本项目员工（不含别的项目）", () => {
		expect(projectMembers(ORG, "alpha").sort()).toEqual([OWNER_ID, 20, 21, 22].sort());
	});

	test("归档员工不加入", () => {
		const withArchived: Org = {
			...ORG,
			people: ORG.people.map((person) =>
				person.conversationId === 22 ? { ...person, archived: true } : person,
			),
		};
		expect(companyMembers(withArchived)).not.toContain(22);
		expect(projectMembers(withArchived, "alpha")).not.toContain(22);
	});
});

describe("频道可见性", () => {
	const state = setup();

	test("老板能看到全部频道", () => {
		for (const channel of Object.values(state.channels)) {
			expect(canView(ORG, OWNER_ID, channel), channel.id).toBe(true);
		}
	});

	test("员工看得到公司群与本项目群，看不到别的项目群", () => {
		expect(canView(ORG, 21, channelOf(state, "company"))).toBe(true);
		expect(canView(ORG, 21, channelOf(state, "proj:alpha"))).toBe(true);
		expect(canView(ORG, 21, channelOf(state, "proj:beta"))).toBe(false);
		expect(canView(ORG, 21, channelOf(state, "leadership"))).toBe(false);
	});

	test("管理层看得到所有项目群（要能监督）", () => {
		expect(canView(ORG, 11, channelOf(state, "proj:alpha"))).toBe(true);
		expect(canView(ORG, 11, channelOf(state, "proj:beta"))).toBe(true);
		expect(canView(ORG, 11, channelOf(state, "leadership"))).toBe(true);
	});

	test("私聊与工作记录只有本人和老板能看", () => {
		expect(canView(ORG, 21, channelOf(state, "dm:21"))).toBe(true);
		expect(canView(ORG, 22, channelOf(state, "dm:21"))).toBe(false);
		expect(canView(ORG, OWNER_ID, channelOf(state, "dm:21"))).toBe(true);
		expect(canView(ORG, 21, channelOf(state, "log:21"))).toBe(true);
		expect(canView(ORG, 11, channelOf(state, "log:21"))).toBe(false);
	});

	test("归档频道不出现在可见列表里", () => {
		const archived: ChannelState = {
			...state,
			channels: {
				...state.channels,
				"proj:alpha": { ...(state.channels["proj:alpha"] as Channel), archived: true },
			},
		};
		const visible = visibleChannels(ORG, 21, Object.values(archived.channels));
		expect(visible.map((channel) => channel.id)).not.toContain("proj:alpha");
	});
});

describe("通信不限方向（@ 谁）", () => {
	const state = setup();

	test("同频道内员工可以 @ 负责人", () => {
		expect(canMention(ORG, 21, 20, channelOf(state, "proj:alpha"))).toBe(true);
	});

	test("公司群里员工可以 @ CEO（通信不限方向）", () => {
		expect(canMention(ORG, 21, 10, channelOf(state, "company"))).toBe(true);
	});

	test("不能 @ 看不到该频道的人（@ 了也读不到上下文）", () => {
		// 林越在项目群里 @ 另一个项目的阿岚
		expect(canMention(ORG, 21, 31, channelOf(state, "proj:alpha"))).toBe(false);
	});

	test("不能 @ 自己", () => {
		expect(canMention(ORG, 21, 21, channelOf(state, "proj:alpha"))).toBe(false);
	});

	test("不能 @ 已归档的人", () => {
		const archived: Org = {
			...ORG,
			people: ORG.people.map((person) =>
				person.conversationId === 22 ? { ...person, archived: true } : person,
			),
		};
		expect(canMention(archived, 21, 22, channelOf(state, "proj:alpha"))).toBe(false);
	});

	test("可 @ 名单按频道成员过滤", () => {
		const list = mentionable(ORG, 21, channelOf(state, "proj:alpha"));
		const ids = list.map((person) => person.conversationId);
		expect(ids).toContain(20);
		expect(ids).not.toContain(31); // 别的项目
		expect(ids).not.toContain(21); // 自己
	});
});

describe("派任务只能从上到下", () => {
	test("老板可以给任何人派（任何地方）", () => {
		for (const person of ORG.people) {
			expect(canAssign(ORG, OWNER_ID, person.conversationId), person.label).toBe(true);
		}
	});

	test("沿 manager 链的上级可以派（含隔级）", () => {
		expect(canAssign(ORG, 20, 21)).toBe(true); // 负责人 → 员工
		expect(canAssign(ORG, 11, 21)).toBe(true); // CTO → 隔级员工（沿链）
		expect(canAssign(ORG, 10, 21)).toBe(true); // CEO → 隔级员工
	});

	test("项目负责人可以给本项目员工派", () => {
		expect(canAssign(ORG, 20, 22)).toBe(true);
	});

	test("管理层可以给任何项目负责人派", () => {
		expect(canAssign(ORG, 11, 30)).toBe(true); // CTO → beta 负责人
		expect(canAssign(ORG, 12, 20)).toBe(true); // CFO → alpha 负责人
	});

	test("下级不能给上级派（那是上报）", () => {
		expect(canAssign(ORG, 21, 20)).toBe(false);
		expect(canAssign(ORG, 20, 11)).toBe(false);
		expect(canAssign(ORG, 11, 10)).toBe(false);
	});

	test("同级之间不能派（那是协作，用 say）", () => {
		expect(canAssign(ORG, 11, 12)).toBe(false); // CTO → CFO
		expect(canAssign(ORG, 21, 22)).toBe(false); // 员工 → 员工
	});

	test("跨项目负责人之间不能派", () => {
		expect(canAssign(ORG, 20, 30)).toBe(false);
	});

	test("不能给自己派", () => {
		expect(canAssign(ORG, 21, 21)).toBe(false);
	});

	test("不能给已归档的人派", () => {
		const archived: Org = {
			...ORG,
			people: ORG.people.map((person) =>
				person.conversationId === 21 ? { ...person, archived: true } : person,
			),
		};
		expect(canAssign(archived, 20, 21)).toBe(false);
	});
});

describe("上报只能从下到上", () => {
	test("员工可以向直属上级与更上层上报", () => {
		expect(canEscalate(ORG, 21, 20)).toBe(true);
		expect(canEscalate(ORG, 21, 11)).toBe(true);
		expect(canEscalate(ORG, 21, 10)).toBe(true);
	});

	test("管理层之间可以向上报 CEO", () => {
		expect(canEscalate(ORG, 11, 10)).toBe(true);
		expect(canEscalate(ORG, 20, 11)).toBe(true);
	});

	test("不能向同级或下级上报（那是聊天）", () => {
		expect(canEscalate(ORG, 20, 21)).toBe(false);
		expect(canEscalate(ORG, 11, 12)).toBe(false);
		expect(canEscalate(ORG, 10, 11)).toBe(false);
	});

	test("老板不是上报对象（由 CEO 决定要不要递）", () => {
		expect(canEscalate(ORG, 10, OWNER_ID)).toBe(false);
		expect(canEscalate(ORG, 21, OWNER_ID)).toBe(false);
	});
});

describe("频道 owner（老板发言没 @ 时唤醒谁）", () => {
	const state = setup();

	test("公司群与领导层群 → CEO", () => {
		expect(ownerOfChannel(ORG, channelOf(state, "company"))).toBe(10);
		expect(ownerOfChannel(ORG, channelOf(state, "leadership"))).toBe(10);
	});

	test("项目群 → 该项目负责人", () => {
		expect(ownerOfChannel(ORG, channelOf(state, "proj:alpha"))).toBe(20);
	});

	test("私聊 → 对方", () => {
		expect(ownerOfChannel(ORG, channelOf(state, "dm:21"))).toBe(21);
	});
});

describe("显示名解析", () => {
	test("老板有专用名字", () => {
		expect(labelOf(ORG, OWNER_ID)).toBe("老板");
	});

	test("找不到时降级但不抛错", () => {
		expect(labelOf(ORG, 999)).toBe("会话 999");
	});
});
