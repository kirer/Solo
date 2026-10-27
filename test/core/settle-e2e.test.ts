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
	it("decision 消息落地后游标推进（不再等 remember(scope=project)）", async () => {
		const { shell, agentsRoot, projectsRoot } = await setup();
		const lin = await createAgent({ root: agentsRoot, name: "林越", project: "alpha" });
		await shell.openAgent(lin.slug);
		await writeProject(projectsRoot, { slug: "alpha", name: "alpha", owner: lin.slug, body: "目标 X" });
		await openProject(shell, "alpha", [lin.slug]);

		await shell.postAs({ channelId: "proj:alpha", from: lin.slug, text: "定了：连接池调到 20", kind: "decision" });
		const state = (await shell.harness.snapshot(SettleDoc)) as SettleState | undefined;
		// settleProject 在 afterPost 里被调用过，游标应已推进到 1。
		expect(state?.cursors.alpha).toBe(1);
	});

	it("游标推进后不再重复提同一条", async () => {
		const { shell, agentsRoot, projectsRoot } = await setup();
		const lin = await createAgent({ root: agentsRoot, name: "林越", project: "alpha" });
		await shell.openAgent(lin.slug);
		await writeProject(projectsRoot, { slug: "alpha", name: "alpha", owner: lin.slug, body: "目标 X" });
		await openProject(shell, "alpha", [lin.slug]);

		await shell.postAs({ channelId: "proj:alpha", from: lin.slug, text: "定了", kind: "decision" });
		// 游标已在 afterPost 推进，手动再调 settleProject 不应再问。
		const result = await settleProject(settleDeps(shell, agentsRoot, projectsRoot, async () => shell.conversations.get(lin.slug)), "alpha");
		expect(result.asked).toBeUndefined();
	});

	it("confirmedBy 兜底推进游标", async () => {
		const { shell, agentsRoot, projectsRoot } = await setup();
		const lin = await createAgent({ root: agentsRoot, name: "林越", project: "alpha" });
		await shell.openAgent(lin.slug);
		await writeProject(projectsRoot, { slug: "alpha", name: "alpha", owner: lin.slug, body: "目标 X" });
		await openProject(shell, "alpha", [lin.slug]);

		await shell.postAs({ channelId: "proj:alpha", from: lin.slug, text: "定了", kind: "decision" });
		// afterPost 已推进游标到 1，confirmedBy 应检测到游标已是最新、不重复推进。
		const advanced = await confirmedBy(shell.harness, "alpha");
		expect(advanced).toBe(0);
		const state = (await shell.harness.snapshot(SettleDoc)) as SettleState | undefined;
		expect(state?.cursors.alpha).toBe(1);
	});

	it("普通 chat 不触发沉淀，游标不动", async () => {
		const { shell, agentsRoot, projectsRoot } = await setup();
		const lin = await createAgent({ root: agentsRoot, name: "林越", project: "alpha" });
		await shell.openAgent(lin.slug);
		await writeProject(projectsRoot, { slug: "alpha", name: "alpha", owner: lin.slug, body: "目标 X" });
		await openProject(shell, "alpha", [lin.slug]);

		await shell.postAs({ channelId: "proj:alpha", from: lin.slug, text: "今天风很大" });
		const state = (await shell.harness.snapshot(SettleDoc)) as SettleState | undefined;
		expect(state?.cursors.alpha).toBeUndefined();
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
		expect(state?.cursors.alpha).toBe(1);
	});
});
