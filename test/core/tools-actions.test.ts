/**
 * 合并后的工具：一个工具两三种 `action`。
 *
 * 工具清单每轮都进提示词，名字越多，模型选错的概率越高（ADR-084）。合并的代价是
 * **参数里有分支** —— 所以每个合并工具都要钉两件事：
 *
 * 1. 每个 `action` 都真的能跑通（不是只有默认那个）；
 * 2. 不认识的 `action` 要回一句能自救的话（列出合法值），而不是沉默或抛错。
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BACKGROUND_CONTEXT, createRegistry, setupModels } from "../../src/core/runtime/index.ts";
import { openCore, type CoreRuntime } from "../../src/core/runtime/open.ts";
import { createCoreTools } from "../../src/core/channel/tools.ts";
import {
	ChannelDoc,
	OWNER,
	appendMessage,
	ensureChannel,
	dmId,
	teamId,
	type ChannelState,
} from "../../src/core/channel/state.ts";
import { emptyDirectory } from "../../src/core/agent/roster.ts";
import { writeTeam } from "../../src/core/team/doc.ts";

const roots: string[] = [];
const runtimes: CoreRuntime[] = [];

afterEach(async () => {
	for (const runtime of runtimes.splice(0)) await runtime.close().catch(() => undefined);
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

const ME = "沈舟";
const CONVERSATION = 7;
const DM = dmId(OWNER, ME);
const TEAM = teamId("alpha");

async function setup(): Promise<{
	tools: readonly { name: string; execute?: (...args: never[]) => Promise<unknown> }[];
	call: (name: string, args: Record<string, unknown>) => Promise<string>;
	root: string;
}> {
	const root = await mkdtemp(join(tmpdir(), "core-tools-"));
	roots.push(root);
	const agentsRoot = join(root, "agents");
	const teamsRoot = join(root, "teams");
	await mkdir(join(agentsRoot, ME, "skills"), { recursive: true });
	await writeFile(
		join(agentsRoot, ME, "identity.md"),
		"---\nname: 沈舟\ntitle: 前端开发\nmanager: owner\nteam: alpha\n---\n\n写小恐龙。\n",
		"utf8",
	);
	await writeFile(join(agentsRoot, ME, "memory.md"), "# 记忆\n\n## 端口\n\n部署前先看端口被谁占了。\n", "utf8");
	await writeTeam(teamsRoot, { slug: "alpha", name: "alpha", lead: ME, body: "目标：把网页做到能看。" });
	await mkdir(join(root, "skills", "写周报"), { recursive: true });
	await writeFile(
		join(root, "skills", "写周报", "SKILL.md"),
		"---\nname: 写周报\ndescription: 每周五要交周报时用。\n---\n\n1. 写三行。\n",
		"utf8",
	);
	await writeFile(join(root, "notes.md"), "第一行\n第二行\n第三行\n", "utf8");

	const { models } = setupModels(process.env, { workspace: root });
	const runtime = await openCore({
		databasePath: join(root, "core.sqlite"),
		models,
		registry: createRegistry(),
	});
	runtimes.push(runtime);

	await runtime.harness.commit(async (tx) => {
		const doc = (await tx.doc(ChannelDoc)) as ChannelState;
		Object.assign(doc, ensureChannel(doc, { id: DM, title: ME, members: [OWNER, ME], at: 1 }));
		// 三个成员才是群聊：chatKind 只看成员表（我 + 一个人 = 私聊）。
		Object.assign(doc, ensureChannel(doc, { id: TEAM, title: "alpha", members: [OWNER, ME, "guyan"], at: 2 }));
		const first = appendMessage(doc, TEAM, { from: OWNER, text: "连接池调到 20", at: 10 });
		doc.messages[TEAM] = [first.message];
		doc.nextSeq[TEAM] = first.message.seq + 1;
	}, BACKGROUND_CONTEXT);

	const tools = createCoreTools({
		harness: runtime.harness,
		workspaceRoot: root,
		agentsRoot,
		teamsRoot,
		directory: async () => ({
			...emptyDirectory(),
			slugToConversation: { [ME]: CONVERSATION },
			conversationToSlug: { [String(CONVERSATION)]: ME },
			wake: { [String(CONVERSATION)]: { channelId: TEAM, seq: 1, from: OWNER, at: 10 } },
		}),
		saveDirectory: async () => undefined,
	} as never);

	return {
		tools: tools as never,
		call: async (name, args) => {
			const tool = tools.find((item) => item.name === name);
			expect(tool, `没有工具 ${name}`).toBeDefined();
			const result = (await tool?.execute(args as never, { conversationId: CONVERSATION } as never, BACKGROUND_CONTEXT)) as {
				output?: readonly { text?: string }[];
			};
			return result?.output?.[0]?.text ?? "";
		},
		root,
	};
}

describe("工具收敛：注册表只有十一个", () => {
	it("名单是 11 个，org / read_channel 这些旧名字一个不剩", async () => {
		const { tools } = await setup();
		expect(tools.map((item) => item.name)).toEqual([
			"say",
			"chats",
			"read_history",
			"remember",
			"teams",
			"write_team",
			"skills",
			"hire",
			"me",
			"run",
			"file",
		]);
	});
});

describe("chats", () => {
	it("action=list 列出我在的会话，带未读和最后一条", async () => {
		const { call } = await setup();
		const output = await call("chats", {});
		expect(output).toContain(TEAM);
		expect(output).toContain("群聊");
		expect(output).toContain("私聊");
		expect(output).toContain("连接池调到 20");
	});

	it("action=read 读历史消息", async () => {
		const { call } = await setup();
		const output = await call("chats", { action: "read", channel: TEAM });
		expect(output).toContain("连接池调到 20");
		expect(output).toContain("已标记到 #1 为已读");
	});

	it("不认识的 action 列出合法值", async () => {
		const { call } = await setup();
		const output = await call("chats", { action: "fetch" });
		expect(output).toContain("action 只有 list / read");
		expect(output).toContain("fetch");
	});
});

describe("read_history", () => {
	it("scope=memory 翻我的记忆", async () => {
		const { call } = await setup();
		const output = await call("read_history", { scope: "memory" });
		expect(output).toContain("部署前先看端口被谁占了");
	});

	it("scope=team 翻团队记忆（没写过就说没有）", async () => {
		const { call } = await setup();
		const output = await call("read_history", { scope: "team", team: "alpha" });
		expect(output).toContain("还没有记忆");
	});

	it("不认识的 scope 列出合法值", async () => {
		const { call } = await setup();
		const output = await call("read_history", { scope: "everywhere" });
		expect(output).toContain("scope 只有 channel / memory / personal / team");
	});
});

describe("teams", () => {
	it("action=list 列出团队", async () => {
		const { call } = await setup();
		const output = await call("teams", {});
		expect(output).toContain("alpha");
		expect(output).toContain("目标：把网页做到能看。");
	});

	it("action=read 读团队说明", async () => {
		const { call } = await setup();
		const output = await call("teams", { action: "read", team: "alpha" });
		expect(output).toContain("# alpha（alpha）");
		expect(output).toContain("目标：把网页做到能看。");
	});

	it("有 action 没 team 时说出该给什么", async () => {
		const { call } = await setup();
		const output = await call("teams", { action: "read" });
		expect(output).toContain("read 要带 team");
		expect(output).toContain("alpha");
	});

	it("不认识的 action 列出合法值", async () => {
		const { call } = await setup();
		const output = await call("teams", { action: "open" });
		expect(output).toContain("action 只有 list / read");
	});
});

describe("skills", () => {
	it("action=list 列公司层和我自己的技能", async () => {
		const { call } = await setup();
		const output = await call("skills", {});
		expect(output).toContain("写周报（公司）");
	});

	it("action=read 读正文", async () => {
		const { call } = await setup();
		const output = await call("skills", { action: "read", name: "写周报" });
		expect(output).toContain("# 技能：写周报（公司层）");
		expect(output).toContain("1. 写三行。");
	});

	it("action=write 写我个人层，写完读得到", async () => {
		const { call, root } = await setup();
		const written = await call("skills", {
			action: "write",
			name: "部署检查",
			description: "部署前要检查端口时用。",
			body: "先 lsof 看端口。",
		});
		expect(written).toContain("已写入技能「部署检查」");
		const source = await readFile(join(root, "agents", ME, "skills", "部署检查", "SKILL.md"), "utf8");
		expect(source).toContain("先 lsof 看端口。");
		const back = await call("skills", { action: "read", name: "部署检查" });
		expect(back).toContain("先 lsof 看端口。");
	});

	it("action=write 缺 description 时说缺什么", async () => {
		const { call } = await setup();
		const output = await call("skills", { action: "write", name: "空技能", body: "只有正文" });
		expect(output).toContain("写技能还缺");
		expect(output).toContain("description");
	});

	it("不认识的 action 列出合法值", async () => {
		const { call } = await setup();
		const output = await call("skills", { action: "delete", name: "写周报" });
		expect(output).toContain("action 只有 list / read / write");
	});
});

describe("me", () => {
	it("action=show 说出我是谁、在哪个团队、上级是谁", async () => {
		const { call } = await setup();
		const output = await call("me", {});
		expect(output).toContain("沈舟");
		expect(output).toContain("岗位：前端开发");
		expect(output).toContain("所在团队：alpha");
		expect(output).toContain("直属上级：owner");
	});

	it("action=update 整篇重写我的身份，文件真的变了", async () => {
		const { call, root } = await setup();
		const output = await call("me", { action: "update", body: "我是沈舟，现在也管部署。" });
		expect(output).toContain("已改我的身份");
		const source = await readFile(join(root, "agents", ME, "identity.md"), "utf8");
		expect(source).toContain("我是沈舟，现在也管部署。");
		expect(source).toContain("manager: owner");
	});

	it("action=update 不带 body 时说该带什么", async () => {
		const { call } = await setup();
		const output = await call("me", { action: "update" });
		expect(output).toContain("body");
	});

	it("不认识的 action 列出合法值", async () => {
		const { call } = await setup();
		const output = await call("me", { action: "rename" });
		expect(output).toContain("action 只有 show / update");
	});
});

describe("file", () => {
	it("action=read 读文件，能按行取", async () => {
		const { call } = await setup();
		const output = await call("file", { path: "notes.md", offset: 2, limit: 1 });
		expect(output).toContain("第二行");
		expect(output).not.toContain("第一行");
	});

	it("action=write 写文件，写完读得到", async () => {
		const { call } = await setup();
		const written = await call("file", { action: "write", path: "out/报告.md", content: "结论：能跑。" });
		expect(written).toContain("已写入 out/报告.md");
		const back = await call("file", { path: "out/报告.md" });
		expect(back).toContain("结论：能跑。");
	});

	it("write 不带 content 时说该带什么", async () => {
		const { call } = await setup();
		const output = await call("file", { action: "write", path: "out/空.md" });
		expect(output).toContain("content");
	});

	it("不认识的 action 列出合法值", async () => {
		const { call } = await setup();
		const output = await call("file", { action: "append", path: "notes.md" });
		expect(output).toContain("action 只有 read / write");
	});
});
