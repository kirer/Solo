import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BACKGROUND_CONTEXT, createRegistry, setupModels } from "../../src/core/runtime/index.ts";
import { openCore, type CoreRuntime } from "../../src/core/runtime/open.ts";
import { assembleCore, type CoreShell } from "../../src/core/shell/assemble.ts";
import { ChannelDoc, ensureChannel, type ChannelState } from "../../src/core/channel/state.ts";
import { createAgent } from "../../src/core/agent/create.ts";
import { SettleDoc, confirmedBy, settleProjects, type SettleState } from "../../src/core/project/settle.ts";
import { writeProject } from "../../src/core/project/doc.ts";

/**
 * 项目记忆自动沉淀：端到端（不调模型）。
 *
 * 验证的是**接线**是否真的接上了：一条带 `decision` 标签的消息落进项目频道后，
 * 项目里该负责的那个人会收到一条「请你沉淀」的投递。写什么由模型决定，这里不验。
 */
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

/** 建一个项目频道，成员是老板 + 给定的 agent。 */
async function openProject(shell: CoreShell, project: string, members: readonly string[]): Promise<void> {
	await shell.harness.commit(async (tx) => {
		const doc = (await tx.doc(ChannelDoc)) as ChannelState;
		Object.assign(
			doc,
			ensureChannel(doc, {
				id: `proj:${project}`,
				title: project,
				members: ["owner", ...members],
				at: Date.now(),
			}),
		);
	}, BACKGROUND_CONTEXT);
}

describe("项目记忆自动沉淀", () => {
	it("decision 消息落地后，项目里的人会被叫去沉淀", async () => {
		const { shell, agentsRoot, projectsRoot } = await setup();
		const lin = await createAgent({ root: agentsRoot, name: "林越", project: "alpha" });
		await shell.openAgent(lin.slug);
		await writeProject(projectsRoot, { slug: "alpha", name: "alpha", owner: lin.slug, body: "目标 X" });
		await openProject(shell, "alpha", [lin.slug]);

		await shell.postAs({
			channelId: "proj:alpha",
			from: lin.slug,
			text: "定了：连接池调到 20",
			kind: "decision",
		});

		const state = (await shell.harness.snapshot(SettleDoc)) as SettleState | undefined;
		// 被叫去了 ≠ 沉淀完成：游标只在 remember_project 真的落盘后才前进。
		expect(state?.awaiting.alpha).toBe(1);
		expect(state?.cursors.alpha).toBeUndefined();
	});

	it("写完记忆游标才前进，等待标记清掉", async () => {
		const { shell, agentsRoot, projectsRoot } = await setup();
		const lin = await createAgent({ root: agentsRoot, name: "林越", project: "alpha" });
		await shell.openAgent(lin.slug);
		await writeProject(projectsRoot, { slug: "alpha", name: "alpha", owner: lin.slug, body: "目标 X" });
		await openProject(shell, "alpha", [lin.slug]);

		await shell.postAs({ channelId: "proj:alpha", from: lin.slug, text: "定了：连接池调到 20", kind: "decision" });
		const advanced = await confirmedBy(shell.harness, "alpha");
		expect(advanced).toBe(1);
		const state = (await shell.harness.snapshot(SettleDoc)) as SettleState | undefined;
		expect(state?.cursors.alpha).toBe(1);
		expect(state?.awaiting.alpha).toBeUndefined();
	});

	it("已在等答复时不再重复打扰", async () => {
		const { shell, agentsRoot, projectsRoot } = await setup();
		const lin = await createAgent({ root: agentsRoot, name: "林越", project: "alpha" });
		await shell.openAgent(lin.slug);
		await writeProject(projectsRoot, { slug: "alpha", name: "alpha", owner: lin.slug, body: "目标 X" });
		await openProject(shell, "alpha", [lin.slug]);

		await shell.postAs({ channelId: "proj:alpha", from: lin.slug, text: "定了：连接池调到 20", kind: "decision" });
		const again = await settleProjects({
			harness: shell.harness,
			agentsRoot,
			projectsRoot,
			channelState: async () =>
				(await shell.harness.snapshot(ChannelDoc)) ?? { channels: {}, messages: {}, nextSeq: {}, readMarks: {} },
			conversationOf: async () => undefined,
		});
		expect(again.asked).toHaveLength(0);
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

	it("项目里没人能写时记为 stranded，不阻塞其他人", async () => {
		const { shell } = await setup();
		await openProject(shell, "ghost", []);
		await shell.harness.commit(async (tx) => {
			const doc = (await tx.doc(ChannelDoc)) as ChannelState;
			const list = doc.messages["proj:ghost"] ?? [];
			doc.messages["proj:ghost"] = [...list, { seq: 1, from: "owner", at: Date.now(), text: "定了", mentions: [], kind: "decision" }];
			doc.nextSeq["proj:ghost"] = 2;
		}, BACKGROUND_CONTEXT);

		const report = await settleProjects({
			harness: shell.harness,
			agentsRoot: join(shell.agentsRoot, ""),
			projectsRoot: shell.projectsRoot,
			channelState: () => channelState(shell),
			conversationOf: async () => undefined,
		});
		expect(report.asked).toEqual([]);
		expect(report.stranded.map((item) => item.project)).toContain("ghost");
	});

	it("沉淀游标是幂等的下限：同一条不会重复提", async () => {
		const { shell, agentsRoot, projectsRoot } = await setup();
		const lin = await createAgent({ root: agentsRoot, name: "林越", project: "alpha" });
		await shell.openAgent(lin.slug);
		await writeProject(projectsRoot, { slug: "alpha", name: "alpha", owner: lin.slug, body: "目标 X" });
		await openProject(shell, "alpha", [lin.slug]);
		await shell.postAs({ channelId: "proj:alpha", from: lin.slug, text: "定了", kind: "decision" });

		const deps = {
			harness: shell.harness,
			agentsRoot,
			projectsRoot,
			channelState: () => channelState(shell),
			conversationOf: async () => shell.conversations.get(lin.slug),
		};
		const again = await settleProjects(deps);
		expect(again.asked).toEqual([]);
	});

	it("每个 agent 都拿到 remember_project 与 read_project_memory", async () => {
		const { shell, agentsRoot } = await setup();
		const lin = await createAgent({ root: agentsRoot, name: "林越", project: "alpha" });
		await shell.openAgent(lin.slug);
		const conversation = shell.conversations.get(lin.slug);
		if (conversation === undefined) throw new Error("没有会话");
		const agent = await conversation.agent();
		const names = agent.tools.map((item) => item.name);
		expect(names).toContain("remember_project");
		expect(names).toContain("read_project_memory");
	});
});

describe("项目频道自动存在", () => {
	it("agent 开会话时自动进自己的项目频道（频道不存在则建）", async () => {
		const { shell, agentsRoot } = await setup();
		const lin = await createAgent({ root: agentsRoot, name: "林越", project: "alpha" });
		await shell.openAgent(lin.slug);

		const state = await channelState(shell);
		expect(state.channels["proj:alpha"]).toBeDefined();
		expect(state.channels["proj:alpha"]?.members).toEqual(["owner", lin.slug]);
	});

	it("重复开会话不会重复拉人，也不重复建频道", async () => {
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

	it("老板在项目频道里拍板（kind=decision）也会触发沉淀", async () => {
		const { shell, agentsRoot } = await setup();
		const lin = await createAgent({ root: agentsRoot, name: "林越", project: "alpha" });
		await shell.openAgent(lin.slug);

		await shell.postAs({ channelId: "proj:alpha", from: "owner", text: "定了：先做 A", kind: "decision" });

		const state = (await shell.harness.snapshot(SettleDoc)) as SettleState | undefined;
		expect(state?.awaiting.alpha).toBe(1);
	});
});
