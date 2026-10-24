/**
 * 真实模型的端到端测试（可选执行）。
 *
 * 只有在本地网关可用时才跑，否则跳过——CI 与离线环境不应因此失败。
 *
 * 验证的是「用真实模型时组织机制仍然成立」：模型真的调用工具、
 * 真的走完立项与配人，而不是只有 faux provider 下能跑。
 */
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createRegistry, openCompany, probeLocalGateway, recover, setupModels, type CompanyRuntime } from "../../src/runtime/index.ts";
import { bootstrapCompany, listStaff, readCompany } from "../../src/company/org.ts";
import { rollupAll } from "../../src/company/cost.ts";

const probe = await probeLocalGateway({ timeoutMs: 2_000 }).catch(() => ({ ok: false, detail: "不可用" }));

describe.skipIf(!probe.ok)("真实模型端到端", () => {
	let dir: string;
	let runtime: CompanyRuntime;
	let roleConversations: Record<string, number> = {};
	let workspaceRoot: string;

	beforeAll(async () => {
		dir = await mkdtemp(join(tmpdir(), "ai-company-real-"));
		workspaceRoot = join(dir, "projects");
		const { models, defaultModel, catalog } = setupModels();
		const registry = createRegistry();
		runtime = await openCompany({ databasePath: join(dir, "company.sqlite"), models, registry }, BACKGROUND_CONTEXT);
		await recover(runtime, BACKGROUND_CONTEXT);
		const boot = await bootstrapCompany(
			runtime,
			{ companyName: "一人公司", registry, workspaceRoot, defaultModel, modelCatalog: catalog },
			BACKGROUND_CONTEXT,
		);
		roleConversations = boot.roleConversations;
	}, 120_000);

	afterAll(async () => {
		await runtime?.close().catch(() => undefined);
		if (dir !== undefined) await rm(dir, { recursive: true, force: true });
	});

	test("CEO 用真实模型回答老板", async () => {
		const ceo = await runtime.harness.conversation(roleConversations.ceo as never, BACKGROUND_CONTEXT);
		const settled = await (
			await ceo?.submit({ type: "input", content: "用一句话说明你是谁。" }, BACKGROUND_CONTEXT)
		)?.wait(BACKGROUND_CONTEXT);

		expect(settled?.status).toBe("done");

		const usage = await rollupAll(runtime, BACKGROUND_CONTEXT);
		expect(usage.totalTokens, "真实模型应产生 token 消耗").toBeGreaterThan(0);
	}, 120_000);

	test("CPO 用真实模型调用工具完成立项", async () => {
		const cpo = await runtime.harness.conversation(roleConversations.cpo as never, BACKGROUND_CONTEXT);
		const settled = await (
			await cpo?.submit(
				{
					type: "input",
					content:
						'立项「网页坦克大战」项目：显示名用「坦克大战」，目录标识 tank-battle，需求摘要写 Canvas 像素风双人对战，验收标准写浏览器可玩。',
				},
				BACKGROUND_CONTEXT,
			)
		)?.wait(BACKGROUND_CONTEXT);

		expect(settled?.status).toBe("done");

		const state = await readCompany(runtime, BACKGROUND_CONTEXT);
		expect(Object.keys(state?.projects ?? {}), "CPO 应真的建立了项目").toContain("tank-battle");

		const dirs = await readdir(workspaceRoot).catch(() => [] as string[]);
		expect(dirs, "工作空间目录应真实创建").toContain("tank-battle");
	}, 180_000);

	test("CHRO 用真实模型为项目配员工", async () => {
		const chro = await runtime.harness.conversation(roleConversations.chro as never, BACKGROUND_CONTEXT);
		const settled = await (
			await chro?.submit(
				{
					type: "input",
					content: "为 tank-battle 项目招两名员工：dev-1（开发，上级 cto）、qa-1（测试，上级 cto）。",
				},
				BACKGROUND_CONTEXT,
			)
		)?.wait(BACKGROUND_CONTEXT);

		expect(settled?.status).toBe("done");

		const staff = await listStaff(runtime, "tank-battle", BACKGROUND_CONTEXT);
		expect(staff.length, "CHRO 应真的配了员工").toBeGreaterThanOrEqual(2);
		const names = staff.map((person) => person.name);
		expect(names).toContain("dev-1");
	}, 180_000);
});
