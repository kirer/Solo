/**
 * 过程话合并（ADR-065）。
 *
 * 守的三件事：
 *
 * 1. **30 秒内同一个人连发的过程话并成一段**。实测 agent 会把一个动作拆成
 *    「我先看下代码」「找到原因了」「正在改」三条 —— 读起来像刷屏，而且收件人被叫醒三次。
 * 2. **并进去就不再叫醒**。合并的意义一半是排版，一半是不打扰。
 * 3. **带 @ 的不合并**。`@` 的意思是「这句话必须叫醒他」，并进一条已经投递过的消息，
 *    被 @ 的人就永远收不到那次投递。
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BACKGROUND_CONTEXT, createRegistry, setupModels } from "../../src/core/runtime/index.ts";
import { openCore, type CoreRuntime } from "../../src/core/runtime/open.ts";
import { postMessage } from "../../src/core/channel/post.ts";
import {
	ChannelDoc,
	OWNER,
	ensureChannel,
	projectId,
	type ChannelState,
	type Message,
} from "../../src/core/channel/state.ts";

const roots: string[] = [];
const runtimes: CoreRuntime[] = [];

afterEach(async () => {
	for (const runtime of runtimes.splice(0)) await runtime.close().catch(() => undefined);
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

const ME = "沈舟";
const PEER = "陆衡";
const PROJ = projectId("dino");
const AT = 1_700_000_000_000;

async function setup(): Promise<{
	post: (input: {
		text: string;
		from?: string;
		at: number;
		step?: boolean;
		channelId?: string;
		wake?: false;
	}) => Promise<{ seq: number; merged: boolean; delivered: readonly string[] }>;
	state: () => Promise<ChannelState>;
}> {
	const root = await mkdtemp(join(tmpdir(), "core-step-"));
	roots.push(root);
	const agentsRoot = join(root, "agents");
	const projectsRoot = join(root, "projects");
	for (const [slug, name] of [[ME, "沈舟"], [PEER, "陆衡"]] as const) {
		await mkdir(join(agentsRoot, slug), { recursive: true });
		await writeFile(
			join(agentsRoot, slug, "identity.md"),
			`---\nname: ${name}\ntitle: 开发\nmanager: owner\n---\n\n写小恐龙。\n`,
			"utf8",
		);
	}
	const { models } = setupModels(process.env, { workspace: root });
	const runtime = await openCore({
		databasePath: join(root, "core.sqlite"),
		models,
		registry: createRegistry(),
	});
	runtimes.push(runtime);

	await runtime.harness.commit(async (tx) => {
		const doc = (await tx.doc(ChannelDoc)) as ChannelState;
		Object.assign(
			doc,
			ensureChannel(doc, { id: PROJ, title: "小恐龙", members: [OWNER, ME, PEER], at: 1 }),
		);
	}, BACKGROUND_CONTEXT);

	const snapshot = async (): Promise<ChannelState> =>
		((await runtime.harness.snapshot(ChannelDoc, BACKGROUND_CONTEXT)) ?? {
			channels: {},
			messages: {},
			nextSeq: {},
			readMarks: {},
		}) as ChannelState;

	return {
		post: async (input) => {
			const current = await snapshot();
			const result = await postMessage(
				{
					harness: runtime.harness,
					state: current,
					// 不建真会话：投递会落成「它还没有会话」的 skipped，正是想验的行为。
					conversationOf: async () => undefined,
				},
				{
					channelId: input.channelId ?? PROJ,
					from: input.from ?? ME,
					text: input.text,
					at: input.at,
					...(input.step === true ? { step: true } : {}),
					...(input.wake === false ? { wake: false } : {}),
				},
				BACKGROUND_CONTEXT,
			);
			return {
				seq: result.message.seq,
				merged: result.merged === true,
				delivered: result.delivery.delivered,
			};
		},
		state: snapshot,
	};
}

/** 真正的发言：排掉系统留痕（note）和 @ 之后生成的「开始处理…」占位。 */
function spoken(state: ChannelState): readonly Message[] {
	return (state.messages[PROJ] ?? []).filter(
		(message) => message.kind !== "note" && message.processing !== true && message.status !== "pending",
	);
}

describe("过程话合并", () => {
	it("30 秒内的第二句过程话并进上一条：seq 不变，正文接在后面", async () => {
		const { post, state } = await setup();
		const first = await post({ text: "我先看下代码", at: AT, step: true });
		const second = await post({ text: "找到原因了，正在改", at: AT + 8_000, step: true });
		expect(second.merged).toBe(true);
		expect(second.seq).toBe(first.seq);
		const list = spoken(await state());
		expect(list).toHaveLength(1);
		expect(list[0]?.text).toBe("我先看下代码\n找到原因了，正在改");
		expect(list[0]?.at).toBe(AT + 8_000);
		expect(list[0]?.step).toBe(true);
	});

	it("超过 30 秒就另起一条（新进展不该被塞回旧消息里）", async () => {
		const { post, state } = await setup();
		const first = await post({ text: "我先看下代码", at: AT, step: true });
		const later = await post({ text: "改完了", at: AT + 31_000, step: true });
		expect(later.merged).toBe(false);
		expect(later.seq).toBeGreaterThan(first.seq);
		expect(spoken(await state())).toHaveLength(2);
	});

	it("带 @ 别人的过程话不合并 —— 并进去被 @ 的人就收不到投递了", async () => {
		const { post, state } = await setup();
		await post({ text: "我先看下代码", at: AT, step: true });
		const withMention = await post({ text: `@${PEER} 你那边接口改了吗`, at: AT + 5_000, step: true });
		expect(withMention.merged).toBe(false);
		expect(spoken(await state())).toHaveLength(2);
	});

	it("不同人的过程话不合并", async () => {
		const { post } = await setup();
		const mine = await post({ text: "我先看下代码", at: AT, step: true });
		const theirs = await post({ text: "我这边也在看", from: PEER, at: AT + 3_000, step: true });
		expect(theirs.merged).toBe(false);
		expect(theirs.seq).toBeGreaterThan(mine.seq);
	});

	it("结论（没带 step）不合并 —— 它是这一轮的话，不该被并进过程", async () => {
		const { post, state } = await setup();
		await post({ text: "我先看下代码", at: AT, step: true });
		const conclusion = await post({ text: "根因是转义", at: AT + 2_000 });
		expect(conclusion.merged).toBe(false);
		expect(spoken(await state())).toHaveLength(2);
	});

	it("合并之后不再叫醒任何人（一个人写三段过程，不该打扰收件人三次）", async () => {
		const { post } = await setup();
		const first = await post({ text: "我先看下代码", at: AT, step: true });
		const second = await post({ text: "找到原因了", at: AT + 5_000, step: true });
		// 第一次可能叫醒了人（也可能没有），但合并那一次一定没有。
		expect(second.delivered).toEqual([]);
		expect(first.seq).toBe(second.seq);
	});
});
