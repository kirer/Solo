/**
 * 改了 `settings.json`，**每个 agent 的会话是不是真的换到了新模型**。
 *
 * 模型是进程启动时装配的（`setupModels`），会话在装配时对齐一次（`assembleCore` 的
 * `applyModel`）。所以「在插件里加 / 删提供商」能不能生效，取决于两件事：
 * 1. 写下去的 settings.json 装配层认（`setupModels` 读到的就是那一份）；
 * 2. 装配时**每一个已经存在的会话**都被改成新模型 —— 漏一个，那个人就还用着旧模型，
 *    而界面上完全看不出来（他会照常回话，只是回话的是另一只模型）。
 *
 * 这里用真的装配（不开网络、不调模型），逐个会话读 `agent.model`。
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BACKGROUND_CONTEXT, setupModels } from "../../src/core/runtime/index.ts";
import type { ModelSetup } from "../../src/core/runtime/models.ts";
import { sandboxPool, type Sandbox } from "./support.ts";

const pool = sandboxPool();

afterEach(() => pool.cleanup());

async function person(box: Sandbox, slug: string): Promise<void> {
	await mkdir(join(box.agentsRoot, slug), { recursive: true });
	await writeFile(join(box.agentsRoot, slug, "identity.md"), `---\nname: ${slug}\ntitle: 工程师\n---\n\n# ${slug}\n`, "utf8");
}

/** 覆盖写一份 settings.json（等价于插件 POST 之后磁盘上的样子）。 */
async function settings(box: Sandbox, providers: readonly unknown[], defaultModel?: string): Promise<void> {
	await writeFile(join(box.root, "settings.json"), `${JSON.stringify({ providers, defaultModel }, null, 2)}\n`, "utf8");
}

/** 按这份配置启动一次，读回 slug → 会话当前用的模型。 */
async function modelsAfterRestart(box: Sandbox, setup: ModelSetup): Promise<Record<string, string>> {
	const runtime = await box.open({ models: setup.models });
	try {
		const shell = await box.assemble(runtime, { defaultModel: setup.defaultModel });
		const seen: Record<string, string> = {};
		for (const [slug, conversation] of shell.conversations) {
			const agent = await conversation.agent(BACKGROUND_CONTEXT);
			seen[slug] = `${agent.model?.provider ?? "?"}/${agent.model?.modelId ?? "?"}`;
		}
		return seen;
	} finally {
		await runtime.close();
	}
}

const gateway = (models: readonly string[]) => ({
	id: "magpie",
	name: "本地网关",
	baseUrl: "http://127.0.0.1:3425/v1",
	api: "openai-responses",
	models: models.map((id) => ({ id })),
});

const other = (models: readonly string[]) => ({
	id: "other",
	name: "另一家",
	baseUrl: "https://example.test/v1",
	api: "openai",
	models: models.map((id) => ({ id })),
});

describe("改了 settings.json：每个 agent 都跟着换模型", () => {
	it("换默认模型 / 删掉一家换成另一家：老会话和新加入的人都用新模型", async () => {
		const box = await pool.make("core-model-switch-");
		await person(box, "甲");
		await person(box, "乙");

		// 第一份：两家模型里选了第二个当默认。
		await settings(box, [gateway(["m-one", "m-two"])], "magpie/m-two");
		const first = setupModels({}, { workspace: box.root });
		expect(first.defaultModel).toEqual({ provider: "magpie", modelId: "m-two" });
		expect(await modelsAfterRestart(box, first)).toEqual({ 甲: "magpie/m-two", 乙: "magpie/m-two" });

		// 第二份：删掉 magpie、加上 other，默认换成 other/m-three（插件里这一趟是两次保存，
		// 磁盘上只留最后一次的结果 —— 这里直接摆出结果）。
		await settings(box, [other(["m-three"])], "other/m-three");
		const second = setupModels({}, { workspace: box.root });
		expect(second.defaultModel).toEqual({ provider: "other", modelId: "m-three" });
		expect(await modelsAfterRestart(box, second)).toEqual({ 甲: "other/m-three", 乙: "other/m-three" });

		// 换完之后才加入的人，一建会话就是新模型（不能只改老会话）。
		await person(box, "丙");
		expect(await modelsAfterRestart(box, second)).toEqual({
			甲: "other/m-three",
			乙: "other/m-three",
			丙: "other/m-three",
		});
	});

	it("默认模型指向已经删掉的那一家：装配报错，不偷偷换一只", async () => {
		const box = await pool.make("core-model-switch-");
		await person(box, "甲");

		// 手改 settings.json 才会出现（插件保存时会挡下来）。换一只顶上更糟：
		// 人以为在用 A，实际每轮都在用 B。报错里列出可选的那几只，改一行就好。
		await settings(box, [other(["m-three"])], "magpie/m-two");
		expect(() => setupModels({}, { workspace: box.root })).toThrow(/magpie\/m-two.*other\/m-three/);
	});

	it("providers 被删空：一个模型都不剩，老会话引用的那只也不存在了", async () => {
		const box = await pool.make("core-model-switch-");
		await person(box, "甲");

		await settings(box, [gateway(["m-one"])], "magpie/m-one");
		expect((await modelsAfterRestart(box, setupModels({}, { workspace: box.root }))).甲).toBe("magpie/m-one");

		// 空数组等于「没有 providers」：没有默认模型，也不回落到任何网关（ADR-023）。
		await settings(box, []);
		const empty = setupModels({}, { workspace: box.root });
		expect(empty.defaultModel).toBeUndefined();
		expect(empty.models.getModels()).toEqual([]);

		// 会话里还留着上一次的模型引用，但注册表里已经查不到 —— 生成会以 no_model 失败，
		// 而不是「悄悄换一只顶上」。
		const runtime = await box.open({ models: empty.models });
		try {
			const shell = await box.assemble(runtime);
			const conversation = shell.conversations.get("甲");
			if (conversation === undefined) throw new Error("没有会话");
			const agent = await conversation.agent(BACKGROUND_CONTEXT);
			expect(empty.models.getModel(agent.model?.provider ?? "", agent.model?.modelId ?? "")).toBeUndefined();
		} finally {
			await runtime.close();
		}
	});
});

describe("思考档位：每个人建会话时就设好，不用等下一次重启", () => {
	/** 装配一次，读回 slug → 会话当前的思考档位。 */
	async function thinkingAfterRestart(box: Sandbox, setup: ModelSetup): Promise<Record<string, string>> {
		const runtime = await box.open({ models: setup.models });
		try {
			const shell = await box.assemble(runtime, { defaultModel: setup.defaultModel });
			const seen: Record<string, string> = {};
			for (const [slug, conversation] of shell.conversations) {
				seen[slug] = (await conversation.agent(BACKGROUND_CONTEXT)).thinkingLevel;
			}
			return seen;
		} finally {
			await runtime.close();
		}
	}

	it("老会话与新建的人都从 off 变成 medium", async () => {
		const box = await pool.make("core-model-switch-");
		await person(box, "甲");
		await settings(box, [gateway(["m-one"])], "magpie/m-one");
		const setup = setupModels({}, { workspace: box.root });
		expect(await thinkingAfterRestart(box, setup)).toEqual({ 甲: "medium" });

		// 换一份配置再装配：已经是 medium 的人不该再写一次（幂等），新加的人也要是 medium。
		await person(box, "乙");
		expect(await thinkingAfterRestart(box, setup)).toEqual({ 甲: "medium", 乙: "medium" });
	});
});
