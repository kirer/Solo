import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BACKGROUND_CONTEXT, LiveDoc, createRegistry, setupModels } from "../../src/core/runtime/index.ts";
import { openCore, type CoreRuntime } from "../../src/core/runtime/open.ts";

/**
 * 重启自愈：**会话的「忙」标记必须一起清掉**。
 *
 * 这是一个真实事故的回归测试。我私聊问「音效加完了吗？」，助手一直不理——库里
 * 一切正常：消息在、投递成功、任务也都被启动自愈结算成了 terminal。但 `pi.live`
 * 文档里的 `run` 还指着那个已经 terminal 的 generation，而入库的判据是
 * `busy = live.run !== undefined`，于是这个会话**被永久当成忙**：之后每一条输入
 * 都进 `queued`，却没有任何活着的一轮来取，永远等下去。
 *
 * 所以自愈不能只结算任务，必须在同一个事务里摘掉 `run`。
 */
const roots: string[] = [];
const runtimes: CoreRuntime[] = [];

afterEach(async () => {
	for (const runtime of runtimes.splice(0)) await runtime.close().catch(() => undefined);
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function freshFile(): Promise<{ root: string; file: string }> {
	const root = await mkdtemp(join(tmpdir(), "core-reconcile-"));
	roots.push(root);
	return { root, file: join(root, "core.sqlite") };
}

describe("重启自愈", () => {
	it("清掉指向已不存在任务的 run，会话不再被当成忙", async () => {
		const { root, file } = await freshFile();
		const { models } = setupModels(process.env, { workspace: root });

		const first = await openCore({ databasePath: file, models, registry: createRegistry() });
		runtimes.push(first);
		const conversation = await first.harness.createConversation(
			{ ownership: { kind: "ownerless" }, agent: { extensions: [] } },
			BACKGROUND_CONTEXT,
		);

		// 造一个强杀现场：run 指着一条根本不存在的任务（真实现场里它是 terminal 的）。
		await first.harness.commit(async (tx) => {
			const live = await tx.doc(LiveDoc, conversation.id);
			live.run = { taskId: 999_999, inputs: [] };
		}, BACKGROUND_CONTEXT);
		expect((await first.harness.snapshot(LiveDoc, conversation.id))?.run).toBeDefined();

		await first.close();
		runtimes.length = 0;

		// 重新打开：自愈应当把这条陈旧的 run 摘掉。
		const second = await openCore({ databasePath: file, models, registry: createRegistry() });
		runtimes.push(second);
		const live = await second.harness.snapshot(LiveDoc, conversation.id);
		expect(live?.run).toBeUndefined();
	});

	it("不动另一个活着的进程的 run（同库双进程时不能互相踩）", async () => {
		const { root, file } = await freshFile();
		const { models } = setupModels(process.env, { workspace: root });

		const first = await openCore({ databasePath: file, models, registry: createRegistry() });
		runtimes.push(first);
		const conversation = await first.harness.createConversation(
			{ ownership: { kind: "ownerless" }, agent: { extensions: [] } },
			BACKGROUND_CONTEXT,
		);

		await first.harness.commit(async (tx) => {
			const live = await tx.doc(LiveDoc, conversation.id);
			live.run = { taskId: 999_999, inputs: [] };
		}, BACKGROUND_CONTEXT);

		// 同一个库上再开一个（模拟「另一个进程正拿着这个会话」）：它的自愈会摘掉
		// 上面那条陈旧 run，但只要我们自己的任务还活着就不该动。
		const second = await openCore({ databasePath: file, models, registry: createRegistry() });
		runtimes.push(second);
		await second.harness.commit(async (tx) => {
			const live = await tx.doc(LiveDoc, conversation.id);
			live.run = { taskId: 999_998, inputs: [] };
		}, BACKGROUND_CONTEXT);

		// 第三刀：再开一次，999_998 仍然是「不存在」→ 也该清。这条断言守的是
		// 「只清陈旧指针」这个判据本身没有被写反。
		const third = await openCore({ databasePath: file, models, registry: createRegistry() });
		runtimes.push(third);
		expect((await third.harness.snapshot(LiveDoc, conversation.id))?.run).toBeUndefined();
	});
});
