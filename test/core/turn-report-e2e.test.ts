/**
 * 整条路走一遍（faux 模型，不花 token）：被叫醒 → 模型把结论写在正文里、不调 `say`
 * → `afterRun` 建 durable task → 任务把正文补进频道。
 *
 * 这里证明的是「钩子真的被选中并跑了」，不是任务定义本身 —— 后者由
 * `turn-report.test.ts` 与 `crash-turn-report.test.ts` 钉住。
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createModels, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { BACKGROUND_CONTEXT } from "../../src/core/runtime/index.ts";
import { ChannelDoc, dmId, type ChannelState } from "../../src/core/channel/types.ts";
import { sandboxPool } from "./support.ts";

const pool = sandboxPool();

afterEach(async () => {
	await pool.cleanup();
});

async function until(check: () => Promise<boolean>, timeout = 8_000): Promise<void> {
	const deadline = Date.now() + timeout;
	while (Date.now() < deadline) {
		if (await check()) return;
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	throw new Error(`等超时了（${String(timeout)}ms）`);
}

describe("答完写回频道：afterRun → durable task（ADR-077）", () => {
	it("模型只把结论写在正文里，频道里也有一句", async () => {
		const box = await pool.make("turn-report-e2e-");
		await box.seedTemplates();
		await mkdir(join(box.agentsRoot, "林越"), { recursive: true });
		await writeFile(
			join(box.agentsRoot, "林越", "identity.md"),
			"---\nname: 林越\ntitle: 测试\n---\n\n测试用。\n",
			"utf8",
		);

		const faux = fauxProvider();
		const models = createModels();
		models.setProvider(faux.provider);
		const runtime = await box.open({ models });
		const shell = await box.assemble(runtime, {
			models,
			defaultModel: { provider: faux.getModel().provider, modelId: faux.getModel().id },
		});
		await shell.rescan();
		faux.setResponses([fauxAssistantMessage("在的。")]);

		const channelId = dmId("owner", "林越");
		await shell.ownerSay({ channelId, text: "@林越 在吗" });

		const channel = async () =>
			((await runtime.harness.snapshot(ChannelDoc, BACKGROUND_CONTEXT)) as ChannelState).messages[channelId] ?? [];
		await until(async () => (await channel()).some((item) => item.from === "林越" && item.text === "在的。"));

		// 再等一小会儿：收尾说第二次也必须被同文判据挡住。
		await new Promise((resolve) => setTimeout(resolve, 300));
		const said = (await channel()).filter((item) => item.from === "林越" && item.text === "在的。");
		expect(said).toHaveLength(1);
	}, 20_000);
});
