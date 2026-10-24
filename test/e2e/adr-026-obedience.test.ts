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
	test("CTO 正忙时，CEO 转交给 CTO 必须被受理而不是返回『本次转交未执行』", async () => {
		const { ctx, runtime, ceoId, ctoId } = await setup();

		const tools = createManagementTools({ runtime });
		const delegateToRole = tools.delegateToRole;

		// 先让 CTO 忙起来：一个慢活占住它的会话
		const ctoConversation = await runtime.harness.conversation(ctoId as never, BACKGROUND_CONTEXT);
		ctx.faux.setResponses([slowAnswer(600, "慢活"), answer("转交的活")]);
		void ctoConversation?.submit({ type: "input", content: "先干这个慢活" }, BACKGROUND_CONTEXT);
		await new Promise((resolve) => setTimeout(resolve, 100));

		// 断言：transcripts 里不得出现抗命文案
		const result = await delegateToRole.execute(
			{ role: "cto", task: "帮我看个技术选型", fromConversationId: ceoId },
			BACKGROUND_CONTEXT,
		);
		const text_ = typeof result === "string" ? result : JSON.stringify(result);

		// ADR-026 落地第一步的核心断言
		expect(text_).not.toContain("本次转交未执行");
		expect(text_).not.toMatch(/正在忙.*未执行/);
	}, 20_000);

	test("负责人正忙时，管理层下达不得返回『本次下达未执行』", async () => {
		const { ctx, runtime, ceoId } = await setup();

		const tools = createManagementTools({ runtime });
		const delegateToLeader = tools.delegateToLeader;

		// 让项目负责人忙：给它派一个慢活
		const { readCompany } = await import("../../src/company/org.ts");
		const company = await readCompany(runtime, BACKGROUND_CONTEXT);
		const leaderId = company?.projects?.alpha?.leader;
		expect(leaderId, "alpha 必须已有负责人").toBeDefined();

		const leaderConversation = await runtime.harness.conversation(leaderId as never, BACKGROUND_CONTEXT);
		ctx.faux.setResponses([slowAnswer(600, "慢活"), answer("下达的活")]);
		void leaderConversation?.submit({ type: "input", content: "先干这个慢活" }, BACKGROUND_CONTEXT);
		await new Promise((resolve) => setTimeout(resolve, 100));

		const result = await delegateToLeader.execute(
			{ project: "alpha", task: "推进一下首期交付", fromConversationId: ceoId },
			BACKGROUND_CONTEXT,
		);
		const text_ = typeof result === "string" ? result : JSON.stringify(result);

		expect(text_).not.toContain("本次下达未执行");
		expect(text_).not.toMatch(/正在忙.*未执行/);
	}, 20_000);
});
