import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BACKGROUND_CONTEXT, createRegistry, setupModels, type Conversation } from "../../src/core/runtime/index.ts";
import { openCore, type CoreRuntime } from "../../src/core/runtime/open.ts";
import {
	ChannelDoc,
	OWNER,
	appendMessage,
	botHopsSinceOwner,
	ensureChannel,
	relayLimit,
	type ChannelState,
} from "../../src/core/channel/state.ts";
import { postMessage } from "../../src/core/channel/post.ts";

/**
 * 投递层的两条护栏：
 *
 * 1. **接力上限**：`wakeOnAll` 让「不 @ 人也叫醒负责人」，于是 A 回 → 唤醒 B →
 *    B 回 → 又唤醒 A。没有上限就是无限循环烧钱。
 * 2. **没人接要看得见**：投递失败/没会话原来只写 stderr，频道里什么都没有，
 *    老板看到的「我说了没人理」和「系统挂了」长得一模一样。
 */
function emptyState(): ChannelState {
	return { channels: {}, messages: {}, nextSeq: {}, readMarks: {} };
}

function stateWithChannel(): ChannelState {
	return ensureChannel(emptyState(), {
		id: "proj:x",
		title: "项目",
		members: [OWNER, "a", "b"],
		wakeOnAll: ["a", "b"],
		at: 1,
	});
}

describe("接力上限（纯函数）", () => {
	it("按频道里的 agent 数量给，至少 3", () => {
		const channel = (members: string[]) => ({
			id: "c",
			title: "c",
			members,
			wakeOnAll: [] as string[],
			createdAt: 1,
		});
		expect(relayLimit(channel([OWNER]))).toBe(3);
		expect(relayLimit(channel([OWNER, "a"]))).toBe(3);
		expect(relayLimit(channel([OWNER, "a", "b"]))).toBe(6);
		expect(relayLimit(channel([OWNER, "a", "b", "c"]))).toBe(9);
	});

	it("老板还没在这个频道说过话时，从频道建立算起", () => {
		// 早先这里返回 0（「不惩罚」），结果是：老板一次不开口的项目频道，上限永远
		// 不触发 —— 那正是唯一会烧钱失控的地方。真正让项目频道安静下来的不是豁免，
		// 是这条计数 + `post.ts` 的拦截。
		let state = stateWithChannel();
		state = appendMessage(state, "proj:x", { from: "a", text: "1", at: 2 }).state;
		state = appendMessage(state, "proj:x", { from: "b", text: "2", at: 3 }).state;
		expect(botHopsSinceOwner(state, "proj:x")).toBe(2);
		// 老板终于开口 → 归零，重新开始计。
		state = appendMessage(state, "proj:x", { from: OWNER, text: "在", at: 4 }).state;
		expect(botHopsSinceOwner(state, "proj:x")).toBe(0);
	});

	it("只数老板最后一条之后、agent 发的普通消息", () => {
		let state = stateWithChannel();
		state = appendMessage(state, "proj:x", { from: OWNER, text: "开始", at: 2 }).state;
		state = appendMessage(state, "proj:x", { from: "a", text: "1", at: 3 }).state;
		state = appendMessage(state, "proj:x", { from: "b", text: "2", at: 4 }).state;
		expect(botHopsSinceOwner(state, "proj:x")).toBe(2);
		// 老板再说一句就归零。
		state = appendMessage(state, "proj:x", { from: OWNER, text: "停", at: 5 }).state;
		expect(botHopsSinceOwner(state, "proj:x")).toBe(0);
	});

	it("note / work 不算接力，也不能把计数清零", () => {
		let state = stateWithChannel();
		state = appendMessage(state, "proj:x", { from: OWNER, text: "开始", at: 2 }).state;
		state = appendMessage(state, "proj:x", { from: "a", text: "1", at: 3 }).state;
		// 系统留痕的 from 是 owner，但它不是老板在说话 —— 不能当成交接点。
		state = appendMessage(state, "proj:x", { from: OWNER, text: "系统说明", at: 4, kind: "note" }).state;
		state = appendMessage(state, "proj:x", { from: "b", text: "记录", at: 5, kind: "work" }).state;
		expect(botHopsSinceOwner(state, "proj:x")).toBe(1);
	});
});

const roots: string[] = [];
const runtimes: CoreRuntime[] = [];

afterEach(async () => {
	for (const runtime of runtimes.splice(0)) await runtime.close().catch(() => undefined);
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

type FakeConversation = { conversation: Conversation; submitted: string[] };

async function setup(members: string[], wakeOnAll: string[]) {
	const root = await mkdtemp(join(tmpdir(), "core-relay-"));
	roots.push(root);
	const { models } = setupModels(process.env, { workspace: root });
	const runtime = await openCore({ databasePath: join(root, "core.sqlite"), models, registry: createRegistry() });
	runtimes.push(runtime);
	const channelId = "proj:x";
	await runtime.harness.commit(async (tx) => {
		const doc = (await tx.doc(ChannelDoc)) as ChannelState;
		Object.assign(doc, ensureChannel(emptyState(), { id: channelId, title: "项目", members, wakeOnAll, at: 1 }));
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

describe("接力上限拦截", () => {
	it("接力到上限的那条只落库、不投递，并留一条 note；老板发言后恢复", async () => {
		const { state, post, submitted } = await setup([OWNER, "a", "b"], ["a", "b"]);
		const limit = relayLimit((await state()).channels["proj:x"]!);
		expect(limit).toBe(6);

		await post({ from: OWNER, text: "@a @b 开工", at: 2 });
		expect(submitted.length).toBe(2);
		for (let index = 1; index <= limit; index += 1) {
			submitted.length = 0;
			const result = await post({ from: index % 2 === 1 ? "a" : "b", text: `第${index}棒`, at: 10 + index });
			expect(result.delivery.delivered.length).toBe(1);
		}
		expect(botHopsSinceOwner(await state(), "proj:x")).toBe(limit);

		// 第 limit+1 棒：消息进频道，但没人被叫醒，多出一条 note。
		submitted.length = 0;
		const before = (await state()).messages["proj:x"]!.length;
		const blocked = await post({ from: "a", text: "超出的一棒", at: 99 });
		expect(blocked.delivery.delivered).toEqual([]);
		expect(submitted.length).toBe(0);
		const after = (await state()).messages["proj:x"]!;
		expect(after.length).toBe(before + 2);
		expect(after.at(-2)!.text).toBe("超出的一棒");
		expect(after.at(-1)!.kind).toBe("note");
		expect(after.at(-1)!.from).toBe(OWNER);
		expect(after.at(-1)!.text).toContain(`接力到上限（${limit} 次）`);

		// 老板说一句 → 计数归零，agent 之间又能接。
		await post({ from: OWNER, text: "继续", at: 100 });
		expect(botHopsSinceOwner(await state(), "proj:x")).toBe(0);
		submitted.length = 0;
		const resumed = await post({ from: "b", text: "接着干", at: 101 });
		expect(resumed.delivery.delivered.length).toBe(1);
	});

	it("显式 @ 一个人可以突破上限 —— note 里说「自己 @ 人就能接着走」，代码就得真的放行", async () => {
		const { state, post, submitted } = await setup([OWNER, "a", "b"], ["a", "b"]);
		const limit = relayLimit((await state()).channels["proj:x"]!);
		await post({ from: OWNER, text: "开工", at: 2 });
		for (let index = 1; index <= limit; index += 1) {
			await post({ from: index % 2 === 1 ? "a" : "b", text: `第${index}棒`, at: 10 + index });
		}
		expect(botHopsSinceOwner(await state(), "proj:x")).toBe(limit);

		submitted.length = 0;
		const addressed = await post({ from: "a", text: "@b 这块你接一下", at: 98 });
		expect(addressed.delivery.delivered).toEqual(["b"]);
		expect(submitted.length).toBe(1);

		// 不 @ 人还是照拦 —— 放宽的是「指名」，不是「接力」。
		submitted.length = 0;
		const plain = await post({ from: "b", text: "好的", at: 99 });
		expect(plain.delivery.delivered).toEqual([]);
	});

	it("老板自己发言永远不拦（计数满了也照发照叫）", async () => {
		const { state, post, submitted } = await setup([OWNER, "a", "b"], ["a", "b"]);
		const limit = relayLimit((await state()).channels["proj:x"]!);
		await post({ from: OWNER, text: "开工", at: 2 });
		for (let index = 1; index <= limit; index += 1) {
			await post({ from: index % 2 === 1 ? "a" : "b", text: `第${index}棒`, at: 10 + index });
		}
		expect(botHopsSinceOwner(await state(), "proj:x")).toBe(limit);

		submitted.length = 0;
		const result = await post({ from: OWNER, text: "都停一下", at: 50 });
		expect(result.delivery.failed).toEqual([]);
		expect(result.delivery.delivered).toEqual(["a", "b"]);
		expect((await state()).messages["proj:x"]!.at(-1)!.kind).toBe("chat");
	});
});

describe("投递失败可见", () => {
	it("目标是 agent 但没有会话时，频道里留一条说明", async () => {
		const { state, post } = await setup([OWNER, "a"], []);
		const result = await post({ from: OWNER, text: "@a 在吗", at: 2, conversationOf: async () => undefined });
		expect(result.delivery.delivered).toEqual([]);
		expect(result.delivery.skipped).toEqual(["a"]);
		const channel = (await state()).messages["proj:x"]!;
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
		const channel = (await state()).messages["proj:x"]!;
		expect(channel.at(-1)!.kind).toBe("note");
		expect(channel.at(-1)!.text).toContain("投递失败：会话已关闭");
	});
});
