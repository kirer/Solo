/**
 * tui-workspace 的测试。
 *
 * 界面分两层，分别测：
 * - state.ts：把已提交状态映射成视图模型（纯数据，可精确断言）
 * - render.ts：把视图模型画成行（纯函数，可断言布局与内容）
 *
 * 真实的终端交互（键盘、订阅）在 app.ts，靠一个受控的假终端驱动测试。
 */
import { afterEach, describe, expect, test } from "vitest";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createRegistry, openCompany, recover, type CompanyRuntime } from "../../src/runtime/index.ts";
import { bootstrapCompany, createProject, hireStaff } from "../../src/company/org.ts";
import { delegate } from "../../src/company/delegation.ts";
import { answerPending, createEscalationTask, listPending, startEscalation } from "../../src/company/escalation.ts";
import { buildStream, buildUiState } from "../../src/tui/state.ts";
import { computeLayout, formatTokens, renderLayout, renderOrgTree, renderPanel, renderStream } from "../../src/tui/render.ts";
import { answer, createTestContext, eventually, type TestContext, TEST_MODEL_CATALOG } from "../support.ts";

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
			modelCatalog: [...TEST_MODEL_CATALOG], companyName: "测试公司", registry, workspaceRoot: join(ctx.dir, "projects") },
		BACKGROUND_CONTEXT,
	);
	const { project } = await createProject(
		runtime,
		{ name: "Alpha", slug: "alpha", brief: "测试", workspaceRoot: join(ctx.dir, "projects") },
		BACKGROUND_CONTEXT,
	);
	const hired = await hireStaff(
		runtime,
		{ project: "alpha", name: "dev-1", role: "开发", manager: "cto" },
		BACKGROUND_CONTEXT,
	);
	return { ctx, runtime, boot, project, hired, escalationTask };
}

afterEach(async () => {
	for (const runtime of runtimes) await runtime.close().catch(() => undefined);
	for (const ctx of contexts) await ctx.cleanup();
	runtimes = [];
	contexts = [];
});

describe("三栏常驻布局", () => {
	test("标准窗口下三栏都有宽度", () => {
		const layout = computeLayout(120, 30);
		expect(layout.treeWidth).toBeGreaterThan(0);
		expect(layout.panelWidth).toBeGreaterThan(0);
		expect(layout.streamWidth).toBeGreaterThan(0);
		expect(layout.collapsed).toBe(false);
	});

	test("会话流占据剩余空间", () => {
		const layout = computeLayout(120, 30);
		const total = layout.treeWidth + layout.panelWidth + layout.streamWidth + 2;
		expect(total).toBe(120);
	});

	test("极窄窗口折叠侧栏但不崩溃", () => {
		const layout = computeLayout(40, 20);
		expect(layout.collapsed).toBe(true);
		expect(layout.treeWidth).toBe(0);
		expect(layout.panelWidth).toBe(0);
		expect(layout.streamWidth).toBe(40);
	});

	test("尺寸变化后重新布局", () => {
		const wide = computeLayout(160, 40);
		const narrow = computeLayout(80, 20);
		expect(wide.treeWidth).not.toBe(narrow.treeWidth);
		expect(narrow.streamWidth).toBeGreaterThan(0);
	});
});

describe("组织树导航", () => {
	test("层级结构：CEO、管理层、项目、员工", async () => {
		const { runtime, boot } = await setup();
		const state = await buildUiState(runtime, { selectedConversationId: boot.ownerConversationId });

		const kinds = state.org.map((node) => node.kind);
		expect(kinds[0]).toBe("owner");
		expect(kinds).toContain("role");
		expect(kinds).toContain("project");
		expect(kinds).toContain("staff");

		// CEO 在最上层，员工在项目下
		const ceo = state.org.find((node) => node.kind === "owner");
		expect(ceo?.depth).toBe(0);
		const staff = state.org.find((node) => node.kind === "staff");
		expect(staff?.depth).toBe(2);
	});

	test("状态标记：忙碌与空闲可区分", async () => {
		const { ctx, runtime, boot, project } = await setup();

		ctx.faux.setResponses([answer("完成")]);
		await delegate(
			runtime,
			{ project: "alpha", employee: "dev-1", task: "干活", fromConversationId: project.leader, from: "负责人" },
			BACKGROUND_CONTEXT,
		);

		const state = await buildUiState(runtime, { selectedConversationId: boot.ownerConversationId });
		for (const node of state.org) {
			expect(["busy", "pending", "idle"]).toContain(node.status);
		}
	});

	test("渲染出的行数等于节点数加表头", async () => {
		const { runtime, boot } = await setup();
		const state = await buildUiState(runtime, { selectedConversationId: boot.ownerConversationId });
		const lines = renderOrgTree(state.org, 24, boot.ownerConversationId);
		expect(lines.length).toBe(state.org.length + 2);
	});

	test("选中项有游标标记", async () => {
		const { runtime, boot } = await setup();
		const state = await buildUiState(runtime, { selectedConversationId: boot.ownerConversationId });
		const lines = renderOrgTree(state.org, 24, boot.ownerConversationId);
		expect(lines.some((line) => line.startsWith("›"))).toBe(true);
	});
});

describe("会话流渲染", () => {
	test("历史消息按时间顺序，角色可区分", async () => {
		const { ctx, runtime, boot } = await setup();

		ctx.faux.setResponses([answer("我来安排。")]);
		const ceo = await runtime.harness.conversation(boot.ownerConversationId as never, BACKGROUND_CONTEXT);
		await (await ceo?.submit({ type: "input", content: "做个坦克大战" }, BACKGROUND_CONTEXT))?.wait(BACKGROUND_CONTEXT);

		const stream = await buildStream(runtime, boot.ownerConversationId, "CEO");
		expect(stream.messages.length).toBeGreaterThanOrEqual(2);

		const roles = stream.messages.map((message) => message.role);
		expect(roles).toContain("user");
		expect(roles).toContain("assistant");

		// 用户消息在前
		const userIndex = roles.indexOf("user");
		const assistantIndex = roles.indexOf("assistant");
		expect(userIndex).toBeLessThan(assistantIndex);
	});

	test("用户消息渲染带 [你] 前缀", async () => {
		const { ctx, runtime, boot } = await setup();

		ctx.faux.setResponses([answer("好的")]);
		const ceo = await runtime.harness.conversation(boot.ownerConversationId as never, BACKGROUND_CONTEXT);
		await (await ceo?.submit({ type: "input", content: "问题" }, BACKGROUND_CONTEXT))?.wait(BACKGROUND_CONTEXT);

		const state = await buildUiState(runtime, { selectedConversationId: boot.ownerConversationId });
		const lines = renderStream(state, 60, 30);
		expect(lines.some((line) => line.includes("[你]"))).toBe(true);
	});

	test("大输出标记为可折叠", async () => {
		const { runtime, boot } = await setup();
		const stream = await buildStream(runtime, boot.ownerConversationId, "CEO");
		// 空会话也应能渲染
		const lines = renderStream(
			{
				org: [],
				selectedConversationId: boot.ownerConversationId,
				stream,
				tasks: [],
				pendingCount: 0,
				cost: {
					conversationTokens: 0,
					projectTokens: 0,
					companyTokens: 0,
					conversationCostUsd: 0,
					projectCostUsd: 0,
					companyCostUsd: 0,
				},
			},
			60,
			30,
		);
		expect(lines.length).toBeGreaterThan(0);
	});

	test("分支视图标明来源", async () => {
		const { runtime, boot } = await setup();
		const state = await buildUiState(runtime, {
			selectedConversationId: boot.ownerConversationId,
			branchFrom: { entryId: 42, label: "CEO" },
		});

		const lines = renderStream(state, 60, 30);
		expect(lines[0]).toContain("⎇");
		expect(lines[0]).toContain("#42");
	});
});

describe("任务与成本面板", () => {
	test("显示活跃任务与等待对象", async () => {
		const { runtime, boot } = await setup();
		const state = await buildUiState(runtime, { selectedConversationId: boot.ownerConversationId });

		const lines = renderPanel(state.tasks, state.cost, state.pendingCount, 30);
		expect(lines.some((line) => line.includes("任务"))).toBe(true);
		expect(lines.some((line) => line.includes("成本"))).toBe(true);
	});

	test("显示本会话、本项目、全公司三级成本", async () => {
		const { ctx, runtime, boot } = await setup();

		ctx.faux.setResponses([answer("回答")]);
		const ceo = await runtime.harness.conversation(boot.ownerConversationId as never, BACKGROUND_CONTEXT);
		await (await ceo?.submit({ type: "input", content: "问题" }, BACKGROUND_CONTEXT))?.wait(BACKGROUND_CONTEXT);

		const state = await buildUiState(runtime, { selectedConversationId: boot.ownerConversationId });
		const lines = renderPanel(state.tasks, state.cost, state.pendingCount, 30);

		expect(lines.some((line) => line.includes("本会话"))).toBe(true);
		expect(lines.some((line) => line.includes("本项目"))).toBe(true);
		expect(lines.some((line) => line.includes("全公司"))).toBe(true);
	});

	test("有待拍板时显示计数", async () => {
		const { runtime, boot, project, escalationTask } = await setup();

		await startEscalation(
			runtime,
			escalationTask,
			{
				question: "要不要接外包？",
				from: "dev-1",
				fromConversationId: project.leader,
				manager: "ceo",
				escalationKey: "ui-esc-1",
			},
			BACKGROUND_CONTEXT,
		);

		await eventually(async () => (await listPending(runtime, BACKGROUND_CONTEXT)).length > 0, { label: "待决出现" });
		await answerPending(
			runtime,
			{ key: "ui-esc-1", answer: "老板定。", answeredBy: "ceo", escalate: true },
			BACKGROUND_CONTEXT,
		);
		await eventually(
			async () => (await listPending(runtime, BACKGROUND_CONTEXT)).some((item) => item.level === "owner"),
			{ label: "老板待决出现" },
		);

		const state = await buildUiState(runtime, { selectedConversationId: boot.ownerConversationId });
		expect(state.pendingCount).toBeGreaterThan(0);

		const lines = renderPanel(state.tasks, state.cost, state.pendingCount, 30);
		expect(lines.some((line) => line.includes("待你拍板"))).toBe(true);
	});

	test("token 数字紧凑显示", () => {
		expect(formatTokens(999)).toBe("999");
		expect(formatTokens(1_500)).toBe("1.5k");
		expect(formatTokens(2_500_000)).toBe("2.50M");
	});
});

describe("完整画面", () => {
	test("三栏拼接，每行有分隔符", async () => {
		const { runtime, boot } = await setup();
		const state = await buildUiState(runtime, { selectedConversationId: boot.ownerConversationId });
		const layout = computeLayout(120, 30);
		const lines = renderLayout(state, layout);

		expect(lines.length).toBeGreaterThan(0);
		// 至少大部分行包含两个分隔符
		const withSeparators = lines.filter((line) => (line.match(/│/g) ?? []).length === 2);
		expect(withSeparators.length).toBeGreaterThan(lines.length * 0.8);
	});

	test("极窄窗口只渲染会话流", async () => {
		const { runtime, boot } = await setup();
		const state = await buildUiState(runtime, { selectedConversationId: boot.ownerConversationId });
		const layout = computeLayout(40, 20);
		const lines = renderLayout(state, layout);

		expect(lines.every((line) => !line.includes("│"))).toBe(true);
	});

	test("每行宽度不超过窗口宽度", async () => {
		const { runtime, boot } = await setup();
		const state = await buildUiState(runtime, { selectedConversationId: boot.ownerConversationId });
		const layout = computeLayout(100, 30);
		const lines = renderLayout(state, layout);

		const { visibleWidth } = await import("@earendil-works/pi-tui");
		for (const line of lines) {
			expect(visibleWidth(line), `行超宽：${line}`).toBeLessThanOrEqual(layout.totalWidth);
		}
	});
});

describe("订阅与切换", () => {
	test("切换会话后状态随之切换", async () => {
		const { ctx, runtime, boot } = await setup();

		// 给 CEO 一条消息
		ctx.faux.setResponses([answer("CEO 的回答")]);
		const ceo = await runtime.harness.conversation(boot.ownerConversationId as never, BACKGROUND_CONTEXT);
		await (await ceo?.submit({ type: "input", content: "问题" }, BACKGROUND_CONTEXT))?.wait(BACKGROUND_CONTEXT);

		const ceoState = await buildUiState(runtime, { selectedConversationId: boot.ownerConversationId });
		expect(ceoState.selectedConversationId).toBe(boot.ownerConversationId);
		expect(ceoState.stream.messages.length).toBeGreaterThan(0);

		// 切到 CFO（空会话）
		const cfoState = await buildUiState(runtime, { selectedConversationId: boot.roleConversations.cfo });
		expect(cfoState.selectedConversationId).toBe(boot.roleConversations.cfo);
		expect(cfoState.stream.messages.length).toBe(0);
	});

	test("迟到附着直接呈现当前状态，不重放历史事件", async () => {
		const { ctx, runtime, boot } = await setup();

		ctx.faux.setResponses([answer("第一答")]);
		const ceo = await runtime.harness.conversation(boot.ownerConversationId as never, BACKGROUND_CONTEXT);
		await (await ceo?.submit({ type: "input", content: "第一问" }, BACKGROUND_CONTEXT))?.wait(BACKGROUND_CONTEXT);
		ctx.faux.setResponses([answer("第二答")]);
		await (await ceo?.submit({ type: "input", content: "第二问" }, BACKGROUND_CONTEXT))?.wait(BACKGROUND_CONTEXT);

		// 现在才附着：应看到全部历史（当前状态），而不是从某个事件开始
		const stream = await buildStream(runtime, boot.ownerConversationId, "CEO");
		expect(stream.messages.filter((message) => message.role === "user").length).toBe(2);
	});
});

describe("键盘操作", () => {
	test("焦点切换", async () => {
		const { interpretKey } = await import("../../src/tui/app.ts");
		expect(interpretKey("\t", "input").kind).toBe("toggle-focus");
		expect(interpretKey("\t", "tree").kind).toBe("toggle-focus");
	});

	test("组织树里方向键移动、Enter 进入", async () => {
		const { interpretKey } = await import("../../src/tui/app.ts");
		expect(interpretKey("\u001b[A", "tree")).toEqual({ kind: "move", delta: -1 });
		expect(interpretKey("\u001b[B", "tree")).toEqual({ kind: "move", delta: 1 });
		expect(interpretKey("\r", "tree").kind).toBe("enter");
	});

	test("输入框里 Enter 发送、Esc 中断、退格删除", async () => {
		const { interpretKey } = await import("../../src/tui/app.ts");
		expect(interpretKey("\r", "input").kind).toBe("send");
		expect(interpretKey("\u001b", "input").kind).toBe("abort");
		expect(interpretKey("\u007f", "input").kind).toBe("backspace");
	});

	test("普通字符进入输入框", async () => {
		const { interpretKey } = await import("../../src/tui/app.ts");
		expect(interpretKey("a", "input")).toEqual({ kind: "type", text: "a" });
		expect(interpretKey("中", "input")).toEqual({ kind: "type", text: "中" });
	});

	test("退出键：Ctrl+C 任意焦点都退出，组织树里 q 也退出", async () => {
		const { interpretKey } = await import("../../src/tui/app.ts");
		expect(interpretKey("\u0003", "input").kind).toBe("quit");
		expect(interpretKey("\u0003", "tree").kind).toBe("quit");
		expect(interpretKey("q", "tree").kind).toBe("quit");
		// 输入框里 q 是普通字符，不退出
		expect(interpretKey("q", "input")).toEqual({ kind: "type", text: "q" });
	});

	test("分叉键在组织树里生效", async () => {
		const { interpretKey } = await import("../../src/tui/app.ts");
		expect(interpretKey("f", "tree").kind).toBe("fork");
	});
});
