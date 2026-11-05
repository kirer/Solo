/**
 * `route`：助理在后台把一条消息交给该看的人（ADR-063）。
 *
 * 三件必须钉住的事：
 * - 频道里**不出现**「我把这条转给了谁」——只多一条隐藏留痕，界面不画；
 * - 收件人拿到的是原文，正文多一句「谁让你看这条」；
 * - 只有助理能用，且不会把我、他自己、不在频道里的人、已经被 @ 的人再叫一遍。
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BACKGROUND_CONTEXT } from "../../src/core/runtime/index.ts";
import { createCoreTools } from "../../src/core/channel/tools/index.ts";
import { ChannelDoc, OWNER, teamId, type ChannelState } from "../../src/core/channel/types.ts";
import { appendMessage, ensureChannel } from "../../src/core/channel/rules.ts";
import { emptyDirectory } from "../../src/core/channel/roster.ts";
import type { ChannelWiring } from "../../src/core/channel/wiring.ts";
import { createChannelFlow } from "../../src/core/channel/post.ts";
import { SEED_TEXT } from "./catalog.ts";
import { sandboxPool } from "./support.ts";

const pool = sandboxPool();

afterEach(() => pool.cleanup());

const ASSISTANT = "知言";
const ME = "沈舟";
const OTHER = "林越";
const TEAM = teamId("alpha");
const ASSISTANT_ID = 8;
const ME_ID = 7;
const OTHER_ID = 9;

async function person(root: string, slug: string, header: string): Promise<void> {
	await mkdir(join(root, slug), { recursive: true });
	await writeFile(join(root, slug, "identity.md"), `---\nname: ${slug}\n${header}---\n\n做事的。\n`, "utf8");
}

/** 投给每个收件人的正文都记下来：断言「他看到了什么」只能从这里看。 */
type Sent = { readonly to: string; readonly text: string };

async function setup(options: { mentionOther?: boolean } = {}) {
	const box = await pool.make("route-");
	await person(box.layout.assistantRoot, ASSISTANT, "title: 助理\n");
	await person(box.agentsRoot, ME, "title: 前端\nteam: alpha\n");
	await person(box.agentsRoot, OTHER, "title: 测试\nteam: alpha\n");
	const runtime = await box.open();
	await box.seedTemplates();

	await runtime.harness.commit(async (tx) => {
		const doc = (await tx.doc(ChannelDoc)) as ChannelState;
		Object.assign(
			doc,
			ensureChannel(doc, {
				id: TEAM,
				title: "alpha",
				members: [OWNER, ASSISTANT, ME, OTHER],
				// 团队频道只有助理被叫醒：其余的人靠 route 才看得到（ADR-063）。
				wakeOnAll: [ASSISTANT],
				at: 1,
			}),
		);
		const first = appendMessage(doc, TEAM, {
			from: OWNER,
			// 带上 @ 的那条：投递时他已经收到，`route` 不该再叫一次。
			text: options.mentionOther === true ? "连接池调到 20，@林越 你改" : "连接池调到 20",
			at: 10,
		});
		doc.messages[TEAM] = [first.message];
		doc.nextSeq[TEAM] = first.message.seq + 1;
	}, BACKGROUND_CONTEXT);

	const sent: Sent[] = [];
	const conversation = (id: number, slug: string) => ({
		id,
		submit: async (input: { content: unknown }) => {
			sent.push({ to: slug, text: typeof input.content === "string" ? input.content : JSON.stringify(input.content) });
			return {};
		},
	});
	const conversationOf = async (key: string) =>
		key === ME
			? (conversation(ME_ID, ME) as never)
			: key === OTHER
				? (conversation(OTHER_ID, OTHER) as never)
				: undefined;
	const wiring: ChannelWiring = {
		harness: runtime.harness,
		promptDir: box.layout.promptRoot,
		uploadsRoot: box.layout.uploadsRoot,
		text: SEED_TEXT,
		flow: createChannelFlow({
			harness: runtime.harness,
			promptDir: box.layout.promptRoot,
			uploadsRoot: box.layout.uploadsRoot,
			text: SEED_TEXT,
			conversationOf,
		}),
		finishTurn: async () => undefined,
		conversationOf,
		rememberWake: async () => undefined,
		wakeOf: async () => undefined,
	};
	const tools = createCoreTools({
		harness: runtime.harness,
		layout: box.layout,
		text: SEED_TEXT,
		directory: async () => ({
			...emptyDirectory(),
			slugToConversation: { [ASSISTANT]: ASSISTANT_ID, [ME]: ME_ID, [OTHER]: OTHER_ID },
			conversationToSlug: { [String(ASSISTANT_ID)]: ASSISTANT, [String(ME_ID)]: ME, [String(OTHER_ID)]: OTHER },
			wake: { [String(ASSISTANT_ID)]: { channelId: TEAM, seq: 1, from: OWNER, at: 10 } },
		}),
		saveDirectory: async () => undefined,
		wiring,
	} as never);

	return {
		box,
		runtime,
		sent,
		call: async (name: string, args: Record<string, unknown>, conversationId = ASSISTANT_ID): Promise<string> => {
			const tool = tools.find((item) => item.name === name);
			expect(tool, `没有工具 ${name}`).toBeDefined();
			const result = (await tool?.execute(args as never, { conversationId } as never, BACKGROUND_CONTEXT)) as {
				output?: readonly { text?: string }[];
			};
			return result?.output?.[0]?.text ?? "";
		},
	};
}

describe("route：助理在后台分发", () => {
	it("收件人看到原文和「谁让你看这条」，频道里只多一条隐藏留痕", async () => {
		const { runtime, sent, call } = await setup();
		const before = (await runtime.harness.snapshot(ChannelDoc, BACKGROUND_CONTEXT)) as ChannelState;
		const count = (before.messages[TEAM] ?? []).length;

		const output = await call("route", { to: [ME] });
		expect(output).toContain("已把 #1 交给：沈舟");
		expect(sent).toHaveLength(1);
		expect(sent[0]?.to).toBe(ME);
		expect(sent[0]?.text).toContain("连接池调到 20");
		expect(sent[0]?.text).toContain("（知言 让你看这条。）");

		const after = (await runtime.harness.snapshot(ChannelDoc, BACKGROUND_CONTEXT)) as ChannelState;
		const messages = after.messages[TEAM] ?? [];
		// 只多一条：隐藏留痕（`note`），不是一条可见的「转交」。
		expect(messages).toHaveLength(count + 1);
		const note = messages[messages.length - 1];
		expect(note?.kind).toBe("note");
		expect(note?.noteOf).toBe("route");
		expect(note?.text).toContain("把 #1 交给 沈舟 看");
	});

	it("只有助理能用：成员调 route 被拒", async () => {
		const { sent, call } = await setup();
		const output = await call("route", { to: [OTHER] }, ME_ID);
		expect(output).toContain("只有助理能用 route");
		expect(sent).toHaveLength(0);
	});

	it("不转给我、自己和不在频道里的人", async () => {
		const { sent, call } = await setup();
		expect(await call("route", { to: [OWNER] })).toContain("我不走 route");
		expect(await call("route", { to: [ASSISTANT] })).toContain("不用转给自己");
		expect(await call("route", { to: ["查无此人"] })).toContain("不在「alpha」里");
		expect(sent).toHaveLength(0);
	});

	it("已经被 @ 的人不重复叫：那条消息投递时他就收到了", async () => {
		const { sent, call } = await setup({ mentionOther: true });
		expect(await call("route", { to: [OTHER] })).toContain("没有叫醒任何人");
		expect(sent).toHaveLength(0);
	});

	it("没给 seq 就是「我刚被叫醒的那条」；要转的条不存在就说清", async () => {
		const { call } = await setup();
		expect(await call("route", { to: [ME], seq: 99 })).toContain("没有 #99 这条消息");
	});
});
