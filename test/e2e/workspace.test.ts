/**
 * project-workspace 的端到端测试。
 *
 * 覆盖 specs/project-workspace/spec.md：目录创建、立项文档、文件操作隔离、项目互不干扰。
 */
import { afterEach, describe, expect, test } from "vitest";
import { chmod, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createRegistry, openCompany, recover, type CompanyRuntime } from "../../src/runtime/index.ts";
import { bootstrapCompany, createProject, hireStaff, readCompany } from "../../src/company/org.ts";
import { projectSlug } from "../../src/runtime/ids.ts";
import { createTestContext, type TestContext, TEST_MODEL_CATALOG } from "../support.ts";

/** 在环境里跑一条 shell 命令；失败时抛错。 */
async function runShell(env: { exec: Function } | undefined, command: string): Promise<void> {
	expect(env, "执行环境应存在").toBeDefined();
	const result = await env?.exec(command, undefined, BACKGROUND_CONTEXT);
	expect(result?.ok, `命令失败：${command} ${JSON.stringify(result)}`).toBe(true);
}

let contexts: TestContext[] = [];
let runtimes: CompanyRuntime[] = [];

async function setup(): Promise<{ ctx: TestContext; runtime: CompanyRuntime; registry: ReturnType<typeof createRegistry> }> {
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
			modelCatalog: [...TEST_MODEL_CATALOG], companyName: "测试公司", registry, workspaceRoot: join(ctx.dir, "projects") },
		BACKGROUND_CONTEXT,
	);
	return { ctx, runtime, registry };
}

afterEach(async () => {
	for (const runtime of runtimes) await runtime.close().catch(() => undefined);
	for (const ctx of contexts) await ctx.cleanup();
	runtimes = [];
	contexts = [];
});

describe("立项时创建真实目录", () => {
	test("立项成功时目录存在并登记到索引", async () => {
		const { ctx, runtime } = await setup();
		const { project } = await createProject(
			runtime,
			{ name: "Tank Battle", brief: "网页坦克大战", workspaceRoot: join(ctx.dir, "projects") },
			BACKGROUND_CONTEXT,
		);

		expect((await stat(project.workspace)).isDirectory()).toBe(true);
		expect(project.workspace).toBe(join(ctx.dir, "projects", "tank-battle"));

		const state = await readCompany(runtime, BACKGROUND_CONTEXT);
		expect(state?.projects["tank-battle"]?.workspace).toBe(project.workspace);
	});

	test("目录已存在时复用而不失败", async () => {
		const { ctx, runtime } = await setup();
		const existing = join(ctx.dir, "projects", "alpha");
		await mkdir(existing, { recursive: true });
		await writeFile(join(existing, "旧文件.txt"), "保留", "utf8");

		const { project } = await createProject(
			runtime,
			{ name: "Alpha", brief: "测试", workspaceRoot: join(ctx.dir, "projects") },
			BACKGROUND_CONTEXT,
		);

		expect(project.workspace).toBe(existing);
		expect(await readFile(join(existing, "旧文件.txt"), "utf8")).toBe("保留");
	});

	test("目录无法创建时立项失败且索引无残留", async () => {
		const { ctx, runtime } = await setup();
		const blocked = join(ctx.dir, "readonly");
		await mkdir(blocked, { recursive: true });
		await chmod(blocked, 0o500);

		await expect(
			createProject(runtime, { name: "Beta", brief: "测试", workspaceRoot: blocked }, BACKGROUND_CONTEXT),
		).rejects.toBeDefined();

		const state = await readCompany(runtime, BACKGROUND_CONTEXT);
		expect(state?.projects["beta"], "失败的立项不得留下索引记录").toBeUndefined();

		await chmod(blocked, 0o700);
	});
});

describe("立项文档", () => {
	test("包含项目名称、需求摘要与验收标准三段", async () => {
		const { ctx, runtime } = await setup();
		const { project } = await createProject(
			runtime,
			{
				name: "Alpha",
				brief: "做一个能双人对战的坦克游戏",
				acceptance: "两人能同时操作，有胜负判定",
				workspaceRoot: join(ctx.dir, "projects"),
			},
			BACKGROUND_CONTEXT,
		);

		const content = await readFile(join(project.workspace, "PROJECT.md"), "utf8");
		expect(content).toContain("# Alpha");
		expect(content).toContain("## 需求摘要");
		expect(content).toContain("做一个能双人对战的坦克游戏");
		expect(content).toContain("## 验收标准");
		expect(content).toContain("两人能同时操作");
	});

	test("未给验收标准时给出待补充提示而非空段", async () => {
		const { ctx, runtime } = await setup();
		const { project } = await createProject(
			runtime,
			{ name: "Alpha", brief: "测试", workspaceRoot: join(ctx.dir, "projects") },
			BACKGROUND_CONTEXT,
		);

		const content = await readFile(join(project.workspace, "PROJECT.md"), "utf8");
		expect(content).toContain("## 验收标准");
		expect(content).toContain("待 CPO 补充");
	});

	test("更新立项文档时原有内容不被静默丢弃", async () => {
		const { ctx, runtime } = await setup();
		const { project } = await createProject(
			runtime,
			{ name: "Alpha", brief: "原始需求", workspaceRoot: join(ctx.dir, "projects") },
			BACKGROUND_CONTEXT,
		);

		const path = join(project.workspace, "PROJECT.md");
		const original = await readFile(path, "utf8");
		await writeFile(path, `${original}\n## 补充\n\n细化后的需求\n`, "utf8");

		const updated = await readFile(path, "utf8");
		expect(updated).toContain("原始需求");
		expect(updated).toContain("细化后的需求");
	});
});

describe("项目内文件操作限定在工作空间", () => {
	test("员工写文件落在项目目录", async () => {
		const { ctx, runtime } = await setup();
		const { project } = await createProject(
			runtime,
			{ name: "Alpha", brief: "测试", workspaceRoot: join(ctx.dir, "projects") },
			BACKGROUND_CONTEXT,
		);
		const hired = await hireStaff(
			runtime,
			{ project: "alpha", name: "dev-1", role: "开发", manager: "cto" },
			BACKGROUND_CONTEXT,
		);

		// 通过执行环境在员工会话的工作目录里写文件
		const env = await runtime.environments.factory(
			{ conversationId: hired.conversationId, cwd: project.workspace },
			BACKGROUND_CONTEXT,
		);
		expect(env).toBeDefined();
		await runShell(env, "printf 'hello' > index.html");

		expect(await readFile(join(project.workspace, "index.html"), "utf8")).toBe("hello");
	});

	test("未配置工作空间的会话得到未定义环境，不退化为进程当前目录", async () => {
		const { runtime } = await setup();
		const conversation = await runtime.harness.createConversation(
			{ ownership: { kind: "ownerless" } },
			BACKGROUND_CONTEXT,
		);

		const env = await runtime.environments.factory(
			{ conversationId: Number(conversation.id) },
			BACKGROUND_CONTEXT,
		);
		expect(env).toBeUndefined();
	});

	test("相对路径相对于项目工作空间解析", async () => {
		const { ctx, runtime } = await setup();
		const { project } = await createProject(
			runtime,
			{ name: "Alpha", brief: "测试", workspaceRoot: join(ctx.dir, "projects") },
			BACKGROUND_CONTEXT,
		);

		const env = await runtime.environments.factory(
			{ conversationId: project.leader, cwd: project.workspace },
			BACKGROUND_CONTEXT,
		);
		await runShell(env, "mkdir -p src && printf 'x' > src/main.js");

		expect((await stat(join(project.workspace, "src", "main.js"))).isFile()).toBe(true);
	});
});

describe("项目之间互不干扰", () => {
	test("两个项目的同名文件分别存在，修改互不影响", async () => {
		const { ctx, runtime } = await setup();
		const alpha = await createProject(
			runtime,
			{ name: "Alpha", brief: "A", workspaceRoot: join(ctx.dir, "projects") },
			BACKGROUND_CONTEXT,
		);
		const beta = await createProject(
			runtime,
			{ name: "Beta", brief: "B", workspaceRoot: join(ctx.dir, "projects") },
			BACKGROUND_CONTEXT,
		);

		const alphaEnv = await runtime.environments.factory(
			{ conversationId: alpha.project.leader, cwd: alpha.project.workspace },
			BACKGROUND_CONTEXT,
		);
		const betaEnv = await runtime.environments.factory(
			{ conversationId: beta.project.leader, cwd: beta.project.workspace },
			BACKGROUND_CONTEXT,
		);

		await runShell(alphaEnv, "printf 'alpha 的内容' > README.md");
		await runShell(betaEnv, "printf 'beta 的内容' > README.md");

		expect(await readFile(join(alpha.project.workspace, "README.md"), "utf8")).toBe("alpha 的内容");
		expect(await readFile(join(beta.project.workspace, "README.md"), "utf8")).toBe("beta 的内容");
	});

	test("项目标识规范化为小写字母数字与连字符", async () => {
		const { ctx, runtime } = await setup();
		const { project } = await createProject(
			runtime,
			{ name: "My Cool Project!", brief: "测试", workspaceRoot: join(ctx.dir, "projects") },
			BACKGROUND_CONTEXT,
		);

		expect(project.slug).toMatch(/^[a-z0-9-]+$/);
		expect(project.slug).toBe("my-cool-project");
	});

	test("纯中文项目名配显式英文 slug：显示名保留中文，目录用英文", async () => {
		const { ctx, runtime } = await setup();
		const { project } = await createProject(
			runtime,
			{
				name: "坦克大战",
				slug: "tank-battle",
				brief: "网页坦克大战",
				workspaceRoot: join(ctx.dir, "projects"),
			},
			BACKGROUND_CONTEXT,
		);

		expect(project.name, "显示名保留中文").toBe("坦克大战");
		expect(project.slug, "目录标识是英文").toBe("tank-battle");
		expect(project.workspace.endsWith("/tank-battle")).toBe(true);

		const content = await readFile(join(project.workspace, "PROJECT.md"), "utf8");
		expect(content, "立项文档用中文显示名").toContain("# 坦克大战");
	});

	test("纯中文项目名且未给 slug 时报错并说明怎么修", () => {
		expect(() => projectSlug("坦克大战")).toThrow(/英文 slug/);
	});

	test("中文与英文混合名可推导出英文标识", () => {
		expect(projectSlug("坦克大战 Tank Battle")).toBe("tank-battle");
	});
});
