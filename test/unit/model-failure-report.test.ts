/**
 * OPS-20261025-04：模型调用失败必须看得见。
 *
 * 现象（真实事故）：模型返回 401，`pi.generation` 以 `state.outcome.status = "failed"`
 * 结束，但底层不为这条路径调 `onReport`，于是 app.log 里没有任何记录。
 *
 * 因果链与做法见 `src/runtime/run-failure.ts` 顶部注释。
 *
 * 审计（顾承审）的两条阻断项对应本文件两处：
 * - R-01：不再观测 `Submission`（那是「用户消息有没有被消费」，不是「模型调没调成」，
 *   还会挂长寿命悬空 Promise）。改为扫 `tasks.outcome.status === "failed"`。
 *   下面「不挂悬空 Promise」那条测试就是这道护栏。
 * - R-02：回归必须走 **HTTP `/api/message` 的 now 档（老板默认档）**，
 *   因为那才是老板真实发消息的路径。直接调内部 API 证明不了接线对。
 */
import { afterEach, describe, expect, test } from "vitest";
import { mkdtemp, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { BACKGROUND_CONTEXT, createRegistry, openCompany, recover, type CompanyRuntime, type RuntimeReport } from "../../src/runtime/index.ts";
import {
	createFailureScanner,
	diagnosticOf,
	reportForTaskFailure,
	taskFailureOf,
	toolDiagnosticOf,
} from "../../src/runtime/run-failure.ts";
import { bootstrapCompany } from "../../src/company/org.ts";
import { serve } from "../../src/server/http.ts";
import { configureEventLog, describeReport, eventLogPath, writeEvent } from "../../src/server/event-log.ts";
import { createTestContext, fauxAssistantMessage, TEST_MODEL_CATALOG, type TestContext } from "../support.ts";

describe("taskFailureOf：只认终态 + failed", () => {
	const failedRecord = {
		id: 53,
		kind: "pi.generation",
		conversationId: 1,
		state: {
			status: "terminal",
			outcome: { status: "failed", error: { message: "OpenAI API error (401) invalid_api_key", detail: { reason: "model_error" } } },
		},
	};

	test("终态 failed 被识别，message 与 reason 都带出来", () => {
		expect(taskFailureOf(failedRecord)).toEqual({
			taskId: 53,
			taskKind: "pi.generation",
			conversationId: 1,
			message: "OpenAI API error (401) invalid_api_key",
			reason: "model_error",
		});
	});

	test("completed 不算失败", () => {
		expect(taskFailureOf({ ...failedRecord, state: { status: "terminal", outcome: { status: "completed" } } })).toBeUndefined();
	});

	test("aborted / faulted 不走这条路径（faulted 已由底层 onReport 报过，避免重复）", () => {
		expect(taskFailureOf({ ...failedRecord, state: { status: "terminal", outcome: { status: "aborted" } } })).toBeUndefined();
		expect(taskFailureOf({ ...failedRecord, state: { status: "terminal", outcome: { status: "faulted" } } })).toBeUndefined();
	});

	test("还在跑的任务不算（status 不是 terminal）", () => {
		expect(taskFailureOf({ ...failedRecord, state: { status: "running", checkpoint: {} } })).toBeUndefined();
	});

	test("error.message 缺失时给一句可读兜底", () => {
		const failure = taskFailureOf({
			...failedRecord,
			state: { status: "terminal", outcome: { status: "failed", error: {} } },
		});
		expect(failure?.message).toBe("任务失败（底层未给出原因）");
	});
});

describe("reportForTaskFailure：用真实 taskId（审计 R-03）", () => {
	test("taskId 就是 tasks.id，能直接拿去检索、和 [任务受阻] 口径一致", () => {
		expect(
			reportForTaskFailure({
				taskId: 53,
				taskKind: "pi.generation",
				conversationId: 1,
				message: "OpenAI API error (401) invalid_api_key",
				reason: "model_error",
			}),
		).toEqual({
			kind: "task-failed",
			taskId: "53",
			taskKind: "pi.generation",
			error: "OpenAI API error (401) invalid_api_key",
		});
	});

	test("经 describeReport 变成 [任务出错] <id> (<kind>): <err>", () => {
		// D-03：正文加了 taskKind——光看 taskId 分不清是模型失败还是工具失败，
		// 而巡检最常问的正是这一句（实测 13 行 `Tool read threw` 全是工具失败）。
		const event = describeReport({
			kind: "task-failed",
			taskId: "53",
			taskKind: "pi.generation",
			error: "OpenAI API error (401) invalid_api_key",
		});
		expect(event).toEqual({ tag: "[任务出错]", rest: "53 (pi.generation): OpenAI API error (401) invalid_api_key" });
	});
});

describe("端到端：老板发消息（now 档主路径）撞 401", () => {
	let contexts: TestContext[] = [];
	let runtimes: CompanyRuntime[] = [];
	const closers: (() => Promise<void>)[] = [];

	afterEach(async () => {
		for (const close of closers.splice(0)) await close().catch(() => undefined);
		for (const runtime of runtimes.splice(0)) await runtime.close?.().catch(() => undefined);
		for (const ctx of contexts.splice(0)) await ctx.cleanup();
	});

	async function boot(
		onReport?: (report: RuntimeReport) => void,
	): Promise<{ ctx: TestContext; runtime: CompanyRuntime; rootId: number }> {
		const ctx = await createTestContext();
		contexts.push(ctx);
		const registry = createRegistry();
		const runtime = await openCompany(
			{
				databasePath: ctx.databasePath,
				models: ctx.models,
				registry,
				...(onReport === undefined ? {} : { onReport }),
			},
			BACKGROUND_CONTEXT,
		);
		runtimes.push(runtime);
		await recover(runtime, BACKGROUND_CONTEXT);
		const booted = await bootstrapCompany(
			runtime,
			{
				modelCatalog: [...TEST_MODEL_CATALOG],
				companyName: "测试公司",
				registry,
				workspaceRoot: join(ctx.dir, "projects"),
				watchdog: false,
			},
			BACKGROUND_CONTEXT,
		);
		return { ctx, runtime, rootId: booted.roleConversations.ceo };
	}

	test("走 HTTP /api/message（默认 now 档）：app.log 里出现 [任务出错]，taskId 是真实任务号", async () => {
		// 日志落到临时目录，绝不碰 workspace/logs
		const logDir = await mkdtemp(join(tmpdir(), "ops04-log-"));
		configureEventLog({ path: join(logDir, "app.log") });

		// 与 src/server/main.ts 的接线一致：onReport → describeReport → writeEvent 落盘。
		// （落盘是调用方的职责，openCompany 只负责把 report 交出来。）
		const { ctx, runtime, rootId } = await boot((report) => {
			const event = describeReport(report);
			if (event !== undefined) writeEvent(event.tag, event.rest);
		});
		// onReport 已由 openCompany 绑好；这里通过 serve 的入口再抓一遍落盘结果。
		const server = await serve({ runtime, port: 0, watchdog: false, uiDir: join(process.cwd(), "ui") });
		closers.push(async () => {
			await server.close();
		});

		// 让下一次模型调用以 401 失败结束（等价于老板真实遇到的 invalid_api_key）
		ctx.faux.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "OpenAI API error (401) invalid_api_key" }),
		]);

		// 不传 mode → 走默认 now 档，即老板真实路径
		const response = await fetch(new URL("/api/message", server.url), {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ conversationId: rootId, text: "这条会撞上 401" }),
		});
		expect(response.status).toBe(200);

		// 失败是异步落库；轮询直到日志出现，最多 15 秒
		const path = eventLogPath();
		expect(path).not.toBeNull();
		const deadline = Date.now() + 15_000;
		let content = "";
		while (Date.now() < deadline) {
			content = existsSync(path as string) ? await readFile(path as string, "utf8") : "";
			if (content.includes("[任务出错]")) break;
			// 后提交路径已经扫过一次；失败可能稍晚才落库，用运行时自己的扫描器补扫
			await runtime.scanTaskFailures(BACKGROUND_CONTEXT);
			await new Promise((resolve) => setTimeout(resolve, 100));
		}

		expect(content).toContain("[任务出错]");
		expect(content).toContain("OpenAI API error (401) invalid_api_key");
		// 真实任务号（数字），不是伪造的 submission#N
		expect(content).not.toContain("submission#");
		// D-03：现在带上 taskKind，格式是 `[任务出错] <id> (<kind>): <err>`
		expect(content).toMatch(/\[任务出错\] \d+ \(pi\.generation\): OpenAI API error \(401\)/);
	}, 40_000);

	test("不挂悬空 Promise：提交后运行时能干净关闭（审计 R-01 护栏）", async () => {
		const { runtime, rootId } = await boot();

		// 让模型正常回答 —— 这条路径以前会留下永不结算的 wait()
		runtime.harness.resume();
		const conversation = await runtime.harness.conversation(rootId as never, BACKGROUND_CONTEXT);
		await conversation!.submit({ type: "input", content: "正常说一句" }, BACKGROUND_CONTEXT);

		// 关闭必须很快返回（旧实现会因为 wait() 挂着而拖住或泄漏）
		const startedAt = Date.now();
		await runtime.close?.();
		const elapsed = Date.now() - startedAt;
		expect(elapsed).toBeLessThan(20_000);
	}, 30_000);

	test("扫描器幂等：同一批失败重复扫不会重复报", async () => {
		const { runtime } = await boot();
		const reported: RuntimeReport[] = [];
		// 用真实 storage 以外的假 storage 测幂等本身（不依赖时序）
		const scanner = createFailureScanner(
			{
				scanTasks: async () => ({
					items: [
						{
							id: 53,
							kind: "pi.generation",
							conversationId: 1,
							state: { status: "terminal", outcome: { status: "failed", error: { message: "401" } } },
						},
					],
				}),
			} as never,
			(report) => reported.push(report),
		);
		await scanner.scan(BACKGROUND_CONTEXT);
		await scanner.scan(BACKGROUND_CONTEXT);
		await scanner.scan(BACKGROUND_CONTEXT);
		expect(reported).toHaveLength(1);
		expect(reported[0]).toMatchObject({ kind: "task-failed", taskId: "53" });
		void runtime;
	});
});

describe("扫描分页：终态任务多于一页时，新失败仍必须被报出来", () => {
	/**
	 * 假 storage：真实库已有 3000+ 条终态任务，`scanTasks` 必然分页。
	 * 第一版实现按 `ascending` 只读第一页（最老的 200 条），水位也就只覆盖到那里——
	 * 之后所有新失败都落在后面几页，**永远报不出来**（审计阻断项）。
	 * 这里的 450 条 > 2 页，失败放在最新一页，正是那条路径。
	 */
	function fakeStorage(total: number, failedIds: readonly number[]) {
		const failed = new Set(failedIds);
		const all = Array.from({ length: total }, (_, index) => ({
			id: index + 1,
			kind: "pi.generation",
			conversationId: 1,
			state: {
				status: "terminal",
				outcome: failed.has(index + 1)
					? { status: "failed", error: { message: `fail-${index + 1}` } }
					: { status: "completed" },
			},
		}));
		return {
			scanTasks: async (
				query: { readonly order?: "ascending" | "descending" },
				limit: number,
				cursor?: { readonly offset?: number },
			) => {
				const offset = cursor?.offset ?? 0;
				const ordered = query.order === "descending" ? [...all].reverse() : all;
				const items = ordered.slice(offset, offset + limit);
				return offset + limit < ordered.length
					? { items, next: { offset: offset + limit } }
					: { items };
			},
		};
	}

	test("新失败在最新一页（第 3 页之外）也能报，且只报一次", async () => {
		const reported: RuntimeReport[] = [];
		const scanner = createFailureScanner(
			fakeStorage(450, [3, 449]) as never,
			(report) => reported.push(report),
		);
		expect(await scanner.scan(BACKGROUND_CONTEXT)).toBe(2);
		expect(reported.map((report) => (report as { taskId?: string }).taskId).sort()).toEqual(["3", "449"]);
		// 水位已推进到最新：再扫不重报
		expect(await scanner.scan(BACKGROUND_CONTEXT)).toBe(0);
	});
});

/**
 * D-03/D-04 回归：工具抛错时，日志必须给出**真实原因**，而不只是 `Tool read threw`。
 *
 * 真实现象（workspace/logs/app.log，13 行全是这样）：
 *   `[任务出错] 271: Tool read threw`
 * 底层 `pi-durable/dist/harness/tool.js:328` 把 `outcome.error.message` 固定写成
 * `Tool ${name} threw`，真实异常文本被放进**工具结果条目**的
 * `data.diagnostics[].message`（实测 task 271 → entry 273：
 * `"EISDIR: illegal operation on a directory, read"`）。
 */
describe("工具失败：把 diagnostics 里的真实原因带进日志（D-03/D-04）", () => {
	const failedToolRecord = {
		id: 271,
		kind: "pi.tool",
		conversationId: 191,
		state: {
			status: "terminal",
			outcome: {
				status: "failed",
				error: { message: "Tool read threw" },
				result: { kind: "model", entryId: 273 },
			},
		},
	};

	test("diagnosticOf：从工具结果条目抽出第一条 diagnostics 正文", () => {
		expect(
			diagnosticOf({
				kind: "pi.tool-result",
				data: { diagnostics: [{ severity: "error", code: "tool_error", message: "EISDIR: illegal operation on a directory, read" }] },
			}),
		).toBe("EISDIR: illegal operation on a directory, read");
	});

	test("diagnosticOf：形状不符/为空时不炸，返回 undefined", () => {
		expect(diagnosticOf(undefined)).toBeUndefined();
		expect(diagnosticOf({})).toBeUndefined();
		expect(diagnosticOf({ data: {} })).toBeUndefined();
		expect(diagnosticOf({ data: { diagnostics: [] } })).toBeUndefined();
		expect(diagnosticOf({ data: { diagnostics: [{ message: "" }] } })).toBeUndefined();
	});

	test("toolDiagnosticOf：按 outcome.result.entryId 去读条目", async () => {
		const read = async (entryId: number) =>
			entryId === 273
				? { kind: "pi.tool-result", data: { diagnostics: [{ message: "EISDIR: illegal operation on a directory, read" }] } }
				: undefined;
		expect(await toolDiagnosticOf(failedToolRecord as never, read)).toBe(
			"EISDIR: illegal operation on a directory, read",
		);
	});

	test("toolDiagnosticOf：读条目抛错时不影响上报（返回 undefined）", async () => {
		expect(
			await toolDiagnosticOf(failedToolRecord as never, async () => {
				throw new Error("storage boom");
			}),
		).toBeUndefined();
	});

	test("reportForTaskFailure：把诊断拼进 error 正文", () => {
		const report = reportForTaskFailure({
			taskId: 271,
			taskKind: "pi.tool",
			conversationId: 191,
			message: "Tool read threw",
			diagnostic: "EISDIR: illegal operation on a directory, read",
		});
		expect(report).toMatchObject({
			kind: "task-failed",
			taskId: "271",
			taskKind: "pi.tool",
			error: "Tool read threw（原因：EISDIR: illegal operation on a directory, read）",
		});
		// 最终落盘那一行同时含任务号、类型与真实原因
		const event = describeReport(report)!;
		expect(event.tag).toBe("[任务出错]");
		expect(event.rest).toBe("271 (pi.tool): Tool read threw（原因：EISDIR: illegal operation on a directory, read）");
	});

	test("扫描器端到端：日志里出现真实原因，而不只是 `Tool read threw`", async () => {
		const reported: RuntimeReport[] = [];
		const scanner = createFailureScanner(
			{
				scanTasks: async () => ({ items: [failedToolRecord] }),
				entry: async (id: number) =>
					id === 273
						? {
								entry: {
									kind: "pi.tool-result",
									data: { diagnostics: [{ message: "EISDIR: illegal operation on a directory, read" }] },
								},
							}
						: undefined,
			} as never,
			(report) => reported.push(report),
		);
		expect(await scanner.scan(BACKGROUND_CONTEXT)).toBe(1);
		const error = (reported[0] as { error?: unknown }).error;
		expect(String(error)).toContain("EISDIR: illegal operation on a directory, read");
	});
});
