/**
 * 动态创建能力：招聘时显式声明 tools / duty，能力不再按角色名推断。
 *
 * 真实事故（记录在 docs/roundtable/VERDICT.md 裁决 B1）：`staff_hire` 的 `role`
 * 是自由字符串，而能力来自 `STAFF_TOOLSETS[role] ?? DEFAULT_TOOLSET`
 * （`src/company/staff-tools.ts`）。于是「前端」「backend」「Rust工程师」
 * 全部静默落进「只读」默认值——老板招到一个不能写文件的开发，
 * 不报错、不打日志，要等任务卡住才发现。
 *
 * 这里的断言不锁定「唯一的修法」，只锁定结论：**任意角色名都不许静默退化**。
 */
import { afterEach, describe, expect, test } from "vitest";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createRegistry, openCompany, recover, type CompanyRuntime } from "../../src/runtime/index.ts";
import { bootstrapCompany, createProject, employeeToolsFor, hireStaff, readCompany } from "../../src/company/org.ts";
import { createManagementTools } from "../../src/company/management-tools.ts";
import { assertGrantableTools, assertToolsRequested, toolsForNames } from "../../src/company/staff-tools.ts";
import { readProfile } from "../../src/server/profile.ts";
import { allToolNames, createTestContext, type TestContext, TEST_MODEL_CATALOG } from "./../support.ts";

let contexts: TestContext[] = [];
let runtimes: CompanyRuntime[] = [];

afterEach(async () => {
	for (const runtime of runtimes) await runtime.close().catch(() => undefined);
	for (const ctx of contexts) await ctx.cleanup();
	runtimes = [];
	contexts = [];
});

/** 员工永远自带、不属于 `tools` 参数的工具（与 staff_hire 的 description 一一对应）。 */
const UNIVERSAL = new Set([
	"whoami",
	"say",
	"ask",
	"read_channel",
	"inbox",
	"task_list",
	"task_update",
	"memory_search",
	"memory_write",
]);
/** 员工专属的额外能力：上报 + 自查（由 `employeeToolsFor` 追加，不由 tools 控制）。 */
const EXTRA = new Set(["escalate", "my_capabilities"]);

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
	await bootstrapCompany(
		runtime,
		{
			modelCatalog: [...TEST_MODEL_CATALOG],
			companyName: "招聘能力测试公司",
			registry,
			workspaceRoot: join(ctx.dir, "projects"),
			watchdog: false,
		},
		BACKGROUND_CONTEXT,
	);
	await createProject(
		runtime,
		{ name: "Alpha", slug: "alpha", brief: "测试", workspaceRoot: join(ctx.dir, "projects") },
		BACKGROUND_CONTEXT,
	);
	const tools = createManagementTools({
		runtime,
		workspaceRoot: join(ctx.dir, "projects"),
		registry,
	});
	return { ctx, runtime, registry, staffHire: tools.staffHire };
}

/** 某会话真正装配到的执行工具名（去掉通用与额外能力，也去掉按需加载的检索器）。 */
async function executionToolNames(runtime: CompanyRuntime, conversationId: number): Promise<string[]> {
	const conversation = await runtime.harness.conversation(conversationId as never, BACKGROUND_CONTEXT);
	return allToolNames(await conversation?.agent(BACKGROUND_CONTEXT)).filter(
		(name) => !UNIVERSAL.has(name) && !EXTRA.has(name) && name !== "tool_search",
	);
}

async function conversationIdOf(runtime: CompanyRuntime, project: string, name: string): Promise<number> {
	const state = await readCompany(runtime, BACKGROUND_CONTEXT);
	const person = state?.staff[`${project}/${name}`];
	if (person === undefined) throw new Error(`名册里没有 ${project}/${name}`);
	return person.conversationId;
}

describe("回归：任意角色名都不许静默退化成只读员工", () => {
	test("「前端」这类目录里没有的角色：要么拿到写工具，要么招聘入口显式报错", async () => {
		const { runtime, staffHire } = await setup();

		// ① 写明 tools 时，能力必须来自 tools，而不是角色名。
		const result = await staffHire.execute(
			{ project: "alpha", name: "front-1", role: "前端", tools: ["read", "write", "edit"], duty: "写页面。" },
			{ conversationId: 1 } as never,
			BACKGROUND_CONTEXT,
		);
		const text = JSON.stringify(result);
		expect(text, "「前端」不该被拒绝：它写明了要什么工具").toContain("已招聘");

		const names = await executionToolNames(runtime, await conversationIdOf(runtime, "alpha", "front-1"));
		// 这就是 bug 的判定线：以前这里是 ["read"]（静默只读），不报错、不打日志。
		expect(names, "「前端」拿到了写/改工具，不是只读").toEqual(["read", "write", "edit"]);
		expect(names, "不满足『静默返回只读工具集』").not.toEqual(["read"]);
	});

	test("不写 tools 时招聘入口显式报错，绝不猜一个默认能力集", async () => {
		const { runtime, staffHire } = await setup();
		const result = await staffHire.execute(
			{ project: "alpha", name: "front-2", role: "前端", tools: [], duty: "写页面。" },
			{ conversationId: 1 } as never,
			BACKGROUND_CONTEXT,
		);
		const text = JSON.stringify(result);
		expect(text).toContain("未指定 tools");
		expect(text).toContain("my_capabilities");
		const state = await readCompany(runtime, BACKGROUND_CONTEXT);
		expect(state?.staff["alpha/front-2"], "报错时不该留下半个员工").toBeUndefined();
	});
});

describe("staff_hire 的 tools 校验", () => {
	test("非法工具名 → 抛错，且错误文案含该工具名", async () => {
		const { staffHire } = await setup();
		const result = await staffHire.execute(
			{ project: "alpha", name: "dev-1", role: "开发", tools: ["read", "runn"], duty: "写代码。" },
			{ conversationId: 1 } as never,
			BACKGROUND_CONTEXT,
		);
		const text = JSON.stringify(result);
		expect(text).toContain("runn");
		expect(text).toContain("可授予的原子工具");
		// 同一个校验在纯函数层也拦得住（测试与工具走同一条路径）
		expect(() => toolsForNames(["read", "runn"])).toThrow(/runn/);
	});

	test("空 tools → 抛错", async () => {
		const { staffHire } = await setup();
		const result = await staffHire.execute(
			{ project: "alpha", name: "dev-1", role: "开发", tools: [], duty: "写代码。" },
			{ conversationId: 1 } as never,
			BACKGROUND_CONTEXT,
		);
		expect(JSON.stringify(result)).toContain("未指定 tools");
		expect(() => assertToolsRequested([])).toThrow(/未指定 tools/);
		expect(() => assertToolsRequested(undefined)).toThrow(/未指定 tools/);
	});

	test("合法 tools → 员工装配后的执行工具恰好是这些（不多不少）", async () => {
		const { runtime, registry, staffHire } = await setup();
		const result = await staffHire.execute(
			{ project: "alpha", name: "dev-1", role: "开发", tools: ["read", "write", "edit"], duty: "写代码。" },
			{ conversationId: 1 } as never,
			BACKGROUND_CONTEXT,
		);
		expect(JSON.stringify(result)).toContain("已招聘");
		expect(registry).toBeDefined();

		const conversationId = await conversationIdOf(runtime, "alpha", "dev-1");
		expect(await executionToolNames(runtime, conversationId)).toEqual(["read", "write", "edit"]);
		// 通用能力与上报能力照旧存在（tools 参数只管执行类工具）
		const conversation = await runtime.harness.conversation(conversationId as never, BACKGROUND_CONTEXT);
		const names = allToolNames(await conversation?.agent(BACKGROUND_CONTEXT));
		expect(names).toContain("escalate");
		expect(names).toContain("say");

		// 档案页要能显示上级写的职责
		const profile = await readProfile(runtime, conversationId, BACKGROUND_CONTEXT);
		expect("profile" in profile).toBe(true);
		if ("profile" in profile) {
			expect(profile.profile.duty).toBe("写代码。");
			expect(profile.profile.charter).toContain("写代码。");
			expect(profile.profile.charter).toContain("Alpha");
		}
	});

	test("超出权限的工具名（员工被授予 staff_hire 这类管理层工具）→ 抛错", async () => {
		const { staffHire } = await setup();
		for (const forbidden of ["staff_hire", "project_create", "take_over_pending"]) {
			const result = await staffHire.execute(
				{ project: "alpha", name: `x-${forbidden}`, role: "开发", tools: ["read", forbidden], duty: "…" },
				{ conversationId: 1 } as never,
				BACKGROUND_CONTEXT,
			);
			const text = JSON.stringify(result);
			expect(text, `${forbidden} 不该能被授予员工`).toContain(forbidden);
			expect(text).toContain("ADR-004");
			expect(() => assertGrantableTools([forbidden])).toThrow(/ADR-004/);
		}
	});

	test("hireStaff 收到同样的 tools 时，能力取自 tools 而不是 role", async () => {
		const { runtime, registry } = await setup();
		// role 写成「不存在的角色」，tools 写了 bash —— 以前会静默只读
		await hireStaff(
			runtime,
			{ project: "alpha", name: "ops-1", role: "不存在的角色", tools: ["read", "bash"], duty: "跑巡检。", registry },
			BACKGROUND_CONTEXT,
		);
		const names = await executionToolNames(runtime, await conversationIdOf(runtime, "alpha", "ops-1"));
		expect(names).toEqual(["read", "bash"]);
		expect(employeeToolsFor(runtime, ["read"]).map((tool) => tool.name)).toEqual([
			"read",
			"escalate",
			"my_capabilities",
		]);
	});
});
