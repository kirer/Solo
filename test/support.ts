/**
 * 测试辅助：临时目录 + faux 模型 + 可编程响应。
 *
 * 全部测试都用 faux provider，不需要任何 API key，也不产生真实费用。
 * 注意一个坑：faux 的 tool call 消息必须带 stopReason: "toolUse"，否则工具不会执行。
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels } from "@earendil-works/pi-ai/models";
import {
	type FauxResponseStep,
	fauxAssistantMessage,
	fauxProvider,
	fauxText,
	fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import type { Models } from "@earendil-works/pi-ai";

export type TestContext = {
	readonly dir: string;
	readonly databasePath: string;
	readonly models: Models;
	readonly faux: ReturnType<typeof fauxProvider>;
	cleanup(): Promise<void>;
};

/** 创建一个隔离的测试环境。 */
export async function createTestContext(): Promise<TestContext> {
	const dir = await mkdtemp(join(tmpdir(), "ai-company-test-"));
	const models = createModels();
	const faux = fauxProvider({ models: [{ id: "faux-1" }, { id: "cheap-1" }, { id: "strong-1" }] });
	models.setProvider(faux.provider);

	return {
		dir,
		databasePath: join(dir, "company.sqlite"),
		models,
		faux,
		async cleanup() {
			await rm(dir, { recursive: true, force: true });
		},
	};
}

/** 一段纯文本回答。 */
export function answer(text: string): FauxResponseStep {
	return fauxAssistantMessage(fauxText(text));
}

/** 一次工具调用回答。stopReason 必须显式设为 toolUse，否则工具不执行。 */
export function toolCall(name: string, args: Record<string, unknown>): FauxResponseStep {
	return fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: "toolUse" });
}

/** 一个会等待指定毫秒的回答，用于制造「正在运行」的窗口。 */
export function slowAnswer(ms: number, text = "slow done"): FauxResponseStep {
	return async () => {
		await new Promise((resolve) => setTimeout(resolve, ms));
		return fauxAssistantMessage(fauxText(text));
	};
}

/** 等待某个条件成立，超时抛错。 */
export async function eventually(
	check: () => Promise<boolean> | boolean,
	options: { timeoutMs?: number; intervalMs?: number; label?: string } = {},
): Promise<void> {
	const timeout = options.timeoutMs ?? 5_000;
	const interval = options.intervalMs ?? 20;
	const start = Date.now();
	while (Date.now() - start < timeout) {
		if (await check()) return;
		await new Promise((resolve) => setTimeout(resolve, interval));
	}
	throw new Error(`等待超时：${options.label ?? "条件未成立"}`);
}

export { fauxAssistantMessage, fauxText, fauxToolCall, fauxProvider };
export type { FauxResponseStep };

/**
 * 测试用的模型清单。
 *
 * 生产清单由 `setupModels()` 提供；测试必须显式给出，否则
 * `bootstrapCompany` 会因为清单为空而报错（这是有意的：
 * 避免生产环境误用测试模型）。
 */
export const TEST_MODEL_CATALOG = [
	{ id: "faux-1", provider: "faux", modelId: "faux-1", label: "测试标准", inputPerMTok: 3, outputPerMTok: 15 },
	{ id: "cheap-1", provider: "faux", modelId: "cheap-1", label: "测试便宜", inputPerMTok: 0.5, outputPerMTok: 1.5 },
	{ id: "strong-1", provider: "faux", modelId: "strong-1", label: "测试强", inputPerMTok: 15, outputPerMTok: 75 },
] as const;
