import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BACKGROUND_CONTEXT, createRegistry, setupModels } from "../../src/core/runtime/index.ts";
import { openCore, type CoreRuntime } from "../../src/core/runtime/open.ts";
import { assembleCore, type CoreShell } from "../../src/core/shell/assemble.ts";
import { ChannelDoc, ensureChannel, type ChannelState } from "../../src/core/channel/state.ts";
import { createAgent } from "../../src/core/agent/create.ts";
import { SettleDoc, confirmedBy, settleProject, type SettleState } from "../../src/core/project/settle.ts";
import { appendProjectMemory } from "../../src/core/project/memory.ts";
import { writeProject } from "../../src/core/project/doc.ts";

const roots: string[] = [];
const runtimes: CoreRuntime[] = [];

afterEach(async () => {
	for (const runtime of runtimes.splice(0)) await runtime.close().catch(() => undefined);
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function setup(): Promise<{ shell: CoreShell; root: string; agentsRoot: string; projectsRoot: string }> {
	const root = await mkdtemp(join(tmpdir(), "core-settle-"));
	roots.push(root);
	const agentsRoot = join(root, "agents");
	const projectsRoot = join(root, "projects");
	const { models } = setupModels(process.env, { workspace: root });
	const runtime = await openCore({ databasePath: join(root, "core.sqlite"), models, registry: createRegistry() });
	runtimes.push(runtime);
	const shell = await assembleCore(runtime.harness, runtime.registry, {
		agentsRoot,
		projectsRoot,
		defaultModel: { provider: "test", modelId: "test" },
	});
	return { shell, root, agentsRoot, projectsRoot };
}

async function channelState(shell: CoreShell): Promise<ChannelState> {
	return (await shell.harness.snapshot(ChannelDoc)) ?? { channels: {}, messages: {}, nextSeq: {}, readMarks: {} };
}

async function openProject(shell: CoreShell, project: string, members: readonly string[]): Promise<void> {
	await shell.harness.commit(async (tx) => {
		const doc = (await tx.doc(ChannelDoc)) as ChannelState;
		Object.assign(doc, ensureChannel(doc, { id: `proj:${project}`, title: project, members: ["owner", ...members], at: Date.now() }));
	}, BACKGROUND_CONTEXT);
}

const settleDeps = (shell: CoreShell, agentsRoot: string, projectsRoot: string, convOf: (slug: string) => Promise<unknown>) => ({
	harness: shell.harness,
	agentsRoot,
	projectsRoot,
	channelState: () => channelState(shell),
	conversationOf: async (slug: string) => convOf(slug) as never,
});

describe("项目记忆自动沉淀", () => {
	it("消息落地后只记「问过」，游标等记忆真写进去才推进", async () => {
		const { shell, agentsRoot, projectsRoot } = await setup();
		const lin = await createAgent({ root: agentsRoot, name: "林越", project: "alpha" });
		await shell.openAgent(lin.slug);
		await writeProject(projectsRoot, { slug: "alpha", name: "alpha", owner: lin.slug, body: "目标 X" });
		await openProject(shell, "alpha", [lin.slug]);

		await shell.postAs({ channelId: "proj:alpha", from: "owner", text: "定了：连接池调到 20", kind: "decision" });
		const asked = (await shell.harness.snapshot(SettleDoc)) as SettleState | undefined;
		// 问完不推进：负责人被打断或写砸了，这批不能算处理过。
		expect(asked?.cursors.alpha).toBeUndefined();
		expect(asked?.waiting?.alpha?.seq).toBe(1);

		// 记忆文件真被写了之后，下一次沉淀检查才推进游标。
		await appendProjectMemory(projectsRoot, "alpha", { text: "连接池默认调到 20", by: lin.slug });
		await settleProject(settleDeps(shell, agentsRoot, projectsRoot, async () => shell.conversations.get(lin.slug)), "alpha");
		const state = (await shell.harness.snapshot(SettleDoc)) as SettleState | undefined;
		expect(state?.cursors.alpha).toBe(1);
		expect(state?.waiting?.alpha).toBeUndefined();
	});

	it("游标推进后不再重复提同一条", async () => {
		const { shell, agentsRoot, projectsRoot } = await setup();
		const lin = await createAgent({ root: agentsRoot, name: "林越", project: "alpha" });
		await shell.openAgent(lin.slug);
		await writeProject(projectsRoot, { slug: "alpha", name: "alpha", owner: lin.slug, body: "目标 X" });
		await openProject(shell, "alpha", [lin.slug]);

		await shell.postAs({ channelId: "proj:alpha", from: "owner", text: "定了", kind: "decision" });
		// 已经在等确认，手动再调 settleProject 不应重复催。
		const result = await settleProject(settleDeps(shell, agentsRoot, projectsRoot, async () => shell.conversations.get(lin.slug)), "alpha");
		expect(result.asked).toBeUndefined();
	});

	it("confirmedBy 兜底推进游标", async () => {
		const { shell, agentsRoot, projectsRoot } = await setup();
		const lin = await createAgent({ root: agentsRoot, name: "林越", project: "alpha" });
		await shell.openAgent(lin.slug);
		await writeProject(projectsRoot, { slug: "alpha", name: "alpha", owner: lin.slug, body: "目标 X" });
		await openProject(shell, "alpha", [lin.slug]);

		await shell.postAs({ channelId: "proj:alpha", from: "owner", text: "定了", kind: "decision" });
		// remember(scope=project) 落地：confirmedBy 兜底把游标推到最新一条。
		const advanced = await confirmedBy(shell.harness, "alpha");
		expect(advanced).toBe(1);
		const state = (await shell.harness.snapshot(SettleDoc)) as SettleState | undefined;
		expect(state?.cursors.alpha).toBe(1);
		expect(state?.waiting?.alpha).toBeUndefined();
	});

	it("普通 chat 也进候选：问过但不推进游标", async () => {
		const { shell, agentsRoot, projectsRoot } = await setup();
		const lin = await createAgent({ root: agentsRoot, name: "林越", project: "alpha" });
		await shell.openAgent(lin.slug);
		await writeProject(projectsRoot, { slug: "alpha", name: "alpha", owner: lin.slug, body: "目标 X" });
		await openProject(shell, "alpha", [lin.slug]);

		await shell.postAs({ channelId: "proj:alpha", from: "owner", text: "今天风很大" });
		const state = (await shell.harness.snapshot(SettleDoc)) as SettleState | undefined;
		expect(state?.waiting?.alpha?.seq).toBe(1);
		expect(state?.cursors.alpha).toBeUndefined();
	});

	it("负责人自己说的话不念回给他听", async () => {
		const { shell, agentsRoot, projectsRoot } = await setup();
		const lin = await createAgent({ root: agentsRoot, name: "林越", project: "alpha" });
		await shell.openAgent(lin.slug);
		await writeProject(projectsRoot, { slug: "alpha", name: "alpha", owner: lin.slug, body: "目标 X" });
		await openProject(shell, "alpha", [lin.slug]);

		await shell.postAs({ channelId: "proj:alpha", from: lin.slug, text: "我自己说的" });
		const state = (await shell.harness.snapshot(SettleDoc)) as SettleState | undefined;
		expect(state?.waiting?.alpha).toBeUndefined();
	});

	it("项目频道之外的消息不触发沉淀", async () => {
		const { shell, agentsRoot } = await setup();
		const lin = await createAgent({ root: agentsRoot, name: "林越", project: "alpha" });
		await shell.openAgent(lin.slug);

		await shell.postAs({ channelId: "company", from: lin.slug, text: "定了：用方案 B", kind: "decision" });
		const state = (await shell.harness.snapshot(SettleDoc)) as SettleState | undefined;
		expect(state?.cursors.alpha).toBeUndefined();
	});

	it("项目里没人能写时记为 skipped，游标仍推进", async () => {
		const { shell, agentsRoot, projectsRoot } = await setup();
		await openProject(shell, "ghost", []);
		await shell.harness.commit(async (tx) => {
			const doc = (await tx.doc(ChannelDoc)) as ChannelState;
			const list = doc.messages["proj:ghost"] ?? [];
			doc.messages["proj:ghost"] = [...list, { seq: 1, from: "owner", at: Date.now(), text: "定了", mentions: [], kind: "decision" }];
			doc.nextSeq["proj:ghost"] = 2;
		}, BACKGROUND_CONTEXT);

		const result = await settleProject(settleDeps(shell, agentsRoot, projectsRoot, async () => undefined), "ghost");
		expect(result.asked).toBeUndefined();
		expect(result.skipped?.project).toBe("ghost");
		const state = (await shell.harness.snapshot(SettleDoc)) as SettleState | undefined;
		expect(state?.cursors.ghost).toBe(1);
	});

	it("remember/recall 支持 scope=project", async () => {
		const { shell, agentsRoot } = await setup();
		const lin = await createAgent({ root: agentsRoot, name: "林越", project: "alpha" });
		await shell.openAgent(lin.slug);
		const conversation = shell.conversations.get(lin.slug);
		if (conversation === undefined) throw new Error("没有会话");
		const agent = await conversation.agent();
		const names = agent.tools.map((item) => item.name);
		// 合并后 remember 和 recall 各只有一个，不再有 remember_project/read_project_memory
		expect(names).toContain("remember");
		expect(names).toContain("recall");
		expect(names).not.toContain("remember_project");
		expect(names).not.toContain("read_project_memory");
	});
});

describe("项目频道自动存在", () => {
	it("agent 开会话时自动进自己的项目频道", async () => {
		const { shell, agentsRoot } = await setup();
		const lin = await createAgent({ root: agentsRoot, name: "林越", project: "alpha" });
		await shell.openAgent(lin.slug);
		const state = await channelState(shell);
		expect(state.channels["proj:alpha"]).toBeDefined();
		expect(state.channels["proj:alpha"]?.members).toEqual(["owner", lin.slug]);
	});

	it("重复开会话不会重复拉人", async () => {
		const { shell, agentsRoot } = await setup();
		const lin = await createAgent({ root: agentsRoot, name: "林越", project: "alpha" });
		await shell.openAgent(lin.slug);
		await shell.openAgent(lin.slug);
		const state = await channelState(shell);
		expect(state.channels["proj:alpha"]?.members.filter((item) => item === lin.slug)).toHaveLength(1);
	});

	it("同一个项目第二个人进来会加进同一个频道", async () => {
		const { shell, agentsRoot } = await setup();
		const lin = await createAgent({ root: agentsRoot, name: "林越", project: "alpha" });
		const zhao = await createAgent({ root: agentsRoot, name: "赵岚", project: "alpha" });
		await shell.openAgent(lin.slug);
		await shell.openAgent(zhao.slug);
		const state = await channelState(shell);
		expect(state.channels["proj:alpha"]?.members.sort()).toEqual(["owner", lin.slug, zhao.slug].sort());
	});

	it("没有项目的人不会凭空多出频道", async () => {
		const { shell, agentsRoot } = await setup();
		const lin = await createAgent({ root: agentsRoot, name: "林越" });
		await shell.openAgent(lin.slug);
		const state = await channelState(shell);
		expect(Object.keys(state.channels).filter((id) => id.startsWith("proj:"))).toEqual([]);
	});

	it("老板在项目频道里拍板也触发沉淀", async () => {
		const { shell, agentsRoot } = await setup();
		const lin = await createAgent({ root: agentsRoot, name: "林越", project: "alpha" });
		await shell.openAgent(lin.slug);
		await shell.postAs({ channelId: "proj:alpha", from: "owner", text: "定了：先做 A", kind: "decision" });
		const state = (await shell.harness.snapshot(SettleDoc)) as SettleState | undefined;
		expect(state?.waiting?.alpha?.seq).toBe(1);
	});
});
