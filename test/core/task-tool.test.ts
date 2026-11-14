/**
 * `task` 工具：板怎么看、谁能改、改完落什么。
 *
 * 钉住的是**模型和人都看得见的那几句话**：摘要里「几条卡住、最近的是哪条」、
 * `mine` 的口径、四种拒法各说各的话。这些句子写歪了不会让任何别的测试红，
 * 只会让人读到一句听不懂的话。
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BACKGROUND_CONTEXT } from "../../src/core/runtime/index.ts";
import { createCoreTools } from "../../src/core/channel/tools/index.ts";
import { ChannelDoc, OWNER, tasksOf, teamId, type ChannelState } from "../../src/core/channel/types.ts";
import { appendMessage, ensureChannel } from "../../src/core/channel/rules.ts";
import { emptyDirectory } from "../../src/core/channel/roster.ts";
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
const LONG = "把设置页里那些没人看的开关全部删掉";

async function person(root: string, slug: string, header: string): Promise<void> {
	await mkdir(join(root, slug), { recursive: true });
	await writeFile(join(root, slug, "identity.md"), `---\nname: ${slug}\n${header}---\n\n做事的。\n`, "utf8");
}

async function setup() {
	const box = await pool.make("task-tool-");
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
		const notes = ["连接池调到 20", "设置页加班快捷键", "把没人看的开关删了", "日志加一行", "发版前点一次"];
		const messages = notes.map((text, index) => appendMessage(doc, TEAM, { from: OWNER, text, at: 10 + index }).message);
		doc.messages[TEAM] = messages;
		doc.nextSeq[TEAM] = messages[messages.length - 1]!.seq + 1;
	}, BACKGROUND_CONTEXT);

	const wake = { reply: { channelId: TEAM, seq: 1, from: OWNER, at: 10 }, task: { channelId: TEAM, seq: 1, from: OWNER, at: 10 } };
	const tools = createCoreTools({
		harness: runtime.harness,
		layout: box.layout,
		text: SEED_TEXT,
		directory: async () => ({
			...emptyDirectory(),
			slugToConversation: { [ASSISTANT]: ASSISTANT_ID, [ME]: ME_ID, [OTHER]: OTHER_ID },
			conversationToSlug: { [String(ASSISTANT_ID)]: ASSISTANT, [String(ME_ID)]: ME, [String(OTHER_ID)]: OTHER },
			wake: { [String(ASSISTANT_ID)]: wake, [String(ME_ID)]: wake, [String(OTHER_ID)]: wake },
		}),
		saveDirectory: async () => undefined,
	} as never);

	const call = async (args: Record<string, unknown>, conversationId = ASSISTANT_ID): Promise<string> => {
		const tool = tools.find((item) => item.name === "task");
		expect(tool, "没有 task 工具").toBeDefined();
		const result = (await tool?.execute(args as never, { conversationId } as never, BACKGROUND_CONTEXT)) as {
			output?: readonly { text?: string }[];
		};
		return result?.output?.[0]?.text ?? "";
	};

	const state = async (): Promise<ChannelState> =>
		(await runtime.harness.snapshot(ChannelDoc, BACKGROUND_CONTEXT)) as ChannelState;

	/** 助理补标一条，返回它的 id。每调一次换一条起源消息（同一句话交给同一个人只该有一条）。 */
	let origin = 0;
	const add = async (title: string, owner: string, from = ++origin): Promise<string> => {
		const output = await call({ action: "add", from, title, owner });
		const match = /建了 (t\d+)/.exec(output);
		expect(match, `补标没成：${output}`).not.toBeNull();
		return match?.[1] ?? "";
	};

	return { box, runtime, call, state, add };
}

describe("task：看板", () => {
	it("空板说清「没有卡住的」，且不是一句话都不说", async () => {
		const { call } = await setup();
		const output = await call({ action: "list" });
		expect(output).toContain("任务 0 条：没有卡住的");
		expect(output).toContain("板上没有活");
	});

	it("有卡住的一条：摘要带总数、卡住数、那条的标题（超 12 字截断）", async () => {
		const { call, add } = await setup();
		await add("把连接池调到 20", ME);
		const blocked = await add(LONG, OTHER);
		expect(await call({ action: "update", id: blocked, status: "doing" }, OTHER_ID)).toContain("现在是 进行中");
		expect(await call({ action: "update", id: blocked, status: "blocked", note: "等测试环境" }, OTHER_ID)).toContain(
			"现在是 卡住",
		);

		const output = await call({ action: "list" });
		expect(output).toContain("任务 2 条：卡住 1 条，最近的是「把设置页里那些没人看的开…」");
		// 行里用中文状态名，不冒出 doing / blocked 这种词
		expect(output).toContain("[待办]");
		expect(output).toContain("[卡住]");
		expect(output).not.toContain("[blocked]");
	});

	it("没有卡住的时候不写「卡住 0 条」：那是两句话", async () => {
		const { call, add } = await setup();
		await add("把连接池调到 20", ME);
		const output = await call({ action: "list" });
		expect(output).toContain("任务 1 条：没有卡住的");
		expect(output).not.toContain("卡住 0 条");
	});

	it("做完的不列在板上", async () => {
		const { call, add } = await setup();
		const done = await add("把连接池调到 20", ME);
		await call({ action: "update", id: done, status: "doing" }, ME_ID);
		await call({ action: "update", id: done, status: "done", note: "跑了 12 条测试" }, ME_ID);
		const output = await call({ action: "list" });
		expect(output).toContain("任务 0 条：没有卡住的");
	});

	it("没有验收的在行尾标出来：门槛是判断，不写出来就没人知道", async () => {
		const { call, add } = await setup();
		await add("把连接池调到 20", ME);
		await call({ action: "add", from: 5, title: "给设置页加快捷键", owner: ME, accept: "按 Cmd+K 能开" });
		const output = await call({ action: "list" });
		expect(output).toContain("（今天没动）· 缺验收");
		expect(output.match(/缺验收/g)).toHaveLength(1);
	});

	it("mine 只说自己的：几条进行中、几条卡住", async () => {
		const { call, add } = await setup();
		const one = await add("把连接池调到 20", ME);
		const two = await add("给设置页加快捷键", ME);
		await add(LONG, OTHER);
		await call({ action: "update", id: one, status: "doing" }, ME_ID);
		await call({ action: "update", id: two, status: "doing" }, ME_ID);
		await call({ action: "update", id: two, status: "blocked", note: "等设计稿" }, ME_ID);

		const output = await call({ action: "mine" }, ME_ID);
		expect(output).toContain("你手上 2 条：1 条进行中、1 条卡住");
		expect(output).not.toContain(LONG);
	});
});

describe("task：补标（只有助理）", () => {
	it("建一条：板上多一条待办，频道里落一条 note", async () => {
		const { call, state } = await setup();
		const before = (await state()).messages[TEAM] ?? [];
		const output = await call({ action: "add", from: 1, title: "把连接池调到 20", owner: ME, accept: "并发压测不报错" });
		expect(output).toContain("建了 t1（沈舟）：把连接池调到 20");
		const after = await state();
		const task = tasksOf(after, TEAM)["t1"];
		expect(task?.owner).toBe(ME);
		expect(task?.status).toBe("open");
		expect(task?.originSeq).toBe(1);
		expect(task?.accept).toBe("并发压测不报错");
		expect(task?.history).toHaveLength(1);
		const messages = after.messages[TEAM] ?? [];
		expect(messages).toHaveLength(before.length + 1);
		expect(messages[messages.length - 1]?.kind).toBe("note");
		expect(messages[messages.length - 1]?.noteOf).toBe("task");
	});

	it("成员不能建：说「只有助理能建任务」", async () => {
		const { call } = await setup();
		const output = await call({ action: "add", from: 1, title: "把连接池调到 20", owner: ME }, ME_ID);
		expect(output).toContain("只有助理能建任务");
	});

	it("同一句话交给同一个人只建一条", async () => {
		const { call } = await setup();
		await call({ action: "add", from: 1, title: "把连接池调到 20", owner: ME });
		expect(await call({ action: "add", from: 1, title: "换个说法", owner: ME })).toContain("已经在 t1 上了");
	});

	it("要指到一条真消息", async () => {
		const { call } = await setup();
		expect(await call({ action: "add", from: 99, title: "把连接池调到 20", owner: ME })).toContain("里没有 #99");
	});
});

describe("task：改状态", () => {
	it("blocked 不给原因不收；给了就落进 note", async () => {
		const { call, add, state } = await setup();
		const id = await add("把连接池调到 20", ME);
		await call({ action: "update", id, status: "doing" }, ME_ID);
		expect(await call({ action: "update", id, status: "blocked" }, ME_ID)).toContain("必须写原因");
		expect(tasksOf(await state(), TEAM)[id]?.status).toBe("doing");

		const output = await call({ action: "update", id, status: "blocked", note: "等 QA 给环境" }, ME_ID);
		expect(output).toContain("t1 现在是 卡住");
		const after = await state();
		expect(tasksOf(after, TEAM)[id]?.status).toBe("blocked");
		const messages = after.messages[TEAM] ?? [];
		expect(messages[messages.length - 1]?.text).toContain("等 QA 给环境");
		expect(tasksOf(after, TEAM)[id]?.history).toHaveLength(3);
	});

	it("不是自己名下的不许动", async () => {
		const { call, add } = await setup();
		const id = await add("把连接池调到 20", OTHER);
		expect(await call({ action: "update", id, status: "doing" }, ME_ID)).toContain("不是你名下的");
	});

	it("自己划掉不行：做不完就报卡住", async () => {
		const { call, add } = await setup();
		const id = await add("把连接池调到 20", ME);
		expect(await call({ action: "update", id, status: "dropped", note: "不做了" }, ME_ID)).toContain("不能自己划掉");
	});

	it("做完是终态：不能倒回来", async () => {
		const { call, add } = await setup();
		const id = await add("把连接池调到 20", ME);
		await call({ action: "update", id, status: "doing" }, ME_ID);
		await call({ action: "update", id, status: "done", note: "跑了 12 条测试" }, ME_ID);
		expect(await call({ action: "update", id, status: "doing" }, ME_ID)).toContain("到这就是终点了");
	});

	it("板上没有的那条说清没有", async () => {
		const { call } = await setup();
		expect(await call({ action: "update", id: "t9", status: "doing" }, ME_ID)).toContain("板上没有 t9");
	});
});
