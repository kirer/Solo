/**
 * 集成验收：用第一个真实项目（网页坦克大战）跑通完整链路。
 *
 * 这个测试模拟老板的一句话，验证组织机制是否真的能把事情推进下去：
 * 立项 → 建目录 → 配员工 → 派活 → 升级 → 成本 → 留痕。
 *
 * 用 faux provider，不产生真实费用。
 */
import { afterEach, describe, expect, test } from "vitest";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createRegistry, openCompany, recover, type CompanyRuntime } from "../../src/runtime/index.ts";
import { bootstrapCompany, createProject, hireStaff, listStaff, readCompany } from "../../src/company/org.ts";
import {
	answerPending,
	createEscalationTask,
	listPending,
	startEscalation,
} from "../../src/company/escalation.ts";
import { rollupProject } from "../../src/company/cost.ts";
import { buildUiState } from "../../src/tui/state.ts";
import { computeLayout, renderLayout } from "../../src/tui/render.ts";
import { ensureAllChannels, postToChannel, readChannels } from "../../src/company/channels.ts";
import {
	answer,
	askAndWait,
	createTestContext,
	eventually,
	toolCall,
	type TestContext,
	TEST_MODEL_CATALOG,
	waitEscalation,
} from "../support.ts";

let contexts: TestContext[] = [];
let runtimes: CompanyRuntime[] = [];

async function setup() {
	const ctx = await createTestContext();
	contexts.push(ctx);
	const registry = createRegistry();
	const runtime = await openCompany(
		{ databasePath: ctx.databasePath, models: ctx.models, registry },
		BACKGROUND_CONTEXT,
	);
	runtimes.push(runtime);
	await recover(runtime, BACKGROUND_CONTEXT);
	const escalationTask = createEscalationTask(runtime);
	registry.install({ name: "escalation", tasks: [escalationTask] } as never);

	const boot = await bootstrapCompany(
		runtime,
		{
			modelCatalog: [...TEST_MODEL_CATALOG],
			companyName: "一人公司",
			registry,
			workspaceRoot: join(ctx.dir, "projects"),
			modelCatalog: [
				{ id: "faux-1", provider: "faux", modelId: "faux-1", label: "标准", inputPerMTok: 3, outputPerMTok: 15 },
				{ id: "cheap-1", provider: "faux", modelId: "cheap-1", label: "便宜", inputPerMTok: 0.5, outputPerMTok: 1.5 },
				{ id: "strong-1", provider: "faux", modelId: "strong-1", label: "强", inputPerMTok: 15, outputPerMTok: 75 },
			],
		},
		BACKGROUND_CONTEXT,
	);

	return { ctx, runtime, boot, escalationTask, registry };
}

afterEach(async () => {
	for (const runtime of runtimes) await runtime.close().catch(() => undefined);
	for (const ctx of contexts) await ctx.cleanup();
	runtimes = [];
	contexts = [];
});

describe("首个真实项目：网页坦克大战", () => {
	test("完整链路：立项 → 配员工 → 派活 → 产出文件", async () => {
		const { ctx, runtime, boot, registry } = await setup();

		// ① 老板对 CEO 说：立项坦克大战，配齐四个角色
		ctx.faux.setResponses([answer("收到。我让 CPO 立项，CHRO 配人。")]);
		const ceo = await runtime.harness.conversation(boot.ownerConversationId as never, BACKGROUND_CONTEXT);
		await (
			await ceo?.submit(
				{ type: "input", content: "立项一个网页坦克大战游戏，配齐产品、设计、开发、测试" },
				BACKGROUND_CONTEXT,
			)
		)?.wait(BACKGROUND_CONTEXT);

		// ② CPO 立项（含英文 slug）
		const { project } = await createProject(
			runtime,
			{
				name: "坦克大战",
				slug: "tank-battle",
				brief: "HTML5 Canvas 像素风坦克大战，单人闯关 + 双人对战，含地形、道具、胜负判定。",
				acceptance: "能在浏览器打开即玩；双人可同屏操作；三关以上；有明确胜负。",
				workspaceRoot: join(ctx.dir, "projects"),
			},
			BACKGROUND_CONTEXT,
		);

		// 验证目录与立项文档
		expect((await stat(project.workspace)).isDirectory()).toBe(true);
		const brief = await readFile(join(project.workspace, "PROJECT.md"), "utf8");
		expect(brief).toContain("# 坦克大战");
		expect(brief).toContain("HTML5 Canvas");
		expect(brief).toContain("## 验收标准");

		// ③ CHRO 按职责点派员工：能力由 tools 显式声明，不再由角色名推断
		const roles = [
			{ name: "pm-1", role: "产品", tools: ["read", "write"], model: "cheap-1", manager: "cpo" as const },
			{ name: "ui-1", role: "设计", tools: ["read", "write", "edit"], model: "cheap-1", manager: "cpo" as const },
			{
				name: "dev-1",
				role: "开发",
				tools: ["read", "write", "edit", "bash"],
				model: "strong-1",
				manager: "cto" as const,
			},
			{ name: "qa-1", role: "测试", tools: ["read", "write"], model: "cheap-1", manager: "cto" as const },
		];

		for (const person of roles) {
			await hireStaff(
				runtime,
				{
					project: "tank-battle",
					name: person.name,
					role: person.role,
					tools: person.tools,
					manager: person.manager,
					model: { provider: "faux", modelId: person.model },
					registry,
				},
				BACKGROUND_CONTEXT,
			);
		}

		const staff = await listStaff(runtime, "tank-battle", BACKGROUND_CONTEXT);
		expect(staff.length).toBe(4);
		expect(staff.find((person) => person.name === "dev-1")?.model.modelId).toBe("strong-1");
		expect(staff.find((person) => person.name === "qa-1")?.model.modelId).toBe("cheap-1");

		// ④ 项目负责人派活给开发，开发真的在工作空间里创建入口文件
		ctx.faux.setResponses([
			toolCall("write", { path: "index.html", content: '<canvas id="game"></canvas>' }),
			answer("入口文件已创建，包含 canvas 容器。"),
		]);
		const dev = staff.find((person) => person.name === "dev-1");
		const result = await askAndWait(
			runtime,
			{ conversationId: dev?.conversationId as number, text: "创建游戏入口 index.html", from: "坦克大战负责人" },
			BACKGROUND_CONTEXT,
		);

		// 开发拿到了写文件的工具，所以这次应当成功
		expect(result.ok).toBe(true);

		// 派活的真路径：频道里 @ 一句（唤醒）+ assign_task 建任务（不等）。
		// 同步派活（delegation.ts）已删，沟通与留痕都落在频道里。
		await ensureAllChannels(runtime, BACKGROUND_CONTEXT);
		await postToChannel(
			runtime,
			"proj:tank-battle",
			{
				from: project.leader,
				fromLabel: "坦克大战负责人",
				kind: "task",
				text: "@dev-1 创建游戏入口 index.html",
				mentions: [dev?.conversationId as number],
			},
			BACKGROUND_CONTEXT,
		);
		const html = await readFile(join(project.workspace, "index.html"), "utf8");
		expect(html).toContain("canvas");

		// ⑤ 验证成本按项目聚合
		const projectCost = await rollupProject(runtime, "tank-battle", BACKGROUND_CONTEXT);
		expect(projectCost.totalTokens).toBeGreaterThan(0);

		// ⑥ 验证沟通留痕完整
		// 同步派活删除后，真实沟通都落在频道里；`TrailDoc` 只在显式 recordMessage 时写。
		const channels = await readChannels(runtime, BACKGROUND_CONTEXT);
		const messages = Object.values(channels.channels).flatMap((channel) => channel.messages);
		expect(messages.length, "沟通应当落在频道里").toBeGreaterThan(0);
		expect(messages.some((message) => message.mentions.length > 0), "应当有 @ 到人的消息").toBe(true);

		// ⑦ 验证界面能渲染出这个组织
		const state = await buildUiState(runtime, { selectedConversationId: boot.ownerConversationId });
		const staffNodes = state.org.filter((node) => node.kind === "staff");
		expect(staffNodes.length).toBe(4);
		expect(staffNodes.every((node) => node.project === "tank-battle")).toBe(true);

		const lines = renderLayout(state, computeLayout(140, 40));
		expect(lines.length).toBeGreaterThan(0);
	});

	test("员工有执行工具时能真正写文件", async () => {
		const { ctx, runtime, boot, registry } = await setup();
		const { project } = await createProject(
			runtime,
			{ name: "坦克大战", slug: "tank-battle", brief: "测试", workspaceRoot: join(ctx.dir, "projects") },
			BACKGROUND_CONTEXT,
		);

		// 这次给员工文件工具（模拟正式装配时注入执行类工具）
		const { CodingTools } = await import("@earendil-works/pi-durable/tools");
		await hireStaff(
			runtime,
			{
				project: "tank-battle",
				name: "dev-1",
				role: "开发",
				tools: ["read", "write", "edit"],
				manager: "cto",
				employeeTools: CodingTools.tools,
				registry,
			},
			BACKGROUND_CONTEXT,
		);

		ctx.faux.setResponses([
			toolCall("write", { path: "index.html", content: "<canvas id=\"game\"></canvas>" }),
			answer("入口文件已创建。"),
		]);

		const staff = await listStaff(runtime, "tank-battle", BACKGROUND_CONTEXT);
		const result = await askAndWait(
			runtime,
			{ conversationId: staff[0]?.conversationId as number, text: "创建游戏入口", from: "负责人" },
			BACKGROUND_CONTEXT,
		);

		expect(result.ok).toBe(true);
		const content = await readFile(join(project.workspace, "index.html"), "utf8");
		expect(content).toContain("canvas");
		void boot;
	});

	test("升级链：技术选型问题从员工升到老板", async () => {
		const { ctx, runtime, boot, escalationTask } = await setup();
		const { project } = await createProject(
			runtime,
			{ name: "坦克大战", slug: "tank-battle", brief: "测试", workspaceRoot: join(ctx.dir, "projects") },
			BACKGROUND_CONTEXT,
		);
		await hireStaff(
			runtime,
			{ project: "tank-battle", name: "dev-1", role: "开发", manager: "cto" },
			BACKGROUND_CONTEXT,
		);

		// 开发遇到技术选型 → 报 CTO
		const taskId = await startEscalation(
			runtime,
			escalationTask,
			{
				question: "坦克渲染用 Canvas 2D 还是 WebGL？",
				from: "dev-1",
				fromConversationId: project.leader,
				manager: "cto",
				escalationKey: "tank-esc-1",
				project: "tank-battle",
			},
			BACKGROUND_CONTEXT,
		);

		await eventually(async () => (await listPending(runtime, BACKGROUND_CONTEXT)).some((p) => p.level === "cto"), {
			label: "CTO 待决出现",
		});
		await answerPending(
			runtime,
			{ key: "tank-esc-1", answer: "这影响整体架构，得 CEO 定。", answeredBy: "cto", escalate: true },
			BACKGROUND_CONTEXT,
		);

		await eventually(async () => (await listPending(runtime, BACKGROUND_CONTEXT)).some((p) => p.level === "ceo"), {
			label: "CEO 待决出现",
		});
		await answerPending(
			runtime,
			{ key: "tank-esc-1", answer: "涉及长期投入，老板定。", answeredBy: "ceo", escalate: true },
			BACKGROUND_CONTEXT,
		);

		await eventually(
			async () => (await listPending(runtime, BACKGROUND_CONTEXT)).some((p) => p.level === "owner"),
			{ label: "老板待决出现" },
		);

		// 老板拍板
		await answerPending(
			runtime,
			{ key: "tank-esc-1", answer: "用 Canvas 2D，先把玩法做扎实。", answeredBy: "owner" },
			BACKGROUND_CONTEXT,
		);

		const result = await waitEscalation(runtime, taskId, BACKGROUND_CONTEXT);
		expect(result?.decidedBy).toBe("owner");
		expect(result?.decision).toContain("Canvas 2D");
		expect(result?.path).toContain("cto");
		expect(result?.path).toContain("ceo");
		expect(result?.path).toContain("owner");

		// 留痕：完整升级链可在频道里查到（拍板结果现在是一条 `kind: "decision"` 的频道消息）
		const channels = await readChannels(runtime, BACKGROUND_CONTEXT);
		const messages = Object.values(channels.channels).flatMap((channel) => channel.messages);
		expect(messages.some((message) => message.kind === "decision"), "拍板结果应落在频道里").toBe(true);
		// 拍板结果要能追回原问题：`refs.pendingKey` 指向那条待决项。
		const decision = messages.find((message) => message.kind === "decision");
		expect(decision?.refs?.pendingKey, "拍板结果应带上待决项编号").toBeDefined();
		expect(decision?.text).toContain("Canvas 2D");

		void ctx;
		void boot;
	});
});

describe("全量检查", () => {
	test("公司索引在多次操作后保持一致", async () => {
		const { ctx, runtime } = await setup();
		const { project } = await createProject(
			runtime,
			{ name: "坦克大战", slug: "tank-battle", brief: "测试", workspaceRoot: join(ctx.dir, "projects") },
			BACKGROUND_CONTEXT,
		);
		await hireStaff(runtime, { project: "tank-battle", name: "dev-1", role: "开发", manager: "cto" }, BACKGROUND_CONTEXT);
		await hireStaff(runtime, { project: "tank-battle", name: "qa-1", role: "测试", manager: "cto" }, BACKGROUND_CONTEXT);

		const state = await readCompany(runtime, BACKGROUND_CONTEXT);
		expect(Object.keys(state?.projects ?? {})).toEqual(["tank-battle"]);
		expect(state?.projects["tank-battle"]?.leader).toBe(project.leader);
		expect(Object.keys(state?.staff ?? {}).sort()).toEqual(["tank-battle/dev-1", "tank-battle/qa-1"]);
		expect(state?.roles.ceo).toBeGreaterThan(0);
	});
});
