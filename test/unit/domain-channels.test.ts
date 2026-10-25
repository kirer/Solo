/**
 * 频道领域逻辑（纯函数，无数据库）。
 *
 * 覆盖 `docs/design/COMMS-REFACTOR.md` §2.1 / §3 / §4.3：
 * 追加消息、未读推导、已读点、唤醒策略、未读摘要、上下文渲染。
 */
import { describe, expect, test } from "vitest";
import {
	advanceRead,
	removeMember,
	appendMessage,
	createChannel,
	digestFor,
	dmChannelId,
	emptyChannelState,
	hasMember,
	logChannelId,
	markMentionRead,
	member,
	OWNER_ID,
	parseChannelId,
	previewLine,
	projectChannelId,
	recipientsOf,
	renderForModel,
	unreadMentionsOf,
	unreadOf,
	type Channel,
	type ChannelState,
} from "../../src/domain/channels.ts";

/** 建一个测试用频道。 */
function setup(): { state: ChannelState; channel: Channel } {
	let state = emptyChannelState();
	state = createChannel(state, {
		id: projectChannelId("alpha"),
		kind: "project",
		title: "Alpha 项目",
		project: "alpha",
		members: [
			member(OWNER_ID, "owner", 1),
			member(10, "leader", 2, true), // 负责人 wakeOnAll
			member(20, "staff", 3),
			member(21, "staff", 4),
		],
		at: 1,
	});
	const channel = state.channels[projectChannelId("alpha")] as Channel;
	return { state, channel };
}

describe("频道标识", () => {
	test("解析各类标识", () => {
		expect(parseChannelId("company")).toEqual({ kind: "company" });
		expect(parseChannelId("leadership")).toEqual({ kind: "leadership" });
		expect(parseChannelId("proj:alpha")).toEqual({ kind: "project", key: "alpha" });
		expect(parseChannelId("dm:191")).toEqual({ kind: "dm", key: "191" });
		expect(parseChannelId("log:191")).toEqual({ kind: "log", key: "191" });
		expect(parseChannelId("nope")).toBeUndefined();
		expect(parseChannelId("proj:")).toBeUndefined();
	});

	test("生成标识", () => {
		expect(projectChannelId("a-b")).toBe("proj:a-b");
		expect(dmChannelId(7)).toBe("dm:7");
		expect(logChannelId(7)).toBe("log:7");
	});
});

describe("追加消息", () => {
	test("seq 跨频道单调递增", () => {
		const { state } = setup();
		const first = appendMessage(state, "proj:alpha", {
			from: 10,
			fromLabel: "许砚舟",
			kind: "chat",
			text: "一",
			at: 100,
		});
		const second = appendMessage(first.state, "proj:alpha", {
			from: 20,
			fromLabel: "林越",
			kind: "chat",
			text: "二",
			at: 101,
		});
		expect(second.message.seq).toBeGreaterThan(first.message.seq);
	});

	test("@ 去重且剔除发送方自己", () => {
		const { state } = setup();
		const { message } = appendMessage(state, "proj:alpha", {
			from: 20,
			fromLabel: "林越",
			kind: "question",
			text: "@负责人 @负责人 这个字段叫什么？",
			mentions: [10, 10, 20],
			at: 100,
		});
		expect(message.mentions).toEqual([10]);
	});

	test("新消息的所有被 @ 者都是未读", () => {
		const { state } = setup();
		const { message } = appendMessage(state, "proj:alpha", {
			from: 20,
			fromLabel: "林越",
			kind: "question",
			text: "@负责人",
			mentions: [10],
			at: 100,
		});
		expect(message.readBy).toEqual([]);
	});

	test("超出上限时裁掉最旧的", () => {
		let { state } = setup();
		for (let i = 0; i < 810; i += 1) {
			state = appendMessage(state, "proj:alpha", {
				from: 20,
				fromLabel: "林越",
				kind: "chat",
				text: `第 ${i} 条`,
				at: i,
			}).state;
		}
		const channel = state.channels["proj:alpha"] as Channel;
		expect(channel.messages.length).toBe(800);
		expect(channel.messages.at(-1)?.text).toBe("第 809 条");
		expect(channel.lastSeq).toBe(810);
	});

	test("频道不存在时抛错（不静默丢弃）", () => {
		expect(() =>
			appendMessage(emptyChannelState(), "proj:nope", { from: 1, fromLabel: "x", kind: "chat", text: "y" }),
		).toThrow(/频道不存在/);
	});
});

describe("未读与已读", () => {
	test("未读不含自己发的", () => {
		let { state } = setup();
		state = appendMessage(state, "proj:alpha", { from: 20, fromLabel: "林越", kind: "chat", text: "我发的", at: 1 }).state;
		state = appendMessage(state, "proj:alpha", { from: 10, fromLabel: "负责人", kind: "chat", text: "他发的", at: 2 }).state;
		const channel = state.channels["proj:alpha"] as Channel;
		expect(unreadOf(channel, 20).map((m) => m.text)).toEqual(["他发的"]);
	});

	test("读位置只前进不后退", () => {
		let { state } = setup();
		const first = appendMessage(state, "proj:alpha", { from: 20, fromLabel: "林越", kind: "chat", text: "a", at: 1 });
		state = first.state;
		const second = appendMessage(state, "proj:alpha", { from: 20, fromLabel: "林越", kind: "chat", text: "b", at: 2 });
		state = second.state;

		let channel = state.channels["proj:alpha"] as Channel;
		channel = advanceRead(channel, 10, second.message.seq);
		expect(unreadOf(channel, 10).length).toBe(0);
		// 后退无效
		channel = advanceRead(channel, 10, first.message.seq);
		expect(unreadOf(channel, 10).length).toBe(0);
	});

	test("@ 已读标记（灰点变绿点）", () => {
		let { state } = setup();
		const { state: next, message } = appendMessage(state, "proj:alpha", {
			from: 20,
			fromLabel: "林越",
			kind: "question",
			text: "@负责人 问一下",
			mentions: [10],
			at: 1,
		});
		state = next;
		let channel = state.channels["proj:alpha"] as Channel;
		expect(channel.messages[0]?.readBy).toEqual([]);

		channel = markMentionRead(channel, message.seq, 10);
		expect(channel.messages[0]?.readBy).toEqual([10]);
		// 幂等
		channel = markMentionRead(channel, message.seq, 10);
		expect(channel.messages[0]?.readBy).toEqual([10]);
		// 没被 @ 的人标记无效
		channel = markMentionRead(channel, message.seq, 21);
		expect(channel.messages[0]?.readBy).toEqual([10]);
	});

	test("未读 @ 只算 @ 我的", () => {
		let { state } = setup();
		state = appendMessage(state, "proj:alpha", {
			from: 20, fromLabel: "林越", kind: "question", text: "@负责人", mentions: [10], at: 1,
		}).state;
		state = appendMessage(state, "proj:alpha", {
			from: 21, fromLabel: "周野", kind: "question", text: "@负责人 我也问", mentions: [10], at: 2,
		}).state;
		const channel = state.channels["proj:alpha"] as Channel;
		expect(unreadMentionsOf(channel, 10).length).toBe(2);
		expect(unreadMentionsOf(channel, 20).length).toBe(0);
	});
});

describe("唤醒策略（成本控制的核心）", () => {
	const ownerOf = () => 10;

	test("被 @ 的人立即唤醒", () => {
		let { state } = setup();
		const { state: next, message } = appendMessage(state, "proj:alpha", {
			from: 20, fromLabel: "林越", kind: "question", text: "@负责人", mentions: [10], at: 1,
		});
		state = next;
		const channel = state.channels["proj:alpha"] as Channel;
		const targets = recipientsOf(channel, message, ownerOf);
		expect(targets).toContain(10);
	});

	test("agent 发言没 @ 时不唤醒任何人（除 wakeOnAll）", () => {
		let { state } = setup();
		const { state: next, message } = appendMessage(state, "proj:alpha", {
			from: 20, fromLabel: "林越", kind: "chat", text: "闲聊一句", at: 1,
		});
		state = next;
		const channel = state.channels["proj:alpha"] as Channel;
		const targets = recipientsOf(channel, message, ownerOf);
		// 只有 wakeOnAll 的负责人被唤醒；其它员工不该被吵醒
		expect(targets).toEqual([10]);
		expect(targets).not.toContain(21);
		expect(targets).not.toContain(OWNER_ID);
	});

	test("老板发言没 @ 时唤醒频道 owner", () => {
		let { state } = setup();
		const { state: next, message } = appendMessage(state, "proj:alpha", {
			from: OWNER_ID, fromLabel: "老板", kind: "chat", text: "进度怎么样", at: 1,
		});
		state = next;
		const channel = state.channels["proj:alpha"] as Channel;
		const targets = recipientsOf(channel, message, ownerOf);
		expect(targets).toContain(10);
	});

	test("老板 @ 任何人时立即唤醒该人", () => {
		let { state } = setup();
		const { state: next, message } = appendMessage(state, "proj:alpha", {
			from: OWNER_ID, fromLabel: "老板", kind: "chat", text: "@林越 你来一下", mentions: [20], at: 1,
		});
		state = next;
		const channel = state.channels["proj:alpha"] as Channel;
		expect(recipientsOf(channel, message, ownerOf)).toContain(20);
	});

	test("永不唤醒发送方自己", () => {
		let { state } = setup();
		const { state: next, message } = appendMessage(state, "proj:alpha", {
			from: 20, fromLabel: "林越", kind: "chat", text: "@自己", mentions: [20], at: 1,
		});
		state = next;
		const channel = state.channels["proj:alpha"] as Channel;
		expect(recipientsOf(channel, message, ownerOf)).not.toContain(20);
	});
});

describe("未读摘要", () => {
	test("按「有 @ 的优先」排序，且只列有未读的频道", () => {
		let state = emptyChannelState();
		state = createChannel(state, {
			id: "company", kind: "company", title: "公司大群",
			members: [member(OWNER_ID, "owner", 1), member(10, "ceo", 1), member(20, "staff", 1)], at: 1,
		});
		state = createChannel(state, {
			id: "proj:alpha", kind: "project", title: "Alpha", project: "alpha",
			members: [member(OWNER_ID, "owner", 1), member(10, "leader", 1), member(20, "staff", 1)], at: 1,
		});
		// 公司群 3 条普通消息
		for (let i = 0; i < 3; i += 1) {
			state = appendMessage(state, "company", { from: 10, fromLabel: "CEO", kind: "chat", text: `公告 ${i}`, at: i }).state;
		}
		// 项目群 1 条 @ 我
		state = appendMessage(state, "proj:alpha", {
			from: 10, fromLabel: "负责人", kind: "question", text: "@林越 接口字段叫什么", mentions: [20], at: 10,
		}).state;

		const digests = digestFor(state, 20);
		expect(digests.length).toBe(2);
		// 有 @ 的排在前面
		expect(digests[0]?.channelId).toBe("proj:alpha");
		expect(digests[0]?.mentions).toBe(1);
		expect(digests[1]?.channelId).toBe("company");
		expect(digests[1]?.unread).toBe(3);
	});

	test("没有未读时不产出摘要", () => {
		let { state } = setup();
		state = appendMessage(state, "proj:alpha", { from: 20, fromLabel: "林越", kind: "chat", text: "a", at: 1 }).state;
		expect(digestFor(state, 10).length).toBe(1);
		const channel = state.channels["proj:alpha"] as Channel;
		state = { ...state, channels: { ...state.channels, "proj:alpha": advanceRead(channel, 10, 999) } };
		expect(digestFor(state, 10)).toEqual([]);
	});
});

describe("渲染给模型的紧凑消息", () => {
	test("带频道、seq 与上下文提示，但不塞完整历史", () => {
		let { state } = setup();
		const { state: next, message } = appendMessage(state, "proj:alpha", {
			from: 20, fromLabel: "林越", kind: "question",
			text: "T-3 的登录接口，token 过期后返回 401 还是 403？", mentions: [10], at: 1,
			refs: { taskId: "T-3" },
		});
		state = next;
		const channel = state.channels["proj:alpha"] as Channel;
		const text = renderForModel(channel, message, (id) => (id === 10 ? "许砚舟" : "林越"));
		expect(text).toContain("Alpha 项目");
		expect(text).toContain("@许砚舟");
		expect(text).toContain("401 还是 403");
		expect(text).toContain(`#${message.seq}`);
		expect(text).toContain("read_channel");
		expect(text).toContain("T-3");
	});
});

describe("成员管理", () => {
	test("加人幂等，老板不可移除", () => {
		let { state } = setup();
		let channel = state.channels["proj:alpha"] as Channel;
		expect(hasMember(channel, 20)).toBe(true);
		expect(hasMember(channel, 99)).toBe(false);
		// 老板移除无效
		channel = removeMember(channel, OWNER_ID);
		expect(hasMember(channel, OWNER_ID)).toBe(true);
	});
});

describe("previewLine：列表预览剥掉 Markdown 记号", () => {
	test("标题、列表、粗体都去掉，只留文字", () => {
		expect(previewLine("## 验收报告\n\n- 第一项通过\n- 第二项通过")).toBe(
			"验收报告 第一项通过 第二项通过",
		);
		expect(previewLine("**改动清单**：三个文件")).toBe("改动清单：三个文件");
		expect(previewLine("> 引用的话")).toBe("引用的话");
	});

	test("行内代码保留内容、去掉反引号", () => {
		expect(previewLine("改的是 `src/a.ts` 里的函数")).toBe("改的是 src/a.ts 里的函数");
	});

	test("代码块整体丢弃（列表里显示一大段代码没有意义）", () => {
		expect(previewLine("看这个：\n```ts\nconst a = 1;\n```\n就这样")).toBe("看这个： 就这样");
	});

	test("链接只留文字，不留地址", () => {
		expect(previewLine("见 [设计文档](https://example.com/x)")).toBe("见 设计文档");
	});

	test("超长截断并加省略号", () => {
		const text = "字".repeat(200);
		const preview = previewLine(text, 20);
		expect(preview.length).toBe(21);
		expect(preview.endsWith("…")).toBe(true);
	});

	test("斜体不误伤乘法/强调星号", () => {
		expect(previewLine("*强调* 和 a*b 都保留")).toBe("强调 和 a*b 都保留");
	});
});
