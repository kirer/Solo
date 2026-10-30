/**
 * 文档压基线的时机（delta 回收上界）。
 *
 * 三个 `scope: "session"` 的文档都必须有确定的回收上界 —— 写 `() => false` 的后果是
 * 增量永不合并：实测名册 164 条 delta / 44KB，而频道文档只有 13 个。
 */
import { describe, expect, test } from "vitest";
import { DirectoryDoc } from "../../src/core/agent/roster.ts";
import { SettleDoc } from "../../src/core/team/settle.ts";
import { ChannelDoc } from "../../src/core/channel/store.ts";

const checkpointOf = (token: unknown) =>
	(token as { definition: { checkpointWhen: (value: unknown, ops: readonly unknown[], info: { deltasSinceBase: number }) => boolean } })
		.definition.checkpointWhen;

describe("名册 / 沉淀游标：按增量条数压基线", () => {
	test("名册：不到 64 条增量不压，到了就压（不再永不合并）", () => {
		const checkpoint = checkpointOf(DirectoryDoc);
		expect(checkpoint({ slugToConversation: {}, conversationToSlug: {}, wake: {}, labels: {} }, [], { deltasSinceBase: 63 })).toBe(false);
		expect(checkpoint({ slugToConversation: {}, conversationToSlug: {}, wake: {}, labels: {} }, [], { deltasSinceBase: 64 })).toBe(true);
	});

	test("沉淀游标：同样 64 条一次", () => {
		const checkpoint = checkpointOf(SettleDoc);
		expect(checkpoint({ cursors: {} }, [], { deltasSinceBase: 63 })).toBe(false);
		expect(checkpoint({ cursors: {} }, [], { deltasSinceBase: 64 })).toBe(true);
	});

	test("频道文档仍然有上界：短频道 64、长频道 16（防止每条都压整份历史）", () => {
		const checkpoint = checkpointOf(ChannelDoc);
		const short = { messages: { all: Array.from({ length: 10 }, () => ({})) } };
		const long = { messages: { all: Array.from({ length: 300 }, () => ({})) } };
		expect(checkpoint(short, [], { deltasSinceBase: 64 })).toBe(true);
		expect(checkpoint(long, [], { deltasSinceBase: 1 })).toBe(false);
		expect(checkpoint(long, [], { deltasSinceBase: 16 })).toBe(true);
	});
});
