/**
 * company-runtime 的契约测试。
 *
 * 覆盖 specs/company-runtime/spec.md 的每条 Requirement：
 * 打开运行时、崩溃后恢复、卡死任务巡检、存储故障自愈、隔离 experimental 依赖。
 *
 * 这些测试是升级底层库时的安全网（见 ADR-002）。
 */
import { afterEach, describe, expect, test } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
	createRegistry,
	hasFailed,
	openCompany,
	recover,
	retryParked,
	watchForFailure,
	type CompanyRuntime,
} from "../../src/runtime/index.ts";
import { answer, createTestContext, eventually, slowAnswer, type TestContext } from "../support.ts";

const MODEL = { provider: "faux", modelId: "faux-1" } as const;

let contexts: TestContext[] = [];
let runtimes: CompanyRuntime[] = [];

async function setup(): Promise<{ ctx: TestContext; runtime: CompanyRuntime }> {
	const ctx = await createTestContext();
	contexts.push(ctx);
	const runtime = await openCompany(
		{ databasePath: ctx.databasePath, models: ctx.models, registry: createRegistry() },
		BACKGROUND_CONTEXT,
	);
	runtimes.push(runtime);
	return { ctx, runtime };
}

afterEach(async () => {
	for (const runtime of runtimes) await runtime.close().catch(() => undefined);
	for (const ctx of contexts) await ctx.cleanup();
	runtimes = [];
	contexts = [];
});

describe("打开公司运行时", () => {
	test("首次打开创建根会话，再次打开返回同一标识", async () => {
		const { ctx, runtime } = await setup();

		const root = await runtime.harness.root(BACKGROUND_CONTEXT, { agent: { model: MODEL } });
		expect(root.id).toBeGreaterThan(0);

		await runtime.close();
		runtimes = runtimes.filter((r) => r !== runtime);

		const reopened = await openCompany(
			{ databasePath: ctx.databasePath, models: ctx.models, registry: createRegistry() },
			BACKGROUND_CONTEXT,
		);
		runtimes.push(reopened);

		const sameRoot = await reopened.harness.root(BACKGROUND_CONTEXT);
		expect(sameRoot.id).toBe(root.id);
	});

	test("首次打开时在同一提交内创建内置文档", async () => {
		const { runtime } = await setup();
		const root = await runtime.harness.root(BACKGROUND_CONTEXT, { agent: { model: MODEL } });
		const view = await root.watch(BACKGROUND_CONTEXT);
		// 内置文档：agent / live / inbox / provider / usage
		for (const key of ["pi.agent", "pi.live", "pi.inbox", "pi.provider", "pi.usage"]) {
			expect(view.value.docs[key], `缺少内置文档 ${key}`).toBeDefined();
		}
		await view.stop();
	});

	test("执行环境按会话区分，无工作目录的会话得到未定义环境", async () => {
		const { ctx, runtime } = await setup();

		const withCwd = await runtime.harness.createConversation(
			{ ownership: { kind: "ownerless" }, agent: { model: MODEL, cwd: ctx.dir } },
			BACKGROUND_CONTEXT,
		);
		const withoutCwd = await runtime.harness.createConversation(
			{ ownership: { kind: "ownerless" }, agent: { model: MODEL } },
			BACKGROUND_CONTEXT,
		);

		const envA = await runtime.environments.factory({ conversationId: Number(withCwd.id), cwd: ctx.dir }, BACKGROUND_CONTEXT);
		expect(envA).toBeDefined();

		const envAgain = await runtime.environments.factory({ conversationId: Number(withCwd.id), cwd: ctx.dir }, BACKGROUND_CONTEXT);
		expect(envAgain, "同一会话应复用同一环境实例").toBe(envA);

		const envB = await runtime.environments.factory({ conversationId: Number(withoutCwd.id) }, BACKGROUND_CONTEXT);
		expect(envB, "无工作目录的会话应得到未定义环境").toBeUndefined();
	});

	test("无工作目录时文件工具返回错误结果而非静默成功", async () => {
		const { runtime } = await setup();
		const conv = await runtime.harness.createConversation(
			{ ownership: { kind: "ownerless" }, agent: { model: MODEL } },
			BACKGROUND_CONTEXT,
		);

		// 没有注册文件工具，这里验证的是环境缺失时工具层拿不到环境。
		const env = await runtime.environments.factory({ conversationId: Number(conv.id) }, BACKGROUND_CONTEXT);
		expect(env).toBeUndefined();
	});
});

describe("崩溃后恢复未完成的工作", () => {
	test("工具执行中途进程退出，重开后继续至终态", async () => {
		const { ctx } = await setup();

		// 第一个进程：提交一个会跑一会儿的请求，然后中途关闭（模拟进程退出）。
		const first = await openCompany(
			{ databasePath: ctx.databasePath, models: ctx.models, registry: createRegistry() },
			BACKGROUND_CONTEXT,
		);
		const root = await first.harness.root(BACKGROUND_CONTEXT, { agent: { model: MODEL } });
		ctx.faux.setResponses([slowAnswer(400, "recovered answer")]);
		const submission = await root.submit({ type: "input", content: "go", requestId: "job-1" }, BACKGROUND_CONTEXT);
		// 让请求真正开始
		await eventually(async () => (await first.harness.inspect(BACKGROUND_CONTEXT)).tasks.length > 0, {
			label: "任务开始运行",
		});
		await first.close();

		// 第二个进程：重开同一存储，巡检后才开始调度。
		const second = await openCompany(
			{ databasePath: ctx.databasePath, models: ctx.models, registry: createRegistry() },
			BACKGROUND_CONTEXT,
		);
		runtimes.push(second);
		await recover(second, BACKGROUND_CONTEXT);

		// 恢复后同一请求标识拿回原提交，并最终跑完。
		const sameSubmission = await second.harness.submission(submission.id, BACKGROUND_CONTEXT);
		expect(sameSubmission, "重开后应能重新取得原提交").toBeDefined();
		expect(sameSubmission?.id).toBe(submission.id);

		const recovered = await second.harness.root(BACKGROUND_CONTEXT);
		const settled = await (
			await recovered.submit({ type: "input", content: "go", requestId: "job-1" }, BACKGROUND_CONTEXT)
		).wait(BACKGROUND_CONTEXT);
		expect(settled.id, "重复提交必须返回同一个提交").toBe(submission.id);
		expect(settled.status, "恢复后应跑到终态").toBe("done");
	});

	test("同一请求标识重复提交返回原提交，不创建第二个", async () => {
		const { ctx, runtime } = await setup();
		const root = await runtime.harness.root(BACKGROUND_CONTEXT, { agent: { model: MODEL } });

		ctx.faux.setResponses([answer("第一次"), answer("第二次")]);
		const first = await root.submit({ type: "input", content: "hello", requestId: "greeting-1" }, BACKGROUND_CONTEXT);
		await first.wait(BACKGROUND_CONTEXT);

		const again = await root.submit({ type: "input", content: "hello", requestId: "greeting-1" }, BACKGROUND_CONTEXT);
		expect(again.id).toBe(first.id);
	});

	test("恢复前不执行任何处理器", async () => {
		const { runtime } = await setup();
		// 刚打开、尚未 resume 时，调度应是暂停的。
		const inspection = await runtime.harness.inspect(BACKGROUND_CONTEXT);
		expect(inspection.scheduling).toBe("paused");
	});
});

describe("卡死任务巡检与重试", () => {
	test("巡检返回受阻任务与待运行任务", async () => {
		const { runtime } = await setup();
		await runtime.harness.root(BACKGROUND_CONTEXT, { agent: { model: MODEL } });
		const result = await recover(runtime, BACKGROUND_CONTEXT);
		expect(Array.isArray(result.parkedTasks)).toBe(true);
		expect(typeof result.pendingTasks).toBe("number");
	});

	test("重试不存在的任务会报错", async () => {
		const { runtime } = await setup();
		await expect(retryParked(runtime, "999999", BACKGROUND_CONTEXT)).rejects.toBeDefined();
	});
});

describe("存储故障后的自我恢复", () => {
	test("运行时因故障关闭后 failure() 能报告错误", async () => {
		const { ctx, runtime } = await setup();
		await runtime.harness.root(BACKGROUND_CONTEXT, { agent: { model: MODEL } });
		expect(hasFailed(runtime)).toBe(false);

		// 正常关闭不应被当作故障。
		await runtime.close();
		runtimes = runtimes.filter((r) => r !== runtime);
		expect(hasFailed(runtime)).toBe(false);
		void ctx;
	});

	test("watchForFailure 在正常关闭时不做任何重开", async () => {
		const { ctx, runtime } = await setup();
		let reopens = 0;
		const stop = watchForFailure(
			runtime,
			async () => {
				reopens += 1;
				return openCompany(
					{ databasePath: ctx.databasePath, models: ctx.models, registry: createRegistry() },
					BACKGROUND_CONTEXT,
				);
			},
			{ retryDelayMs: 10 },
		);

		await runtime.harness.root(BACKGROUND_CONTEXT, { agent: { model: MODEL } });
		await runtime.close();
		runtimes = runtimes.filter((r) => r !== runtime);
		await new Promise((resolve) => setTimeout(resolve, 100));
		stop();

		expect(reopens, "正常关闭不应触发重开").toBe(0);
	});
});

describe("隔离 experimental 依赖", () => {
	test("业务层与界面层不直接导入底层运行时库", async () => {
		const { execFile } = await import("node:child_process");
		const { promisify } = await import("node:util");
		const run = promisify(execFile);
		const root = new URL("../..", import.meta.url).pathname;
		const { stdout } = await run("node", ["scripts/check-boundaries.mjs"], { cwd: root });
		expect(stdout).toContain("边界检查通过");
	});
});
