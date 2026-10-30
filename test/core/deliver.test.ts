import { describe, expect, test } from "vitest";
import { deliver, queuedAhead, renderDelivery, renderDigest } from "../../src/core/channel/post.ts";
import { INTERRUPTED_TEMPLATE, REPLY_TEMPLATE } from "./seed-prompt.ts";

/**
 * 投递正文必须带真模板：`renderDelivery` 刻意**不给** `replyTemplate` 默认值 ——
 * 默认值等于允许「回话段为空」静默通过，正是这一刀要防的洞。所以这里统一补上 seed 里那份。
 */
function renderDeliveryWithTemplates(
	options: Omit<Parameters<typeof renderDelivery>[0], "replyTemplate" | "interruptedTemplate">,
): string {
	return renderDelivery({ ...options, replyTemplate: REPLY_TEMPLATE, interruptedTemplate: INTERRUPTED_TEMPLATE });
}
import type { Harness } from "../../src/core/runtime/index.ts";
import { appendMessage, ensureChannel, type ChannelState } from "../../src/core/channel/store.ts";

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
		const text = renderDeliveryWithTemplates({ channel: state.channels.general!, message });
		expect(text).toContain("【全员】#1");
		expect(text).toContain("owner：有人吗");
		// 回话规矩由 seed 的 80-reply.md 提供：正文里必须贴上它的第一行（不是代码里硬编码的那句）。
		expect(text).toContain(REPLY_TEMPLATE.split("\n")[0]!);
	});

	test("引用时标出被引用的序号", () => {
		let state = stateWith({ id: "g", title: "G", members: ["owner", "cto"] });
		const first = appendMessage(state, "g", { from: "cto", text: "A", at: 1 });
		state = first.state;
		const second = appendMessage(state, "g", { from: "owner", text: "B", at: 2, replyTo: 1 });
		expect(renderDeliveryWithTemplates({ channel: state.channels.g!, message: second.message })).toContain("（回复 #1）");
	});

	test("插话要明说「不是新任务」", () => {
		// 实测：我在沈舟加音效的中途私聊问「你是谁啊」，它答完就收工，
		// 再没回团队频道汇报。所以打断式的投递必须把「答完回去干活」写进正文。
		const state = stateWith({ id: "g", title: "G", members: ["owner", "cto"] });
		const { message } = appendMessage(state, "g", { from: "owner", text: "你是谁", at: 1 });
		const interrupted = renderDeliveryWithTemplates({ channel: state.channels.g!, message, interrupted: true });
		expect(interrupted).toContain(INTERRUPTED_TEMPLATE.trim());
		// 对方闲着时不该看到这句——那会让人以为手上还有活。
		expect(renderDeliveryWithTemplates({ channel: state.channels.g!, message })).not.toContain(INTERRUPTED_TEMPLATE.trim());
	});

	test("列出同时被 @ 的其他人，且不含自己", () => {
		const state = stateWith({ id: "g", title: "G", members: ["owner", "cto", "cfo"] });
		const { message } = appendMessage(state, "g", {
			from: "owner",
			text: "@cto @cfo 一起看",
			at: 1,
		});
		const text = renderDeliveryWithTemplates({
			channel: state.channels.g!,
			message,
			viewer: "cto",
			labelOf: (slug) => (slug === "cfo" ? "财务" : slug),
		});
		expect(text).toContain("还 @ 了：财务");
		expect(text).not.toContain("还 @ 了：cto");
	});

	test("写清这条会叫醒谁、自己是第几个", () => {
		// 两个人被同时叫醒时，谁都不知道对方也在场，于是各写一条重复甚至矛盾的回复。
		// 投递名单模型看不到，只能由代码注入。
		const state = stateWith({ id: "g", title: "G", members: ["owner", "cto", "cfo"] });
		const { message } = appendMessage(state, "g", { from: "owner", text: "@cto @cfo 一起看", at: 1 });
		const forCfo = renderDeliveryWithTemplates({ channel: state.channels.g!, message, viewer: "cfo" });
		expect(forCfo).toContain("这条会叫醒：cto、cfo（你在第 2 位）");
		expect(forCfo).toContain("别人也在看这条。动手前先说一句你接哪一块");
		// 只叫醒一个人时不写「别人也在看」——那是假话。
		const solo = stateWith({ id: "s", title: "S", members: ["owner", "cto"] });
		const soloMessage = appendMessage(solo, "s", { from: "owner", text: "@cto 看一下", at: 1 }).message;
		const single = renderDeliveryWithTemplates({ channel: solo.channels.s!, message: soloMessage, viewer: "cto" });
		expect(single).toContain("这条会叫醒：cto（你在第 1 位）");
		expect(single).not.toContain("别人也在看这条");
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
			{ id: "p", title: "团队", members: ["owner", "cto"] },
		);
		state = appendMessage(state, "g", { from: "owner", text: "第一条", at: 1 }).state;
		state = appendMessage(state, "g", { from: "owner", text: "最新一条", at: 2 }).state;
		state = appendMessage(state, "p", { from: "owner", text: "团队里的事", at: 3 }).state;

		const digest = renderDigest(state, "cto");
		expect(digest).toContain("别的频道里还有 3 条没看");
		expect(digest).toContain("全员：2 条 — 最新一条");
		expect(digest).toContain("团队：1 条 — 团队里的事");
	});

	test("自己发的不算未读", () => {
		let state = stateWith({ id: "g", title: "G", members: ["owner", "cto"] });
		state = appendMessage(state, "g", { from: "cto", text: "我说的", at: 1 }).state;
		expect(renderDigest(state, "cto")).toBe("");
	});
});

describe("合并唤醒：同一会话最多一个未开始的排队项", () => {
	const submissions = [
		{ id: 1, conversationId: 7, status: "queued", requestId: "ch:team:x:3:lin" },
		{ id: 2, conversationId: 7, status: "placed", requestId: "ch:team:x:2:lin" },
		{ id: 3, conversationId: 9, status: "queued", requestId: "ch:team:x:3:gu" },
		{ id: 4, conversationId: 7, status: "queued", requestId: "ch:owner:team:x:1:lin" },
	];

	test("只挑同会话、还没开始的；正在跑的不算，别的会话不算，我排的队也算（连发要合并）", () => {
		expect(queuedAhead(submissions, 7)).toEqual([1, 4]);
		expect(queuedAhead(submissions, 9)).toEqual([3]);
	});

	test("连续三条只留一个未开始项，且一条消息都没丢", async () => {
		// 假 harness：提交进排队、撤销把状态改成 cancelled —— 够验「最多一个」这条约束。
		let nextId = 100;
		const queue: { id: number; conversationId: number; status: string; requestId?: string }[] = [];
		const submitted: string[] = [];
		const harness = {
			inspect: async () => ({ submissions: queue, tasks: [] }),
			abortSubmission: async (id: number) => {
				const found = queue.find((item) => item.id === id);
				if (found !== undefined) found.status = "cancelled";
			},
		} as unknown as Harness;
		const conversation = {
			id: 7,
			submit: async (input: { requestId?: string; content?: unknown }) => {
				queue.push({ id: nextId, conversationId: 7, status: "queued", requestId: input.requestId });
				submitted.push(String((input.content as { type: string; text?: string }[] | string) instanceof Array
					? (input.content as { text?: string }[]).map((part) => part.text ?? "").join("")
					: String(input.content)));
				return { id: nextId++ };
			},
		};

		// 发送方是成员而不是我：我自己的排期不合并（连说三句要按顺序答三句）。
		let state = stateWith({ id: "team:x", title: "X", members: ["owner", "lin", "gu"] });
		const bodies: string[] = [];
		for (const text of ["第一条", "第二条", "第三条"]) {
			const { state: next, message } = appendMessage(state, "team:x", { from: "lin", text, at: Date.now() });
			state = next;
			const result = await deliver({
				digests: new Map(),
				channel: state.channels["team:x"]!,
				message,
				targets: ["gu"],
				conversationOf: async () => conversation as never,
				coalesceQueue: async (conversationId, keepRequestId) => {
					const pending = queuedAhead((await harness.inspect()) .submissions, conversationId, keepRequestId);
					let merged = 0;
					for (const id of pending) {
						await harness.abortSubmission(id as number, undefined as never, undefined as never);
						merged += 1;
					}
					return merged;
				},
			});
			bodies.push(String(result.merged?.[0]?.count ?? 0));
		}

		// 每条消息都还在频道里（一条不漏），但同一时刻只有一个「还没开始」的排队项。
		expect(state.messages["team:x"]!.map((item) => item.text)).toEqual(["第一条", "第二条", "第三条"]);
		expect(submitted).toHaveLength(3);
		// 第一、二条各撤掉前一条没开始的，第三条撤掉第二条：合并计数 0、1、1。
		expect(bodies).toEqual(["0", "1", "1"]);
		expect(queue.filter((item) => item.status === "queued")).toHaveLength(1);
		expect(queue.filter((item) => item.status === "cancelled")).toHaveLength(2);
	});
});

describe("我连发三条也只排一个唤醒", () => {
	test("三条消息都在频道里，未开始项只剩一个", async () => {
		let nextId = 500;
		const queue: { id: number; conversationId: number; status: string; requestId?: string }[] = [];
		const harness = {
			inspect: async () => ({ submissions: queue, tasks: [] }),
			abortSubmission: async (id: number) => {
				const found = queue.find((item) => item.id === id);
				if (found !== undefined) found.status = "cancelled";
			},
		} as unknown as Harness;
		const conversation = {
			id: 7,
			submit: async (input: { requestId?: string }) => {
				queue.push({ id: nextId, conversationId: 7, status: "queued", requestId: input.requestId });
				return { id: nextId++ };
			},
		};
		const coalesceQueue = async (conversationId: number, keepRequestId: string) => {
			const pending = queuedAhead((await harness.inspect()).submissions, conversationId, keepRequestId);
			let merged = 0;
			for (const id of pending) {
				await harness.abortSubmission(id as number, undefined as never, undefined as never);
				merged += 1;
			}
			return merged;
		};

		let state = stateWith({ id: "team:x", title: "X", members: ["owner", "lin"] });
		const mergedCounts: number[] = [];
		for (const text of ["第一句", "第二句", "第三句"]) {
			const { state: next, message } = appendMessage(state, "team:x", { from: "owner", text, at: Date.now() });
			state = next;
			const result = await deliver({
				digests: new Map(),
				channel: state.channels["team:x"]!,
				message,
				targets: ["lin"],
				conversationOf: async () => conversation as never,
				// 我插队与「连发合并」现在同一条路（`coalesceQueue`）。
				coalesceQueue,
			});
			mergedCounts.push(result.merged?.[0]?.count ?? 0);
		}

		expect(state.messages["team:x"]!.map((item) => item.text)).toEqual(["第一句", "第二句", "第三句"]);
		expect(mergedCounts).toEqual([0, 1, 1]);
		expect(queue.filter((item) => item.status === "queued")).toHaveLength(1);
		expect(queue.filter((item) => item.status === "cancelled")).toHaveLength(2);
	});
});
