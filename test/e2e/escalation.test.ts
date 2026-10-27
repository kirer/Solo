/**
 * escalation 的端到端测试。
 *
 * 覆盖 specs/escalation/spec.md：授权范围内自行拍板、逐级上报、等待老板、全程可追溯。
 */
import { afterEach, describe, expect, test } from "vitest";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createRegistry, openCompany, recover, type CompanyRuntime } from "../../src/runtime/index.ts";
import { bootstrapCompany, createProject, escalateUp, hireStaff } from "../../src/company/org.ts";
import {
	answerPending,
	createEscalationTask,
	listPending,
	startEscalation,
} from "../../src/company/escalation.ts";
import { AuditDoc, CompanyDoc } from "../../src/company/docs.ts";
import { createTestContext, eventually, type TestContext, TEST_MODEL_CATALOG, waitEscalation } from "../support.ts";

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

	// 升级任务需要在注册表里，且要能访问运行时
	const escalationTask = createEscalationTask(runtime);
	registry.install({
		name: "escalation",
		tasks: [escalationTask],
	} as never);

	await bootstrapCompany(
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
	await hireStaff(runtime, { project: "alpha", name: "dev-1", role: "开发", manager: "cto" }, BACKGROUND_CONTEXT);

	const state = await runtime.harness.snapshot(CompanyDoc, BACKGROUND_CONTEXT);
	return { ctx, runtime, registry, project, escalationTask, roles: state?.roles ?? {} };
}

afterEach(async () => {
	for (const runtime of runtimes) await runtime.close().catch(() => undefined);
	for (const ctx of contexts) await ctx.cleanup();
	runtimes = [];
	contexts = [];
});

describe("管理层在授权范围内自行拍板", () => {
	test("管理层答复且不升级时流程结束在管理层", async () => {
		const { runtime, project, escalationTask } = await setup();

		const taskId = await startEscalation(
			runtime,
			escalationTask,
			{
				question: "登录模块用 JWT 还是 session？",
				from: "dev-1",
				fromConversationId: project.leader,
				manager: "cto",
				escalationKey: "esc-1",
				project: "alpha",
			},
			BACKGROUND_CONTEXT,
		);

		// 等 CTO 那条待决问题出现
		await eventually(async () => (await listPending(runtime, BACKGROUND_CONTEXT)).length > 0, {
			label: "待决问题出现",
		});

		const pending = await listPending(runtime, BACKGROUND_CONTEXT);
		expect(pending[0]?.level).toBe("cto");

		await answerPending(
			runtime,
			{ key: "esc-1", answer: "用 JWT，别引入 session 存储。", answeredBy: "cto" },
			BACKGROUND_CONTEXT,
		);

		const result = await waitEscalation(runtime, taskId, BACKGROUND_CONTEXT);
		expect(result?.decidedBy).toBe("cto");
		expect(result?.decision).toContain("JWT");
	});
});

describe("逐级上报", () => {
	test("管理层拍不了 → 转 CEO → CEO 拍板", async () => {
		const { runtime, project, escalationTask } = await setup();

		const taskId = await startEscalation(
			runtime,
			escalationTask,
			{
				question: "要不要把整个前端重写成 WebGL？",
				from: "dev-1",
				fromConversationId: project.leader,
				manager: "cto",
				escalationKey: "esc-2",
				project: "alpha",
			},
			BACKGROUND_CONTEXT,
		);

		await eventually(async () => (await listPending(runtime, BACKGROUND_CONTEXT)).some((p) => p.level === "cto"), {
			label: "CTO 待决出现",
		});

		// CTO 表示拍不了
		await answerPending(
			runtime,
			{ key: "esc-2", answer: "这超出我的授权范围。", answeredBy: "cto", escalate: true },
			BACKGROUND_CONTEXT,
		);

		// 等升级到 CEO
		await eventually(async () => (await listPending(runtime, BACKGROUND_CONTEXT)).some((p) => p.level === "ceo"), {
			label: "CEO 待决出现",
		});

		await answerPending(
			runtime,
			{ key: "esc-2", answer: "先不重写，用 Canvas 2D 把功能做完整。", answeredBy: "ceo" },
			BACKGROUND_CONTEXT,
		);

		const result = await waitEscalation(runtime, taskId, BACKGROUND_CONTEXT);
		expect(result?.decidedBy).toBe("ceo");
		expect(result?.decision).toContain("Canvas 2D");
		expect(result?.path).toContain("ceo");
	});

	test("CEO 拍不了 → 转为等待老板", async () => {
		const { runtime, project, escalationTask } = await setup();

		const taskId = await startEscalation(
			runtime,
			escalationTask,
			{
				question: "要不要接这个外包项目？",
				from: "dev-1",
				fromConversationId: project.leader,
				manager: "ceo",
				escalationKey: "esc-3",
			},
			BACKGROUND_CONTEXT,
		);

		await eventually(async () => (await listPending(runtime, BACKGROUND_CONTEXT)).some((p) => p.level === "ceo"), {
			label: "CEO 待决出现",
		});
		await answerPending(
			runtime,
			{ key: "esc-3", answer: "这是战略决策，得老板定。", answeredBy: "ceo", escalate: true },
			BACKGROUND_CONTEXT,
		);

		await eventually(
			async () => (await listPending(runtime, BACKGROUND_CONTEXT)).some((p) => p.level === "owner"),
			{ label: "老板待决出现" },
		);

		const pending = await listPending(runtime, BACKGROUND_CONTEXT);
		const ownerItem = pending.find((item) => item.level === "owner");
		expect(ownerItem).toBeDefined();
		expect(ownerItem?.question).toContain("外包");

		// 老板拍板
		await answerPending(
			runtime,
			{ key: "esc-3", answer: "接，但要求分三期交付。", answeredBy: "owner" },
			BACKGROUND_CONTEXT,
		);

		const result = await waitEscalation(runtime, taskId, BACKGROUND_CONTEXT);
		expect(result?.decidedBy).toBe("owner");
		expect(result?.decision).toContain("分三期");
	});
});

describe("等待老板拍板", () => {
	test("等待期间任务处于休眠，不占用执行", async () => {
		const { runtime, project, escalationTask } = await setup();

		await startEscalation(
			runtime,
			escalationTask,
			{
				question: "预算要不要翻倍？",
				from: "dev-1",
				fromConversationId: project.leader,
				manager: "ceo",
				escalationKey: "esc-4",
			},
			BACKGROUND_CONTEXT,
		);

		await eventually(async () => (await listPending(runtime, BACKGROUND_CONTEXT)).length > 0, { label: "待决出现" });
		await answerPending(
			runtime,
			{ key: "esc-4", answer: "得老板定。", answeredBy: "ceo", escalate: true },
			BACKGROUND_CONTEXT,
		);

		await eventually(
			async () => (await listPending(runtime, BACKGROUND_CONTEXT)).some((p) => p.level === "owner"),
			{ label: "老板待决出现" },
		);

		// 此时任务应处于休眠
		const inspection = await runtime.harness.inspect(BACKGROUND_CONTEXT);
		const escalationTasks = inspection.tasks.filter((task) => task.record.kind === "app.escalation");
		expect(escalationTasks.length).toBeGreaterThan(0);
		const sleeping = escalationTasks.some((task) => task.state.kind === "sleeping");
		expect(sleeping, "等待老板时任务应休眠").toBe(true);
	});

	test("老板长时间不回应，待决问题保持", async () => {
		const { runtime, project, escalationTask } = await setup();

		await startEscalation(
			runtime,
			escalationTask,
			{
				question: "要不要换供应商？",
				from: "dev-1",
				fromConversationId: project.leader,
				manager: "ceo",
				escalationKey: "esc-5",
			},
			BACKGROUND_CONTEXT,
		);
		await eventually(async () => (await listPending(runtime, BACKGROUND_CONTEXT)).length > 0, { label: "待决出现" });
		await answerPending(
			runtime,
			{ key: "esc-5", answer: "老板定。", answeredBy: "ceo", escalate: true },
			BACKGROUND_CONTEXT,
		);
		await eventually(
			async () => (await listPending(runtime, BACKGROUND_CONTEXT)).some((p) => p.level === "owner"),
			{ label: "老板待决出现" },
		);

		// 等几轮轮询，问题应仍在
		await new Promise((resolve) => setTimeout(resolve, 600));
		const stillPending = await listPending(runtime, BACKGROUND_CONTEXT);
		expect(stillPending.some((item) => item.level === "owner"), "老板未答复时问题必须保持").toBe(true);
	});
});

describe("升级全程可追溯", () => {
	test("记录每次跃迁与最终决定", async () => {
		const { runtime, project, escalationTask } = await setup();

		const taskId = await startEscalation(
			runtime,
			escalationTask,
			{
				question: "要不要引入 TypeScript？",
				from: "dev-1",
				fromConversationId: project.leader,
				manager: "cto",
				escalationKey: "esc-6",
				project: "alpha",
			},
			BACKGROUND_CONTEXT,
		);

		await eventually(async () => (await listPending(runtime, BACKGROUND_CONTEXT)).length > 0, { label: "待决出现" });
		await answerPending(
			runtime,
			{ key: "esc-6", answer: "引入。", answeredBy: "cto" },
			BACKGROUND_CONTEXT,
		);
		await waitEscalation(runtime, taskId, BACKGROUND_CONTEXT);

		const audit = await runtime.harness.snapshot(AuditDoc, project.leader as never, BACKGROUND_CONTEXT);
		const events = audit?.events ?? [];
		expect(events.some((event) => event.type === "escalate"), "应有跃迁记录").toBe(true);
		expect(events.some((event) => event.type === "decide"), "应有决定记录").toBe(true);
		expect(events.every((event) => event.ref === "esc-6" || event.ref === undefined)).toBe(true);
	});

	test("完整路径可从结果读出", async () => {
		const { runtime, project, escalationTask } = await setup();

		const taskId = await startEscalation(
			runtime,
			escalationTask,
			{
				question: "技术栈选型",
				from: "dev-1",
				fromConversationId: project.leader,
				manager: "cto",
				escalationKey: "esc-7",
			},
			BACKGROUND_CONTEXT,
		);
		await eventually(async () => (await listPending(runtime, BACKGROUND_CONTEXT)).length > 0, { label: "待决出现" });
		await answerPending(runtime, { key: "esc-7", answer: "用 Vite。", answeredBy: "cto" }, BACKGROUND_CONTEXT);

		const result = await waitEscalation(runtime, taskId, BACKGROUND_CONTEXT);
		expect(result?.path).toContain("dev-1");
		expect(result?.path).toContain("cto");
	});
});

describe("不重复询问已结论层级", () => {
	test("升级到 CEO 后不再回到管理层", async () => {
		const { runtime, project, escalationTask } = await setup();

		const taskId = await startEscalation(
			runtime,
			escalationTask,
			{
				question: "要不要做移动端？",
				from: "dev-1",
				fromConversationId: project.leader,
				manager: "cto",
				escalationKey: "esc-8",
			},
			BACKGROUND_CONTEXT,
		);

		await eventually(async () => (await listPending(runtime, BACKGROUND_CONTEXT)).some((p) => p.level === "cto"), {
			label: "CTO 待决出现",
		});
		await answerPending(
			runtime,
			{ key: "esc-8", answer: "拍不了。", answeredBy: "cto", escalate: true },
			BACKGROUND_CONTEXT,
		);

		await eventually(async () => (await listPending(runtime, BACKGROUND_CONTEXT)).some((p) => p.level === "ceo"), {
			label: "CEO 待决出现",
		});

		// 此时不应再有 cto 层的未答复项
		const pending = await listPending(runtime, BACKGROUND_CONTEXT);
		expect(pending.filter((item) => item.level === "cto"), "已结论的层级不得再次出现").toEqual([]);

		await answerPending(runtime, { key: "esc-8", answer: "先做网页版。", answeredBy: "ceo" }, BACKGROUND_CONTEXT);
		const result = await waitEscalation(runtime, taskId, BACKGROUND_CONTEXT);
		expect(result?.decidedBy).toBe("ceo");
	});
});

/**
 * 回归：升级编号必须跨重启唯一。
 *
 * 旧实现用模块级内存自增（`let escalationSeq = 0`），进程重启后归零，
 * 于是重启后的第一条上报拿到和重启前相同的 `esc:<conv>:1`：
 * 1. `ensurePending` 发现同 key+level 已存在 → 直接 return，**新问题不建待办**；
 * 2. `readOutcome` 读到**旧的已答复条目** → 旧答复被当成新问题的决定交付。
 * 结果：老板看不到新问题，提问方收到答非所问的「拍板结果」，且全程不报错。
 *
 * 这条测试必须真的关掉再打开同一个库，不能用同一个进程里的两个 runtime。
 */
describe("升级编号跨重启唯一（回归）", () => {
	test("重启后新上报不得撞上重启前的已答复编号", async () => {
		const ctx = await createTestContext();
		contexts.push(ctx);

		/** 打开同一个库并完成装配。 */
		const boot = async () => {
			const registry = createRegistry();
			const runtime = await openCompany(
				{ databasePath: ctx.databasePath, models: ctx.models, registry },
				BACKGROUND_CONTEXT,
			);
			runtimes.push(runtime);
			await recover(runtime, BACKGROUND_CONTEXT);
			const escalationTask = createEscalationTask(runtime);
			registry.install({ name: "escalation", tasks: [escalationTask] } as never);
			const booted = await bootstrapCompany(
				runtime,
				{
					modelCatalog: [...TEST_MODEL_CATALOG],
					companyName: "重启测试",
					registry,
					workspaceRoot: join(ctx.dir, "projects"),
					escalationTask,
				},
				BACKGROUND_CONTEXT,
			);
			return { runtime, escalationTask, roles: booted.roleConversations };
		};

		// ── 第一次进程：CEO 上报一件公司级事项，并把它答掉 ──
		const first = await boot();
		const firstReply = await escalateUp(
			first.runtime,
			{
				question: "第一问：要不要裁掉测试团队",
				from: "CEO",
				conversationId: first.roles.cto,
				topic: "company-level",
			},
			first.escalationTask,
			BACKGROUND_CONTEXT,
		);
		const firstKey = /编号 ([^，,]+)/.exec(firstReply)?.[1];
		expect(firstKey, "第一次上报必须给出编号").toBeTruthy();

		await eventually(
			async () => (await listPending(first.runtime, BACKGROUND_CONTEXT)).some((p) => p.key === firstKey),
			{ label: "第一问进入待办" },
		);
		await answerPending(
			first.runtime,
			{ key: firstKey as string, answer: "同意裁掉", answeredBy: "ceo" },
			BACKGROUND_CONTEXT,
		);
		expect(
			(await listPending(first.runtime, BACKGROUND_CONTEXT)).some((p) => p.key === firstKey),
			"第一问应已被答复",
		).toBe(false);

		await first.runtime.close();

		// ── 第二次进程：同一对话再上报一件完全不同的事 ──
		const second = await boot();
		const secondReply = await escalateUp(
			second.runtime,
			{
				question: "第二问：要不要给所有人涨薪",
				from: "CEO",
				conversationId: second.roles.cto,
				topic: "company-level",
			},
			second.escalationTask,
			BACKGROUND_CONTEXT,
		);
		const secondKey = /编号 ([^，,]+)/.exec(secondReply)?.[1];
		expect(secondKey, "第二次上报必须给出编号").toBeTruthy();
		expect(secondKey, "重启后的编号不得与重启前撞车").not.toBe(firstKey);

		// 新问题必须真的建出待办（旧实现这里会是空数组：新问题凭空消失）
		await eventually(
			async () => (await listPending(second.runtime, BACKGROUND_CONTEXT)).some((p) => p.key === secondKey),
			{ label: "第二问进入待办" },
		);
		const pending = await listPending(second.runtime, BACKGROUND_CONTEXT);
		const item = pending.find((p) => p.key === secondKey);
		expect(item?.question).toContain("第二问");
		expect(item?.answer, "新问题不能带着旧答复").toBeUndefined();
	});
});
