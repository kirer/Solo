import { describe, expect, test } from "vitest";
import { renderDelivery, renderDigest } from "../../src/core/channel/deliver.ts";
import { appendMessage, ensureChannel, type ChannelState } from "../../src/core/channel/state.ts";

function stateWith(...ids: { id: string; title: string; members: string[]; wakeOnAll?: string[] }[]): ChannelState {
	return ids.reduce(
		(acc, input) => ensureChannel(acc, { ...input, at: 1 }),
		{ channels: {}, messages: {}, nextSeq: {}, readMarks: {} } as ChannelState,
	);
}

describe("投递正文", () => {
	test("带频道名、序号、说话人", () => {
		const state = stateWith({ id: "general", title: "全员", members: ["owner", "cto"] });
		const { message } = appendMessage(state, "general", { from: "owner", text: "有人吗", at: 1 });
		const text = renderDelivery({ channel: state.channels.general!, message });
		expect(text).toContain("【全员】#1");
		expect(text).toContain("owner：有人吗");
		expect(text).toContain("say");
	});

	test("引用时标出被引用的序号", () => {
		let state = stateWith({ id: "g", title: "G", members: ["owner", "cto"] });
		const first = appendMessage(state, "g", { from: "cto", text: "A", at: 1 });
		state = first.state;
		const second = appendMessage(state, "g", { from: "owner", text: "B", at: 2, replyTo: 1 });
		expect(renderDelivery({ channel: state.channels.g!, message: second.message })).toContain("（回复 #1）");
	});

	test("插话要明说「不是新任务」", () => {
		// 实测：老板在沈舟加音效的中途私聊问「你是谁啊」，它答完就收工，
		// 再没回项目频道汇报。所以打断式的投递必须把「答完回去干活」写进正文。
		const state = stateWith({ id: "g", title: "G", members: ["owner", "cto"] });
		const { message } = appendMessage(state, "g", { from: "owner", text: "你是谁", at: 1 });
		const interrupted = renderDelivery({ channel: state.channels.g!, message, interrupted: true });
		expect(interrupted).toContain("这是插话，不是新任务");
		// 对方闲着时不该看到这句——那会让人以为手上还有活。
		expect(renderDelivery({ channel: state.channels.g!, message })).not.toContain("这是插话");
	});

	test("列出同时被 @ 的其他人，且不含自己", () => {
		const state = stateWith({ id: "g", title: "G", members: ["owner", "cto", "cfo"] });
		const { message } = appendMessage(state, "g", {
			from: "owner",
			text: "@cto @cfo 一起看",
			at: 1,
		});
		const text = renderDelivery({
			channel: state.channels.g!,
			message,
			viewer: "cto",
			labelOf: (slug) => (slug === "cfo" ? "财务" : slug),
		});
		expect(text).toContain("还 @ 了：财务");
		expect(text).not.toContain("还 @ 了：cto");
	});
});

describe("未读摘要", () => {
	test("没有未读时不产生任何文字", () => {
		const state = stateWith({ id: "g", title: "G", members: ["cto"] });
		expect(renderDigest(state, "cto")).toBe("");
	});

	test("列出有未读的频道与最后一句预览", () => {
		let state = stateWith(
			{ id: "g", title: "全员", members: ["owner", "cto"] },
			{ id: "p", title: "项目", members: ["owner", "cto"] },
		);
		state = appendMessage(state, "g", { from: "owner", text: "第一条", at: 1 }).state;
		state = appendMessage(state, "g", { from: "owner", text: "最新一条", at: 2 }).state;
		state = appendMessage(state, "p", { from: "owner", text: "项目里的事", at: 3 }).state;

		const digest = renderDigest(state, "cto");
		expect(digest).toContain("【你有 3 条未读】");
		expect(digest).toContain("全员：2 条 — 最新一条");
		expect(digest).toContain("项目：1 条 — 项目里的事");
	});

	test("自己发的不算未读", () => {
		let state = stateWith({ id: "g", title: "G", members: ["owner", "cto"] });
		state = appendMessage(state, "g", { from: "cto", text: "我说的", at: 1 }).state;
		expect(renderDigest(state, "cto")).toBe("");
	});
});
