/**
 * 处理中占位必须有人收尾（审计 A1）。
 *
 * 占位只在「同一个人往同一个频道发言」时被填充。他一轮没在这个频道说话，占位就永远
 * `pending` —— 实测 `proj:solo` 里挂过 175 分钟的「开始处理…」。两条兜底：
 * 1. 这一轮结算时收掉（`expirePlaceholders`）；
 * 2. 启动时按年龄收掉陈旧的（`expireStalePlaceholders`）。
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createRegistry, setupModels, BACKGROUND_CONTEXT } from "../../src/core/runtime/index.ts";
import { openCore, type CoreRuntime } from "../../src/core/runtime/open.ts";
import { ChannelDoc, ensureChannel, type ChannelState } from "../../src/core/channel/state.ts";
import { expirePlaceholders, expireStalePlaceholders, PLACEHOLDER_TTL_MS } from "../../src/core/channel/post.ts";

const roots: string[] = [];
const runtimes: CoreRuntime[] = [];

afterEach(async () => {
	for (const runtime of runtimes.splice(0)) await runtime.close().catch(() => undefined);
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function setup(): Promise<{ runtime: CoreRuntime; channelId: string }> {
	const root = await mkdtemp(join(tmpdir(), "core-placeholder-"));
	roots.push(root);
	const { models } = setupModels(process.env, { workspace: root });
	const runtime = await openCore({ databasePath: join(root, "core.sqlite"), models, registry: createRegistry() });
	runtimes.push(runtime);
	await runtime.harness.commit(async (tx) => {
		const doc = (await tx.doc(ChannelDoc)) as ChannelState;
		const seeded = ensureChannel(doc, { id: "proj:x", title: "X", members: ["owner", "lin"], wakeOnAll: [], at: 1 });
		doc.channels["proj:x"] = seeded.channels["proj:x"]!;
		doc.messages["proj:x"] = [
			// 一条仍被填的占位（刚起）和一条旧的
			{ seq: 1, at: Date.now(), from: "lin", text: "开始处理", kind: "chat", status: "pending", pendingFor: "lin", processing: true, mentions: [] },
			{ seq: 2, at: Date.now(), from: "owner", text: "在吗", kind: "chat", mentions: [] },
		];
		doc.nextSeq["proj:x"] = 3;
	}, BACKGROUND_CONTEXT);
	return { runtime, channelId: "proj:x" };
}

describe("一轮结束时收掉未填充的占位", () => {
	it("把该人该频道的 processing 占位标成 error，别人的消息不动", async () => {
		const { runtime, channelId } = await setup();
		const expired = await expirePlaceholders({ harness: runtime.harness }, channelId, "lin", BACKGROUND_CONTEXT);
		expect(expired).toBe(1);
		const state = (await runtime.harness.snapshot(ChannelDoc)) as ChannelState;
		const [placeholder, other] = state.messages[channelId]!;
		expect(placeholder?.status).toBe("error");
		expect(placeholder?.processing).toBe(false);
		expect(other?.text).toBe("在吗");
		expect(other?.status).toBeUndefined();
	});

	it("重复调用不会二次改动（已经被填的占位不再带 processing）", async () => {
		const { runtime, channelId } = await setup();
		await expirePlaceholders({ harness: runtime.harness }, channelId, "lin", BACKGROUND_CONTEXT);
		expect(await expirePlaceholders({ harness: runtime.harness }, channelId, "lin", BACKGROUND_CONTEXT)).toBe(0);
	});
});

describe("启动时收掉陈旧占位", () => {
	it("超过 TTL 的收掉，新的留着，别的频道也扫", async () => {
		const { runtime } = await setup();
		// 再放一条「两小时前」的占位
		await runtime.harness.commit(async (tx) => {
			const doc = (await tx.doc(ChannelDoc)) as ChannelState;
			doc.messages["dm:owner-lin"] = [
				{ seq: 1, at: Date.now() - 2 * 60 * 60_000, from: "lin", text: "开始处理", kind: "chat", status: "pending", pendingFor: "lin", processing: true, mentions: [] },
			];
			doc.nextSeq["dm:owner-lin"] = 2;
		}, BACKGROUND_CONTEXT);

		const expired = await expireStalePlaceholders(runtime.harness, PLACEHOLDER_TTL_MS, BACKGROUND_CONTEXT);
		expect(expired).toBe(1);

		const state = (await runtime.harness.snapshot(ChannelDoc)) as ChannelState;
		expect(state.messages["dm:owner-lin"]?.[0]?.status).toBe("error");
		// 刚起的那条还没到 TTL，留着继续转圈（他可能真的还在跑）。
		expect(state.messages["proj:x"]?.[0]?.processing).toBe(true);
	});
});
