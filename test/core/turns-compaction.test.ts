/**
 * 压缩之后，轮次还得在。
 *
 * 事故：`turnsOf` 原来读 `conversation.context()`，那是**压缩之后**的活动上下文；
 * 一轮 `pi.compaction` 落下来，之前的 `core.channel` 就从视图里消失了，界面上的
 * 「后台任务」变成空列表 —— 人还在跑，看起来却像什么都没干。
 * 原文一直在 storage 里，这里守的是「从原文里翻回来」。
 */
import { describe, expect, it } from "vitest";
import { createRead } from "../../src/app/read.ts";

const channel = (id: number, seq: number) => ({
	id,
	conversationId: 7,
	kind: "core.channel",
	data: { channelId: "team:小恐龙", channelTitle: "小恐龙", seq, from: "owner", text: `第 ${seq} 句` },
});

const fixture = [
	channel(1, 5),
	{ id: 2, conversationId: 7, kind: "pi.assistant", model: [{ role: "assistant", content: [], timestamp: 1 }] },
	{ id: 3, conversationId: 7, kind: "pi.compaction", model: [{ role: "user", content: [] }] },
	{ id: 4, conversationId: 7, kind: "pi.assistant", model: [{ role: "assistant", content: [], timestamp: 2 }] },
];

/** 假 harness：只实现 `conversation().entries()` 的倒序分页（和真底座一样，新→旧）。 */
function shellOf(entries: readonly unknown[]) {
	const sorted = [...entries].sort((left, right) => (right as { id: number }).id - (left as { id: number }).id);
	return {
		harness: {
			conversation: async () => ({
				entries: async (_query: unknown, limit: number, cursor: unknown) => {
					const start = Number(cursor ?? 0);
					const items = sorted.slice(start, start + limit);
					const next = start + limit < sorted.length ? start + limit : undefined;
					return { items, ...(next === undefined ? {} : { next }) };
				},
			}),
			snapshot: async () => undefined,
		},
		registry: { snapshot: () => ({ tools: () => [] }) },
		labelOf: (slug: string) => slug,
	};
}

function snapshotsOf() {
	return {
		channelSnapshot: async () => ({
			directory: { slugToConversation: { 叶程: 7 }, conversationToSlug: { "7": "叶程" }, wake: {}, labels: {} },
			channels: { channels: {}, messages: {} },
		}),
	};
}

describe("轮次：压缩之后还在", () => {
	it("pi.compaction 之前的 core.channel 也切得出来", async () => {
		const read = createRead(shellOf(fixture) as never, snapshotsOf() as never);
		const { turns } = await read.readPersonTurns("叶程", 0, Number.MAX_SAFE_INTEGER, false);
		expect(turns.map((turn) => turn.seq)).toEqual([5]);
	});

	it("一条都没有时不编（空会话就是空列表）", async () => {
		const read = createRead(shellOf([]) as never, snapshotsOf() as never);
		const { turns } = await read.readPersonTurns("叶程", 0, Number.MAX_SAFE_INTEGER, false);
		expect(turns).toEqual([]);
	});
});
