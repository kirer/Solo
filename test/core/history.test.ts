import { describe, expect, it } from "vitest";
import { BACKGROUND_CONTEXT } from "../../src/core/runtime/index.ts";
import { createCoreTools } from "../../src/core/channel/tools/index.ts";
import { emptyDirectory } from "../../src/core/agent/roster.ts";

/**
 * `read_history` 守的事故：上下文被压成 `pi.compaction` 之后，原文还在 storage 里，
 * 但模型再也看不见、也没有任何工具能读回 —— 于是它开始凭记忆编路径、编数字、编原话，
 * 而且错得无法被发现。这里测的是「能查回来」。
 */
type Fixture = { readonly id: number; readonly kind: string; readonly text: string; readonly at: number };

const NOW = Date.UTC(2026, 9, 27, 12, 0, 0);

/** 一个假 harness：只实现 read_history 用到的 `conversation().entries()` 分页。 */
function harnessOf(fixtures: readonly Fixture[]) {
	const sorted = [...fixtures].sort((left, right) => right.id - left.id);
	return {
		conversation: async () => ({
			entries: async (query: { maxEntryId?: number }, limit: number, cursor: unknown) => {
				const cap = query.maxEntryId === undefined ? Number.POSITIVE_INFINITY : Number(query.maxEntryId);
				const pool = sorted.filter((item) => item.id <= cap);
				const start = Number(cursor ?? 0);
				const items = pool.slice(start, start + limit).map((fixture) => ({
					id: fixture.id,
					conversationId: 7,
					kind: fixture.kind,
					model: [{ content: [{ type: "text", text: fixture.text }], timestamp: fixture.at }],
				}));
				const next = start + limit < pool.length ? start + limit : undefined;
				return { items, ...(next === undefined ? {} : { next }) };
			},
		}),
	};
}

async function ask(fixtures: readonly Fixture[], args: Record<string, unknown>): Promise<string> {
	const tools = createCoreTools({
		harness: harnessOf(fixtures) as never,
		workspaceRoot: "/tmp/nowhere-history",
		agentsRoot: "/tmp/nowhere-history/agents",
		teamsRoot: "/tmp/nowhere-history/teams",
		directory: async () => emptyDirectory(),
		saveDirectory: async () => undefined,
	} as never);
	const tool = tools.find((item) => item.name === "read_history");
	expect(tool).toBeDefined();
	const result = await tool?.execute(
		args as never,
		{ conversationId: 7 } as never,
		BACKGROUND_CONTEXT,
	);
	const output = result?.output as readonly { text?: string }[] | undefined;
	return output?.[0]?.text ?? "";
}

const fixtures: readonly Fixture[] = [
	{ id: 1, kind: "pi.user", text: "把服务端口改成 7799，别用 7788", at: NOW - 86_400_000 },
	{ id: 2, kind: "pi.assistant", text: "改好了，跑的是 7799", at: NOW - 80_000_000 },
	{ id: 3, kind: "pi.compaction", text: "之前聊过端口和一次失败的迁移", at: NOW - 70_000_000 },
	{ id: 4, kind: "pi.assistant", text: "现在去写总结", at: NOW - 60_000 },
];

describe("read_history", () => {
	it("不给参数就取最近几条，并给出往前翻的入口", async () => {
		const output = await ask(fixtures, { limit: 2 });
		expect(output).toContain("现在去写总结");
		expect(output).toContain("之前聊过端口");
		expect(output).not.toContain("7799，别用");
		expect(output).toContain("around=3");
	});

	it("按关键词跨页找得到被压缩掉的原文", async () => {
		const many: Fixture[] = [
			{ id: 1, kind: "pi.user", text: "旧的原话：端口 7799", at: NOW - 900_000_000 },
			...Array.from({ length: 70 }, (_, index) => ({
				id: index + 2,
				kind: "pi.assistant",
				text: `第 ${index} 句无关的话`,
				at: NOW - 800_000_000 + index * 1000,
			})),
		];
		const output = await ask(many, { query: "7799", limit: 1 });
		expect(output).toContain("端口 7799");
		expect(output).toContain("[#1");
	});

	it("压缩摘要标出来源，别让摘要冒充原话", async () => {
		const output = await ask(fixtures, { limit: 12 });
		expect(output).toContain("[压缩摘要]: 之前聊过端口");
	});

	it("没有命中时说人话", async () => {
		expect(await ask(fixtures, { query: "完全不存在的东西" })).toBe("这个会话里没有匹配的记录。");
	});

	it("around 只往前取，不重复已经看过的", async () => {
		const output = await ask(fixtures, { around: 3, limit: 5 });
		expect(output).toContain("[#2");
		expect(output).not.toContain("[#3");
		expect(output).toContain("[#1");
	});
});
