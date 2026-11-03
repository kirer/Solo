/**
 * 接活的入口：**一条消息叫醒一个人，代码替他立工单**（`work/intake.ts`）。
 *
 * 为什么要钉：这一步是「模型不肯自己做记工」的修法。它对了，工单才会出现在
 * 每一轮的正文里；它错了，要么每句话都开一张单子（聊天变成账本），要么单子永远
 * 挂在「在干」（`list` 一天就废）。所以守四件事：
 *
 * 1. 我 @ 人：立单，正文末尾带上工单号；
 * 2. agent 之间互相说话：不立（他们没有授权）；
 * 3. 追问：沿用同一张，不另开；
 * 4. 收尾：一个汇报都没有的单子自动收工，报过 progress 的留着。
 */
import { writeFile } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { BACKGROUND_CONTEXT, type Conversation } from "../../src/core/runtime/index.ts";
import { ChannelDoc, OWNER, type ChannelState } from "../../src/core/channel/types.ts";
import { appendMessage, ensureChannel } from "../../src/core/channel/rules.ts";
import { postMessage } from "../../src/core/channel/post.ts";
import { WorkDoc, reportTicket } from "../../src/core/work/ticket.ts";
import { closeUntouched, intakeAll } from "../../src/core/work/intake.ts";
import { emptyWorkState, type WorkState } from "../../src/core/work/types.ts";
import { SEED_TEXT } from "./catalog.ts";
import { sandboxPool } from "./support.ts";

const pool = sandboxPool();

afterEach(() => pool.cleanup());

const POLICY = `---\nmode: off\n---\n\n# 谁能派活\n\n## 明确 @ 我 / 私聊\n\n- 所有人\n\n# 规矩\n\n## 只在工作区里改\n\n只动自己的工作区。\n`;

async function setup() {
	const box = await pool.make("core-intake-");
	const runtime = await box.open();
	const layout = box.layout;
	await writeFile(layout.policyFile, POLICY, "utf8");
	const channelId = "team:x";
	await runtime.harness.commit(async (tx) => {
		const doc = (await tx.doc(ChannelDoc)) as ChannelState;
		Object.assign(
			doc,
			ensureChannel(
				{ channels: {}, messages: {}, nextSeq: {}, readMarks: {} },
				{ id: channelId, title: "团队", members: [OWNER, "a"], wakeOnAll: ["a"], at: 1 },
			),
		);
	}, BACKGROUND_CONTEXT);

	const submitted: string[] = [];
	const conversation = {
		id: "1",
		submit: async (input: { content: string }) => {
			submitted.push(String(input.content));
		},
	} as unknown as Conversation;
	const state = async () => (await runtime.harness.snapshot(ChannelDoc, BACKGROUND_CONTEXT)) as ChannelState;
	const post = async (input: { from: string; text: string; at: number }) =>
		postMessage(
			{
				harness: runtime.harness,
				state: await state(),
				text: SEED_TEXT,
				policyFile: layout.policyFile,
				conversationOf: async (slug: string) => (slug === "a" ? conversation : undefined),
			},
			{ channelId, ...input },
		);
	const work = async (): Promise<WorkState> =>
		((await runtime.harness.snapshot(WorkDoc, BACKGROUND_CONTEXT)) as WorkState | undefined) ?? emptyWorkState();
	const seed = async (input: { from: string; text: string; at: number }) => {
		await runtime.harness.commit(async (tx) => {
			const doc = (await tx.doc(ChannelDoc)) as ChannelState;
			Object.assign(doc, appendMessage(doc, channelId, input).state);
		}, BACKGROUND_CONTEXT);
	};
	return { runtime, layout, channelId, submitted, post, work, seed };
}

describe("接活：代码立单，模型推进", () => {
	it("我 @ 他：立一张单子，正文末尾写清工单号", async () => {
		const s = await setup();
		await s.post({ from: OWNER, text: "@a 把 demo 的测试跑一遍", at: 2 });
		const state = await s.work();
		const ticket = state.tickets.T1;
		expect(ticket?.assignee).toBe("a");
		expect(ticket?.title).toBe("把 demo 的测试跑一遍");
		expect(s.submitted.join("\n")).toContain("T1");
	});

	it("agent 之间说话：不立单（没有授权）", async () => {
		const s = await setup();
		await s.post({ from: "a", text: "我给 b 派个活", at: 2 });
		expect(Object.keys((await s.work()).tickets)).toEqual([]);
	});

	it("同一件事的追问：沿用那张单子，不另开", async () => {
		const s = await setup();
		await s.post({ from: OWNER, text: "@a 把 demo 的测试跑一遍", at: 2 });
		await s.post({ from: OWNER, text: "跑完顺便说下用时", at: 3 });
		const state = await s.work();
		expect(Object.keys(state.tickets)).toEqual(["T1"]);
	});

	it("闸门不放行（没点名、不在名单里）：不立单", async () => {
		const s = await setup();
		await s.seed({ from: "stranger", text: "帮我看看这个", at: 1 });
		const channel = (await s.runtime.harness.snapshot(ChannelDoc, BACKGROUND_CONTEXT)) as ChannelState;
		const message = channel.messages[s.channelId]![0]!;
		const opened = await intakeAll(
			{ harness: s.runtime.harness, policyFile: s.layout.policyFile },
			channel.channels[s.channelId]!,
			message,
			["a"],
		);
		expect(opened.size).toBe(0);
	});

	it("被合并掉的那几条：单子跟着这一轮的收尾一起收工，不留幽灵", async () => {
		const s = await setup();
		await s.post({ from: OWNER, text: "@a 做 A", at: 2 });
		const second = await s.post({ from: OWNER, text: "@a 做 B", at: 3 });
		expect(Object.keys((await s.work()).tickets)).toEqual(["T1", "T2"]);
		await closeUntouched(
			{ harness: s.runtime.harness, policyFile: s.layout.policyFile },
			{ slug: "a", channelId: "team:x", seq: second.message.seq },
		);
		const state = await s.work();
		expect([state.tickets.T1?.endedBy, state.tickets.T2?.endedBy]).toEqual(["dropped", "dropped"]);
	});

	it("收尾：没汇报过的单子自动收工，报过的留着", async () => {
		const s = await setup();
		const first = await s.post({ from: OWNER, text: "@a 把 demo 的测试跑一遍", at: 2 });
		await closeUntouched(
			{ harness: s.runtime.harness, policyFile: s.layout.policyFile },
			{ slug: "a", channelId: "team:x", seq: first.message.seq },
		);
		expect((await s.work()).tickets.T1?.endedBy).toBe("dropped");

		const second = await s.post({ from: OWNER, text: "@a 再跑一次", at: 5 });
		const before = await s.work();
		const reported = reportTicket(before, "T2", { outcome: "progress", text: "在跑", at: 6 });
		if (!reported.ok) throw new Error("应当记上");
		await s.runtime.harness.commit(async (tx) => {
			const doc = (await tx.doc(WorkDoc)) as WorkState;
			doc.tickets = reported.state.tickets;
		}, BACKGROUND_CONTEXT);
		await closeUntouched(
			{ harness: s.runtime.harness, policyFile: s.layout.policyFile },
			{ slug: "a", channelId: "team:x", seq: second.message.seq },
		);
		expect((await s.work()).tickets.T2?.endedAt).toBeUndefined();
	});
});
