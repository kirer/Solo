/**
 * 可靠性与真实可用性的回归测试。
 *
 * 覆盖一批「只有真跑才会发现」的问题：
 * - 重启后角色能力是否还在（registry 是内存态）
 * - CEO 是否被误给了全部工具
 * - 员工是否按角色拿到工具（没有工具就干不了活）
 * - 输出被截断时派活是否判失败（不能当成做完了）
 */
import { afterEach, describe, expect, test } from "vitest";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
	createRegistry,
	inspectLivenessFrom,
	isConversationBusy,
	openCompany,
	recover,
	type CompanyRuntime,
} from "../../src/runtime/index.ts";
import { bootstrapCompany, COMPANY_TASKS_EXTENSION, createProject, hireStaff } from "../../src/company/org.ts";
import { toolsForRole, toolNamesForRole } from "../../src/company/staff-tools.ts";
import { delegate, isEmployeeBusy } from "../../src/company/delegation.ts";
import { listStaff } from "../../src/company/org.ts";
import {
	ALERT_ENTRY_KIND,
	runWatchdogPass,
	startWatchdog,
	type WatchdogAlert,
} from "../../src/company/watchdog.ts";
import {
	delegationWaits,
	enterDelegation,
	resetDelegationWaits,
} from "../../src/company/delegation-guard.ts";
import {
	answer,
	createTestContext,
	eventually,
	slowAnswer,
	type TestContext,
	TEST_MODEL_CATALOG,
} from "../support.ts";

let contexts: TestContext[] = [];
let runtimes: CompanyRuntime[] = [];

async function boot(runtime: CompanyRuntime, registry: ReturnType<typeof createRegistry>, dir: string) {
	return bootstrapCompany(
		runtime,
		{
			modelCatalog: [...TEST_MODEL_CATALOG],
			companyName: "测试公司",
			registry,
			workspaceRoot: join(dir, "projects"),
			...(process.env.TEST_MODEL === undefined
				? { modelCatalog: [{ id: "faux-1", provider: "faux", modelId: "faux-1", label: "测试", inputPerMTok: 0, outputPerMTok: 0 }] }
				: {}),
		},
		BACKGROUND_CONTEXT,
	);
}

afterEach(async () => {
	for (const runtime of runtimes) await runtime.close().catch(() => undefined);
	for (const ctx of contexts) await ctx.cleanup();
	runtimes = [];
	contexts = [];
});

describe("重启后角色能力不能丢", () => {
	test("第二次启动（幂等分支）后管理层仍有工具", async () => {
		const ctx = await createTestContext();
		contexts.push(ctx);
		const db = ctx.databasePath;

		// 第一次启动
		const registryA = createRegistry();
		const first = await openCompany({ databasePath: db, models: ctx.models, registry: registryA }, BACKGROUND_CONTEXT);
		await recover(first, BACKGROUND_CONTEXT);
		const bootA = await boot(first, registryA, ctx.dir);
		await first.close();

		// 第二次启动：全新 registry（内存态不持久化）
		const registryB = createRegistry();
		const second = await openCompany({ databasePath: db, models: ctx.models, registry: registryB }, BACKGROUND_CONTEXT);
		runtimes.push(second);
		await recover(second, BACKGROUND_CONTEXT);
		const bootB = await boot(second, registryB, ctx.dir);

		expect(bootB.created, "第二次应走幂等分支").toBe(false);

		for (const [role, id] of Object.entries(bootB.roleConversations)) {
			const conversation = await second.harness.conversation(id as never, BACKGROUND_CONTEXT);
			const tools = (await conversation?.agent(BACKGROUND_CONTEXT))?.tools.map((tool) => tool.name) ?? [];
			expect(tools.length, `重启后 ${role} 应有工具，实际为空`).toBeGreaterThan(0);
		}
		void bootA;
	});

	test("内置任务注册后员工锚点不阻塞", async () => {
		const ctx = await createTestContext();
		contexts.push(ctx);
		const registry = createRegistry();
		const runtime = await openCompany(
			{ databasePath: ctx.databasePath, models: ctx.models, registry },
			BACKGROUND_CONTEXT,
		);
		runtimes.push(runtime);
		await recover(runtime, BACKGROUND_CONTEXT);
		registry.install(COMPANY_TASKS_EXTENSION);
		await boot(runtime, registry, ctx.dir);

		await createProject(runtime, { name: "A", slug: "a", brief: "b", workspaceRoot: join(ctx.dir, "projects") }, BACKGROUND_CONTEXT);
		await hireStaff(runtime, { project: "a", name: "dev-1", role: "开发", manager: "cto", registry }, BACKGROUND_CONTEXT);

		await new Promise((resolve) => setTimeout(resolve, 200));
		const inspection = await runtime.harness.inspect(BACKGROUND_CONTEXT);
		const blocked = inspection.tasks.filter((task) => task.state.kind === "blocked");
		expect(blocked, "员工锚点不应受阻").toEqual([]);
	});
});

describe("CEO 不能越权", () => {
	test("CEO 只有组织视图与上报能力，没有招聘与立项", async () => {
		const ctx = await createTestContext();
		contexts.push(ctx);
		const registry = createRegistry();
		const runtime = await openCompany(
			{ databasePath: ctx.databasePath, models: ctx.models, registry },
			BACKGROUND_CONTEXT,
		);
		runtimes.push(runtime);
		await recover(runtime, BACKGROUND_CONTEXT);
		const booted = await boot(runtime, registry, ctx.dir);

		const ceo = await runtime.harness.conversation(booted.ownerConversationId as never, BACKGROUND_CONTEXT);
		const tools = (await ceo?.agent(BACKGROUND_CONTEXT))?.tools.map((tool) => tool.name) ?? [];

		expect(tools).toContain("org_tree");
		expect(tools).toContain("escalate");
		expect(tools, "CEO 不应自己招人").not.toContain("staff_hire");
		expect(tools, "CEO 不应自己立项").not.toContain("project_create");
	});
});

describe("员工按角色拿到执行工具", () => {
	test("开发拿到读写与命令执行", () => {
		expect(toolNamesForRole("开发")).toEqual(["read", "write", "edit", "bash"]);
	});

	test("产品只能读写，不能跑命令", () => {
		expect(toolNamesForRole("产品")).toEqual(["read", "write", "edit"]);
		expect(toolNamesForRole("产品")).not.toContain("bash");
	});

	test("未知角色最保守：只读", () => {
		expect(toolNamesForRole("不存在的角色")).toEqual(["read"]);
	});

	test("招聘时按角色自动分配工具", async () => {
		const ctx = await createTestContext();
		contexts.push(ctx);
		const registry = createRegistry();
		const runtime = await openCompany(
			{ databasePath: ctx.databasePath, models: ctx.models, registry },
			BACKGROUND_CONTEXT,
		);
		runtimes.push(runtime);
		await recover(runtime, BACKGROUND_CONTEXT);
		await boot(runtime, registry, ctx.dir);
		await createProject(runtime, { name: "A", slug: "a", brief: "b", workspaceRoot: join(ctx.dir, "projects") }, BACKGROUND_CONTEXT);

		const dev = await hireStaff(runtime, { project: "a", name: "dev-1", role: "开发", manager: "cto", registry }, BACKGROUND_CONTEXT);
		const qa = await hireStaff(runtime, { project: "a", name: "qa-1", role: "测试", manager: "cto", registry }, BACKGROUND_CONTEXT);

		const devConv = await runtime.harness.conversation(dev.conversationId as never, BACKGROUND_CONTEXT);
		const devTools = (await devConv?.agent(BACKGROUND_CONTEXT))?.tools.map((tool) => tool.name) ?? [];
		expect(devTools).toContain("write");
		expect(devTools).toContain("bash");

		const qaConv = await runtime.harness.conversation(qa.conversationId as never, BACKGROUND_CONTEXT);
		const qaTools = (await qaConv?.agent(BACKGROUND_CONTEXT))?.tools.map((tool) => tool.name) ?? [];
		expect(qaTools).toContain("write");
	});
});

describe("多个员工各有独立能力包", () => {
	test("招四个员工后每人都有工具且互不覆盖", async () => {
		const ctx = await createTestContext();
		contexts.push(ctx);
		const registry = createRegistry();
		const runtime = await openCompany(
			{ databasePath: ctx.databasePath, models: ctx.models, registry },
			BACKGROUND_CONTEXT,
		);
		runtimes.push(runtime);
		await recover(runtime, BACKGROUND_CONTEXT);
		await boot(runtime, registry, ctx.dir);
		await createProject(runtime, { name: "A", slug: "a", brief: "b", workspaceRoot: join(ctx.dir, "projects") }, BACKGROUND_CONTEXT);

		const hired = [];
		for (const [name, role] of [
			["pm-1", "产品"],
			["ui-1", "设计"],
			["dev-1", "开发"],
			["qa-1", "测试"],
		] as const) {
			hired.push(await hireStaff(runtime, { project: "a", name, role, manager: "cto", registry }, BACKGROUND_CONTEXT));
		}

		for (const person of hired) {
			const conversation = await runtime.harness.conversation(person.conversationId as never, BACKGROUND_CONTEXT);
			const tools = (await conversation?.agent(BACKGROUND_CONTEXT))?.tools.map((tool) => tool.name) ?? [];
			expect(tools.length, `${person.staff.name} 应有工具，实际为空`).toBeGreaterThan(0);
		}

		// 开发有 bash，产品没有
		const dev = hired.find((person) => person.staff.role === "开发");
		const pm = hired.find((person) => person.staff.role === "产品");
		const devConv = await runtime.harness.conversation(dev?.conversationId as never, BACKGROUND_CONTEXT);
		const pmConv = await runtime.harness.conversation(pm?.conversationId as never, BACKGROUND_CONTEXT);
		const devTools = (await devConv?.agent(BACKGROUND_CONTEXT))?.tools.map((tool) => tool.name) ?? [];
		const pmTools = (await pmConv?.agent(BACKGROUND_CONTEXT))?.tools.map((tool) => tool.name) ?? [];

		expect(devTools).toContain("bash");
		expect(pmTools).not.toContain("bash");
	});
});

describe("截断不能被当成完成", () => {
	test("助手消息以 length 结束时派活判失败", async () => {
		const ctx = await createTestContext();
		contexts.push(ctx);
		const registry = createRegistry();
		const runtime = await openCompany(
			{ databasePath: ctx.databasePath, models: ctx.models, registry },
			BACKGROUND_CONTEXT,
		);
		runtimes.push(runtime);
		await recover(runtime, BACKGROUND_CONTEXT);
		await boot(runtime, registry, ctx.dir);
		const { project } = await createProject(
			runtime,
			{ name: "A", slug: "a", brief: "b", workspaceRoot: join(ctx.dir, "projects") },
			BACKGROUND_CONTEXT,
		);
		await hireStaff(runtime, { project: "a", name: "dev-1", role: "开发", manager: "cto", registry }, BACKGROUND_CONTEXT);

		// 模拟输出被长度截断
		ctx.faux.setResponses([
			{
				role: "assistant",
				content: [{ type: "text", text: "我来实现（被截断）" }],
				api: "faux",
				provider: "faux",
				model: "faux-1",
				usage: { input: 10, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 20 },
				stopReason: "length",
				timestamp: Date.now(),
			} as never,
		]);

		const result = await delegate(
			runtime,
			{
				project: "a",
				employee: "dev-1",
				task: "写一个长文件",
				fromConversationId: project.leader,
				from: "负责人",
			},
			BACKGROUND_CONTEXT,
		);

		expect(result.ok, "截断不得当作成功").toBe(false);
		expect(result.reason).toBe("failed");
		expect(result.text).toContain("截断");
	});
});

// ── 卡住 / 容错（契约 §5） ───────────────────────────────────────────────────

describe("存活判定：区分真的在跑和僵住的 waiting", () => {
	/** 造一份巡检快照，用于纯函数测试。 */
	function inspection(tasks: readonly unknown[]) {
		return { scheduling: "running", tasks, submissions: [] } as never;
	}

	test("waiting 的任务，等的子任务已全部结束 → 僵住，不算忙", () => {
		const live = inspectLivenessFrom(
			inspection([
				{
					record: { id: 1, conversationId: 42, kind: "pi.generation", startedAt: 1_000 },
					state: { kind: "waiting", on: [2] },
				},
			]),
		);

		expect(live.stuckTasks.map((task) => task.taskId)).toEqual(["1"]);
		expect(live.stuckTasks[0]?.reason).toBe("waiting-on-dead");
		expect(isConversationBusy(live, 42), "僵住的 waiting 不得算作在忙").toBe(false);
		expect(live.busyConversations).toEqual([]);
	});

	test("waiting 的子任务还在跑 → 真的在忙", () => {
		const now = 1_000_000;
		const live = inspectLivenessFrom(
			inspection([
				{
					record: { id: 1, conversationId: 42, kind: "pi.generation", startedAt: now - 1_000 },
					state: { kind: "waiting", on: [2] },
				},
				{
					record: { id: 2, conversationId: 42, kind: "pi.tool", startedAt: now - 1_000 },
					state: { kind: "running" },
				},
			]),
			{ now },
		);

		expect(live.stuckTasks).toEqual([]);
		expect(isConversationBusy(live, 42)).toBe(true);
	});

	test("waiting 的子任务全部受阻 → 僵住（等下去没有意义）", () => {
		const live = inspectLivenessFrom(
			inspection([
				{
					record: { id: 1, conversationId: 42, kind: "pi.generation", startedAt: 1_000 },
					state: { kind: "waiting", on: [2] },
				},
				{
					record: { id: 2, conversationId: 42, kind: "pi.tool", startedAt: 1_000 },
					state: { kind: "blocked", reason: "missing_task" },
				},
			]),
		);

		expect(live.stuckTasks.map((task) => task.reason)).toEqual(["waiting-on-blocked", "blocked"]);
	});

	test("休眠等老板拍板不算忙（可以跨天）", () => {
		const live = inspectLivenessFrom(
			inspection([
				{
					record: { id: 1, conversationId: 42, kind: "app.escalation", startedAt: 1_000 },
					state: { kind: "sleeping", until: 9_999_999 },
				},
			]),
		);
		expect(isConversationBusy(live, 42)).toBe(false);
		expect(live.stuckTasks).toEqual([]);
	});

	test("超期判定从「开始观察」起算，不继承重启前的 startedAt", () => {
		const now = 1_000_000;
		const task = {
			record: { id: 1, conversationId: 42, kind: "pi.generation", startedAt: now - 900_000 },
			state: { kind: "running" },
		};

		// 重启后刚看到它：观察起点就是现在，不该立刻判超期
		// （processStartedAt 晚于 startedAt → 这条任务是上个进程的遗留）
		const fresh = inspectLivenessFrom(inspection([task]), {
			now,
			processStartedAt: now - 100_000,
			observedAt: new Map([["1", now]]),
			generationOverdueMs: 600_000,
		});
		expect(fresh.stuckTasks, "刚重启不得把正在恢复的任务判成超期").toEqual([]);

		// 已经观察了 700 秒：确实超期
		const old = inspectLivenessFrom(inspection([task]), {
			now,
			processStartedAt: now - 800_000,
			observedAt: new Map([["1", now - 700_000]]),
			generationOverdueMs: 600_000,
		});
		expect(old.stuckTasks[0]?.reason).toBe("overdue");
	});

	test("工具阈值与生成阈值分开", () => {
		const now = 1_000_000;
		const observedAt = new Map([
			["1", now - 400_000],
			["2", now - 400_000],
		]);
		const live = inspectLivenessFrom(
			inspection([
				{ record: { id: 1, conversationId: 42, kind: "pi.tool", startedAt: 0 }, state: { kind: "running" } },
				{ record: { id: 2, conversationId: 43, kind: "pi.generation", startedAt: 0 }, state: { kind: "running" } },
			]),
			{
				now,
				processStartedAt: now - 1_000,
				observedAt,
				toolOverdueMs: 300_000,
				generationOverdueMs: 600_000,
			},
		);

		expect(live.stuckTasks.map((task) => task.taskKind)).toEqual(["pi.tool"]);
	});
});

describe("派活必须有等待上限", () => {
	test("员工迟迟不答复时超时返回，不再永远挂住", async () => {
		const ctx = await createTestContext();
		contexts.push(ctx);
		const registry = createRegistry();
		const runtime = await openCompany(
			{ databasePath: ctx.databasePath, models: ctx.models, registry },
			BACKGROUND_CONTEXT,
		);
		runtimes.push(runtime);
		await recover(runtime, BACKGROUND_CONTEXT);
		await boot(runtime, registry, ctx.dir);
		const { project } = await createProject(
			runtime,
			{ name: "A", slug: "a", brief: "b", workspaceRoot: join(ctx.dir, "projects") },
			BACKGROUND_CONTEXT,
		);
		await hireStaff(runtime, { project: "a", name: "dev-1", role: "开发", manager: "cto", registry }, BACKGROUND_CONTEXT);

		// 员工这一轮要 2 秒，派活方只等 100ms
		ctx.faux.setResponses([slowAnswer(2_000, "很晚才答")]);
		const started = Date.now();
		const result = await delegate(
			runtime,
			{
				project: "a",
				employee: "dev-1",
				task: "慢活",
				fromConversationId: project.leader,
				from: "负责人",
				timeoutMs: 100,
			},
			BACKGROUND_CONTEXT,
		);

		expect(result.ok).toBe(false);
		expect(result.reason).toBe("timeout");
		expect(result.text).toContain("秒");
		expect(Date.now() - started, "必须在超时量级返回").toBeLessThan(1_500);

		// 等待图必须释放：否则下一次反向派活会被假环挡住
		expect(delegationWaits().has(project.leader)).toBe(false);

		// 员工仍在后台继续（ADR-005）：超时只放弃等待，不撤销工作
		await eventually(
			async () => {
				const staff = await listStaff(runtime, "a", BACKGROUND_CONTEXT);
				const person = staff[0];
				if (person === undefined) return false;
				return !(await isEmployeeBusy(runtime, person, BACKGROUND_CONTEXT));
			},
			{ label: "员工自己跑完", timeoutMs: 6_000 },
		);
	});

	test("派活给正在等自己的会话被环检测拒绝", async () => {
		const ctx = await createTestContext();
		contexts.push(ctx);
		const registry = createRegistry();
		const runtime = await openCompany(
			{ databasePath: ctx.databasePath, models: ctx.models, registry },
			BACKGROUND_CONTEXT,
		);
		runtimes.push(runtime);
		await recover(runtime, BACKGROUND_CONTEXT);
		await boot(runtime, registry, ctx.dir);
		await createProject(
			runtime,
			{ name: "A", slug: "a", brief: "b", workspaceRoot: join(ctx.dir, "projects") },
			BACKGROUND_CONTEXT,
		);
		await hireStaff(runtime, { project: "a", name: "dev-1", role: "开发", manager: "cto", registry }, BACKGROUND_CONTEXT);

		const staff = await listStaff(runtime, "a", BACKGROUND_CONTEXT);
		const person = staff[0];
		expect(person).toBeDefined();

		// 员工正在同步等负责人 → 负责人再派活给它就是闭环
		const release = enterDelegation(person?.conversationId as number, 999);
		try {
			const result = await delegate(
				runtime,
				{
					project: "a",
					employee: "dev-1",
					task: "干活",
					fromConversationId: 999,
					from: "负责人",
					timeoutMs: 50,
				},
				BACKGROUND_CONTEXT,
			);
			expect(result.ok).toBe(false);
			expect(result.reason).toBe("cycle");
		} finally {
			release();
			resetDelegationWaits();
		}
	});
});

describe("看门狗收尾", () => {
	async function setupCompany() {
		const ctx = await createTestContext();
		contexts.push(ctx);
		const registry = createRegistry();
		const runtime = await openCompany(
			{ databasePath: ctx.databasePath, models: ctx.models, registry },
			BACKGROUND_CONTEXT,
		);
		runtimes.push(runtime);
		await recover(runtime, BACKGROUND_CONTEXT);
		await boot(runtime, registry, ctx.dir);
		const { project } = await createProject(
			runtime,
			{ name: "A", slug: "a", brief: "b", workspaceRoot: join(ctx.dir, "projects") },
			BACKGROUND_CONTEXT,
		);
		await hireStaff(runtime, { project: "a", name: "dev-1", role: "开发", manager: "cto", registry }, BACKGROUND_CONTEXT);
		return { ctx, runtime, project };
	}

	test("超期的运行任务被中断，并写一条看得见的告警", async () => {
		const { ctx, runtime } = await setupCompany();
		const root = await runtime.harness.root(BACKGROUND_CONTEXT);

		// 一轮要 3 秒的生成；阈值设成 100ms，它必然超期
		ctx.faux.setResponses([slowAnswer(3_000, "慢到被看门狗收走")]);
		void root.submit({ type: "input", content: "慢慢来" }, BACKGROUND_CONTEXT).catch(() => undefined);

		// 等它真的跑起来
		await eventually(async () => (await runtime.harness.inspect(BACKGROUND_CONTEXT)).tasks.length > 0, {
			label: "任务开始",
		});

		// 让任务真的活过阈值：超期按真实 startedAt 算，刚起 13ms 不算超期
		await new Promise((resolve) => setTimeout(resolve, 250));

		const alerts: WatchdogAlert[] = [];
		const first = await runWatchdogPass(runtime, {
			generationOverdueMs: 100,
			toolOverdueMs: 100,
			intervalMs: 0,
			retryCooldownMs: 0,
			drainInbox: false,
			onAlert: (alert) => alerts.push(alert),
		});

		expect(first.liveness.stuckTasks.length).toBeGreaterThan(0);
		expect(alerts.length).toBeGreaterThan(0);
		expect(alerts[0]?.action).toBe("abort");
		expect(alerts[0]?.giveUp).toBe(false);
		expect(alerts[0]?.message).toContain("看门狗");

		// 留痕：告警必须写进会话流（老板看得见）
		const entries = await root.entries({ order: "descending" }, 20, undefined, BACKGROUND_CONTEXT);
		const alertEntry = entries.items.find((entry) => entry.kind === ALERT_ENTRY_KIND);
		expect(alertEntry, "看门狗告警必须落成会话条目").toBeDefined();
		expect((alertEntry?.data as { text?: string })?.text).toContain("看门狗");

		// 收尾后任务不再活着（abort 生效）
		await eventually(
			async () =>
				(await runtime.harness.inspect(BACKGROUND_CONTEXT)).tasks.every((task) => task.state.kind !== "running"),
			{ label: "超期任务被中断", timeoutMs: 5_000 },
		);
	});

	test("同一条任务最多自动处理 2 次，之后标记故障并停手", async () => {
		const { ctx, runtime } = await setupCompany();
		const root = await runtime.harness.root(BACKGROUND_CONTEXT);

		ctx.faux.setResponses([slowAnswer(2_000, "永远慢")]);
		void root.submit({ type: "input", content: "慢慢来" }, BACKGROUND_CONTEXT).catch(() => undefined);
		await eventually(async () => (await runtime.harness.inspect(BACKGROUND_CONTEXT)).tasks.length > 0, {
			label: "任务开始",
		});

		const options = {
			generationOverdueMs: 10,
			toolOverdueMs: 10,
			intervalMs: 0,
			retryCooldownMs: 0,
			drainInbox: false,
		} as const;

		const seen: WatchdogAlert[] = [];
		// 多跑几轮：每轮都可能有新任务（生成任务被中断后会重开一轮），
		// 但同一条任务标识最多被动手 maxAttempts 次。
		for (let index = 0; index < 8; index += 1) {
			const pass = await runWatchdogPass(runtime, { ...options, onAlert: (alert) => seen.push(alert) });
			if (pass.liveness.tasks.length === 0) break;
			await new Promise((resolve) => setTimeout(resolve, 60));
		}

		const perTask = new Map<string, number>();
		for (const alert of seen) {
			if (alert.action === "abort") perTask.set(alert.taskId, (perTask.get(alert.taskId) ?? 0) + 1);
		}
		for (const [taskId, count] of perTask) {
			expect(count, `任务 ${taskId} 被自动中断次数不得超过上限`).toBeLessThanOrEqual(2);
		}
		expect(seen.some((alert) => alert.action === "report" && alert.giveUp), "超过上限必须如实标记故障").toBe(
			true,
		);
	});

	test("会话变空闲后，压着的排队消息会被自动投出去", async () => {
		const { ctx, runtime } = await setupCompany();
		const root = await runtime.harness.root(BACKGROUND_CONTEXT);

		// ① 一轮要很久的生成；② 老板在它跑的时候又发了一条 → 进队列
		ctx.faux.setResponses([slowAnswer(2_500, "太慢了"), answer("第二条被处理了")]);
		void root.submit({ type: "input", content: "第一条" }, BACKGROUND_CONTEXT).catch(() => undefined);
		await eventually(async () => (await runtime.harness.inspect(BACKGROUND_CONTEXT)).tasks.length > 0, {
			label: "第一轮开始",
		});
		const second = await root.submit(
			{ type: "input", content: "第二条", whenBusy: "followUp" },
			BACKGROUND_CONTEXT,
		);
		expect((await second.status(BACKGROUND_CONTEXT)).status, "消息应排队").toBe("queued");

		// 等它真的活过阈值（超期按真实 startedAt 算）
		await new Promise((resolve) => setTimeout(resolve, 150));

		// ③ 看门狗把超期的那一轮中断。中断路径**不会**触发行边界，
		//    于是这条排队消息会孤零零地留在队列里——正是真实事故的形状。
		const aborted = await runWatchdogPass(runtime, {
			generationOverdueMs: 50,
			toolOverdueMs: 50,
			intervalMs: 0,
			retryCooldownMs: 0,
			drainInbox: false,
		});
		expect(aborted.alerts.some((alert) => alert.action === "abort")).toBe(true);
		await eventually(
			async () =>
				(await runtime.harness.inspect(BACKGROUND_CONTEXT)).tasks.every((task) => task.state.kind !== "running"),
			{ label: "中断生效", timeoutMs: 5_000 },
		);
		expect((await second.status(BACKGROUND_CONTEXT)).status, "中断后消息应仍压着").toBe("queued");

		// ④ 第二轮巡检：会话已经空闲，队列里还有东西 → 自动投出去
		const drained = await runWatchdogPass(runtime, { intervalMs: 0, drainInbox: true });
		const alert = drained.alerts.find((entry) => entry.action === "drain");
		expect(alert, "看门狗应发现并投递被压住的消息").toBeDefined();
		expect(alert?.reason).toBe("inbox-queued");

		// 队列项被撤回后重新投递（旧提交结算为 aborted，新提交承担这次运行），
		// 所以验证的是「消息真的被处理了」，而不是某一个提交标识的状态。
		await eventually(
			async () => {
				const page = await root.entries({ order: "descending" }, 10, undefined, BACKGROUND_CONTEXT);
				return page.items.some((entry) => {
					const message = entry.model?.[0] as { content?: unknown } | undefined;
					const text = JSON.stringify(message?.content ?? "");
					return text.includes("第二条被处理了");
				});
			},
			{ label: "排队消息被处理", timeoutMs: 8_000 },
		);
	});

	test("startWatchdog 返回停止函数，且能立刻停掉巡检", async () => {
		const { runtime } = await setupCompany();
		let passes = 0;
		const stop = startWatchdog(runtime, {
			intervalMs: 20,
			immediate: true,
			drainInbox: false,
			onAlert: () => {
				passes += 1;
			},
		});
		await new Promise((resolve) => setTimeout(resolve, 120));
		stop();
		stop(); // 幂等
		const settled = passes;
		await new Promise((resolve) => setTimeout(resolve, 100));
		expect(passes, "停止后不应再巡检").toBe(settled);
	});

	test("看门狗不碰正常刚启动的任务（启动即误杀是禁止的）", async () => {
		const { ctx, runtime } = await setupCompany();
		const root = await runtime.harness.root(BACKGROUND_CONTEXT);

		// 一轮要 800ms；看门狗用默认阈值（10 分钟）巡检，绝不能把它判成超期
		ctx.faux.setResponses([slowAnswer(800, "正常慢")]);
		const submission = await root.submit({ type: "input", content: "正常任务" }, BACKGROUND_CONTEXT);
		await new Promise((resolve) => setTimeout(resolve, 100));

		const pass = await runWatchdogPass(runtime, { drainInbox: false });
		expect(pass.alerts, "正常任务不该被看门狗动手").toEqual([]);

		const settled = await submission.wait(BACKGROUND_CONTEXT);
		expect(settled.status).toBe("done");
	});
});

describe("启动自动恢复", () => {
	test("recover 报告僵住任务并自动收尾，而不是只报「受阻任务」", async () => {
		const ctx = await createTestContext();
		contexts.push(ctx);
		const registry = createRegistry();
		const runtime = await openCompany(
			{ databasePath: ctx.databasePath, models: ctx.models, registry },
			BACKGROUND_CONTEXT,
		);
		runtimes.push(runtime);

		const result = await recover(runtime, BACKGROUND_CONTEXT);
		// 全新库：没有僵住任务，也没有可恢复的任务
		expect(result.stuckTasks).toEqual([]);
		expect(result.recoveredTasks).toEqual([]);
		expect(result.pendingTasks).toBe(0);
	});

	test("recover 不按时间阈值误杀刚恢复的任务", async () => {
		const ctx = await createTestContext();
		contexts.push(ctx);

		// 第一个进程：跑一个慢任务，中途关闭（模拟进程退出）
		const first = await openCompany(
			{ databasePath: ctx.databasePath, models: ctx.models, registry: createRegistry() },
			BACKGROUND_CONTEXT,
		);
		const root = await first.harness.root(BACKGROUND_CONTEXT);
		ctx.faux.setResponses([slowAnswer(600, "恢复后继续")]);
		void root.submit({ type: "input", content: "go" }, BACKGROUND_CONTEXT).catch(() => undefined);
		await eventually(async () => (await first.harness.inspect(BACKGROUND_CONTEXT)).tasks.length > 0, {
			label: "任务开始",
		});
		await first.close();

		// 第二个进程：重开。任务带着上一次进程的 startedAt，
		// 恢复时**不得**把它当成超期任务中断（否则崩溃恢复永远失败）。
		const second = await openCompany(
			{ databasePath: ctx.databasePath, models: ctx.models, registry: createRegistry() },
			BACKGROUND_CONTEXT,
		);
		runtimes.push(second);
		const result = await recover(second, BACKGROUND_CONTEXT);

		expect(result.stuckTasks, "重启后正在恢复的任务不算僵住").toEqual([]);
		expect(result.recoveredTasks).toEqual([]);
	});
});
