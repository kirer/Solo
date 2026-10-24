/**
 * 员工改名的验收。
 *
 * 改名不是「改个显示字段」：员工名同时是名册键、能力包名与档案标题的一部分。
 * 只改名册不改能力包，员工下一轮会「没有任何工具」——这是最容易回归的一处，
 * 所以这里逐个断言：
 * - 数据层：`staff` 键从 `${project}/${old}` 换成 `${project}/${new}`，其余字段不动；
 * - 档案层：`/api/profile` 的 label 变新名字，工具清单仍在；
 * - 能力层：员工会话选中的能力包名跟着变，工具没丢；
 * - 装配层：CHRO 能力包真的带上了 `staff_rename`，员工能力包没有；
 * - 审计层：`staff-rename` 事件落盘，旧名 → 新名可追溯；
 * - 校验层：重名、非法字符、空名、归档员工、同名幂等都有明确结论。
 *
 * 全部使用 faux provider 与临时 SQLite：**不发真实模型请求、不碰 workspace/company.sqlite**。
 */
import { afterEach, describe, expect, test } from "vitest";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createRegistry, openCompany, recover, type CompanyRuntime } from "../../src/runtime/index.ts";
import {
	archiveStaff,
	bootstrapCompany,
	createProject,
	hireStaff,
	readCompany,
	renameStaff,
} from "../../src/company/org.ts";
import { AuditDoc, type CompanyState } from "../../src/company/docs.ts";
import { createManagementTools } from "../../src/company/management-tools.ts";
import { capabilitiesOf, createEmployeeExtension, createRoleExtensionWithTools } from "../../src/company/tools.ts";
import { readProfile } from "../../src/server/profile.ts";
import { createTestContext, type TestContext, TEST_MODEL_CATALOG } from "../support.ts";

const PROJECT = "ops-defect-loop";
const LEADER_NAME = "许砚舟";
const OLD_NAME = "log-ops";
const NEW_NAME = "林知远";

let contexts: TestContext[] = [];
let runtimes: CompanyRuntime[] = [];

afterEach(async () => {
	for (const runtime of runtimes) await runtime.close().catch(() => undefined);
	for (const ctx of contexts) await ctx.cleanup();
	runtimes = [];
	contexts = [];
});

/** 建一个隔离的测试公司。 */
async function fixture() {
	const ctx = await createTestContext();
	contexts.push(ctx);
	const registry = createRegistry();
	const runtime = await openCompany(
		{ databasePath: ctx.databasePath, models: ctx.models, registry },
		BACKGROUND_CONTEXT,
	);
	runtimes.push(runtime);
	await recover(runtime, BACKGROUND_CONTEXT);

	const boot = await bootstrapCompany(
		runtime,
		{
			modelCatalog: [...TEST_MODEL_CATALOG],
			companyName: "测试公司",
			registry,
			workspaceRoot: join(ctx.dir, "projects"),
		},
		BACKGROUND_CONTEXT,
	);

	const { project } = await createProject(
		runtime,
		{
			name: "系统持续运维与缺陷治理",
			slug: PROJECT,
			brief: "验收夹具：员工改名",
			leaderName: LEADER_NAME,
			workspaceRoot: join(ctx.dir, "projects"),
		},
		BACKGROUND_CONTEXT,
	);

	return { ctx, runtime, registry, boot, project };
}

async function company(runtime: CompanyRuntime): Promise<CompanyState> {
	const state = await readCompany(runtime, BACKGROUND_CONTEXT);
	if (state === undefined) throw new Error("公司尚未初始化");
	return state;
}

async function agentOf(runtime: CompanyRuntime, conversationId: number) {
	const conversation = await runtime.harness.conversation(conversationId as never, BACKGROUND_CONTEXT);
	return conversation?.agent(BACKGROUND_CONTEXT);
}

describe("员工改名", () => {
	test("名册键、档案标题、员工显示名一起改，旧键消失、其余字段不变", async () => {
		const { runtime, registry, boot } = await fixture();
		const hired = await hireStaff(
			runtime,
			{ project: PROJECT, name: OLD_NAME, role: "运营", registry },
			BACKGROUND_CONTEXT,
		);

		const result = await renameStaff(
			runtime,
			{
				project: PROJECT,
				name: OLD_NAME,
				newName: NEW_NAME,
				by: "CHRO",
				fromConversationId: boot.roleConversations.chro,
				registry,
			},
			BACKGROUND_CONTEXT,
		);
		expect(result.ok, result.message).toBe(true);

		const state = await company(runtime);
		expect(state.staff[`${PROJECT}/${OLD_NAME}`]).toBeUndefined();

		const person = state.staff[`${PROJECT}/${NEW_NAME}`];
		expect(person?.name).toBe(NEW_NAME);
		// 身份不随改名变化：会话、上级、角色、模型、入职时间都保留
		expect(person?.conversationId).toBe(hired.conversationId);
		expect(person?.manager).toBe(`leader:${PROJECT}`);
		expect(person?.role).toBe("运营");
		expect(person?.hiredAt).toBe(hired.staff.hiredAt);
		expect(person?.archived).toBe(false);

		// 职工档案：显示名跟着变，上级仍解析到负责人
		const profile = await readProfile(runtime, hired.conversationId, BACKGROUND_CONTEXT);
		if (!("profile" in profile)) throw new Error(profile.error);
		expect(profile.profile.label).toBe(NEW_NAME);
		expect(profile.profile.parent).toBe(LEADER_NAME);
		expect(profile.profile.kind).toBe("staff");
	});

	test("能力包跟着改名重建：会话选中新名字的能力包，工具没丢", async () => {
		const { runtime, registry, boot } = await fixture();
		const hired = await hireStaff(
			runtime,
			{ project: PROJECT, name: OLD_NAME, role: "开发", registry },
			BACKGROUND_CONTEXT,
		);

		const before = await agentOf(runtime, hired.conversationId);
		expect(before?.tools.length ?? 0).toBeGreaterThan(0);

		await renameStaff(
			runtime,
			{
				project: PROJECT,
				name: OLD_NAME,
				newName: NEW_NAME,
				by: "CHRO",
				fromConversationId: boot.roleConversations.chro,
				registry,
			},
			BACKGROUND_CONTEXT,
		);

		const after = await agentOf(runtime, hired.conversationId);
		// 关键回归点：只改名册会让能力包按旧名字解析不到 → 工具全空
		expect(after?.tools.map((tool) => tool.name)).toEqual(before?.tools.map((tool) => tool.name));
		expect(after?.extensions.map((extension) => extension.name)).toEqual([
			`role-employee:${PROJECT}/${NEW_NAME}`,
		]);
		// 改名后仍按角色拿到执行工具
		expect(after?.tools.map((tool) => tool.name)).toContain("bash");
	});

	test("审计留痕：staff-rename 事件记录旧名 → 新名", async () => {
		const { runtime, registry, boot } = await fixture();
		await hireStaff(runtime, { project: PROJECT, name: OLD_NAME, role: "运营", registry }, BACKGROUND_CONTEXT);

		await renameStaff(
			runtime,
			{
				project: PROJECT,
				name: OLD_NAME,
				newName: NEW_NAME,
				by: "CHRO",
				fromConversationId: boot.roleConversations.chro,
				registry,
			},
			BACKGROUND_CONTEXT,
		);

		const audit = await runtime.harness.snapshot(
			AuditDoc,
			boot.roleConversations.chro as never,
			BACKGROUND_CONTEXT,
		);
		const event = audit?.events.find((item) => item.type === "staff-rename");
		expect(event?.from).toBe(OLD_NAME);
		expect(event?.to).toBe(NEW_NAME);
		expect(event?.ref).toBe(`staff:${PROJECT}/${NEW_NAME}`);
	});

	test("重名拒绝：新名字已被项目内其他员工占用（含已归档）", async () => {
		const { runtime, registry, boot } = await fixture();
		await hireStaff(runtime, { project: PROJECT, name: OLD_NAME, role: "运营", registry }, BACKGROUND_CONTEXT);
		await hireStaff(runtime, { project: PROJECT, name: "backend-fix", role: "开发", registry }, BACKGROUND_CONTEXT);

		const clash = await renameStaff(
			runtime,
			{
				project: PROJECT,
				name: OLD_NAME,
				newName: "backend-fix",
				by: "CHRO",
				fromConversationId: boot.roleConversations.chro,
				registry,
			},
			BACKGROUND_CONTEXT,
		);
		expect(clash.ok).toBe(false);
		expect(clash.message).toContain("已经有叫");

		// 归档员工的名字也不复活：名册键仍被历史记录占着
		await archiveStaff(runtime, PROJECT, "backend-fix", BACKGROUND_CONTEXT);
		const archivedClash = await renameStaff(
			runtime,
			{
				project: PROJECT,
				name: OLD_NAME,
				newName: "backend-fix",
				by: "CHRO",
				fromConversationId: boot.roleConversations.chro,
				registry,
			},
			BACKGROUND_CONTEXT,
		);
		expect(archivedClash.ok).toBe(false);
	});

	test("非法输入拒绝：空名、带斜杠、带空白、超长", async () => {
		const { runtime, registry, boot } = await fixture();
		await hireStaff(runtime, { project: PROJECT, name: OLD_NAME, role: "运营", registry }, BACKGROUND_CONTEXT);

		for (const newName of ["", "  ", "a/b", "林 知远", "x".repeat(33)]) {
			const result = await renameStaff(
				runtime,
				{
					project: PROJECT,
					name: OLD_NAME,
					newName,
					by: "CHRO",
					fromConversationId: boot.roleConversations.chro,
					registry,
				},
				BACKGROUND_CONTEXT,
			);
			expect(result.ok, `「${newName}」不该被接受`).toBe(false);
		}

		// 员工还在，键没被破坏
		const state = await company(runtime);
		expect(state.staff[`${PROJECT}/${OLD_NAME}`]?.name).toBe(OLD_NAME);
	});

	test("同名幂等 + 已归档员工不能改名 + 不存在的员工有明确提示", async () => {
		const { runtime, registry, boot } = await fixture();
		await hireStaff(runtime, { project: PROJECT, name: OLD_NAME, role: "运营", registry }, BACKGROUND_CONTEXT);

		const same = await renameStaff(
			runtime,
			{
				project: PROJECT,
				name: OLD_NAME,
				newName: OLD_NAME,
				by: "CHRO",
				fromConversationId: boot.roleConversations.chro,
				registry,
			},
			BACKGROUND_CONTEXT,
		);
		expect(same.ok).toBe(true);
		expect(same.message).toContain("未做改动");

		const missing = await renameStaff(
			runtime,
			{
				project: PROJECT,
				name: "nobody",
				newName: "林知远",
				by: "CHRO",
				fromConversationId: boot.roleConversations.chro,
				registry,
			},
			BACKGROUND_CONTEXT,
		);
		expect(missing.ok).toBe(false);
		expect(missing.message).toContain("没有名为");

		await archiveStaff(runtime, PROJECT, OLD_NAME, BACKGROUND_CONTEXT);
		const archived = await renameStaff(
			runtime,
			{
				project: PROJECT,
				name: OLD_NAME,
				newName: NEW_NAME,
				by: "CHRO",
				fromConversationId: boot.roleConversations.chro,
				registry,
			},
			BACKGROUND_CONTEXT,
		);
		expect(archived.ok).toBe(false);
		expect(archived.message).toContain("已归档");
	});

	test("装配层：CHRO 能力包带 staff_rename，员工能力包不带", async () => {
		const { runtime, ctx } = await fixture();
		expect(capabilitiesOf("chro")).toContain("staff_rename");

		const tools = createManagementTools({ runtime, workspaceRoot: join(ctx.dir, "projects") });
		const chroExtension = createRoleExtensionWithTools("chro", tools);
		expect(chroExtension.tools?.map((tool) => tool.name)).toContain("staff_rename");

		// 权限最小化：员工拿不到管理类工具（ADR-004：权限 = 工具在不在）
		const employeeExtension = createEmployeeExtension(`${PROJECT}/${OLD_NAME}`, []);
		expect(employeeExtension.tools ?? []).toHaveLength(0);
	});
});
