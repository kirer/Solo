import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BACKGROUND_CONTEXT, createRegistry, setupModels } from "../../src/core/runtime/index.ts";
import { openCore, type CoreRuntime } from "../../src/core/runtime/open.ts";
import { ChannelDoc, appendMessage, ensureChannel, type ChannelState } from "../../src/core/channel/state.ts";
import type { DirectoryState } from "../../src/core/agent/roster.ts";
import { rescueAnswer, spokeAfterWake } from "../../src/core/shell/rescue.ts";

/**
 * 「他答了，但没说出来」的安全网。
 *
 * 真事（2026-10-29）：会话 2 的 transcript 里躺着 `sleep 45 跑完、耗时 45 秒…`
 * 这段最终回答，可 `company` 频道里只有「开始处理…」。老板看到的是「问了没人理」。
 * 所以这里守的不是「能不能发」，而是三条判据：别抢跑、别重复、别替系统消息说话。
 */
const roots: string[] = [];
const runtimes: CoreRuntime[] = [];

afterEach(async () => {
	for (const runtime of runtimes.splice(0)) await runtime.close().catch(() => undefined);
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

const CHANNEL = "proj:计费";
const SLUG = "林越";

async function setup(): Promise<{ runtime: CoreRuntime; directory: DirectoryState; conversationId: number }> {
	const root = await mkdtemp(join(tmpdir(), "core-rescue-"));
	roots.push(root);
	const { models } = setupModels(process.env, { workspace: root });
	const runtime = await openCore({ databasePath: join(root, "core.sqlite"), models, registry: createRegistry() });
	runtimes.push(runtime);
	await runtime.harness.commit(async (tx) => {
		const doc = (await tx.doc(ChannelDoc)) as ChannelState;
		doc.channels[CHANNEL] = ensureChannel(doc, {
			id: CHANNEL,
			title: "计费",
			members: ["owner", SLUG],
			wakeOnAll: [],
			at: 1,
		}).channels[CHANNEL] as never;
		doc.nextSeq[CHANNEL] = 1;
	}, BACKGROUND_CONTEXT);
	const directory = {
		wake: { "7": { channelId: CHANNEL, seq: 1, from: "owner", at: 1 } },
		slugToConversation: { [SLUG]: 7, owner: 1 },
	} as unknown as DirectoryState;
	return { runtime, directory, conversationId: 7 };
}

/** 老板在频道里说一句（给他一个唤醒位）。 */
async function ownerSpeaks(runtime: CoreRuntime, text: string): Promise<number> {
	const { postMessage } = await import("../../src/core/channel/post.ts");
	const state = (await runtime.harness.snapshot(ChannelDoc, BACKGROUND_CONTEXT)) as ChannelState;
	const result = await postMessage(
		{ harness: runtime.harness, state, conversationOf: async () => undefined },
		{ channelId: CHANNEL, from: "owner", text, at: 100, wake: false },
		BACKGROUND_CONTEXT,
	);
	return result.message.seq;
}

async function messagesOf(runtime: CoreRuntime): Promise<ChannelState["messages"][string]> {
	const state = (await runtime.harness.snapshot(ChannelDoc, BACKGROUND_CONTEXT)) as ChannelState;
	return state.messages[CHANNEL] ?? [];
}

describe("补发他答了但没说出的话", () => {
	it("他没说过话时，替他把正文发到被叫醒的频道", async () => {
		const { runtime, directory } = await setup();
		await ownerSpeaks(runtime, "@林越 跑完了吗");
		const outcome = await rescueAnswer(runtime.harness, SLUG, 7, "跑完了，耗时 45 秒。", { loadDirectory: async () => directory });
		expect(outcome).toBe("posted");
		const list = await messagesOf(runtime);
		expect(list.at(-1)?.from).toBe(SLUG);
		expect(list.at(-1)?.text).toBe("跑完了，耗时 45 秒。");
		// 落库的是真发言，不是投影消息 —— 否则前端会把它当过程行折起来。
		expect(list.at(-1)?.kind).toBe("say");
	});

	it("他已经自己说过了就不补（同一条唤醒只补一次）", async () => {
		const { runtime, directory } = await setup();
		const seq = await ownerSpeaks(runtime, "@林越 跑完了吗");
		const { postMessage } = await import("../../src/core/channel/post.ts");
		const state = (await runtime.harness.snapshot(ChannelDoc, BACKGROUND_CONTEXT)) as ChannelState;
		await postMessage(
			{ harness: runtime.harness, state, conversationOf: async () => undefined },
			{ channelId: CHANNEL, from: SLUG, text: "跑完了。", at: 200, wake: false },
			BACKGROUND_CONTEXT,
		);
		directory.wake["7"] = { channelId: CHANNEL, seq, from: "owner", at: 1 };
		expect(await rescueAnswer(runtime.harness, SLUG, 7, "跑完了，耗时 45 秒。", { loadDirectory: async () => directory })).toBe("skipped");
		expect((await messagesOf(runtime)).filter((item) => item.from === SLUG)).toHaveLength(1);
	});

	it("没有唤醒位（他从没被叫过）就补不了，也不瞎猜频道", async () => {
		const { runtime } = await setup();
		await ownerSpeaks(runtime, "@林越 跑完了吗");
		const before = (await messagesOf(runtime)).length;
		const empty = { wake: {}, slugToConversation: { [SLUG]: 7 } } as unknown as DirectoryState;
		expect(await rescueAnswer(runtime.harness, SLUG, 7, "跑完了，耗时 45 秒。", { loadDirectory: async () => empty })).toBe("skipped");
		expect((await messagesOf(runtime)).length).toBe(before);
	});
});

describe("谁说的话算「他说过」", () => {
	const at = (over: Record<string, unknown>) => ({ seq: 1, from: SLUG, text: "x", at: 1, ...over }) as never;

	it("唤醒之后他自己的发言算", () => {
		expect(spokeAfterWake([at({ seq: 5 })], SLUG, 1)).toBe(true);
	});

	it("唤醒之前的发言不算（那是上一轮的答案）", () => {
		expect(spokeAfterWake([at({ seq: 1 })], SLUG, 1)).toBe(false);
	});

	it("系统替他记的告警 note 不算", () => {
		// `kind:"note"` 的 from 也是他自己，按 from 判会误当成「已经答过」。
		expect(spokeAfterWake([at({ seq: 5, kind: "note" })], SLUG, 1)).toBe(false);
	});

	it("占位「开始处理…」不算（那正是要替换掉的东西）", () => {
		expect(spokeAfterWake([at({ seq: 5, kind: "chat", processing: true })], SLUG, 1)).toBe(false);
	});

	it("别人说的话不算", () => {
		expect(spokeAfterWake([at({ seq: 5, from: "owner" })], SLUG, 1)).toBe(false);
	});
});

describe("补发会顶掉「开始处理…」占位，而不是多冒一条", () => {
	it("占位被原地填充，频道条数不变", async () => {
		const { runtime, directory } = await setup();
		const seq = await ownerSpeaks(runtime, "@林越 跑完了吗");
		// 造一条他自己的处理中占位，再让补发落到同一个频道。
		await runtime.harness.commit(async (tx) => {
			const doc = (await tx.doc(ChannelDoc)) as ChannelState;
			const placeholder = appendMessage(doc, CHANNEL, {
				from: SLUG,
				text: "开始处理…",
				at: 150,
				kind: "chat",
				status: "pending",
				pendingFor: SLUG,
				processing: true,
			});
			(doc.messages[CHANNEL] as unknown[]).push(placeholder.message);
			doc.nextSeq[CHANNEL] = placeholder.message.seq + 1;
		}, BACKGROUND_CONTEXT);
		const before = (await messagesOf(runtime)).length;
		directory.wake["7"] = { channelId: CHANNEL, seq, from: "owner", at: 1 };

		expect(await rescueAnswer(runtime.harness, SLUG, 7, "跑完了，耗时 45 秒。", { loadDirectory: async () => directory })).toBe("posted");
		const list = await messagesOf(runtime);
		expect(list).toHaveLength(before);
		const filled = list.find((item) => item.from === SLUG);
		expect(filled?.text).toBe("跑完了，耗时 45 秒。");
		expect(filled?.processing).toBeFalsy();
	});
});

describe("序号以消息本身为准，不以 nextSeq 为准", () => {
	it("nextSeq 落后于已有消息时，新消息拿到 max+1（不撞号）", async () => {
		const { runtime } = await setup();
		await ownerSpeaks(runtime, "第一条");
		// 人为把 nextSeq 回调成落后值，模拟实测里出现过的不一致。
		await runtime.harness.commit(async (tx) => {
			const doc = (await tx.doc(ChannelDoc)) as ChannelState;
			doc.nextSeq[CHANNEL] = 1;
		}, BACKGROUND_CONTEXT);
		const { postMessage } = await import("../../src/core/channel/post.ts");
		const state = (await runtime.harness.snapshot(ChannelDoc, BACKGROUND_CONTEXT)) as ChannelState;
		const result = await postMessage(
			{ harness: runtime.harness, state, conversationOf: async () => undefined },
			{ channelId: CHANNEL, from: "owner", text: "第二条", at: 300, wake: false },
			BACKGROUND_CONTEXT,
		);
		const seqs = (await messagesOf(runtime)).map((item) => item.seq);
		expect(new Set(seqs).size).toBe(seqs.length);
		expect(result.message.seq).toBeGreaterThan(1);
	});
});

describe("占位有多条时填最后一条", () => {
	it("不把答案塞进早就滚出屏幕的旧占位", () => {
		let state: ChannelState = { channels: {}, messages: {}, nextSeq: {}, readMarks: {} } as ChannelState;
		state = ensureChannel(state, { id: "g", title: "G", members: ["owner", SLUG], at: 1 });
		for (const at of [1, 2]) {
			const placeholder = appendMessage(state, "g", {
				from: SLUG,
				text: "开始处理…",
				at,
				kind: "chat",
				status: "pending",
				pendingFor: SLUG,
				processing: true,
			});
			state = placeholder.state;
		}
		const last = (state.messages.g as { seq: number }[]).at(-1)!;
		const idx = (state.messages.g as { status?: string; pendingFor?: string }[]).findLastIndex(
			(m) => m.status === "pending" && m.pendingFor === SLUG,
		);
		expect(last.seq).toBe(2);
		expect(idx).toBe(1);
	});
});
