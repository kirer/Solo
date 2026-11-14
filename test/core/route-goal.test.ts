/**
 * `route` 带 `goal`：转交的同时把这条活记进任务板（设计第二节）。
 *
 * 钉住四件事：
 * - 不带 `goal` 就**只是转交**，板上一条都不多；
 * - 带 `goal` 建的正是那句话：标题、验收、负责人、起源 seq；
 * - 一件活只有一个负责人：交给好几个人时只转交、不上板；
 * - 同一次转交重试不长第二条。
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BACKGROUND_CONTEXT } from "../../src/core/runtime/index.ts";
import { createCoreTools } from "../../src/core/channel/tools/index.ts";
import { ChannelDoc, OWNER, tasksOf, teamId, type ChannelState } from "../../src/core/channel/types.ts";
import { appendMessage, ensureChannel } from "../../src/core/channel/rules.ts";
import { emptyDirectory } from "../../src/core/channel/roster.ts";
import { createChannelFlow } from "../../src/core/channel/post.ts";
import type { ChannelWiring } from "../../src/core/channel/wiring.ts";
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

async function setup() {
	const box = await pool.make("route-goal-");
	await person(box.layout.assistantRoot, ASSISTANT, "title: 助理\n");
	await person(box.agentsRoot, ME, "title: 后端\nteam: alpha\n");
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
				wakeOnAll: [ASSISTANT],
				at: 1,
			}),
		);
		const first = appendMessage(doc, TEAM, { from: OWNER, text: "把连接池调到 20，压测要过", at: 10 });
		doc.messages[TEAM] = [first.message];
		doc.nextSeq[TEAM] = first.message.seq + 1;
	}, BACKGROUND_CONTEXT);

	const sent: { readonly to: string; readonly text: string }[] = [];
	const conversationOf = async (key: string) =>
		key === ME
			? ({
					id: ME_ID,
					submit: async (input: { content: unknown }) => {
						sent.push({ to: ME, text: typeof input.content === "string" ? input.content : "" });
						return {};
					},
				} as never)
			: key === OTHER
				? ({
						id: OTHER_ID,
						submit: async (input: { content: unknown }) => {
							sent.push({ to: OTHER, text: typeof input.content === "string" ? input.content : "" });
							return {};
						},
					} as never)
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
		finishTurn: async () => ({ kind: "silent", reason: "no-target" }),
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
			wake: {
				[String(ASSISTANT_ID)]: {
					reply: { channelId: TEAM, seq: 1, from: OWNER, at: 10 },
					task: { channelId: TEAM, seq: 1, from: OWNER, at: 10 },
				},
			},
		}),
		saveDirectory: async () => undefined,
		wiring,
	} as never);

	const call = async (args: Record<string, unknown>): Promise<string> => {
		const tool = tools.find((item) => item.name === "route");
		expect(tool, "没有 route 工具").toBeDefined();
		const result = (await tool?.execute(args as never, { conversationId: ASSISTANT_ID } as never, BACKGROUND_CONTEXT)) as {
			output?: readonly { text?: string }[];
		};
		return result?.output?.[0]?.text ?? "";
	};

	const state = async (): Promise<ChannelState> =>
		(await runtime.harness.snapshot(ChannelDoc, BACKGROUND_CONTEXT)) as ChannelState;

	return { call, sent, state };
}

describe("route 带 goal", () => {
	it("不带 goal 就只是转交：板上一条都不多", async () => {
		const { call, sent, state } = await setup();
		expect(await call({ to: [ME] })).toContain("已把 #1 交给：沈舟");
		expect(sent).toHaveLength(1);
		expect(Object.keys(tasksOf(await state(), TEAM))).toHaveLength(0);
	});

	it("带 goal：那句话进板，标题、验收、负责人、起源都对", async () => {
		const { call, sent, state } = await setup();
		const output = await call({ to: [ME], goal: "把连接池调到 20", accept: "压测不报错" });
		expect(output).toContain("已把 #1 交给：沈舟");
		expect(output).toContain("顺带上板了：t1（沈舟）把连接池调到 20");
		expect(sent).toHaveLength(1);

		const task = tasksOf(await state(), TEAM)["t1"];
		expect(task?.title).toBe("把连接池调到 20");
		expect(task?.accept).toBe("压测不报错");
		expect(task?.owner).toBe(ME);
		expect(task?.status).toBe("open");
		expect(task?.originSeq).toBe(1);
	});

	it("交给好几个人时只转交、不上板：一件活只有一个负责人", async () => {
		const { call, sent, state } = await setup();
		const output = await call({ to: [ME, OTHER], goal: "把连接池调到 20" });
		expect(output).toContain("只转交、没上板");
		expect(sent).toHaveLength(2);
		expect(Object.keys(tasksOf(await state(), TEAM))).toHaveLength(0);
	});

	it("同一次转交重试不长第二条", async () => {
		const { call, state } = await setup();
		await call({ to: [ME], goal: "把连接池调到 20" });
		const again = await call({ to: [ME], goal: "把连接池调到 20" });
		expect(again).toContain("已经在板上（t1），没重复建");
		expect(Object.keys(tasksOf(await state(), TEAM))).toHaveLength(1);
	});
});
