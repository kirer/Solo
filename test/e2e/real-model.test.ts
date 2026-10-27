/**
 * 真实模型的端到端测试（可选执行）。
 *
 * 探测不到本地网关时**默认报红**——`describe.skipIf(!probe.ok)` 曾让整个文件静默 skip，
 * 而 skip 在 `Tests 649 passed` 里不显示为失败，于是随机不跑没人发现。
 * 本次不打算跑真模型（离线 / 只跑单测）必须**显式**设 SKIP_REAL_MODEL=1，跳过一次就是声明一次。
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

// D-008-a：探测超时必须**大于网关真实延迟**。实测该网关 /responses 响应 1.95–3.12s
// （3 次 curl：3.117s / 1.947s / 2.988s），原来的 2_000ms 正好卡在边界上，导致探测
// 随机失败 → `describe.skipIf(!probe.ok)` 把整个 e2e **跳过** → 而 skip 在
// `Tests 649 passed` 里**不显示为失败**。随机红会有人看，随机 skip 没人看。
// 取 10_000ms：约真实延迟上限的 3 倍，且仍远小于测试自身的 180s 超时。
const probe = await probeLocalGateway({ timeoutMs: 10_000 }).catch(() => ({ ok: false, detail: "不可用" }));

// skip 只由环境变量决定，**不由 probe.ok 决定**：探测失败要让测试真的跑起来并失败，
// 而不是把失败翻译成沉默。
const skipRealModel = process.env.SKIP_REAL_MODEL === "1" || process.env.SKIP_REAL_MODEL === "true";
if (skipRealModel) {
	// 不用 console.warn：vitest 4 会把它吞进自己的 reporter，终端上看不见。
	// 直接写 stderr，并带上用例数，免得「跳过了」被读成「跑了也没事」。
	process.stderr.write("[real-model] 已按 SKIP_REAL_MODEL 显式跳过真实模型测试（4 个用例未执行）\n");
}
const PROBE_FAILED = `未探测到本地模型网关（${probe.detail}）。若本次不打算跑真模型，必须显式设 SKIP_REAL_MODEL=1 再跑。`;

describe.skipIf(skipRealModel)("真实模型端到端", () => {
	let dir: string;
	let runtime: CompanyRuntime;
	let roleConversations: Record<string, number> = {};
	let workspaceRoot: string;

	// 单独一条用例，让「网关没起」在报告里是一个好认的失败，而不是三个诡异的失败。
	test("网关可用", () => {
		expect(probe.ok, PROBE_FAILED).toBe(true);
	});

	beforeAll(async () => {
		// 探针失败必须在这里就爆：否则会跑到「CEO 没应答」这类下游症状上，
		// 看不出真正原因是网关没起。
		expect(probe.ok, PROBE_FAILED).toBe(true);
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
