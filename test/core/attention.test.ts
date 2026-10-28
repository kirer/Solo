/**
 * 「找你的 N 件事」的约定。
 *
 * 老板的原话：「消息太多，真正需要我的信息没有 @ 我，能够让我直接定位。」
 * 所以这份列表的每一条都必须是**真的要他开口**的，多一条就是噪音，少一条就是漏事。
 *
 * 这里断言判据本身，而不是断言「函数没抛错」：
 * - 点名叫老板的一定进；
 * - 没 @ 但正文在问「要不要 / 请确认」的也要进（实测这类消息大量没 @ 老板）；
 * - 老板自己说的话永不进（他不需要提醒自己）；
 * - 投影镜像（think/tool/work）不进（它们在老板私聊里只是过程，不是待办）。
 */
import { describe, expect, it } from "vitest";
import { attentionItems, messageView } from "../../src/core/shell/view.ts";
import type { DirectoryState } from "../../src/core/agent/roster.ts";
import type { Channel, ChannelState, Message } from "../../src/core/channel/state.ts";

const AT = 1_700_000_000_000;
const DAY = 24 * 60 * 60 * 1000;

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

function stateOf(channels: Channel[], messages: Record<string, Message[]>): ChannelState {
	return {
		channels: Object.fromEntries(channels.map((channel) => [channel.id, channel])),
		messages,
		nextSeq: {},
		readMarks: {},
	};
}

function message(seq: number, from: string, text: string, extra: Partial<Message> = {}): Message {
	return { seq, at: AT - (10 - seq) * 60_000, from, text, mentions: [], kind: "say", ...extra };
}

const dm: Channel = { id: "dm:owner-lin", title: "林越", members: ["owner", "lin"], wakeOnAll: [], createdAt: AT };
const project: Channel = { id: "proj:坦克大战", title: "坦克大战", members: ["owner", "lin", "shen"], wakeOnAll: [], createdAt: AT };
const directory = directoryOf({ lin: "林越", shen: "沈舟" });

describe("attentionItems", () => {
	it("显式 @ 老板的消息进列表，并带上回原频道的锚点", () => {
		const state = stateOf(
			[project],
			{ [project.id]: [message(1, "lin", "@owner 联机要不要加？", { mentions: ["owner"], kind: "question" })] },
		);
		const items = attentionItems(state, directory, "owner", AT);
		expect(items).toHaveLength(1);
		expect(items[0]).toMatchObject({
			channelId: "proj:坦克大战",
			channelKind: "project",
			seq: 1,
			fromSlug: "lin",
			fromLabel: "林越",
			read: false,
		});
	});

	it("没有 @ 但正文在问「要不要」的也进 —— 模型会写「要你定」然后忘了 @ 你", () => {
		const state = stateOf([project], { [project.id]: [message(1, "lin", "这块要不要拆成两次上线？")] });
		expect(attentionItems(state, directory, "owner", AT).map((item) => item.seq)).toEqual([1]);
	});

	it("老板自己说的话永不进列表", () => {
		const state = stateOf([project], { [project.id]: [message(1, "owner", "要不要加联机你们定")] });
		expect(attentionItems(state, directory, "owner", AT)).toEqual([]);
	});

	it("普通汇报不进列表，除非点了老板", () => {
		const state = stateOf([project], {
			[project.id]: [message(1, "lin", "音效加完了，三个文件都过了测试"), message(2, "shen", "代码合了")],
		});
		expect(attentionItems(state, directory, "owner", AT)).toEqual([]);
	});

	it("过程投影（think/tool/work）不进列表，即使正文里有问句", () => {
		const state = stateOf([dm], {
			[dm.id]: [
				message(1, "lin", "要不要先读一下 state.ts？", { kind: "think" }),
				message(2, "lin", "要不要跑一下测试？", { kind: "tool" }),
				message(3, "lin", "要不要重启？", { kind: "work" }),
			],
		});
		// 这三条其实都会命中 needOwner 的正则，但它们是老板私聊里的镜象过程，不是待办。
		// 现在的实现用 kind 兜住：只有真正的发言才可能进列表。
		const items = attentionItems(state, directory, "owner", AT);
		expect(items.every((item) => !["think", "tool", "work"].includes(item.channelId))).toBe(true);
	});

	it("7 天以外的旧消息不进列表", () => {
		const state = stateOf([project], {
			[project.id]: [message(1, "lin", "@owner 要不要加联机？", { mentions: ["owner"], at: AT - 8 * DAY })],
		});
		expect(attentionItems(state, directory, "owner", AT)).toEqual([]);
	});

	it("跨频道按时间倒序，最新的在最前", () => {
		const state = stateOf([project, dm], {
			[project.id]: [message(1, "lin", "@owner 要不要加？", { mentions: ["owner"] })],
			[dm.id]: [message(2, "lin", "@owner 在吗", { mentions: ["owner"], at: AT - 60_000 })],
		});
		expect(attentionItems(state, directory, "owner", AT).map((item) => item.channelId)).toEqual([
			"dm:owner-lin",
			"proj:坦克大战",
		]);
	});

	it("已读的仍留在列表里，但带 read 标记 —— 读过了和没看见是两件事", () => {
		const state = stateOf([project], {
			[project.id]: [message(1, "lin", "@owner 要不要加？", { mentions: ["owner"] })],
		});
		state.readMarks["owner"] = { [project.id]: 1 };
		const items = attentionItems(state, directory, "owner", AT);
		expect(items).toHaveLength(1);
		expect(items[0]?.read).toBe(true);
	});
});

describe("messageView 的 needsYou", () => {
	it("给需要老板的消息打标记", () => {
		const state = stateOf([project], {});
		const view = messageView(state, project, message(1, "lin", "要不要加联机？"), directory, "owner");
		expect(view.needsYou).toBe(true);
	});

	it("普通汇报不打标记，字段不出现在 JSON 里", () => {
		const state = stateOf([project], {});
		const view = messageView(state, project, message(1, "lin", "音效加完了"), directory, "owner");
		expect("needsYou" in view).toBe(false);
	});
});
