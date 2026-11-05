/**
 * 裸 harness 的并发契约：同一份文档的 commit 会被底座排队，不同文档的可以并行。
 *
 * 1.5.0 的 group commit 取代了 Solo 原来的 `serializedHarness`（全局串行所有 commit）。
 * 这组用例是删掉那层包装**之后**仍然成立的底线：
 *
 * - 同一频道 30 个并发追加，一条不少、seq 连续、不抛 `Cannot use a settled overlay`；
 * - 频道与名册两份文档同时写，各自完整；
 * - 一个 commit 在事务里等待时，后一个同文档 commit 会等它，而不是读同一个覆盖层。
 *
 * 这些用例不经过 `post.ts` 的串行闸（那层保护的是 commit 之前的元数据读），
 * 直接压在 `appendToChannel` / `rememberWake` 的 commit 上。
 */
import { afterEach, describe, expect, it } from "vitest";
import { BACKGROUND_CONTEXT } from "../../src/core/runtime/index.ts";
import type { CoreRuntime } from "../../src/core/runtime/open.ts";
import { ChannelDoc, type ChannelState } from "../../src/core/channel/types.ts";
import { appendToChannel } from "../../src/core/channel/write.ts";
import { ensureChannel } from "../../src/core/channel/rules.ts";
import { DirectoryDoc, directoryWake, type DirectoryState } from "../../src/core/agent/roster.ts";
import { sandboxPool } from "./support.ts";

const pool = sandboxPool();

afterEach(() => pool.cleanup());

async function setup(): Promise<{ runtime: CoreRuntime; channelId: string }> {
	const box = await pool.make("core-commit-");
	const runtime = await box.open();
	const channelId = "team:并发";
	await runtime.harness.commit(async (tx) => {
		const doc = (await tx.doc(ChannelDoc)) as ChannelState;
		doc.channels[channelId] = ensureChannel(doc, {
			id: channelId,
			title: "并发",
			members: ["owner", "林越"],
			wakeOnAll: [],
			at: 1,
		}).channels[channelId] as never;
		doc.nextSeq[channelId] = 1;
	}, BACKGROUND_CONTEXT);
	return { runtime, channelId };
}

describe("group commit：同一文档并发", () => {
	it("30 个并发追加全部落库，seq 连续且不撞号", async () => {
		const { runtime, channelId } = await setup();
		const results = await Promise.allSettled(
			Array.from({ length: 30 }, (_, index) =>
				appendToChannel(
					{ harness: runtime.harness },
					{ channelId, from: "林越", text: `第 ${index} 条`, at: 100 + index },
					BACKGROUND_CONTEXT,
				),
			),
		);

		const rejected = results.filter((item) => item.status === "rejected");
		expect(rejected).toEqual([]);

		const state = (await runtime.harness.snapshot(ChannelDoc, BACKGROUND_CONTEXT)) as ChannelState;
		const messages = state.messages[channelId] ?? [];
		expect(messages).toHaveLength(30);
		expect(messages.map((item) => item.seq).sort((a, b) => a - b)).toEqual(
			Array.from({ length: 30 }, (_, index) => index + 1),
		);
		expect(new Set(messages.map((item) => item.text)).size).toBe(30);
		expect(state.nextSeq[channelId]).toBe(31);
	});

	it("前一个 commit 在事务里等待时，后一个同文档 commit 排队而不是撞覆盖层", async () => {
		const { runtime, channelId } = await setup();
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});

		const first = runtime.harness.commit(async (tx) => {
			const doc = (await tx.doc(ChannelDoc)) as ChannelState;
			doc.nextSeq[channelId] = 10;
			await gate;
			doc.messages[channelId] = [
				...(doc.messages[channelId] ?? []),
				{
					seq: 10,
					from: "林越",
					text: "先开始的事务",
					at: 1,
					kind: "chat",
					mentions: [],
				} as never,
			];
		}, BACKGROUND_CONTEXT);

		await new Promise((resolve) => setTimeout(resolve, 10));
		const second = appendToChannel(
			{ harness: runtime.harness },
			{ channelId, from: "林越", text: "后开始的追加", at: 2 },
			BACKGROUND_CONTEXT,
		);
		await new Promise((resolve) => setTimeout(resolve, 10));
		release();

		const [firstResult, secondResult] = await Promise.allSettled([first, second]);
		expect(firstResult.status).toBe("fulfilled");
		expect(secondResult.status).toBe("fulfilled");

		const state = (await runtime.harness.snapshot(ChannelDoc, BACKGROUND_CONTEXT)) as ChannelState;
		const messages = state.messages[channelId] ?? [];
		expect(messages.map((item) => item.text).sort()).toEqual(["先开始的事务", "后开始的追加"]);
		expect(new Set(messages.map((item) => item.seq)).size).toBe(messages.length);
		expect(state.nextSeq[channelId]).toBe(Math.max(...messages.map((item) => item.seq)) + 1);
	});
});

describe("group commit：不同文档并行", () => {
	it("频道追加与名册唤醒同时写，两份都完整", async () => {
		const { runtime, channelId } = await setup();
		const people = Array.from({ length: 20 }, (_, index) => ({ slug: `人${index}`, id: index + 1 }));

		await runtime.harness.commit(async (tx) => {
			const doc = (await tx.doc(DirectoryDoc)) as DirectoryState;
			for (const person of people) {
				doc.slugToConversation[person.slug] = person.id;
				doc.conversationToSlug[String(person.id)] = person.slug;
			}
		}, BACKGROUND_CONTEXT);

		const wake = directoryWake({ harness: runtime.harness });
		const spot = { channelId, seq: 1, from: "我", at: 1 };
		const writes = [
			...Array.from({ length: 20 }, (_, index) =>
				appendToChannel(
					{ harness: runtime.harness },
					{ channelId, from: "林越", text: `消息 ${index}`, at: 100 + index },
					BACKGROUND_CONTEXT,
				),
			),
			...people.map((person) =>
				wake.rememberWake(person.slug, { reply: spot, task: spot }, BACKGROUND_CONTEXT),
			),
		];

		const results = await Promise.allSettled(writes);
		expect(results.filter((item) => item.status === "rejected")).toEqual([]);

		const channels = (await runtime.harness.snapshot(ChannelDoc, BACKGROUND_CONTEXT)) as ChannelState;
		expect(channels.messages[channelId]).toHaveLength(20);
		expect(channels.nextSeq[channelId]).toBe(21);

		const directory = (await runtime.harness.snapshot(DirectoryDoc, BACKGROUND_CONTEXT)) as DirectoryState;
		expect(Object.keys(directory.wake).sort()).toEqual(people.map((person) => String(person.id)).sort());
	});
});
