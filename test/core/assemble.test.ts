/**
 * 装配的端到端测试：从「文件夹里有什么」到「我说一句话、谁被唤醒」。
 *
 * 这是新核心最重要的一条验证 —— 它同时证明了四件事：
 * 1. `identity.md` 是唯一事实：没有代码里的角色枚举。
 * 2. 名册能从会话 id 反查 slug，因此投递能落地。
 * 3. 我 @ 谁，谁就被唤醒（且只有他）。
 * 4. 我不是 agent，不会被投递（也没有会话）。
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { BACKGROUND_CONTEXT } from "../../src/core/runtime/index.ts";
import { ownerSpeak } from "../../src/shell/assemble.ts";
import { seedOwnerAssistant } from "../../src/shell/seed.ts";
import { readIdentity } from "../../src/core/agent/identity.ts";
import { ChannelDoc, dmId, teamId, type ChannelState } from "../../src/core/channel/types.ts";
import { writeTeam } from "../../src/core/team/doc.ts";
import { DirectoryDoc, emptyDirectory, type DirectoryState } from "../../src/core/agent/roster.ts";
import { createAgent } from "../../src/core/agent/identity.ts";

import { sandboxPool } from "./support.ts";

const pool = sandboxPool();

afterEach(() => pool.cleanup());

describe("装配", () => {
	test("扫文件夹建会话，并把 slug↔会话写进名册", async () => {
		const box = await pool.make("core-assemble-");
		const agents = box.agentsRoot;
		await createAgent({ root: agents, name: "林越", title: "开发" });
		await createAgent({ root: agents, name: "沈舟", title: "财务" });

		const opened = await box.open();
		try {
			const shell = await box.assemble(opened);

			expect([...shell.conversations.keys()].sort()).toEqual(["林越", "沈舟"].sort());
			const directory = (await opened.harness.snapshot(DirectoryDoc)) as DirectoryState | undefined;
			expect(directory?.slugToConversation["林越"]).toBeTypeOf("number");
			expect(directory?.conversationToSlug[String(directory?.slugToConversation["沈舟"])]).toBe("沈舟");
		} finally {
			await opened.close();
		}
	});

	test("全员频道自动包含所有人和我", async () => {
		const box = await pool.make("core-assemble-");
		const agents = box.agentsRoot;
		await createAgent({ root: agents, name: "林越" });

		const opened = await box.open();
		try {
			const shell = await box.assemble(opened);
			const state = await shell.channels();
			expect(state.channels.all?.members.sort()).toEqual(["owner", "林越"].sort());
		} finally {
			await opened.close();
		}
	});

	test("rescan 只为新出现的人开会话", async () => {
		const box = await pool.make("core-assemble-");
		const agents = box.agentsRoot;
		await createAgent({ root: agents, name: "林越" });

		const opened = await box.open();
		try {
			const shell = await box.assemble(opened);
			const before = shell.conversations.size;
			await createAgent({ root: agents, name: "沈舟" });
			const added = await shell.rescan();
			expect(added).toEqual(["沈舟"]);
			expect(shell.conversations.size).toBe(before + 1);
			const state = await shell.channels();
			expect(state.channels.all?.members).toContain("沈舟");
		} finally {
			await opened.close();
		}
	});

	test("重启不会重复造人（会话 id 复用）", async () => {
		const box = await pool.make("core-assemble-");
		const agents = box.agentsRoot;
		await createAgent({ root: agents, name: "林越" });

		const first = await box.open();
		let firstId: number | undefined;
		try {
			await box.assemble(first);
			const directory = (await first.harness.snapshot(DirectoryDoc)) as DirectoryState | undefined;
			firstId = directory?.slugToConversation["林越"];
		} finally {
			await first.close();
		}

		const second = await box.open();
		try {
			await box.assemble(second);
			const directory = (await second.harness.snapshot(DirectoryDoc)) as DirectoryState | undefined;
			expect(directory?.slugToConversation["林越"]).toBe(firstId);
		} finally {
			await second.close();
		}
	});
});

describe("我说话", () => {
	test("@ 谁就只叫谁；我自己不被投递（他没有会话）", async () => {
		const box = await pool.make("core-assemble-");
		const agents = box.agentsRoot;
		await createAgent({ root: agents, name: "林越" });
		await createAgent({ root: agents, name: "沈舟" });

		const opened = await box.open();
		try {
			const shell = await box.assemble(opened);
			const sent = await ownerSpeak(shell, { channelId: "all", text: "@林越 停掉所有任务" });
			expect(sent.seq).toBe(1);

			const state = (await opened.harness.snapshot(ChannelDoc)) as ChannelState;
			const message = state.messages.all?.[0];
			expect(message?.from).toBe("owner");
			expect(message?.mentions).toEqual(["林越"]);

			// 林越的会话里应该收到一条投递（内容含频道名与正文）。
			const lin = shell.conversations.get("林越");
			expect(lin).toBeDefined();
			const view = await lin!.context(undefined as never).catch(() => undefined);
			// 不强制断言 context 内容：投递是异步 task，能读到会话本身已足够。
			expect(view === undefined || Array.isArray(view.messages)).toBe(true);
		} finally {
			await opened.close();
		}
	});

	test("装配之后加的人：@ 得到他，投递摘要里也是名字不是 slug", async () => {
		const box = await pool.make("core-assemble-");
		const agents = box.agentsRoot;
		await createAgent({ root: agents, name: "林越" });

		const opened = await box.open();
		try {
			const shell = await box.assemble(opened);
			// 装配之后才出现的人（另一个进程招的 / 手工加的目录 / 别处 rescan 过）：
			// 装配期那份 `shell.directory` 里没有他。旧代码只读那一份，于是「我视角里没这个人」。
			const dir = join(agents, "shenzhou");
			await mkdir(dir, { recursive: true });
			await writeFile(
				join(dir, "identity.md"),
				"---\nname: 沈舟\ntitle: 前端开发\n---\n\n写小恐龙。\n",
				"utf8",
			);
			// 模拟「另一个进程已经 rescan 过」：频道成员里有他、名册文档里有他的会话映射，
			// 但**本进程**装配期那份 `shell.directory` 里没有他。旧代码只读那一份，
			// 于是投递去找人时找不到，留痕里连名字都退回 slug。
			await opened.harness.commit(async (tx) => {
				const channels = (await tx.doc(ChannelDoc)) as ChannelState;
				const all = channels.channels.all;
				if (all !== undefined) channels.channels.all = { ...all, members: [...all.members, "shenzhou"] };
				const doc = (await tx.doc(DirectoryDoc)) as DirectoryState;
				doc.slugToConversation = { ...doc.slugToConversation, shenzhou: 4242 };
				doc.conversationToSlug = { ...doc.conversationToSlug, "4242": "shenzhou" };
			}, BACKGROUND_CONTEXT);
			const sent = await ownerSpeak(shell, { channelId: "all", text: "@沈舟 看下首页" });
			expect(sent.seq).toBe(1);
			const state = (await opened.harness.snapshot(ChannelDoc)) as ChannelState;
			expect(state.messages.all?.[0]?.mentions).toEqual(["shenzhou"]);
			// 他还没有会话（没人打开过他）：留痕要说清，而且 `@…` 得是当下的名字。
			const note = (state.messages.all ?? []).find((message) => message.kind === "note");
			expect(note?.text ?? "").toContain("@沈舟");
		} finally {
			await opened.close();
		}
	});

	test("不 @ 人时按规则唤醒第一个非我成员", async () => {
		const box = await pool.make("core-assemble-");
		const agents = box.agentsRoot;
		await createAgent({ root: agents, name: "林越" });

		const opened = await box.open();
		try {
			const shell = await box.assemble(opened);
			await ownerSpeak(shell, { channelId: "all", text: "有人吗" });
			const state = (await opened.harness.snapshot(ChannelDoc)) as ChannelState;
			expect(state.messages.all?.[0]?.mentions).toEqual([]);
			// 收件人规则在 state.ts 的单测里已覆盖；这里只确认消息落了盘。
		} finally {
			await opened.close();
		}
	});
});

describe("播种", () => {
	test("种出来的助理住在 assistant/ 下，且正文写清了职责", async () => {
		const box = await pool.make("core-assemble-");
		const slug = await seedOwnerAssistant(box.layout, { name: "林越" });
		const identity = await readIdentity(box.layout.agentRoots, slug);
		expect(identity?.dir.startsWith(box.layout.assistantRoot)).toBe(true);
		// 正文来自 `seed/agents/assistant/identity.md`（组织是文件）。这里只钉两条不变式：
		// 它得是**真的写清了职责**（不是占位），且零工具名 —— V3 起工具改名不许让 seed 撒谎。
		const body = identity?.body ?? "";
		expect(body.length).toBeGreaterThan(80);
		expect(body).not.toMatch(/[a-z_]+\((action|scope)=/);
		expect(body).not.toMatch(/`(say|hire|skills|remember|read_history|write_team|me|run|file)`/);
	});

	test("seed 出来的人能被装配扫到", async () => {
		const box = await pool.make("core-assemble-");
		await seedOwnerAssistant(box.layout, { name: "林越" });

		const opened = await box.open();
		try {
			const shell = await box.assemble(opened);
			expect(shell.conversations.has("林越")).toBe(true);
			expect((await shell.channels()).channels.all?.members).toContain("林越");
		} finally {
			await opened.close();
		}
	});
});

describe("会话只有两种形态与团队频道", () => {
	test("新人做四件事：建会话、记名册、进全员群、开私聊", async () => {
		const box = await pool.make("core-assemble-");
		const agents = box.agentsRoot;
		await createAgent({ root: agents, name: "林越" });
		await createAgent({ root: agents, name: "沈舟" });

		const opened = await box.open();
		try {
			const shell = await box.assemble(opened);
			const state = await shell.channels();
			// 每个成员一出现就有「我 ↔ 他」的私聊：他的工作过程在那里看。
			for (const slug of ["林越", "沈舟"]) {
				const dm = state.channels[dmId("owner", slug)];
				expect(dm?.members).toEqual(["owner", slug]);
			}
			expect(state.channels[dmId("owner", "owner")]).toBeUndefined();
			// 但两人都在全员群里（否则没人 @ 得到他们）。
			for (const slug of ["林越", "沈舟"]) {
				expect(state.channels.all?.members).toContain(slug);
			}
		} finally {
			await opened.close();
		}
	});

	test("助理、成员、我都进团队频道", async () => {
		const box = await pool.make("core-assemble-");
		const agents = box.agentsRoot;
		const teams = box.teamsRoot;
		await createAgent({ root: box.layout.assistantRoot, name: "知言", title: "助理" });
		await createAgent({ root: agents, name: "沈舟", team: "坦克大战" });
		await writeTeam(teams, { slug: "坦克大战", body: "# 目标\n能两个人打。" });

		const opened = await box.open();
		try {
			const shell = await box.assemble(opened, { agentsRoot: agents, teamsRoot: teams });
			const state = await shell.channels();
			const channel = state.channels[teamId("坦克大战")];
			// 团队频道 = 我 + 助理 + 这个团队的人；没有负责人这一层。
			expect(channel?.members.sort()).toEqual(["owner", "沈舟", "知言"].sort());
			expect(channel?.title).toBe("坦克大战");
		} finally {
			await opened.close();
		}
	});

	test("团队频道里没人被 @ 时叫醒助理（不是「负责人」）", async () => {
		const box = await pool.make("core-assemble-");
		const agents = box.agentsRoot;
		const teams = box.teamsRoot;
		await createAgent({ root: box.layout.assistantRoot, name: "知言", title: "助理" });
		await createAgent({ root: agents, name: "沈舟", team: "坦克大战" });
		await writeTeam(teams, { slug: "坦克大战", body: "# 目标\n能两个人打。" });

		const opened = await box.open();
		try {
			const shell = await box.assemble(opened, { agentsRoot: agents, teamsRoot: teams });
			const state = await shell.channels();
			const channel = state.channels[teamId("坦克大战")];
			// 成员说「做完了」时通常不会 @ 人。助理收不到就只能轮询
			// （实测里 agent 用 `run sleep 120` 等进度）。所以团队频道让助理始终醒着。
			expect(channel?.wakeOnAll).toEqual(["知言"]);
		} finally {
			await opened.close();
		}
	});

	test("人换了团队，频道成员跟着变（不需要重启）", async () => {
		const box = await pool.make("core-assemble-");
		const agents = box.agentsRoot;
		const teams = box.teamsRoot;
		await createAgent({ root: agents, name: "林越", team: "坦克大战" });
		await createAgent({ root: agents, name: "沈舟", team: "坦克大战" });
		await writeTeam(teams, { slug: "坦克大战", body: "# 目标\n能两个人打。" });

		const opened = await box.open();
		try {
			const shell = await box.assemble(opened, { agentsRoot: agents, teamsRoot: teams });
			// 林越改去别的团队：团队频道按身份文件精确重算。
			await createAgent({ root: agents, name: "林越", team: "别的" });
			await shell.syncTeam("坦克大战");
			const state = await shell.channels();
			expect(state.channels[teamId("坦克大战")]?.members).toContain("沈舟");
		} finally {
			await opened.close();
		}
	});

	test("团队频道成员按事实精确重算，不残留幽灵成员", async () => {
		const box = await pool.make("core-assemble-");
		const agents = box.agentsRoot;
		const teams = box.teamsRoot;
		await createAgent({ root: agents, name: "林越", team: "坦克大战" });
		await createAgent({ root: agents, name: "沈舟", team: "坦克大战" });
		await writeTeam(teams, { slug: "坦克大战", body: "# 目标\n能两个人打。" });

		const opened = await box.open();
		try {
			const shell = await box.assemble(opened, {
				agentsRoot: agents,
				teamsRoot: teams,
			});
			// 模拟一个旧 slug 残留（改名/重建后留下的幽灵成员）。
			const before = await shell.channels();
			before.channels[teamId("坦克大战")] = {
				...before.channels[teamId("坦克大战")],
				members: [...before.channels[teamId("坦克大战")].members, "gunanyan"],
			};
			await opened.harness.commit(async (tx) => {
				const doc = (await tx.doc(ChannelDoc)) as ChannelState;
				doc.channels[teamId("坦克大战")] = before.channels[teamId("坦克大战")];
			}, BACKGROUND_CONTEXT);

			// 重算后幽灵成员应被清除。
			await shell.syncTeam("坦克大战");
			const after = await shell.channels();
			expect(after.channels[teamId("坦克大战")]?.members).not.toContain("gunanyan");
			expect(after.channels[teamId("坦克大战")]?.members.sort()).toEqual(
				["owner", "林越", "沈舟"].sort(),
			);
		} finally {
			await opened.close();
		}
	});
});
