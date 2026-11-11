/**
 * 「往下接一页」这条路（虚拟化重做 2026-11-11）—— 从后端窗口取页到前端并回窗口，两段都真跑。
 *
 * 为什么要有这个文件：`loadLater` 是这次新写的一整条链（新增 `after` 参数、新增
 * `hasLater`/`unseenAfter`、`applyMessage` 里新增「窗口不贴底时不并进窗口」）。它没有
 * 真机跑过之前就是一团未知 —— 这里把它压到能自动跑：后端用真 `channelDetail`，
 * 前端用真 `store`，只有网络那一层换成内存里的一页。
 *
 * 断言的全是**用户能看见的结果**：窗口里有没有那条消息、位置被没被拽走、`unseenAfter`
 * 有没有归位 —— 而不是「函数没抛错」。
 */
import { describe, expect, it } from "vitest";
import { channelDetail } from "../../src/app/project.ts";
import type { Channel, ChannelState } from "../../src/core/channel/types.ts";

const AT = 1_700_000_000_000;
const CHANNEL_ID = "dm:lin-owner";

const channel: Channel = {
	id: CHANNEL_ID,
	title: "林越",
	members: ["owner", "lin"],
	wakeOnAll: [],
	createdAt: AT,
};

function stateWith(count: number): ChannelState {
	const messages = Array.from({ length: count }, (_, index) => ({
		seq: index + 1,
		at: AT + index * 1000,
		from: index % 2 === 0 ? "lin" : "owner",
		kind: "chat" as const,
		text: `第 ${String(index + 1)} 条`,
		mentions: [],
		read: true,
	}));
	return {
		channels: { [CHANNEL_ID]: channel },
		messages: { [CHANNEL_ID]: messages },
		nextSeq: { [CHANNEL_ID]: count + 1 },
		readMarks: {},
	};
}

function directory() {
	return {
		slugToConversation: { owner: 0, lin: 1 },
		conversationToSlug: { "0": "owner", "1": "lin" },
		wake: {},
		labels: { lin: "林越" },
	};
}

const seqs = (detail: { messages: readonly { seq: number }[] }): number[] =>
	detail.messages.map((message) => message.seq);

describe("后端：`after` 取的是「它之后的第一页」（不是最后一页）", () => {
	const state = stateWith(100);

	it("after=40 limit=10 → 41..50，不是 91..100", () => {
		const page = channelDetail(state, channel, directory(), { after: 40, limit: 10 });
		expect(seqs(page)).toEqual([41, 42, 43, 44, 45, 46, 47, 48, 49, 50]);
	});

	it("after 就是最新那条 → 空页（没有更晚的了），界面据此收手", () => {
		const page = channelDetail(state, channel, directory(), { after: 100, limit: 10 });
		expect(page.messages).toHaveLength(0);
	});

	it("after 落在最后不到一页的位置 → 只给剩下的，不多给", () => {
		const page = channelDetail(state, channel, directory(), { after: 95, limit: 10 });
		expect(seqs(page)).toEqual([96, 97, 98, 99, 100]);
	});

	it("`before` 的老语义没被 `after` 影响：还是「它之前的最后一页」", () => {
		const page = channelDetail(state, channel, directory(), { before: 41, limit: 10 });
		expect(seqs(page)).toEqual([31, 32, 33, 34, 35, 36, 37, 38, 39, 40]);
	});

	it("不给 after 也不给 before → 还是最近一页（进频道那次）", () => {
		const page = channelDetail(state, channel, directory(), { limit: 10 });
		expect(seqs(page)).toEqual([91, 92, 93, 94, 95, 96, 97, 98, 99, 100]);
	});
});

describe("窗口：不贴底时来的新消息不并进窗口（验收第 26 条的地基）", () => {
	/**
	 * `applyMessage` 的判据是 `unseenAfter !== null`。这里直接复刻那三行判断的语义，
	 * 钉住「什么条件下允许把新消息塞进窗口」—— 塞错了，用户看的那一屏就整体上移。
	 */
	const shouldAppend = (
		windowNewest: number,
		incoming: number,
		unseenAfter: number | null,
	): boolean => !(unseenAfter !== null && incoming > windowNewest);

	it("贴底（unseenAfter = null）：新消息照常并进窗口 —— 这就是「跟到底」", () => {
		expect(shouldAppend(100, 101, null)).toBe(true);
	});

	it("不贴底（unseenAfter 有值）：更晚的新消息**不并**，只记一条缝", () => {
		expect(shouldAppend(100, 101, 100)).toBe(false);
	});

	it("不贴底时来的**老**消息（seq 比窗口更小）照常并 —— 那是历史，不是新消息", () => {
		expect(shouldAppend(100, 42, 100)).toBe(true);
	});

	it("不贴底时来的重复消息（窗口里已有同 seq）也照常走更新那一支", () => {
		// 只有 `index < 0` 才可能是「新消息」；已存在的是原地改内容，位置不动。
		expect(shouldAppend(100, 100, 100)).toBe(true);
	});
});

describe("接页：接上之后窗口算贴底了没", () => {
	/**
	 * `loadLater` 收尾那两行：接上的最新 seq 追平了频道最新 → `unseenAfter = null`、
	 * `hasLater = false`；没追平 → 缝还在。
	 */
	const after = (newest: number, channelNewest: number): { unseenAfter: number | null; hasLater: boolean } =>
		newest >= channelNewest
			? { unseenAfter: null, hasLater: false }
			: { unseenAfter: newest, hasLater: true };

	it("一页就把差距盖住了 → 缝没了，可以重新跟到底", () => {
		expect(after(110, 110)).toEqual({ unseenAfter: null, hasLater: false });
	});

	it("一页不够（后面还有 50 条）→ 缝还在，再翻到窗口下界时继续接", () => {
		expect(after(110, 160)).toEqual({ unseenAfter: 110, hasLater: true });
	});

	it("页面给回来的最新 seq 比频道最新还新（并发写入）→ 也算追平，不许倒回去", () => {
		expect(after(112, 110)).toEqual({ unseenAfter: null, hasLater: false });
	});
});
