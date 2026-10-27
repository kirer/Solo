/**
 * 2026-10-27 事故回归：模型 id 漂移让整个公司发不出话。
 *
 * **现象**：老板在公司大群 `@CEO`，消息投递全部成功（`app.ack`、`deliver`
 * 都返回 ok），但 CEO 一句话也不回。`tasks` 表里所有 `pi.generation`
 * 都是 `terminal` + `outcome.status = "failed"`，错误统一为
 *
 * ```
 * Model commandcode/auto/deepseek-v4.1-flash is not available
 * ```
 *
 * **两条独立的因，都在这里锁住**：
 *
 * 1. **覆盖项重复追加**（`src/runtime/models.ts` 的 `setupModels`）：
 *    设置页里「改内置模型的名字」写下的是一条 `custom` + `builtin` 覆盖项。
 *    内置项按覆盖项就地改完 id 后，这段覆盖项**又被当成纯自定义项追加了一遍**，
 *    于是 catalog 里同一个 id 出现两次 → `resolveModelOption` 判 `ambiguous`
 *    → `resolveDefaultModel` 回落到 `base.defaultModel`。若老板同时把默认值
 *    写成了那个新 id，就会得到「默认模型指向一个 catalog 认不出的引用」。
 *
 * 2. **老库的 `pi.agent.model` 是持久化的**（`src/company/org.ts` 的
 *    `repairModelRefs`）：代码默认值换过（`apigoto/deepseek-flash` →
 *    `auto/deepseek-v4.1-flash` → `workbuddy-ai/deepseek-v4.1-flash`），
 *    而 `bootstrapCompany` 的幂等早退分支过去只修能力包 / cwd / 上级，
 *    从不校验模型。会话一旦指向旧 id，provider 里没这个模型，
 *    每一轮生成都以 `is not available` 失败。
 */
import { describe, expect, test } from "vitest";
import { join } from "node:path";
import { BACKGROUND_CONTEXT, createRegistry, openCompany } from "../../src/runtime/index.ts";
import { LOCAL_GATEWAY, parseModelSettings, setupModels } from "../../src/runtime/models.ts";
import { bootstrapCompany } from "../../src/company/org.ts";
import { CompanyDoc } from "../../src/company/docs.ts";
import { createTestContext, TEST_MODEL_CATALOG, type TestContext } from "../support.ts";

/** 覆盖项：把内置的 workbuddy 那条改名成一个自带新名，模拟老板在设置页里的操作。 */
const OVERRIDE = {
	id: "renamed-ds-flash",
	name: "cmdc-ds",
	provider: "openai-responses" as const,
	baseUrl: "http://127.0.0.1:3425/v1",
	apiKey: "magpie",
	builtin: "workbuddy-ai/deepseek-v4.1-flash",
};

describe("setupModels：覆盖项不能被重复追加", () => {
	test("catalog 里没有重复 id（重复会让 resolveModelOption 判 ambiguous）", () => {
		const { catalog } = setupModels({}, { settings: parseModelSettings({ models: { custom: [OVERRIDE] } }) });

		const ids = catalog.map((item) => item.id);
		expect(new Set(ids).size).toBe(ids.length);
	});

	test("改名后的内置项保留原来的 provider/modelId，不是新造一条", () => {
		const { catalog } = setupModels({}, { settings: parseModelSettings({ models: { custom: [OVERRIDE] } }) });
		const renamed = catalog.filter((item) => item.id === OVERRIDE.id);

		expect(renamed).toHaveLength(1);
		// 关键：modelId 还是内置那条的真身。若被当成纯自定义项追加，modelId
		// 会变成覆盖项自己的 `id`，于是一模两号，请求打到一个不存在的模型。
		expect(renamed[0]?.provider).toBe(LOCAL_GATEWAY.id);
		expect(renamed[0]?.modelId).toBe("workbuddy-ai/deepseek-v4.1-flash");
		expect(renamed[0]?.label).toBe("cmdc-ds");
	});

	test("改名撞上另一条内置 id 时放弃改名，不制造两个同 id", () => {
		// 真实场景：老板把 workbuddy 那条改名成 `auto/deepseek-v4.1-flash`，
		// 而后者现在也是内置的一项。若不拦，catalog 就会出现两条同 id。
		const collide = { ...OVERRIDE, id: "auto/deepseek-v4.1-flash" };
		const { catalog } = setupModels({}, { settings: parseModelSettings({ models: { custom: [collide] } }) });

		const ids = catalog.map((item) => item.id);
		expect(new Set(ids).size).toBe(ids.length);
		// 改名的诉求被拒，但 label 覆盖仍然生效（老板至少能看到自己起的名字）。
		expect(catalog.find((item) => item.id === "workbuddy-ai/deepseek-v4.1-flash")?.label).toBe("cmdc-ds");
	});

	test("hidden 的覆盖项只用于摘除，不会以任何形式留在 catalog 里", () => {
		const hidden = {
			id: "monotoo/gpt-6.1-sol",
			provider: "openai-responses" as const,
			builtin: "monotoo/gpt-6.1-sol",
			hidden: true,
		};
		const { catalog } = setupModels({}, { settings: parseModelSettings({ models: { custom: [hidden] } }) });

		expect(catalog.some((item) => item.id === "monotoo/gpt-6.1-sol")).toBe(false);
	});

	test("纯自定义项（无 builtin）仍然会被追加", () => {
		const plain = {
			id: "my-own-model",
			name: "自建",
			provider: "openai-responses" as const,
			baseUrl: "http://127.0.0.1:3425/v1",
			apiKey: "k",
		};
		const { catalog } = setupModels({}, { settings: parseModelSettings({ models: { custom: [plain] } }) });

		expect(catalog.some((item) => item.id === "my-own-model")).toBe(true);
	});

	test("默认值写成被改名后的 id 时仍然解析得出（不再回落 no_model）", () => {
		const { defaultModel, catalog } = setupModels(
			{},
			{ settings: parseModelSettings({ models: { default: OVERRIDE.id, custom: [OVERRIDE] } }) },
		);

		// 解析出来的引用必须真的在 catalog 里——否则运行时就是
		// `Model <provider>/<id> is not available`，整个公司发不出话。
		expect(catalog.some((item) => item.provider === defaultModel.provider && item.modelId === defaultModel.modelId)).toBe(
			true,
		);
		expect(defaultModel.provider).toBe(LOCAL_GATEWAY.id);
		expect(defaultModel.modelId).toBe("workbuddy-ai/deepseek-v4.1-flash");
	});
});

describe("bootstrapCompany：老库失效的模型引用必须自愈", () => {
	function boot(ctx: TestContext, catalog: readonly (typeof TEST_MODEL_CATALOG)[number][] = TEST_MODEL_CATALOG) {
		return async () => {
			const registry = createRegistry();
			const runtime = await openCompany(
				{ databasePath: ctx.databasePath, models: ctx.models, registry },
				BACKGROUND_CONTEXT,
			);
			await bootstrapCompany(
				runtime,
				{
					companyName: "模型引用回归",
					registry,
					workspaceRoot: join(ctx.dir, "projects"),
					modelCatalog: [...catalog],
					defaultModel: { provider: "faux", modelId: "faux-1" },
				},
				BACKGROUND_CONTEXT,
			);
			return { runtime, registry };
		};
	}

	test("指向未注册 id 的会话被拉回默认模型", async () => {
		const ctx = await createTestContext();
		try {
			const { runtime, registry } = await boot(ctx)();

			// 模拟「代码换过默认模型、老库没迁移」：把一个会话改成不存在的 id。
			const state = await runtime.harness.snapshot(CompanyDoc, BACKGROUND_CONTEXT);
			const cfo = state?.roles.cfo;
			expect(cfo).toBeDefined();
			const conversation = await runtime.harness.conversation(cfo as never, BACKGROUND_CONTEXT);
			await conversation?.configure({ model: { provider: "commandcode", modelId: "gone/model" } }, BACKGROUND_CONTEXT);

			// 再跑一次装配：幂等早退分支必须把失效引用修回来。
			await bootstrapCompany(
				runtime,
				{
					companyName: "模型引用回归",
					registry,
					workspaceRoot: join(ctx.dir, "projects"),
					modelCatalog: [...TEST_MODEL_CATALOG],
					defaultModel: { provider: "faux", modelId: "faux-1" },
				},
				BACKGROUND_CONTEXT,
			);

			const repaired = await conversation?.agent(BACKGROUND_CONTEXT);
			expect(repaired?.model?.provider).toBe("faux");
			expect(repaired?.model?.modelId).toBe("faux-1");
		} finally {
			await ctx.cleanup();
		}
	});

	test("认得出的模型引用保持不变（不抢老板给员工指定的模型）", async () => {
		const ctx = await createTestContext();
		try {
			const { runtime, registry } = await boot(ctx)();

			const state = await runtime.harness.snapshot(CompanyDoc, BACKGROUND_CONTEXT);
			const conversation = await runtime.harness.conversation(state?.roles.cfo as never, BACKGROUND_CONTEXT);
			await conversation?.configure({ model: { provider: "faux", modelId: "strong-1" } }, BACKGROUND_CONTEXT);

			await bootstrapCompany(
				runtime,
				{
					companyName: "模型引用回归",
					registry,
					workspaceRoot: join(ctx.dir, "projects"),
					modelCatalog: [...TEST_MODEL_CATALOG],
					defaultModel: { provider: "faux", modelId: "faux-1" },
				},
				BACKGROUND_CONTEXT,
			);

			const kept = await conversation?.agent(BACKGROUND_CONTEXT);
			expect(kept?.model?.modelId).toBe("strong-1");
		} finally {
			await ctx.cleanup();
		}
	});

	test("模型清单会刷新到 CompanyDoc（设置页新加的模型能立刻招聘）", async () => {
		const ctx = await createTestContext();
		try {
			const { runtime, registry } = await boot(ctx)();
			const grown = [...TEST_MODEL_CATALOG, { ...TEST_MODEL_CATALOG[0]!, id: "extra-model", modelId: "extra-model" }];

			await bootstrapCompany(
				runtime,
				{
					companyName: "模型引用回归",
					registry,
					workspaceRoot: join(ctx.dir, "projects"),
					modelCatalog: grown,
					defaultModel: { provider: "faux", modelId: "faux-1" },
				},
				BACKGROUND_CONTEXT,
			);

			const state = await runtime.harness.snapshot(CompanyDoc, BACKGROUND_CONTEXT);
			expect(state?.modelCatalog.some((item) => item.id === "extra-model")).toBe(true);
		} finally {
			await ctx.cleanup();
		}
	});
});
