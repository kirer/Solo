import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { BACKGROUND_CONTEXT, createRegistry, setupModels } from "../../src/core/runtime/index.ts";
import { openCore, type CoreRuntime } from "../../src/core/runtime/open.ts";
import { ChannelDoc, ensureChannel, type ChannelState } from "../../src/core/channel/state.ts";
import { postMessage } from "../../src/core/channel/post.ts";

/**
 * 频道写入的**代价**契约（不只是结果对不对）。
 *
 * 这里守的是一个曾经真实发生过的事故：消息存对了、界面也对，但每发一条消息都把
 * 该频道的**全部历史**重写一遍。一个 189 条消息的频道因此吃掉 27 MB，整个库 60 MB，
 * 而它的真实状态只有 0.7 MB —— 85 倍放大，并且随消息数平方增长。
 *
 * 所以断言不看「消息在不在」，看「写一条消息付出多少字节」。这类退化在功能测试里
 * 完全不可见：所有测试都能过，只有磁盘在涨。
 */
const roots: string[] = [];
const runtimes: CoreRuntime[] = [];

afterEach(async () => {
	for (const runtime of runtimes.splice(0)) await runtime.close().catch(() => undefined);
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

/** 频道文档在库里占的字节数（基线 + 全部增量）。 */
function storedBytes(file: string, kind: string): number {
	const db = new DatabaseSync(file);
	const row = db
		.prepare(
			`select coalesce(sum(length(r.content)), 0) as bytes
			 from document_revisions r join documents d on d.id = r.document_id
			 where json_extract(d.record, '$.kind') = ?`,
		)
		.get(kind) as { bytes: number } | undefined;
	db.close();
	return row?.bytes ?? 0;
}

async function setup(): Promise<{ runtime: CoreRuntime; file: string; channelId: string }> {
	const root = await mkdtemp(join(tmpdir(), "core-write-"));
	roots.push(root);
	const file = join(root, "core.sqlite");
	const { models } = setupModels(process.env, { workspace: root });
	const runtime = await openCore({ databasePath: file, models, registry: createRegistry() });
	runtimes.push(runtime);
	const channelId = "proj:计费";
	await runtime.harness.commit(async (tx) => {
		const doc = (await tx.doc(ChannelDoc)) as ChannelState;
		doc.channels[channelId] = ensureChannel(doc, {
			id: channelId,
			title: "计费",
			members: ["owner", "林越"],
			wakeOnAll: [],
			at: 1,
		}).channels[channelId] as never;
		doc.nextSeq[channelId] = 1;
	}, BACKGROUND_CONTEXT);
	return { runtime, file, channelId };
}

describe("频道写入的字节代价", () => {
	it("每追加一条消息只花消息本身那么多字节，不重写整个频道", async () => {
		const { runtime, file, channelId } = await setup();
		const text = "记".repeat(200);
		const perMessage = 200 * 3 + 200; // UTF-8 三字节 + JSON 结构余量

		for (let index = 0; index < 40; index += 1) {
			const state = (await runtime.harness.snapshot(ChannelDoc, BACKGROUND_CONTEXT)) as ChannelState;
			await postMessage(
				{ harness: runtime.harness, state, conversationOf: async () => undefined },
				{ channelId, from: "林越", text, at: 100 + index, wake: false },
				BACKGROUND_CONTEXT,
			);
		}

		const state = (await runtime.harness.snapshot(ChannelDoc, BACKGROUND_CONTEXT)) as ChannelState;
		expect(state.messages[channelId]?.length).toBe(40);

		// 整值替换的实现下这里是 40²/2 条消息 = 约 100 万字节级别；线性写入不到 5 万。
		const bytes = storedBytes(file, "core.channels");
		expect(bytes).toBeLessThan(40 * perMessage + 20_000);
	});

	it("压基线之后旧增量被回收，库不会只增不减", async () => {
		const { runtime, file, channelId } = await setup();
		// 触发点：`deltasSinceBase >= 64`。
		for (let index = 0; index < 70; index += 1) {
			const state = (await runtime.harness.snapshot(ChannelDoc, BACKGROUND_CONTEXT)) as ChannelState;
			await postMessage(
				{ harness: runtime.harness, state, conversationOf: async () => undefined },
				{ channelId, from: "林越", text: `第 ${index} 条`, at: 200 + index, wake: false },
				BACKGROUND_CONTEXT,
			);
		}

		const state = (await runtime.harness.snapshot(ChannelDoc, BACKGROUND_CONTEXT)) as ChannelState;
		expect(state.messages[channelId]?.length).toBe(70);

		const db = new DatabaseSync(file);
		const bases = db
			.prepare(
				`select count(*) as n from document_revisions r join documents d on d.id = r.document_id
				 where json_extract(d.record, '$.kind') = 'core.channels' and r.kind = 'base'`,
			)
			.get() as { n: number };
		db.close();
		// 压过基线就是「一个基线 + 少量增量」，不是「一个初始基线 + 70 条增量」。
		expect(bases.n).toBeGreaterThanOrEqual(1);
		const bytes = storedBytes(file, "core.channels");
		expect(bytes).toBeLessThan(120_000);
	});
});
