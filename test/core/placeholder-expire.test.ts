/**
 * 处理中占位的收尾（审计 A1，返工后）。
 *
 * 规则改了两处：
 * 1. 未填的占位**删掉**，不是标 `status: "error"` —— 标 error 之后它是一条看得见的
 *    「他说了一句开始处理」，未读数、侧栏 preview、消息流全被污染；
 * 2. 只删**属于这一轮**的占位（`at <= 唤醒那条消息的 at`），老板中途插话新建的那条要留着。
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createRegistry, setupModels, BACKGROUND_CONTEXT } from "../../src/core/runtime/index.ts";
import { openCore, type CoreRuntime } from "../../src/core/runtime/open.ts";
import { ChannelDoc, ensureChannel, unreadCount, type ChannelState } from "../../src/core/channel/state.ts";
import { channelList } from "../../src/core/shell/view.ts";
import { expireStalePlaceholders, PLACEHOLDER_TTL_MS, removePlaceholders } from "../../src/core/channel/post.ts";

const roots: string[] = [];
const runtimes: CoreRuntime[] = [];

afterEach(async () => {
	for (const runtime of runtimes.splice(0)) await runtime.close().catch(() => undefined);
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

const HOUR = 60 * 60_000;

const directory = {
	slugToConversation: { owner: 0 },
	conversationToSlug: { "0": "owner" },
	wake: {},
	labels: {},
} as const;

async function setup(): Promise<{ runtime: CoreRuntime; channelId: string; wakeAt: number }> {
	const root = await mkdtemp(join(tmpdir(), "core-placeholder-"));
	roots.push(root);
	const { models } = setupModels(process.env, { workspace: root });
	const runtime = await openCore({ databasePath: join(root, "core.sqlite"), models, registry: createRegistry() });
	runtimes.push(runtime);
	const wakeAt = Date.now() - 5_000;
	await runtime.harness.commit(async (tx) => {
		const doc = (await tx.doc(ChannelDoc)) as ChannelState;
		const seeded = ensureChannel(doc, { id: "proj:x", title: "X", members: ["owner", "lin"], wakeOnAll: [], at: 1 });
		doc.channels["proj:x"] = seeded.channels["proj:x"]!;
		doc.messages["proj:x"] = [
			// #1 老板叫他（这一轮由它唤醒）
			{ seq: 1, at: wakeAt, from: "owner", text: "@lin 看一眼", kind: "chat", mentions: ["lin"] },
			// #2 这一轮的占位（没人填）
			{ seq: 2, at: wakeAt, from: "lin", text: "开始处理", kind: "chat", status: "pending", pendingFor: "lin", processing: true, mentions: [] },
		];
		doc.nextSeq["proj:x"] = 3;
	}, BACKGROUND_CONTEXT);
	return { runtime, channelId: "proj:x", wakeAt };
}

describe("一轮结束时删掉未填占位", () => {
	it("占位从消息里消失，未读数与侧栏 prett preview 都不变", async () => {
		const { runtime, channelId, wakeAt } = await setup();
		const before = (await runtime.harness.snapshot(ChannelDoc)) as ChannelState;
		// 占位在的时候它会被算成一条未读（`kind: chat`、发件人不是老板）——
		// 这正是「标成 error 气泡」会更糟的地方：它继续挂在消息流里、继续污染这两个数。
		expect(unreadCount(before, channelId, "owner")).toBe(1);

		expect(await removePlaceholders({ harness: runtime.harness }, channelId, "lin", wakeAt, BACKGROUND_CONTEXT)).toBe(1);

		const after = (await runtime.harness.snapshot(ChannelDoc)) as ChannelState;
		expect(after.messages[channelId]!.map((item) => item.seq)).toEqual([1]);
		// 删掉之后未读回到「这条占位从没存在过」的值，侧栏预览是老板自己那句。
		expect(unreadCount(after, channelId, "owner")).toBe(0);
		const rowAfter = channelList(after, directory)[0]!;
		expect(rowAfter.unread).toBe(0);
		expect(rowAfter.preview).toContain("看一眼");
		expect(rowAfter.preview).not.toContain("开始处理");
		// 没有任何「error 气泡」混进消息流
		expect(after.messages[channelId]!.some((item) => item.status === "error")).toBe(false);
	});

	it("老板插话后新建的占位不会被这一轮收尾误删", async () => {
		const { runtime, channelId, wakeAt } = await setup();
		// 老板中途插话：新消息 + 新一轮的占位（at 更晚）
		await runtime.harness.commit(async (tx) => {
			const doc = (await tx.doc(ChannelDoc)) as ChannelState;
			const list = doc.messages[channelId] as NonNullable<ChannelState["messages"][string]>;
			list.push({ seq: 3, at: wakeAt + 1_000, from: "owner", text: "补一句", kind: "chat", mentions: ["lin"] });
			list.push({ seq: 4, at: wakeAt + 1_000, from: "lin", text: "开始处理", kind: "chat", status: "pending", pendingFor: "lin", processing: true, mentions: [] });
			doc.nextSeq[channelId] = 5;
		}, BACKGROUND_CONTEXT);

		expect(await removePlaceholders({ harness: runtime.harness }, channelId, "lin", wakeAt, BACKGROUND_CONTEXT)).toBe(1);
		const after = (await runtime.harness.snapshot(ChannelDoc)) as ChannelState;
		// 这一轮那条删了，插话那一轮的占位还在
		expect(after.messages[channelId]!.map((item) => item.seq)).toEqual([1, 3, 4]);
		expect(after.messages[channelId]!.at(-1)?.processing).toBe(true);
	});
});

describe("启动时只清「不会有结果」的陈旧占位", () => {
	it("超过 TTL 且不在跑的删掉；正在跑的、刚起的一律留着", async () => {
		const { runtime, channelId } = await setup();
		await runtime.harness.commit(async (tx) => {
			const doc = (await tx.doc(ChannelDoc)) as ChannelState;
			// 两小时前的旧占位（lin）+ 另一个人的旧占位（gu，正在跑）
			doc.messages["dm:owner-lin"] = [
				{ seq: 1, at: Date.now() - 2 * HOUR, from: "lin", text: "开始处理", kind: "chat", status: "pending", pendingFor: "lin", processing: true, mentions: [] },
			];
			doc.messages["dm:owner-gu"] = [
				{ seq: 1, at: Date.now() - 2 * HOUR, from: "gu", text: "开始处理", kind: "chat", status: "pending", pendingFor: "gu", processing: true, mentions: [] },
			];
			doc.nextSeq["dm:owner-lin"] = 2;
			doc.nextSeq["dm:owner-gu"] = 2;
		}, BACKGROUND_CONTEXT);

		const removed = await expireStalePlaceholders(
			runtime.harness,
			{ maxAgeMs: PLACEHOLDER_TTL_MS, busySlugs: new Set(["gu"]) },
			BACKGROUND_CONTEXT,
		);
		expect(removed).toBe(1);
		const state = (await runtime.harness.snapshot(ChannelDoc)) as ChannelState;
		expect(state.messages["dm:owner-lin"]).toEqual([]);
		// 正在跑的那个人（gu）的占位留着；这一轮刚起的（proj:x #2）也留着
		expect(state.messages["dm:owner-gu"]?.[0]?.processing).toBe(true);
		expect(state.messages[channelId]?.some((item) => item.processing === true)).toBe(true);
	});
});
