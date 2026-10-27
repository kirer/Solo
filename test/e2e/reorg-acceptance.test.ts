/**
 * 组织改造验收：项目负责人权限 + 员工直属上级迁移。
 *
 * 这是「可直接执行的验收」，不是口头确认：
 * - 数据层：`staff.manager` 存的是 `leader:<slug>`，并能解析回负责人会话；
 * - 展示层：`/api/org`（buildOrgView）与 `/api/profile`（readProfile）显示负责人名字；
 * - 提示词层：员工会话实际收到的 instructions 里写着负责人名字；
 * - 功能层：员工上报落在负责人这一级，不经过 COO/CTO/CEO；
 * - 回收层：项目终止后负责人只剩只读能力包，重启修复也不会把权限还回去；
 * - 迁移层：旧数据（coo/cto）可重复迁移，dryRun 不写库。
 *
 * 全部使用 faux provider 与临时 SQLite：**不发真实模型请求、不碰 workspace/company.sqlite**。
 * 需要模型参与的地方一律用 faux；本文件当前不触发任何模型轮次，只做状态与配置断言。
 */
import { afterEach, describe, expect, test } from "vitest";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createRegistry, openCompany, recover, type CompanyRuntime } from "../../src/runtime/index.ts";
import {
	bootstrapCompany,
	createProject,
	employeeToolsFor,
	hireStaff,
	migrateStaffManagers,
	readCompany,
	reassignStaff,
	repairLeaderAgents,
	setProjectStatus,
	terminateProject,
} from "../../src/company/org.ts";
import {
	AuditDoc,
	isLeaderManagerRef,
	managerConversationOf,
	managerLabelOf,
	type CompanyState,
} from "../../src/company/docs.ts";
import {
	answerPending,
	createEscalationTask,
	listPending,
	startEscalation,
} from "../../src/company/escalation.ts";
import { createManagementTools } from "../../src/company/management-tools.ts";
import { buildOrgView } from "../../src/server/org-view.ts";
import { readProfile } from "../../src/server/profile.ts";
import { createTestContext, eventually, type TestContext, TEST_MODEL_CATALOG, agentTools, waitEscalation } from "../support.ts";

const PROJECT = "ops-defect-loop";
const LEADER_NAME = "许砚舟";
const LEADER_REF = `leader:${PROJECT}`;

let contexts: TestContext[] = [];
let runtimes: CompanyRuntime[] = [];

afterEach(async () => {
	for (const runtime of runtimes) await runtime.close().catch(() => undefined);
	for (const ctx of contexts) await ctx.cleanup();
	runtimes = [];
	contexts = [];
});

/** 建一个隔离的测试公司；必须传 registry 与 escalationTask，负责人会话与升级链才存在。 */
async function setup(): Promise<{
	ctx: TestContext;
	runtime: CompanyRuntime;
	registry: ReturnType<typeof createRegistry>;
	boot: Awaited<ReturnType<typeof bootstrapCompany>>;
	escalationTask: ReturnType<typeof createEscalationTask>;
}> {
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
			companyName: "测试公司",
			registry,
			workspaceRoot: join(ctx.dir, "projects"),
			escalationTask,
		},
		BACKGROUND_CONTEXT,
	);

	return { ctx, runtime, registry, boot, escalationTask };
}

/** 建一个与真实数据同构的项目：slug/显示名/负责人名字都对齐。 */
async function fixture() {
	const base = await setup();
	const { project } = await createProject(
		base.runtime,
		{
			name: "系统持续运维与缺陷治理",
			slug: PROJECT,
			brief: "验收夹具：日志巡检与缺陷治理",
			leaderName: LEADER_NAME,
			workspaceRoot: join(base.ctx.dir, "projects"),
		},
		BACKGROUND_CONTEXT,
	);
	return { ...base, project };
}

/** 读某会话当前的 agent（工具列表/能力包/instructions 都在这里）。 */
async function agentOf(runtime: CompanyRuntime, conversationId: number) {
	const conversation = await runtime.harness.conversation(conversationId as never, BACKGROUND_CONTEXT);
	return conversation?.agent(BACKGROUND_CONTEXT);
}

async function company(runtime: CompanyRuntime): Promise<CompanyState> {
	const state = await readCompany(runtime, BACKGROUND_CONTEXT);
	if (state === undefined) throw new Error("公司尚未初始化");
	return state;
}

// ── 1. 数据层 ────────────────────────────────────────────────────────────────

describe("改造验收", () => {
	test("数据层：不传 manager 招人，索引存 leader:<slug>，且能解析回负责人会话与名字", async () => {
		const { runtime, project, registry } = await fixture();

		// 两名员工都省略 manager：默认应是「本项目负责人」，而不是 CEO/CTO 之类的岗位。
		const logOps = await hireStaff(
			runtime,
			{ project: PROJECT, name: "log-ops", role: "运营", registry },
			BACKGROUND_CONTEXT,
		);
		const backendFix = await hireStaff(
			runtime,
			{ project: PROJECT, name: "backend-fix", role: "开发", registry },
			BACKGROUND_CONTEXT,
		);

		const state = await company(runtime);
		for (const key of [`${PROJECT}/log-ops`, `${PROJECT}/backend-fix`]) {
			const person = state.staff[key];
			expect(person, `${key} 应被登记进名册`).toBeDefined();
			// 关键：存的是可跟随负责人换人的引用，不是写死的岗位，也不是会话 id。
			expect(person?.manager).toBe(LEADER_REF);
			expect(isLeaderManagerRef(person?.manager ?? "")).toBe(true);
			// 解析层：引用 → 会话 id / 显示名。
			expect(managerConversationOf(state, person!.manager)).toBe(project.leader);
			expect(managerLabelOf(state, person!.manager)).toBe(LEADER_NAME);
		}
		// 名册本身也要能通过 listStaff 读出同一份 manager 引用
		expect(logOps.staff.manager).toBe(LEADER_REF);
		expect(backendFix.staff.manager).toBe(LEADER_REF);
	});

	// ── 2. 展示层 ──────────────────────────────────────────────────────────────

	test("展示层：/api/org 与 /api/profile 的上级都显示负责人名字，不再显示 COO/CTO", async () => {
		const { runtime, project, registry } = await fixture();
		const logOps = await hireStaff(
			runtime,
			{ project: PROJECT, name: "log-ops", role: "运营", registry },
			BACKGROUND_CONTEXT,
		);
		const backendFix = await hireStaff(
			runtime,
			{ project: PROJECT, name: "backend-fix", role: "开发", registry },
			BACKGROUND_CONTEXT,
		);

		// 主视图：项目卡片翻面后看到的名字必须与负责人一致。
		const org = await buildOrgView(runtime, BACKGROUND_CONTEXT);
		const view = org.projects.find((item) => item.slug === PROJECT);
		expect(view?.lead.label).toBe(LEADER_NAME);
		expect(view?.lead.parent).toBe("CEO"); // 负责人自己的上级不变
		for (const person of view?.staff ?? []) {
			expect(person.parent, `${person.label} 在 /api/org 的上级`).toBe(LEADER_NAME);
			expect(person.parent).toBe(view?.lead.label);
		}

		// 职工档案：parent 与 charter 都要同源，不能一个显示负责人、一个显示 COO。
		for (const id of [logOps.conversationId, backendFix.conversationId]) {
			const result = await readProfile(runtime, id, BACKGROUND_CONTEXT);
			if (!("profile" in result)) throw new Error(result.error);
			expect(result.profile.parent).toBe(LEADER_NAME);
			// charter 里角色模板本身可能出现「上报 COO/CTO」（那是职责描述），
			// 所以只锁「直属上级」这一行，避免误伤角色模板。
			expect(result.profile.charter).toContain(`直属上级是 ${LEADER_NAME}`);
			expect(result.profile.charter).not.toContain("直属上级是 COO");
			expect(result.profile.charter).not.toContain("直属上级是 CTO");
		}
		expect(project.leader).toBeGreaterThan(0);
	});

	// ── 3. 提示词层 ────────────────────────────────────────────────────────────

	test("提示词层：员工实际 instructions 随上级变化，不是只改索引", async () => {
		const { runtime, boot, project, registry } = await fixture();
		const hired = await hireStaff(
			runtime,
			{ project: PROJECT, name: "log-ops", role: "运营", registry },
			BACKGROUND_CONTEXT,
		);

		const before = await agentOf(runtime, hired.conversationId);
		expect(before?.instructions).toContain(LEADER_NAME);

		// 改成 CTO：索引与提示词必须一起变，否则员工会继续以为自己在向原上级汇报。
		const result = await reassignStaff(
			runtime,
			{
				project: PROJECT,
				name: "log-ops",
				manager: "cto",
				by: "CEO",
				fromConversationId: boot.ownerConversationId,
			},
			BACKGROUND_CONTEXT,
		);
		expect(result.ok).toBe(true);

		const after = await agentOf(runtime, hired.conversationId);
		expect(after?.instructions).toContain("CTO");
		expect(after?.instructions).not.toContain(LEADER_NAME);
		// 索引同步改了
		expect((await company(runtime)).staff[`${PROJECT}/log-ops`]?.manager).toBe("cto");
		expect(project.slug).toBe(PROJECT);
	});

	// ── 4. 变更上级 ────────────────────────────────────────────────────────────

	test("变更上级：成功写审计，同值重复不改不写审计，跨项目负责人被拒", async () => {
		const { runtime, boot, registry, ctx } = await fixture();
		await hireStaff(runtime, { project: PROJECT, name: "log-ops", role: "运营", registry }, BACKGROUND_CONTEXT);
		// 另一个项目：用来证明「不能把员工挂到别的项目负责人名下」。
		await createProject(
			runtime,
			{ name: "Beta", slug: "beta", brief: "另一个项目", workspaceRoot: join(ctx.dir, "projects") },
			BACKGROUND_CONTEXT,
		);

		const auditOfCeo = async () =>
			runtime.harness.snapshot(AuditDoc, boot.ownerConversationId as never, BACKGROUND_CONTEXT);

		const auditBefore = await auditOfCeo();
		const first = await reassignStaff(
			runtime,
			{ project: PROJECT, name: "log-ops", manager: "cto", by: "CEO", fromConversationId: boot.ownerConversationId },
			BACKGROUND_CONTEXT,
		);
		expect(first.ok).toBe(true);

		const auditAfterFirst = await auditOfCeo();
		const changesFirst = (auditAfterFirst?.events ?? []).filter((event) => event.type === "staff-manager-change");
		expect(changesFirst.length).toBe(1);
		expect(changesFirst[0]?.ref).toBe(`staff:${PROJECT}/log-ops`);
		// 审计里要能看出「从谁改到谁」，否则事后无法追溯。
		expect(changesFirst[0]?.from).toBe(LEADER_NAME);
		expect(changesFirst[0]?.to).toBe("CTO");
		const beforeCount = (auditBefore?.events ?? []).length;

		// 幂等：同值再调一次，返回成功但审计条数不增。
		const again = await reassignStaff(
			runtime,
			{ project: PROJECT, name: "log-ops", manager: "cto", by: "CEO", fromConversationId: boot.ownerConversationId },
			BACKGROUND_CONTEXT,
		);
		expect(again.ok).toBe(true);
		expect((await auditOfCeo())?.events.length).toBe(beforeCount + 1);

		// 跨项目负责人：非法，且库里 manager 不变。
		const cross = await reassignStaff(
			runtime,
			{ project: PROJECT, name: "log-ops", manager: "leader:beta", by: "CEO", fromConversationId: boot.ownerConversationId },
			BACKGROUND_CONTEXT,
		);
		expect(cross.ok).toBe(false);
		expect(cross.message).toContain("非法直属上级");
		expect((await company(runtime)).staff[`${PROJECT}/log-ops`]?.manager).toBe("cto");
	});

	// ── 5. 状态机 ──────────────────────────────────────────────────────────────

	test("项目状态机：合法边成功、同状态幂等、非法边/终止入口/越权调用分别报错并写审计", async () => {
		const { runtime, boot, project, registry } = await fixture();
		const employee = await hireStaff(
			runtime,
			{ project: PROJECT, name: "log-ops", role: "运营", registry },
			BACKGROUND_CONTEXT,
		);

		// 终止必须走 terminateProject（它还要停活、归档），这里应明确拒绝。
		const terminated = await setProjectStatus(
			runtime,
			{ project: PROJECT, to: "terminated", by: LEADER_NAME, fromConversationId: project.leader },
			BACKGROUND_CONTEXT,
		);
		expect(terminated.ok).toBe(false);
		expect(terminated.error).toBe("E_USE_TERMINATE");

		// planning 只能到 active：跳步必须被状态机拒绝。
		const jump = await setProjectStatus(
			runtime,
			{ project: PROJECT, to: "done", by: LEADER_NAME, fromConversationId: project.leader },
			BACKGROUND_CONTEXT,
		);
		expect(jump.ok).toBe(false);
		expect(jump.error).toBe("E_INVALID_TRANSITION");

		// 普通员工既不是本项目负责人也不是管理层：即使边合法也要拒。
		const forbidden = await setProjectStatus(
			runtime,
			{ project: PROJECT, to: "active", by: "log-ops", fromConversationId: employee.conversationId },
			BACKGROUND_CONTEXT,
		);
		expect(forbidden.ok).toBe(false);
		expect(forbidden.error).toBe("E_FORBIDDEN");

		// 负责人推进自己的项目：成功并留审计。
		const activated = await setProjectStatus(
			runtime,
			{ project: PROJECT, to: "active", by: LEADER_NAME, fromConversationId: project.leader },
			BACKGROUND_CONTEXT,
		);
		expect(activated.ok).toBe(true);
		expect((await company(runtime)).projects[PROJECT]?.status).toBe("active");

		const audit = await runtime.harness.snapshot(AuditDoc, project.leader as never, BACKGROUND_CONTEXT);
		const statusEvents = (audit?.events ?? []).filter((event) => event.type === "project-status");
		expect(statusEvents.length).toBe(1);
		expect(statusEvents[0]?.from).toBe("planning");
		expect(statusEvents[0]?.to).toBe("active");

		// 幂等：目标与当前相同直接成功，不写第二条审计。
		const idempotent = await setProjectStatus(
			runtime,
			{ project: PROJECT, to: "active", by: LEADER_NAME, fromConversationId: project.leader },
			BACKGROUND_CONTEXT,
		);
		expect(idempotent.ok).toBe(true);
		const auditAgain = await runtime.harness.snapshot(AuditDoc, project.leader as never, BACKGROUND_CONTEXT);
		expect((auditAgain?.events ?? []).filter((event) => event.type === "project-status").length).toBe(1);

		// 管理层也可以推进（CEO 会话），但不在本断言范围；这里只锁负责人路径。
		expect(boot.ownerConversationId).toBeGreaterThan(0);
	});

	// ── 6. 负责人能力面 ────────────────────────────────────────────────────────

	test("负责人能力面：有项目执行工具与接报工具，但没有任何公司级动作", async () => {
		const { runtime, project } = await fixture();
		const agent = await agentOf(runtime, project.leader);
		const names = (agentTools(agent)).map((tool) => tool.name);

		// 「项目全部权限」= 读写项目文件 + 在项目目录跑命令 + 推进项目状态。
		for (const required of [
			"read",
			"write",
			"edit",
			"bash",
			"pending_list",
			"answer_pending",
			"project_status",
			"my_capabilities",
		]) {
			expect(names, `负责人应具备 ${required}`).toContain(required);
		}
		// 负责人必须能用同一份工作目录，否则 read/write 落在别处。
		expect(agent?.cwd).toBe(project.workspace);

		// 越权面：公司级动作一个都不能有（工具不在即无权限，ADR-004）。
		for (const forbidden of [
			"staff_hire",
			"project_create",
			"project_terminate",
			"project_delete",
			"staff_archive",
		]) {
			expect(names, `负责人不得有 ${forbidden}`).not.toContain(forbidden);
		}
	});

	// ── 7. 终止回收 ────────────────────────────────────────────────────────────

	test("终止回收：负责人换成只读能力包，重启修复也不会把执行权限还回去", async () => {
		const { ctx, runtime, boot, project, registry } = await fixture();
		await hireStaff(runtime, { project: PROJECT, name: "log-ops", role: "运营", registry }, BACKGROUND_CONTEXT);

		const terminated = await terminateProject(
			runtime,
			{
				project: PROJECT,
				reason: "验收：终止后权限回收",
				by: "CEO",
				fromConversationId: boot.ownerConversationId,
			},
			BACKGROUND_CONTEXT,
		);
		expect(terminated.ok).toBe(true);

		const after = await agentOf(runtime, project.leader);
		expect((after?.extensions ?? []).map((extension) => extension.name)).toEqual(["role-leader-readonly"]);
		const readableTools = (after?.tools ?? []).map((tool) => tool.name);
		for (const revoked of ["read", "write", "edit", "bash", "staff_assign"]) {
			expect(readableTools, `终止后不得再有 ${revoked}`).not.toContain(revoked);
		}

		// 模拟重启：装配层会再跑一次 repairLeaderAgents。按 project.status 选包，
		// 必须继续选只读版，不能把执行权限「修」回来。
		const taskset = createManagementTools({ runtime, workspaceRoot: join(ctx.dir, "projects") });
		await repairLeaderAgents(runtime, { taskset }, BACKGROUND_CONTEXT);

		const afterRepair = await agentOf(runtime, project.leader);
		expect((afterRepair?.extensions ?? []).map((extension) => extension.name)).toEqual(["role-leader-readonly"]);
		const repairedTools = (afterRepair?.tools ?? []).map((tool) => tool.name);
		for (const revoked of ["read", "write", "edit", "bash", "staff_assign"]) {
			expect(repairedTools, `重启修复后不得恢复 ${revoked}`).not.toContain(revoked);
		}
	});

	// ── 8. 上报路由 ────────────────────────────────────────────────────────────

	test("上报路由：员工上报落在负责人这一级，不经过 COO/CTO/CEO，且只有负责人能拍板", async () => {
		const { runtime, boot, project, registry, escalationTask } = await fixture();
		const employee = await hireStaff(
			runtime,
			{ project: PROJECT, name: "log-ops", role: "运营", registry },
			BACKGROUND_CONTEXT,
		);

		// 员工的上报工具按 staff.manager 决定目标；这里直接把同一份 manager 引用交给升级链。
		expect(employee.staff.manager).toBe(LEADER_REF);

		const taskId = await startEscalation(
			runtime,
			escalationTask,
			{
				question: "日志轮转策略谁定？",
				from: "员工",
				fromConversationId: employee.conversationId,
				manager: employee.staff.manager,
				escalationKey: "accept-route",
			},
			BACKGROUND_CONTEXT,
		);

		await eventually(
			async () => (await listPending(runtime, BACKGROUND_CONTEXT)).some((item) => item.key === "accept-route"),
			{ label: "负责人级待办出现" },
		);
		const mine = (await listPending(runtime, BACKGROUND_CONTEXT)).filter((item) => item.key === "accept-route");
		expect(mine).toHaveLength(1);
		expect(mine[0]?.level).toBe(LEADER_REF);
		expect(mine[0]?.fromConversationId).toBe(employee.conversationId);

		// CEO 不能替负责人拍板（层级守卫），否则「只有负责人能定」是假的。
		expect(
			await answerPending(
				runtime,
				{ key: "accept-route", answer: "CEO 代答", answeredBy: "ceo", level: "ceo" },
				BACKGROUND_CONTEXT,
			),
		).toBe(false);

		// 负责人按自己这一级答复，流程收口在负责人，不往上走。
		const answered = await answerPending(
			runtime,
			{
				key: "accept-route",
				answer: "按 50MB 轮转，保留 7 份。",
				level: LEADER_REF,
				answeredBy: LEADER_NAME,
			},
			BACKGROUND_CONTEXT,
		);
		expect(answered).toBe(true);

		const result = await waitEscalation(runtime, taskId, BACKGROUND_CONTEXT);
		expect(result?.decidedBy).toBe(LEADER_NAME);
		expect(result?.path[0]).toBe("员工");
		expect(result?.path).toContain(LEADER_REF);
		for (const banned of ["ceo", "cto", "coo", "owner"]) {
			expect(result?.path, `路径不得经过 ${banned}`).not.toContain(banned);
		}
		void boot;
		void project;
	});

	// ── 9. 迁移 ────────────────────────────────────────────────────────────────

	test("迁移：旧岗位上级迁到负责人，第二次 0 变更，dryRun 不写库", async () => {
		const { runtime, registry } = await fixture();
		// 复刻改造前的旧库：上级还是管理层岗位枚举。
		await hireStaff(
			runtime,
			{ project: PROJECT, name: "log-ops", role: "运营", manager: "coo", registry },
			BACKGROUND_CONTEXT,
		);
		await hireStaff(
			runtime,
			{ project: PROJECT, name: "backend-fix", role: "开发", manager: "cto", registry },
			BACKGROUND_CONTEXT,
		);

		const first = await migrateStaffManagers(runtime, { project: PROJECT }, BACKGROUND_CONTEXT);
		expect(first.migrated).toBe(2);
		const stateAfter = await company(runtime);
		for (const key of [`${PROJECT}/log-ops`, `${PROJECT}/backend-fix`]) {
			expect(stateAfter.staff[key]?.manager).toBe(LEADER_REF);
			expect(managerLabelOf(stateAfter, stateAfter.staff[key]!.manager)).toBe(LEADER_NAME);
		}

		// 幂等：再跑一次不写库。
		const second = await migrateStaffManagers(runtime, { project: PROJECT }, BACKGROUND_CONTEXT);
		expect(second.migrated).toBe(0);
		expect(await company(runtime)).toEqual(stateAfter);

		// dryRun 在另一份副本（独立临时库）上：只报告，不改 manager。
		const other = await fixture();
		await hireStaff(
			other.runtime,
			{ project: PROJECT, name: "log-ops", role: "运营", manager: "coo", registry: other.registry },
			BACKGROUND_CONTEXT,
		);
		const dry = await migrateStaffManagers(other.runtime, { project: PROJECT, dryRun: true }, BACKGROUND_CONTEXT);
		expect(dry.migrated).toBe(0);
		expect(dry.skipped).toBe(1);
		expect((await company(other.runtime)).staff[`${PROJECT}/log-ops`]?.manager).toBe("coo");
	});

	// ── 10. 员工上报能力 ───────────────────────────────────────────────────────

	test("员工上报能力：按声明裁剪后仍保留 escalate，只给 read 就拿不到写/执行", async () => {
		const { runtime, registry } = await fixture();
		await hireStaff(
			runtime,
			{ project: PROJECT, name: "log-ops", role: "运营", tools: ["read"], registry },
			BACKGROUND_CONTEXT,
		);

		const names = employeeToolsFor(runtime, ["read"]).map((tool) => tool.name);
		expect(names, "运营必须能把问题报给负责人").toContain("escalate");
		expect(names, "员工必须能自查真实能力，而不是凭记忆").toContain("my_capabilities");
		expect(names).toContain("read");
		// 能力最小化没有被松开：运营仍然不能写文件、不能执行命令。
		expect(names).not.toContain("write");
		expect(names).not.toContain("bash");
	});

	// ── 11. 能力自查 ───────────────────────────────────────────────────────────

	test("能力自查：my_capabilities 返回真实工具清单，可用于回答「能不能」", async () => {
		const { runtime, project } = await fixture();
		const agent = await agentOf(runtime, project.leader);
		const tool = (agentTools(agent)).find((entry) => entry.name === "my_capabilities");
		expect(tool, "负责人必须有 my_capabilities").toBeDefined();

		const result = await tool!.execute({}, { conversationId: project.leader } as never, BACKGROUND_CONTEXT);
		const output = result.output.map((part) => (part.type === "text" ? part.text : "")).join("");

		// 回答「能不能写代码/执行命令」所需的事实必须能从工具结果里直接读到。
		for (const name of ["read", "write", "edit", "bash", "my_capabilities"]) {
			expect(output, `工具清单应包含 ${name}`).toContain(name);
		}
		expect(output).toContain(project.workspace);
	});
});
