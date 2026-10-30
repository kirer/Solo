import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BACKGROUND_CONTEXT, createRegistry, setupModels } from "../../src/core/runtime/index.ts";
import { openCore, type CoreRuntime } from "../../src/core/runtime/open.ts";
import { assembleCore, type CoreShell } from "../../src/core/shell/assemble.ts";
import { ChannelDoc, ensureChannel, type ChannelState } from "../../src/core/channel/store.ts";
import { createAgent } from "../../src/core/agent/create.ts";
import { SettleDoc, confirmedBy, settleTeam, type SettleState } from "../../src/core/team/settle.ts";
import { appendTeamMemory } from "../../src/core/team/memory.ts";
import { writeTeam } from "../../src/core/team/doc.ts";
import { seedPromptTemplates } from "../../src/core/shell/seed.ts";

const roots: string[] = [];
const runtimes: CoreRuntime[] = [];

afterEach(async () => {
	for (const runtime of runtimes.splice(0)) await runtime.close().catch(() => undefined);
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function setup(): Promise<{ shell: CoreShell; root: string; agentsRoot: string; teamsRoot: string }> {
	const root = await mkdtemp(join(tmpdir(), "core-settle-"));
	roots.push(root);
	// 沉淀正文现在来自 `prompt/95-settle.md`：没有模板就「不问」（不是退回硬编码）。
	// 生产里 `main.ts` 启动先播种，测试的工作区要自己播。
	await seedPromptTemplates(root);
	const agentsRoot = join(root, "agents");
	const teamsRoot = join(root, "teams");
	const { models } = setupModels(process.env, { workspace: root });
	const runtime = await openCore({ databasePath: join(root, "core.sqlite"), models, registry: createRegistry() });
	runtimes.push(runtime);
	const shell = await assembleCore(runtime.harness, runtime.registry, {
		agentsRoot,
		teamsRoot,
		defaultModel: { provider: "test", modelId: "test" },
	});
	return { shell, root, agentsRoot, teamsRoot };
}

async function channelState(shell: CoreShell): Promise<ChannelState> {
	return (await shell.harness.snapshot(ChannelDoc)) ?? { channels: {}, messages: {}, nextSeq: {}, readMarks: {} };
}

async function openTeam(shell: CoreShell, team: string, members: readonly string[]): Promise<void> {
	await shell.harness.commit(async (tx) => {
		const doc = (await tx.doc(ChannelDoc)) as ChannelState;
		Object.assign(doc, ensureChannel(doc, { id: `team:${team}`, title: team, members: ["owner", ...members], at: Date.now() }));
	}, BACKGROUND_CONTEXT);
}

const settleDeps = (shell: CoreShell, agentsRoot: string, teamsRoot: string, convOf: (slug: string) => Promise<unknown>) => ({
	harness: shell.harness,
	agentsRoot,
	teamsRoot,
	// 工作区根 = agents 的上一层；模板目录跟着工作区走。
	promptDir: join(agentsRoot, "..", "prompt"),
	channelState: () => channelState(shell),
	conversationOf: async (slug: string) => convOf(slug) as never,
});

describe("团队记忆自动沉淀", () => {
	it("消息落地后只记「问过」，游标等记忆真写进去才推进", async () => {
		const { shell, agentsRoot, teamsRoot } = await setup();
		const lin = await createAgent({ root: agentsRoot, name: "林越", team: "alpha" });
		await shell.openAgent(lin.slug);
		await writeTeam(teamsRoot, { slug: "alpha", name: "alpha", lead: lin.slug, body: "目标 X" });
		await openTeam(shell, "alpha", [lin.slug]);

		await shell.postAs({ channelId: "team:alpha", from: "owner", text: "定了：连接池调到 20", kind: "decision" });
		const asked = (await shell.harness.snapshot(SettleDoc)) as SettleState | undefined;
		// 问完不推进：团队管理员被打断或写砸了，这批不能算处理过。
		expect(asked?.cursors.alpha).toBeUndefined();
		expect(asked?.waiting?.alpha?.seq).toBe(1);

		// 记忆文件真被写了之后，下一次沉淀检查才推进游标。
		await appendTeamMemory(teamsRoot, "alpha", { text: "连接池默认调到 20", by: lin.slug });
		await settleTeam(settleDeps(shell, agentsRoot, teamsRoot, async () => shell.conversations.get(lin.slug)), "alpha");
		const state = (await shell.harness.snapshot(SettleDoc)) as SettleState | undefined;
		expect(state?.cursors.alpha).toBe(1);
		expect(state?.waiting?.alpha).toBeUndefined();
	});

	it("游标推进后不再重复提同一条", async () => {
		const { shell, agentsRoot, teamsRoot } = await setup();
		const lin = await createAgent({ root: agentsRoot, name: "林越", team: "alpha" });
		await shell.openAgent(lin.slug);
		await writeTeam(teamsRoot, { slug: "alpha", name: "alpha", lead: lin.slug, body: "目标 X" });
		await openTeam(shell, "alpha", [lin.slug]);

		await shell.postAs({ channelId: "team:alpha", from: "owner", text: "定了", kind: "decision" });
		// 已经在等确认，手动再调 settleTeam 不应重复催。
		const result = await settleTeam(settleDeps(shell, agentsRoot, teamsRoot, async () => shell.conversations.get(lin.slug)), "alpha");
		expect(result.asked).toBeUndefined();
	});

	it("confirmedBy 兜底推进游标", async () => {
		const { shell, agentsRoot, teamsRoot } = await setup();
		const lin = await createAgent({ root: agentsRoot, name: "林越", team: "alpha" });
		await shell.openAgent(lin.slug);
		await writeTeam(teamsRoot, { slug: "alpha", name: "alpha", lead: lin.slug, body: "目标 X" });
		await openTeam(shell, "alpha", [lin.slug]);

		await shell.postAs({ channelId: "team:alpha", from: "owner", text: "定了", kind: "decision" });
		// remember(scope=team) 落地：confirmedBy 兜底把游标推到最新一条。
		const advanced = await confirmedBy(shell.harness, "alpha");
		expect(advanced).toBe(1);
		const state = (await shell.harness.snapshot(SettleDoc)) as SettleState | undefined;
		expect(state?.cursors.alpha).toBe(1);
		expect(state?.waiting?.alpha).toBeUndefined();
	});

	it("普通 chat 也进候选：问过但不推进游标", async () => {
		const { shell, agentsRoot, teamsRoot } = await setup();
		const lin = await createAgent({ root: agentsRoot, name: "林越", team: "alpha" });
		await shell.openAgent(lin.slug);
		await writeTeam(teamsRoot, { slug: "alpha", name: "alpha", lead: lin.slug, body: "目标 X" });
		await openTeam(shell, "alpha", [lin.slug]);

		await shell.postAs({ channelId: "team:alpha", from: "owner", text: "今天风很大" });
		const state = (await shell.harness.snapshot(SettleDoc)) as SettleState | undefined;
		expect(state?.waiting?.alpha?.seq).toBe(1);
		expect(state?.cursors.alpha).toBeUndefined();
	});

	it("团队管理员自己说的话不念回给他听", async () => {
		const { shell, agentsRoot, teamsRoot } = await setup();
		const lin = await createAgent({ root: agentsRoot, name: "林越", team: "alpha" });
		await shell.openAgent(lin.slug);
		await writeTeam(teamsRoot, { slug: "alpha", name: "alpha", lead: lin.slug, body: "目标 X" });
		await openTeam(shell, "alpha", [lin.slug]);

		await shell.postAs({ channelId: "team:alpha", from: lin.slug, text: "我自己说的" });
		const state = (await shell.harness.snapshot(SettleDoc)) as SettleState | undefined;
		expect(state?.waiting?.alpha).toBeUndefined();
	});

	it("团队频道之外的消息不触发沉淀", async () => {
		const { shell, agentsRoot } = await setup();
		const lin = await createAgent({ root: agentsRoot, name: "林越", team: "alpha" });
		await shell.openAgent(lin.slug);

		await shell.postAs({ channelId: "all", from: lin.slug, text: "定了：用方案 B", kind: "decision" });
		const state = (await shell.harness.snapshot(SettleDoc)) as SettleState | undefined;
		expect(state?.cursors.alpha).toBeUndefined();
	});

	it("团队里没人能写时记为 skipped，游标仍推进", async () => {
		const { shell, agentsRoot, teamsRoot } = await setup();
		await openTeam(shell, "ghost", []);
		await shell.harness.commit(async (tx) => {
			const doc = (await tx.doc(ChannelDoc)) as ChannelState;
			const list = doc.messages["team:ghost"] ?? [];
			doc.messages["team:ghost"] = [...list, { seq: 1, from: "owner", at: Date.now(), text: "定了", mentions: [], kind: "decision" }];
			doc.nextSeq["team:ghost"] = 2;
		}, BACKGROUND_CONTEXT);

		const result = await settleTeam(settleDeps(shell, agentsRoot, teamsRoot, async () => undefined), "ghost");
		expect(result.asked).toBeUndefined();
		expect(result.skipped?.team).toBe("ghost");
		const state = (await shell.harness.snapshot(SettleDoc)) as SettleState | undefined;
		expect(state?.cursors.ghost).toBe(1);
	});

	it("remember 与 read_history(scope=memory) 都在注册表里，记忆只有一个入口", async () => {
		const { shell, agentsRoot } = await setup();
		const lin = await createAgent({ root: agentsRoot, name: "林越", team: "alpha" });
		await shell.openAgent(lin.slug);
		const conversation = shell.conversations.get(lin.slug);
		if (conversation === undefined) throw new Error("没有会话");
		const agent = await conversation.agent();
		const names = agent.tools.map((item) => item.name);
		// 记忆有写（remember）和读（read_history 的 memory 分支）两个入口，各只有一个，
		// 不再有 remember_team / read_team_memory 这类同义工具。
		expect(names).toContain("remember");
		expect(names).toContain("read_history");
		expect(names).not.toContain("remember_team");
		expect(names).not.toContain("read_team_memory");
	});
});

describe("团队频道自动存在", () => {
	it("agent 开会话时自动进自己的团队频道", async () => {
		const { shell, agentsRoot } = await setup();
		const lin = await createAgent({ root: agentsRoot, name: "林越", team: "alpha" });
		await shell.openAgent(lin.slug);
		const state = await channelState(shell);
		expect(state.channels["team:alpha"]).toBeDefined();
		expect(state.channels["team:alpha"]?.members).toEqual(["owner", lin.slug]);
	});

	it("重复开会话不会重复拉人", async () => {
		const { shell, agentsRoot } = await setup();
		const lin = await createAgent({ root: agentsRoot, name: "林越", team: "alpha" });
		await shell.openAgent(lin.slug);
		await shell.openAgent(lin.slug);
		const state = await channelState(shell);
		expect(state.channels["team:alpha"]?.members.filter((item) => item === lin.slug)).toHaveLength(1);
	});

	it("同一个团队第二个人进来会加进同一个频道", async () => {
		const { shell, agentsRoot } = await setup();
		const lin = await createAgent({ root: agentsRoot, name: "林越", team: "alpha" });
		const zhao = await createAgent({ root: agentsRoot, name: "赵岚", team: "alpha" });
		await shell.openAgent(lin.slug);
		await shell.openAgent(zhao.slug);
		const state = await channelState(shell);
		expect(state.channels["team:alpha"]?.members.sort()).toEqual(["owner", lin.slug, zhao.slug].sort());
	});

	it("没有团队的人不会凭空多出频道", async () => {
		const { shell, agentsRoot } = await setup();
		const lin = await createAgent({ root: agentsRoot, name: "林越" });
		await shell.openAgent(lin.slug);
		const state = await channelState(shell);
		expect(Object.keys(state.channels).filter((id) => id.startsWith("team:"))).toEqual([]);
	});

	it("我在团队频道里拍板也触发沉淀", async () => {
		const { shell, agentsRoot } = await setup();
		const lin = await createAgent({ root: agentsRoot, name: "林越", team: "alpha" });
		await shell.openAgent(lin.slug);
		await shell.postAs({ channelId: "team:alpha", from: "owner", text: "定了：先做 A", kind: "decision" });
		const state = (await shell.harness.snapshot(SettleDoc)) as SettleState | undefined;
		expect(state?.waiting?.alpha?.seq).toBe(1);
	});
});
