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
import {
	BACKGROUND_CONTEXT,
	type CompanyRuntime,
	type Context,
	inspectLivenessFrom,
	isConversationBusy,
} from "../src/runtime/index.ts";

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

/**
 * 一个 agent 的**全部**工具名：默认给的 + 延迟加载的。
 *
 * 为什么要分开：`deferred: true` 的工具不直接出现在模型面前（见 ADR-032），
 * 但它在 `agent.deferred` 里、模型能用 `tool_search` 找到。
 * 断言「这个角色有什么能力」时必须两边都算，否则会把「按需加载」误判成「没有」。
 */
export function agentTools(agent: { tools?: readonly unknown[]; deferred?: readonly unknown[] } | undefined): readonly { name: string }[] {
	if (agent === undefined) return [];
	return [...(agent.tools ?? []), ...(agent.deferred ?? [])] as { name: string }[];
}

/** 只要工具名的版本。 */
export function allToolNames(agent: { tools?: readonly unknown[]; deferred?: readonly unknown[] } | undefined): string[] {
	return agentTools(agent).map((tool) => tool.name);
}

// ── 派活夹具（delegation.ts 删除后的替代） ────────────────────────────────────

/**
 * 「派一件活并等它做完」——测试用的同步派活夹具。
 *
 * 生产路径已经没有同步派活了（`delegation.ts` 533 行 + `delegation-guard.ts`
 * 165 行已删）：派活是 `assign_task`（建任务，**不等**）+ 频道消息（唤醒）。
 * 但一批老测试写的是「派活 → 断言员工答了话」，它们验证的是**任务/成本/轨迹/
 * 终止/看门狗**这些行为，不是同步派活本身。
 *
 * 所以这里提供一个等价的测试原语：投一条输入进员工会话、等它 settle、
 * 把结果读出来。**它不做** delegation.ts 做过的那四件事（越级校验、环检测、
 * 超时释放、双向留痕），因为这些现在是 `assign_task` + 频道 + 看门狗的职责，
 * 该由各自的测试去钉，而不是靠一个「什么都会一点」的同步原语顺带覆盖。
 *
 * 需要超时/环检测语义的测试应当直接断言新路径（见
 * `test/e2e/reliability.test.ts` 里改写后的两条）。
 */
export async function askAndWait(
	runtime: CompanyRuntime,
	input: {
		readonly conversationId: number;
		readonly text: string;
		readonly from?: string;
		readonly fromLabel?: string;
		readonly requestId?: string;
	},
	context: Context = BACKGROUND_CONTEXT,
): Promise<{ readonly ok: boolean; readonly text: string; readonly status: string }> {
	const conversation = await runtime.harness.conversation(input.conversationId as never, context);
	if (conversation === undefined) return { ok: false, text: "会话不存在", status: "missing" };
	const submission = await conversation.submit(
		{
			type: "input",
			content: input.text,
			...(input.requestId === undefined ? {} : { requestId: input.requestId }),
			...(input.from === undefined
				? {}
				: {
						entry: {
							kind: "app.delegate",
							data: { from: input.from, fromLabel: input.fromLabel ?? input.from, text: input.text.slice(0, 280) },
						},
					}),
		},
		context,
	);
	const settled = await submission.wait(context);
	if (settled.status !== "done") return { ok: false, text: `未能回答（${settled.reason}）`, status: settled.status };
	const entry = await runtime.harness.commit(
		(tx) => tx.entry({ kind: "pi.assistant", is: () => true } as never, settled.answer as never),
		context,
	);
	const message = (entry as { model?: readonly { content?: readonly { type: string; text?: string }[] }[] })?.model?.[0];
	const text = message?.content?.flatMap((part) => (part.type === "text" && part.text !== undefined ? [part.text] : [])).join("");
	return { ok: true, text: text === undefined || text === "" ? "（员工未给出文本内容）" : text, status: "done" };
}

/**
 * 等一次升级跑完，取回结果。
 *
 * 从 `src/company/escalation.ts` 搬来的：它只是 `harness.waitForTask` 的一层
 * 薄包装（等终态 → 取 outcome.result），没有任何业务规则，唯一消费者是测试。
 * 放在 `src/` 里会让「等一个任务结束」看起来像是升级链的公共 API。
 */
export async function waitEscalation(
	runtime: CompanyRuntime,
	taskId: number,
	context: Context = BACKGROUND_CONTEXT,
): Promise<{ readonly decidedBy: string; readonly decision: string; readonly path: string[] } | undefined> {
	const settled = await runtime.harness.waitForTask(taskId as never, context);
	if (settled.state.status !== "terminal") return undefined;
	const outcome = settled.state.outcome;
	if (outcome.status !== "completed") return undefined;
	return outcome.result as { readonly decidedBy: string; readonly decision: string; readonly path: string[] };
}

/** 员工当前是否忙碌（原 `delegation.ts` 的 `isEmployeeBusy`，无派活依赖）。 */
export async function staffBusy(
	runtime: CompanyRuntime,
	staff: { readonly conversationId: number },
	context: Context = BACKGROUND_CONTEXT,
): Promise<boolean> {
	const inspection = await runtime.harness.inspect(context);
	return isConversationBusy(inspectLivenessFrom(inspection), staff.conversationId);
}
