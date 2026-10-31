/**
 * 合并后的工具：一个工具两三种 `action`。
 *
 * 工具清单每轮都进提示词，名字越多，模型选错的概率越高（ADR-084）。合并的代价是
 * **参数里有分支** —— 所以每个合并工具都要钉两件事：
 *
 * 1. 每个 `action` 都真的能跑通（不是只有默认那个）；
 * 2. 不认识的 `action` 要回一句能自救的话（列出合法值），而不是沉默或抛错。
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BACKGROUND_CONTEXT } from "../../src/core/runtime/index.ts";
import { openCore, type CoreRuntime } from "../../src/core/runtime/open.ts";
import { createCoreTools } from "../../src/core/channel/tools/index.ts";
import { ChannelDoc, OWNER, dmId, teamId, type ChannelState } from "../../src/core/channel/types.ts";
import { appendMessage, ensureChannel } from "../../src/core/channel/rules.ts";
import { emptyDirectory } from "../../src/core/agent/roster.ts";
import { writeTeam } from "../../src/core/team/doc.ts";
import { sandboxPool } from "./support.ts";

const pool = sandboxPool();

afterEach(() => pool.cleanup());

const ME = "沈舟";
const CONVERSATION = 7;
const DM = dmId(OWNER, ME);
const TEAM = teamId("alpha");

async function setup(
	extra: Record<string, unknown> = {},
): Promise<{
	tools: readonly { name: string; execute?: (...args: never[]) => Promise<unknown> }[];
	call: (name: string, args: Record<string, unknown>) => Promise<string>;
	root: string;
	runtime: CoreRuntime;
}> {
	const box = await pool.make("core-tools-");
	const root = box.root;
	const agentsRoot = box.agentsRoot;
	const teamsRoot = box.teamsRoot;
	// 助理（直接向 owner 汇报的人）与团队成员分开：团队 README 的 `lead` 不能是助理。
	await mkdir(join(agentsRoot, "知言"), { recursive: true });
	await writeFile(join(agentsRoot, "知言", "identity.md"), "---\nname: 知言\ntitle: 助理\nmanager: owner\n---\n\n统筹。\n", "utf8");
	await mkdir(join(agentsRoot, ME, "skills"), { recursive: true });
	await writeFile(
		join(agentsRoot, ME, "identity.md"),
		"---\nname: 沈舟\ntitle: 前端开发\nmanager: 知言\nteam: alpha\n---\n\n写小恐龙。\n",
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

	const runtime = await box.open();

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
		...extra,
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
		runtime,
	};
}

describe("工具收敛：注册表只有七个", () => {
	it("名单是 7 个，org / read_channel 这些旧名字一个不剩", async () => {
		const { tools } = await setup();
		expect(tools.map((item) => item.name)).toEqual([
			"say",
			"chats",
			"read_history",
			"remember",
			"hire",
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

	it("action=read 走 markRead：游标既不越界也不往回拉", async () => {
		const { call, runtime } = await setup();
		// 先造一个越界的旧游标。旧写法是 `doc.readMarks[slug][频道] = last.seq`，无条件覆盖：
		// 一次被 `since` 过滤过的读就能把游标从 999999 拉回 #1，读过的消息全部重新变红。
		await runtime.harness.commit(async (tx) => {
			const doc = (await tx.doc(ChannelDoc)) as ChannelState;
			doc.readMarks[ME] = { [TEAM]: 999_999 };
		}, BACKGROUND_CONTEXT);
		await call("chats", { action: "read", channel: TEAM });
		const after = (await runtime.harness.snapshot(ChannelDoc)) as ChannelState;
		expect(after.readMarks[ME]?.[TEAM]).toBe(999_999);
	});

	it("action=read 之后来的消息仍然算未读", async () => {
		const { call, runtime } = await setup();
		await call("chats", { action: "read", channel: TEAM });
		await runtime.harness.commit(async (tx) => {
			const doc = (await tx.doc(ChannelDoc)) as ChannelState;
			const added = appendMessage(doc, TEAM, { from: OWNER, text: "连接池调到 50", at: 20 });
			doc.messages[TEAM] = [...(doc.messages[TEAM] ?? []), added.message];
			doc.nextSeq[TEAM] = added.message.seq + 1;
		}, BACKGROUND_CONTEXT);
		// 游标被写成「以后全已读」的话，这个红点永远不会再出现。
		expect(await call("chats", {})).toContain("1 条未读");
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

describe("写盘前先脱敏", () => {
	const KEY = "{{SECRET_quvz7n3k}}";

	async function withSecret(root: string): Promise<void> {
		await writeFile(join(root, ".secrets.json"), JSON.stringify({ FAKE_KEY: KEY }), "utf8");
	}

	// V3 删了 `me` / `skills` / `write_team` 三个包装工具，写盘只剩 `file`（+ `remember` / `hire`）。
	// 脱敏这条契约没变：**任何进提示词的文件的写入口都必须脱敏**，所以改走 `file` 再钉一遍。
	it("file 写进 identity.md 的是马赛克", async () => {
		const { call, root } = await setup();
		await withSecret(root);
		const output = await call("file", { action: "write", path: `agents/${ME}/identity.md`, content: `---\nname: ${ME}\n---\n\n部署用这个 key：${KEY}` });
		expect(output).toContain("已写入");
		const source = await readFile(join(root, "agents", ME, "identity.md"), "utf8");
		// identity.md 每轮都进提示词：原值写进去就是**每一轮**都发给模型，不可逆。
		expect(source).not.toContain(KEY);
		expect(source).toContain("[密钥已隐藏]");
	});

	it("file 写进个人 SKILL.md 的是马赛克", async () => {
		const { call, root } = await setup();
		await withSecret(root);
		await call("file", {
			action: "write",
			path: `agents/${ME}/skills/调接口/SKILL.md`,
			content: `---\nname: 调接口\ndescription: 调那个接口时用。\n---\n\ncurl -H 'Authorization: ${KEY}'`,
		});
		const source = await readFile(join(root, "agents", ME, "skills", "调接口", "SKILL.md"), "utf8");
		expect(source).not.toContain(KEY);
		expect(source).toContain("[密钥已隐藏]");
	});

	it("file 写进团队 README.md 的是马赛克", async () => {
		const { call, root } = await setup();
		await withSecret(root);
		await call("file", {
			action: "write",
			path: "teams/alpha/README.md",
			content: `---\nname: alpha\nlead: 沈舟\n---\n\n目标：把网页做到能看。\n\n数据库密码：${KEY}`,
		});
		const source = await readFile(join(root, "teams", "alpha", "README.md"), "utf8");
		expect(source).not.toContain(KEY);
		expect(source).toContain("[密钥已隐藏]");
	});

	it("remember scope=team 写进 memory.md 的是马赛克", async () => {
		const { call, root } = await setup();
		await withSecret(root);
		await call("remember", { scope: "team", text: `以后用这个 key 连库：${KEY}` });
		const source = await readFile(join(root, "teams", "alpha", "memory.md"), "utf8");
		expect(source).not.toContain(KEY);
		expect(source).toContain("[密钥已隐藏]");
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

describe("写团队 README 会重投影频道（ADR-097）", () => {
	it("写 teams/<slug>/README.md 触发 syncTeam，写普通文件不触发", async () => {
		const synced: string[] = [];
		const { call } = await setup({
			syncTeam: async (team: string) => {
				synced.push(team);
			},
		});
		await call("file", { action: "write", path: "teams/alpha/README.md", content: "---\nname: alpha\nlead: 沈舟\n---\n\n新目标。" });
		expect(synced).toEqual(["alpha"]);

		await call("file", { action: "write", path: "out/日报.md", content: "普通文件" });
		expect(synced).toEqual(["alpha"]);
	});

	it("别的 teams 路径（memory.md、深层目录）不算团队说明", async () => {
		const synced: string[] = [];
		const { call } = await setup({
			syncTeam: async (team: string) => {
				synced.push(team);
			},
		});
		await call("file", { action: "write", path: "teams/alpha/memory.md", content: "记忆" });
		await call("file", { action: "write", path: "teams/alpha/sub/README.md", content: "子目录" });
		expect(synced).toEqual([]);
	});

	it("syncTeam 抛错时仍算写入成功，并说清「刷新失败」", async () => {
		const { call } = await setup({
			syncTeam: async () => {
				throw new Error("频道存储不可用");
			},
		});
		const output = await call("file", {
			action: "write",
			path: "teams/alpha/README.md",
			content: "---\nname: alpha\nlead: 沈舟\n---\n\n新目标",
		});
		// 不能反过来报「没写进去」：模型会重写一遍，把刚写的正文覆盖掉。
		expect(output).toContain("已写入 teams/alpha/README.md");
		expect(output).toContain("团队频道刷新失败");
		expect(output).toContain("频道存储不可用");
	});
});

describe("写团队 README 前校验 lead", () => {
	it("缺 lead：拒绝，且不落盘", async () => {
		const { call, root } = await setup();
		const output = await call("file", { action: "write", path: "teams/alpha/README.md", content: "新目标" });
		expect(output).toContain("必须写");
		const source = await readFile(join(root, "teams", "alpha", "README.md"), "utf8");
		expect(source).not.toContain("新目标");
	});

	it("lead 查无此人：拒绝，并列出名册里的 slug", async () => {
		const { call } = await setup();
		const output = await call("file", {
			action: "write",
			path: "teams/alpha/README.md",
			content: "---\nname: alpha\nlead: 不存在的人\n---\n\n新目标",
		});
		expect(output).toContain("不在名册里");
		expect(output).toContain(ME);
	});

	it("助理不能当团队管理员：拒绝", async () => {
		const { call } = await setup();
		const output = await call("file", {
			action: "write",
			path: "teams/alpha/README.md",
			content: "---\nname: alpha\nlead: 知言\n---\n\n新目标",
		});
		expect(output).toContain("不能当团队管理员");
	});

	it("合法 lead：照常写入", async () => {
		const { call, root } = await setup();
		const output = await call("file", {
			action: "write",
			path: "teams/alpha/README.md",
			content: "---\nname: alpha\nlead: 沈舟\n---\n\n新目标",
		});
		expect(output).toContain("已写入");
		expect(await readFile(join(root, "teams", "alpha", "README.md"), "utf8")).toContain("新目标");
	});
});
