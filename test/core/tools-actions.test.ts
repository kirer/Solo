/**
 * 合并后的工具：一个工具两三种 `action`。
 *
 * 工具清单每轮都进提示词，名字越多，模型选错的概率越高（ADR-084）。合并的代价是
 * **参数里有分支** —— 所以每个合并工具都要钉两件事：
 *
 * 1. 每个 `action` 都真的能跑通（不是只有默认那个）；
 * 2. 不认识的 `action` 要回一句能自救的话（列出合法值），而不是沉默或抛错。
 */
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BACKGROUND_CONTEXT } from "../../src/core/runtime/index.ts";
import { openCore, type CoreRuntime } from "../../src/core/runtime/open.ts";
import { SEED_TEXT } from "./catalog.ts";
import { createCoreTools } from "../../src/core/channel/tools/index.ts";
import { ChannelDoc, OWNER, dmId, teamId, type ChannelState } from "../../src/core/channel/types.ts";
import { appendMessage, ensureChannel } from "../../src/core/channel/rules.ts";
import { emptyDirectory } from "../../src/core/channel/roster.ts";
import { writeTeam } from "../../src/core/documents/team/doc.ts";
import { existsAt } from "../../src/core/runtime/io.ts";
import { sandboxPool } from "./support.ts";

const pool = sandboxPool();

afterEach(() => pool.cleanup());

const ME = "沈舟";
const CONVERSATION = 7;
const ASSISTANT = 8;
const DM = dmId(OWNER, ME);
const TEAM = teamId("alpha");

async function setup(
	extra: Record<string, unknown> = {},
): Promise<{
	tools: readonly { name: string; execute?: (...args: never[]) => Promise<unknown> }[];
	call: (name: string, args: Record<string, unknown>) => Promise<string>;
	root: string;
	layout: import("../../src/core/layout.ts").Layout;
	runtime: CoreRuntime;
}> {
	const box = await pool.make("core-tools-");
	const root = box.root;
	const agentsRoot = box.agentsRoot;
	const teamsRoot = box.teamsRoot;
	// 助理住在应用根的 `assistant/` 下（文件夹事实，ADR-058）：招人 / 建团队归它。
	await mkdir(join(box.layout.assistantRoot, "知言"), { recursive: true });
	await writeFile(join(box.layout.assistantRoot, "知言", "identity.md"), "---\nname: 知言\ntitle: 助理\n---\n\n统筹。\n", "utf8");
	await mkdir(join(agentsRoot, ME, "skills"), { recursive: true });
	await writeFile(
		join(agentsRoot, ME, "identity.md"),
		"---\nname: 沈舟\ntitle: 前端开发\nteam: alpha\n---\n\n写小恐龙。\n",
		"utf8",
	);
	await writeFile(join(agentsRoot, ME, "memory.md"), "# 记忆\n\n## 端口\n\n部署前先看端口被谁占了。\n", "utf8");
	await writeTeam(teamsRoot, { slug: "alpha", name: "alpha", body: "目标：把网页做到能看。" });
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
		layout: box.layout,
		text: SEED_TEXT,
		directory: async () => ({
			...emptyDirectory(),
			slugToConversation: { [ME]: CONVERSATION, 知言: ASSISTANT },
			conversationToSlug: { [String(CONVERSATION)]: ME, [String(ASSISTANT)]: "知言" },
			wake: {
				[String(CONVERSATION)]: {
					reply: { channelId: TEAM, seq: 1, from: OWNER, at: 10 },
					task: { channelId: TEAM, seq: 1, from: OWNER, at: 10 },
				},
			},
		}),
		saveDirectory: async () => undefined,
		// 招人这条路在装配里是必填项；测试只关心工具说了什么，给它一组能跑的空实现。
		openAgent: async () => 99,
		syncTeam: async () => undefined,
		announceJoin: async () => undefined,
		modelChoices: async () => ({ models: [] }),
		setModel: async () => {
			throw new Error("没有这个模型");
		},
		...extra,
	} as never);

	return {
		layout: box.layout,
		tools: tools as never,
		call: async (name, args, conversationId = CONVERSATION) => {
			const tool = tools.find((item) => item.name === name);
			expect(tool, `没有工具 ${name}`).toBeDefined();
			const result = (await tool?.execute(args as never, { conversationId } as never, BACKGROUND_CONTEXT)) as {
				output?: readonly { text?: string }[];
			};
			return result?.output?.[0]?.text ?? "";
		},
		root,
		runtime,
	};
}

describe("工具收敛：注册表只有八个", () => {
	it("名单是 8 个，org / read_channel 这些旧名字一个不剩", async () => {
		const { tools } = await setup();
		expect(tools.map((item) => item.name)).toEqual([
			"say",
			"chats",
			"read_history",
			"remember",
			"hire",
			"route",
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

	it("写完报出「原 N → 现 M 字节」，新建报「新建」", async () => {
		const { call } = await setup();
		// 新建：没有「原」，说「新建」。
		const first = await call("file", { action: "write", path: "out/字节.md", content: "第一版" });
		expect(first).toContain("新建");
		const firstBytes = Buffer.byteLength("第一版", "utf8");
		expect(first).toContain(`${String(firstBytes)} 字节`);

		// 覆写：原 → 现，两边都是字节数。
		const next = "第二版长一点";
		const second = await call("file", { action: "write", path: "out/字节.md", content: next });
		const nextBytes = Buffer.byteLength(next, "utf8");
		expect(second).toContain(`原 ${String(firstBytes)} → 现 ${String(nextBytes)} 字节`);
	});

	it("空正文 + 目标非空：拒绝，文件原样不动", async () => {
		const { call, root } = await setup();
		const original = "# 缺陷清单\n\n这份东西丢了就没了。\n";
		await call("file", { action: "write", path: "out/清单.md", content: original });
		const before = Buffer.byteLength(original, "utf8");

		const refused = await call("file", { action: "write", path: "out/清单.md", content: "" });
		// 报明「现在多少字节」，别只说「不许」。
		expect(refused).toContain(`${String(before)} 字节`);
		expect(refused).not.toContain("已写入");

		// 原件必须还在盘上，一个字节都不能少。
		const onDisk = await readFile(join(root, "out/清单.md"), "utf8");
		expect(onDisk).toBe(original);
	});

	it("空正文 + 目标是新的或本来就是空文件：放行（那是在建空文件）", async () => {
		const { call, root } = await setup();
		// 文件本来不存在。
		const fresh = await call("file", { action: "write", path: "out/新空.md", content: "" });
		expect(fresh).toContain("已写入");
		expect(await readFile(join(root, "out/新空.md"), "utf8")).toBe("");
		// 已经是空文件，再写一次空：不该被挡（挡了就写不出空文件了）。
		const again = await call("file", { action: "write", path: "out/新空.md", content: "" });
		expect(again).toContain("已写入");
	});

	it("写到一半坏掉：原件还在，内容一个字节没变", async () => {
		const { call, root } = await setup();
		const original = "原件内容，不能被半截写坏\n".repeat(10);
		const path = "out/要坏.md";
		await call("file", { action: "write", path, content: original });
		const before = Buffer.byteLength(original, "utf8");

		// 在「临时文件写好、还没换上去」那一瞬注入失败 —— 这正是崩溃的位置。
		const io = await import("../../src/core/runtime/io.ts");
		io.setAtomicWriteFault(() => Promise.reject(new Error("写到一半崩了")));
		try {
			await expect(io.writeTextAtomic(join(root, path), "新内容")).rejects.toThrow("写到一半崩了");
		} finally {
			io.setAtomicWriteFault(undefined);
		}

		// 关键断言：目标文件还是原来那一份完整的，不是半截、不是空的。
		const onDisk = await readFile(join(root, path), "utf8");
		expect(onDisk).toBe(original);
		expect(Buffer.byteLength(onDisk, "utf8")).toBe(before);
	});

	it("文件工具走的是原子写：中途崩了，报告「没写进去」，原件还在", async () => {
		const { call, root } = await setup();
		const original = "这份不能丢。\n".repeat(20);
		const path = "out/经工具写.md";
		await call("file", { action: "write", path, content: original });

		const io = await import("../../src/core/runtime/io.ts");
		io.setAtomicWriteFault(() => Promise.reject(new Error("盘满了")));
		try {
			const refused = await call("file", { action: "write", path, content: "半截内容" });
			// 不能回「已写入」骗人。
			expect(refused).not.toContain("已写入");
			expect(refused).toContain("没写进去");
		} finally {
			io.setAtomicWriteFault(undefined);
		}

		expect(await readFile(join(root, path), "utf8")).toBe(original);
	});

	it("写失败不留临时文件", async () => {
		const { call, root } = await setup();
		await call("file", { action: "write", path: "out/有临时.md", content: "原样" });

		const io = await import("../../src/core/runtime/io.ts");
		io.setAtomicWriteFault(() => Promise.reject(new Error("崩了")));
		try {
			await io.writeTextAtomic(join(root, "out/有临时.md"), "新").catch(() => undefined);
		} finally {
			io.setAtomicWriteFault(undefined);
		}

		const leftovers = (await readdir(join(root, "out"))).filter((name) => name.includes(".tmp"));
		expect(leftovers).toEqual([]);
	});

	it("不认识的 action 列出合法值", async () => {
		const { call } = await setup();
		const output = await call("chats", { action: "fetch" });
		expect(output).toContain("action 只有 list / read");
		expect(output).toContain("fetch");
	});

	it("action=create：任何成员都能拉群，自己在里面（ADR-063）", async () => {
		const { call, runtime } = await setup();
		const output = await call("chats", { action: "create", title: "小群", members: ["知言"] });
		expect(output).toContain("已建群「小群」");
		const state = (await runtime.harness.snapshot(ChannelDoc, BACKGROUND_CONTEXT)) as ChannelState;
		const group = state.channels["group:小群"];
		expect(group?.members.sort()).toEqual(["知言", ME].sort());
		expect(group?.wakeOnAll.sort()).toEqual(["知言", ME].sort());
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

	async function withSecret(layout: { readonly secretsFile: string }): Promise<void> {
		await writeFile(layout.secretsFile, JSON.stringify({ FAKE_KEY: KEY }), "utf8");
	}

	// V3 删了 `me` / `skills` / `write_team` 三个包装工具，写盘只剩 `file`（+ `remember` / `hire`）。
	// 脱敏这条契约没变：**任何进提示词的文件的写入口都必须脱敏**，所以改走 `file` 再钉一遍。
	it("file 写进 identity.md 的是马赛克", async () => {
		const { call, root, layout } = await setup();
		await withSecret(layout);
		const output = await call("file", { action: "write", path: `members/${ME}/identity.md`, content: `---\nname: ${ME}\n---\n\n部署用这个 key：${KEY}` });
		expect(output).toContain("已写入");
		const source = await readFile(join(root, "members", ME, "identity.md"), "utf8");
		// identity.md 每轮都进提示词：原值写进去就是**每一轮**都发给模型，不可逆。
		expect(source).not.toContain(KEY);
		expect(source).toContain("[密钥已隐藏]");
	});

	it("file 写进个人 SKILL.md 的是马赛克", async () => {
		const { call, root, layout } = await setup();
		await withSecret(layout);
		await call("file", {
			action: "write",
			path: `members/${ME}/skills/调接口/SKILL.md`,
			content: `---\nname: 调接口\ndescription: 调那个接口时用。\n---\n\ncurl -H 'Authorization: ${KEY}'`,
		});
		const source = await readFile(join(root, "members", ME, "skills", "调接口", "SKILL.md"), "utf8");
		expect(source).not.toContain(KEY);
		expect(source).toContain("[密钥已隐藏]");
	});

	it("file 写进团队 README.md 的是马赛克", async () => {
		const { call, root, layout } = await setup();
		await withSecret(layout);
		await call("file", {
			action: "write",
			path: "teams/alpha/README.md",
			content: `---\nname: alpha\n---\n\n目标：把网页做到能看。\n\n数据库密码：${KEY}`,
		});
		const source = await readFile(join(root, "teams", "alpha", "README.md"), "utf8");
		expect(source).not.toContain(KEY);
		expect(source).toContain("[密钥已隐藏]");
	});

	it("remember scope=team 写进 memory.md 的是马赛克", async () => {
		const { call, root, layout } = await setup();
		await withSecret(layout);
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

	it("漏写 action 但给了 content：按写处理，不报「文件不存在」", async () => {
		const { call } = await setup();
		const written = await call("file", { path: "out/漏了.md", content: "结论：能跑。" });
		expect(written).toContain("已写入 out/漏了.md");
		const back = await call("file", { path: "out/漏了.md" });
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

describe("开新团队只有助理能做", () => {
	it("团队成员写一个新团队的 README 被拒，不落盘", async () => {
		const { call, root } = await setup();
		const output = await call("file", {
			action: "write",
			path: "teams/beta/README.md",
			content: "---\nname: beta\n---\n\n新团队。",
		});
		expect(output).toContain("只有助理能做");
		expect(await readFile(join(root, "teams", "beta", "README.md"), "utf8").catch(() => "missing")).toBe("missing");
	});

	it("改已有团队的 README 不受这条限制", async () => {
		const synced: string[] = [];
		const { call } = await setup({ syncTeam: async (team: string) => void synced.push(team) });
		await call("file", { action: "write", path: "teams/alpha/README.md", content: "---\nname: alpha\n---\n\n新目标。" });
		expect(synced).toEqual(["alpha"]);
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
		await call("file", { action: "write", path: "teams/alpha/README.md", content: "---\nname: alpha\n---\n\n新目标。" });
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
			content: "---\nname: alpha\n---\n\n新目标",
		});
		// 不能反过来报「没写进去」：模型会重写一遍，把刚写的正文覆盖掉。
		expect(output).toContain("已写入 teams/alpha/README.md");
		expect(output).toContain("团队频道刷新失败");
		expect(output).toContain("频道存储不可用");
	});
});

describe("hire：招人 / 让人走 / 看模型", () => {
	it("action=models 列出能挑的模型，并标出默认那只", async () => {
		const { call } = await setup({
			modelChoices: async () => ({ models: ["provider/fast", "provider/strong"], default: "provider/strong" }),
		});
		const output = await call("hire", { action: "models", name: "" });
		expect(output).toContain("provider/fast");
		expect(output).toContain("provider/strong（默认）");
	});

	it("action=create 带 model 时把 model 交给装配，非法只回一句话、人照样招到", async () => {
		const assigned: string[] = [];
		const { call, root } = await setup({
			setModel: async (_slug: string, ref: string) => {
				if (ref !== "provider/fast") throw new Error(`没有这个模型：${ref}`);
				assigned.push(ref);
				return { model: ref };
			},
		});
		const ok = await call("hire", { name: "顾南", model: "provider/fast" }, ASSISTANT);
		expect(ok).toContain("模型 provider/fast");
		expect(assigned).toEqual(["provider/fast"]);
		const bad = await call("hire", { name: "温言", model: "provider/nope" }, ASSISTANT);
		expect(bad).toContain("模型没换成");
		// 模型写不进去不影响「人已经招到」。
		expect(await existsAt(join(root, "members", "温言", "identity.md"))).toBe(true);
	});

	it("招进一个还没有 README 的团队：人照招，但明确说「这个团队还没有频道」", async () => {
		// 建立团队技能的顺序就是先招人、再写 README。所以这里不拦，只把事实说清楚 ——
		// 不说的话，模型会在一个不存在的频道里 say，失败只回到它自己。
		const { call } = await setup();
		const output = await call("hire", { name: "顾南", team: "dino" }, ASSISTANT);
		expect(output).toContain("已新建");
		expect(output).toContain("还没有 README");
		expect(output).toContain("teams/dino/README.md");
		// 已有 README 的团队不啰嗦这一句。
		expect(await call("hire", { name: "温言", team: "alpha" }, ASSISTANT)).not.toContain("还没有 README");
	});

	it("招进已有团队：叫他自己去报到；团队还没有 README 时不叫", async () => {
		// 新人进频道是 `openAgent` 顺手做的，「新进的」差集算不出来 —— 由招人自己点名。
		const joined: string[] = [];
		const { call } = await setup({
			announceJoin: async (team: string, slugs: readonly string[]) => {
				joined.push(`${team}:${slugs.join(",")}`);
			},
		});
		await call("hire", { name: "顾南", team: "alpha" }, ASSISTANT);
		expect(joined).toEqual(["alpha:顾南"]);
		// 频道还不存在（没有 README）：这时候叫不到人，建团队时才会一起叫。
		await call("hire", { name: "温言", team: "dino" }, ASSISTANT);
		expect(joined).toHaveLength(1);
	});

	it("招人 / 开除只有助理能做：成员被拒，人还在", async () => {
		const { call, root } = await setup();
		expect(await call("hire", { name: "顾南" })).toContain("只有助理能做");
		// 助理招进来的人，成员开不掉。
		await call("hire", { name: "顾南" }, ASSISTANT);
		expect(await call("hire", { action: "fire", name: "顾南" })).toContain("只有助理能做");
		expect(await existsAt(join(root, "members", "顾南"))).toBe(true);
	});

	it("action=fire 把目录移到 .retired/，从名册里摘掉（只移不删）", async () => {
		const { call, root } = await setup();
		expect(await call("hire", { name: "顾南", team: "alpha" }, ASSISTANT)).toContain("members/");
		const output = await call("hire", { action: "fire", name: "顾南" }, ASSISTANT);
		expect(output).toContain("已让");
		expect(await existsAt(join(root, "members", "顾南"))).toBe(false);
		const retired = await readdir(join(root, "members", ".retired"));
		expect(retired.some((name) => name.startsWith("顾南-"))).toBe(true);
	});
});

describe("file 写身份：换团队要重投影两次", () => {
	it("旧团队和新团队各叫一次 syncTeam（加人后团队频道立刻更新）", async () => {
		const synced: string[] = [];
		const { call } = await setup({
			syncTeam: async (team: string) => {
				synced.push(team);
			},
		});
		const output = await call("file", {
			action: "write",
			path: `members/${ME}/identity.md`,
			content: `---\nname: ${ME}\ntitle: 前端开发\nteam: beta\n---\n\n写小恐龙。\n`,
		});
		expect(output).toContain("已写入");
		// 旧团队 alpha 与人走了之后要重算，新团队 beta 也要重算 —— 少一次就是「加进团队了但频道里没他」。
		expect(new Set(synced)).toEqual(new Set(["alpha", "beta"]));
	});
});
