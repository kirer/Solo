/**
 * ADR-026 验收：指令无条件受理。
 *
 * 老板的两条硬要求：
 * 1. 他发出的每条指令都必须被无条件受理，不许出现「正在忙，本次转交未执行」；
 * 2. 界面上不再出现「已排队 / 立即处理 / 插入」这类需要二次点击的提示。
 *
 * 本文件只覆盖落地第一步（不许抗命），第 2、3 步（处置与恢复、决策路由）
 * 按 ADR 要求后续再做——前两步没做，路由过去的决策也执行不了。
 */
import { afterEach, describe, expect, test } from "vitest";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createRegistry, openCompany, recover, type CompanyRuntime } from "../../src/runtime/index.ts";
import { bootstrapCompany, createProject, hireStaff } from "../../src/company/org.ts";
import { createManagementTools } from "../../src/company/management-tools.ts";
import { answer, createTestContext, slowAnswer, type TestContext, TEST_MODEL_CATALOG } from "../support.ts";

let contexts: TestContext[] = [];
let runtimes: CompanyRuntime[] = [];

async function setup(): Promise<{
	ctx: TestContext;
	runtime: CompanyRuntime;
	ceoId: number;
	ctoId: number;
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
	const boot = await bootstrapCompany(
		runtime,
		{
			modelCatalog: [...TEST_MODEL_CATALOG],
			companyName: "测试公司",
			registry,
			workspaceRoot: join(ctx.dir, "projects"),
			// 本文件只验协议，不需要看门狗插手调度
			watchdog: false,
		},
		BACKGROUND_CONTEXT,
	);
	await createProject(
		runtime,
		{ name: "Alpha", slug: "alpha", brief: "测试项目", workspaceRoot: join(ctx.dir, "projects") },
		BACKGROUND_CONTEXT,
	);
	await hireStaff(runtime, { project: "alpha", name: "dev-1", role: "开发", manager: "cto" }, BACKGROUND_CONTEXT);
	return { ctx, runtime, ceoId: boot.roleConversations.ceo, ctoId: boot.roleConversations.cto };
}

afterEach(async () => {
	for (const runtime of runtimes.splice(0)) await runtime.close?.();
	contexts = [];
});

describe("ADR-026：链上上级的指令不得被「正在忙」拒收", () => {
	/**
	 * 通信重构后，派活不再有「忙碌拒收」这个概念——因为**根本不等**。
	 * 这条测试保留原意（指令到达即生效），但断言换成新语义：
	 * 对方正忙时，派活工具仍然立刻成功返回。
	 */
	test("CTO 正忙时，CEO 派活给 CTO 仍然立刻成功（不拒收、不等待）", async () => {
		const { ctx, runtime, ceoId, ctoId } = await setup();

		const tools = createManagementTools({ runtime });
		const askRole = tools.askRole;

		// 先让 CTO 忙起来：一个慢活占住它的会话
		const ctoConversation = await runtime.harness.conversation(ctoId as never, BACKGROUND_CONTEXT);
		ctx.faux.setResponses([slowAnswer(600, "慢活"), answer("后来的活")]);
		void ctoConversation?.submit({ type: "input", content: "先干这个慢活" }, BACKGROUND_CONTEXT);
		await new Promise((resolve) => setTimeout(resolve, 100));

		const started = Date.now();
		const result = await askRole.execute(
			{ to: "CTO", text: "帮我看个技术选型" },
			{ conversationId: ceoId } as never,
			BACKGROUND_CONTEXT,
		);
		const elapsed = Date.now() - started;
		const body = typeof result === "string" ? result : JSON.stringify(result);

		// 核心断言：不拒收、不等待
		expect(body).not.toContain("本次转交未执行");
		expect(body).not.toMatch(/正在忙.*未执行/);
		expect(elapsed, `对方正忙时派活也必须立刻返回（实测 ${elapsed}ms）`).toBeLessThan(1500);
	}, 20_000);

	test("负责人正忙时，管理层派任务仍然立刻成功（不拒收、不等待）", async () => {
		const { ctx, runtime, ceoId } = await setup();

		const tools = createManagementTools({ runtime });
		const assignTask = tools.assignTask;

		// 让项目负责人忙：给它派一个慢活
		const { readCompany } = await import("../../src/company/org.ts");
		const company = await readCompany(runtime, BACKGROUND_CONTEXT);
		const leaderId = company?.projects?.alpha?.leader;
		expect(leaderId, "alpha 必须已有负责人").toBeDefined();

		const leaderConversation = await runtime.harness.conversation(leaderId as never, BACKGROUND_CONTEXT);
		ctx.faux.setResponses([slowAnswer(600, "慢活"), answer("下达的活")]);
		void leaderConversation?.submit({ type: "input", content: "先干这个慢活" }, BACKGROUND_CONTEXT);
		await new Promise((resolve) => setTimeout(resolve, 100));

		const started = Date.now();
		const result = await assignTask.execute(
			{
				assignee: "负责人",
				project: "alpha",
				title: "推进首期交付",
				acceptance: "首期功能在浏览器里能跑通，有验收记录",
			},
			{ conversationId: ceoId } as never,
			BACKGROUND_CONTEXT,
		);
		const elapsed = Date.now() - started;
		const body = typeof result === "string" ? result : JSON.stringify(result);

		expect(body).not.toContain("本次下达未执行");
		expect(body).not.toMatch(/正在忙.*未执行/);
		expect(elapsed, `负责人正忙时派任务也必须立刻返回（实测 ${elapsed}ms）`).toBeLessThan(1500);
	}, 20_000);
});
