import { afterEach, describe, expect, it } from "vitest";
import { BACKGROUND_CONTEXT, type Conversation } from "../../src/core/runtime/index.ts";
import { ChannelDoc, OWNER, type ChannelState } from "../../src/core/channel/types.ts";
import { appendMessage, ensureChannel } from "../../src/core/channel/rules.ts";
import { postMessage } from "../../src/core/channel/post.ts";
import { sandboxPool } from "./support.ts";

/**
 * 投递失败必须看得见。
 *
 * 原来这一份还守「接力上限」（`wakeOnAll` 让 A→B→A 无限循环）。V3 删掉了
 * `relayLimit` / `botHopsSinceOwner`，改由 `rules.md` 第 13 条「别自己跟自己聊超过两轮」
 * 约束（ADR-090）。但「投递失败 / 没会话只写 stderr、频道里什么都没有」那条 bug 跟接力
 * 无关，必须继续守 —— 我看到的「我说了没人理」和「系统挂了」不能长得一模一样。
 */
function emptyState(): ChannelState {
	return { channels: {}, messages: {}, nextSeq: {}, readMarks: {} };
}

function stateWithChannel(): ChannelState {
	return ensureChannel(emptyState(), {
		id: "team:x",
		title: "团队",
		members: [OWNER, "a", "b"],
		wakeOnAll: ["a", "b"],
		at: 1,
	});
}

const pool = sandboxPool();

afterEach(() => pool.cleanup());

type FakeConversation = { conversation: Conversation; submitted: string[] };

async function setup(members: string[], wakeOnAll: string[]) {
	const runtime = await (await pool.make("core-relay-")).open();
	const channelId = "team:x";
	await runtime.harness.commit(async (tx) => {
		const doc = (await tx.doc(ChannelDoc)) as ChannelState;
		Object.assign(doc, ensureChannel(emptyState(), { id: channelId, title: "团队", members, wakeOnAll, at: 1 }));
	}, BACKGROUND_CONTEXT);

	const submitted: string[] = [];
	const fake = (slug: string): FakeConversation => ({
		conversation: {
			id: slug === "a" ? "1" : "2",
			submit: async (input: { content: string }) => {
				submitted.push(`${slug}:${input.content}`);
			},
		} as unknown as Conversation,
		submitted,
	});
	const fakes = new Map<string, FakeConversation>();
	const state = async () => (await runtime.harness.snapshot(ChannelDoc, BACKGROUND_CONTEXT)) as ChannelState;
	const post = async (input: {
		from: string;
		text: string;
		at: number;
		wake?: false;
		conversationOf?: (slug: string) => Promise<Conversation | undefined>;
	}) =>
		postMessage(
			{
				harness: runtime.harness,
				state: await state(),
				conversationOf:
					input.conversationOf ??
					(async (slug: string) => {
						const known = fakes.get(slug);
						return known === undefined ? undefined : known.conversation;
					}),
			},
			{
				channelId,
				from: input.from,
				text: input.text,
				at: input.at,
				...(input.wake === false ? { wake: false as const } : {}),
			},
			BACKGROUND_CONTEXT,
		);
	for (const slug of members.filter((slug) => slug !== OWNER)) fakes.set(slug, fake(slug));
	return { runtime, channelId, state, post, submitted };
}

describe("投递失败可见", () => {
	it("目标是 agent 但没有会话时，频道里留一条说明", async () => {
		const { state, post } = await setup([OWNER, "a"], []);
		const result = await post({ from: OWNER, text: "@a 在吗", at: 2, conversationOf: async () => undefined });
		expect(result.delivery.delivered).toEqual([]);
		expect(result.delivery.skipped).toEqual(["a"]);
		const channel = (await state()).messages["team:x"]!;
		expect(channel.at(-1)!.kind).toBe("note");
		expect(channel.at(-1)!.from).toBe(OWNER);
		expect(channel.at(-1)!.text).toContain("还没有会话");
		expect(channel.at(-1)!.text).toContain("@a");
	});

	it("投递抛错时写明是谁、为什么", async () => {
		const { state, post } = await setup([OWNER, "a"], []);
		const result = await post({
			from: OWNER,
			text: "@a 看下这个",
			at: 2,
			conversationOf: async () =>
				({ id: "9", submit: async () => { throw new Error("会话已关闭"); } }) as unknown as Conversation,
		});
		expect(result.delivery.failed).toEqual(["a"]);
		const channel = (await state()).messages["team:x"]!;
		expect(channel.at(-1)!.kind).toBe("note");
		expect(channel.at(-1)!.text).toContain("投递失败：会话已关闭");
	});
});
