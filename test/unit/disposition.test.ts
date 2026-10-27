/**
 * 处置与恢复（ADR-026 决策 4/5）的单元测试。
 *
 * 覆盖三件必须成立的事：
 * 1. checkpoint 从条目与任务**机械推导**，不调模型；
 * 2. 默认只能是可逆的一侧（暂搁），且暂搁必须有恢复条件；
 * 3. 超时按默认执行，且「用了哪个默认值」可被留痕区分。
 */
import { describe, expect, test } from "vitest";
import {
	DEFAULT_DISPOSITION,
	DEFAULT_RESUME_AFTER_MS,
	DISPOSITION_DEADLINE_MS,
	settleDueDispositions,
	buildDispositionQuestion,
	countToolCalls,
	createDispositionPending,
	defaultOptions,
	deriveProgress,
	describeProgress,
	dispositionKey,
	findAssignment,
	hasResumeCondition,
	parseDispositionAnswer,
	readDisposition,
	settleDisposition,
	shouldApplyTimeoutDefault,
	type DispositionPayload,
	type InterruptedWork,
} from "../../src/company/disposition.ts";

// ── 纯函数 ──────────────────────────────────────────────────────

describe("countToolCalls：工具调用配对（机械推导，不调模型）", () => {
	test("assistant 的 toolCall 与 tool-result 按 callId 配对", () => {
		const entries = [
			{ kind: "pi.user" },
			{ kind: "pi.assistant", model: [{ content: [{ type: "toolCall", id: "c1" }] }] },
			{ kind: "pi.tool-result", model: [{ toolCallId: "c1" }] },
			{ kind: "pi.assistant", model: [{ content: [{ type: "toolCall", id: "c2" }] }] },
			// c2 还没有结果
		];
		expect(countToolCalls(entries)).toEqual({ completed: 1, total: 2 });
	});

	test("同一条 assistant 里的多个 toolCall 都算", () => {
		const entries = [
			{
				kind: "pi.assistant",
				model: [
					{
						content: [
							{ type: "toolCall", id: "a" },
							{ type: "toolCall", id: "b" },
						],
					},
				],
			},
			{ kind: "pi.tool-result", model: [{ toolCallId: "a" }] },
			{ kind: "pi.tool-result", model: [{ toolCallId: "b" }] },
		];
		expect(countToolCalls(entries)).toEqual({ completed: 2, total: 2 });
	});

	test("非 toolCall 内容（纯文本/thinking）不计入", () => {
		const entries = [
			{ kind: "pi.assistant", model: [{ content: [{ type: "text", id: "x" }] }] },
			{ kind: "pi.assistant", model: [{ content: [{ type: "thinking" }] }] },
		];
		expect(countToolCalls(entries)).toEqual({ completed: 0, total: 0 });
	});

	test("空条目返回 0/0", () => {
		expect(countToolCalls([])).toEqual({ completed: 0, total: 0 });
	});

	test("孤儿 tool-result（没有对应调用）不制造幻觉计数", () => {
		const entries = [{ kind: "pi.tool-result", model: [{ toolCallId: "ghost" }] }];
		expect(countToolCalls(entries)).toEqual({ completed: 0, total: 0 });
	});
});

describe("deriveProgress / describeProgress", () => {
	test("第几步 = 已完成 + 1，且不超过总数", () => {
		expect(deriveProgress({ completed: 2, total: 5 }, 12000).step).toBe(3);
		expect(deriveProgress({ completed: 5, total: 5 }, 0).step).toBe(5);
	});

	test("没有工具调用时总步数未知（null），但步骤仍从 1 开始", () => {
		const progress = deriveProgress({ completed: 0, total: 0 }, 0);
		expect(progress.totalSteps).toBeNull();
		expect(progress.step).toBe(1);
	});

	test("渲染成 ADR 要求的那句话", () => {
		const text = describeProgress(deriveProgress({ completed: 2, total: 5 }, 12000));
		expect(text).toContain("第 3 步 / 共 5 步");
		expect(text).toContain("已完成 2 次工具调用");
		expect(text).toContain("12k token");
	});

	test("总步数未知时措辞不撒谎", () => {
		const text = describeProgress(deriveProgress({ completed: 0, total: 0 }, 500));
		expect(text).toContain("已进行到第 1 步");
		expect(text).toContain("500 token");
	});
});

describe("findAssignment：从 app.delegate 取下达人与项目", () => {
	test("取最近一条 delegate", () => {
		const entries = [
			{ kind: "app.delegate", data: { from: "CTO", project: "old" } },
			{ kind: "pi.assistant" },
			{ kind: "app.delegate", data: { from: "许砚舟", project: "ops-defect-loop" } },
		];
		expect(findAssignment(entries)).toEqual({ from: "许砚舟", project: "ops-defect-loop" });
	});

	test("没有 delegate 时返回 null（不猜）", () => {
		expect(findAssignment([{ kind: "pi.user" }])).toEqual({ from: null, project: null });
	});
});

// ── 默认值 / 恢复条件 ───────────────────────────────────────────

function payload(overrides: Partial<DispositionPayload> = {}): DispositionPayload {
	return {
		type: "disposition",
		work: {
			taskId: "42",
			taskKind: "pi.tool",
			conversationId: 7,
			startedAt: null,
			project: "ops-defect-loop",
			assignedBy: "老板",
			assignedByConversationId: null,
			progress: {
				completedToolCalls: 2,
				totalToolCalls: 5,
				step: 3,
				totalSteps: 5,
				tokensUsed: 12000,
			},
		},
		options: defaultOptions(),
		defaultDisposition: DEFAULT_DISPOSITION,
		deadlineAt: 1000 + DISPOSITION_DEADLINE_MS,
		resumeAfterMs: DEFAULT_RESUME_AFTER_MS,
		resumeNote: "默认：30 分钟后提醒下达人",
		...overrides,
	};
}

test("默认处置只能是暂搁（唯一可逆的一侧）", () => {
	expect(DEFAULT_DISPOSITION).toBe("shelve");
	const options = defaultOptions();
	expect(options.find((option) => option.id === "shelve")?.recommended).toBe(true);
	expect(options.find((option) => option.id === "abandon")?.recommended).toBe(false);
});

test("问题正文是结构化的：带项目/任务、进度、选项、恢复条件", () => {
	const question = buildDispositionQuestion(payload().work);
	expect(question).toContain("被打断的工作：ops-defect-loop / pi.tool#42");
	expect(question).toContain("第 3 步 / 共 5 步");
	expect(question).toContain("12k token");
	expect(question).toContain("① 暂搁（推荐）② 永久放弃");
	expect(question).toContain("恢复条件");
	expect(question).toContain("5 分钟内未答复");
});

test("暂搁永远有恢复条件（默认 30 分钟），因此成立", () => {
	expect(hasResumeCondition(payload())).toBe(true);
	expect(payload().resumeAfterMs).toBe(30 * 60_000);
});

test("恢复条件被清零时，暂搁不成立", () => {
	expect(hasResumeCondition(payload({ resumeAfterMs: 0 }))).toBe(false);
});

test("解析答案：只说「暂搁」而不给恢复条件 → 必须被拒绝（必填项不是可选项）", () => {
	// ADR-026 决策 4：「没有恢复条件的暂搁不是暂停，是让工作无声烂掉」
	for (const answer of ["暂搁", "暂搁：", "暂搁 "]) {
		const parsed = parseDispositionAnswer(answer, payload());
		expect(parsed.ok, `「${answer}」没给恢复条件，必须被拒`).toBe(false);
		if (!parsed.ok) expect(parsed.reason).toContain("恢复条件");
	}
});

test("解析答案：暂搁 + 明确恢复条件才成立", () => {
	const parsed = parseDispositionAnswer("暂搁：30 分钟后提醒我", payload());
	expect(parsed.ok).toBe(true);
	if (parsed.ok) {
		expect(parsed.disposition).toBe("shelve");
		expect(parsed.resumeCondition).toBe("30 分钟后提醒我");
	}
});

test("解析答案：暂搁可带自定义恢复条件", () => {
	const parsed = parseDispositionAnswer("暂搁：等老板确认方案后再继续", payload());
	expect(parsed.ok).toBe(true);
	if (parsed.ok) {
		expect(parsed.disposition).toBe("shelve");
		expect(parsed.resumeCondition).toContain("等老板确认方案后再继续");
	}
});

test("解析答案：永久放弃不带恢复条件", () => {
	const parsed = parseDispositionAnswer("永久放弃", payload());
	expect(parsed.ok).toBe(true);
	if (parsed.ok) {
		expect(parsed.disposition).toBe("abandon");
		expect(parsed.resumeCondition).toBe("");
	}
});

test("说不清的答案一律拒绝（不放行成默认值）", () => {
	expect(parseDispositionAnswer("", payload()).ok).toBe(false);
	expect(parseDispositionAnswer("随便", payload()).ok).toBe(false);
	// 同时提两个选项 = 说不清
	expect(parseDispositionAnswer("暂搁还是放弃？", payload()).ok).toBe(false);
});

// ── 超时表 ──────────────────────────────────────────────────────

test("未到期不兜底", () => {
	expect(shouldApplyTimeoutDefault(payload({ deadlineAt: 2000 }), 1000)).toEqual({ apply: false });
});

test("到期按默认暂搁执行", () => {
	const check = shouldApplyTimeoutDefault(payload({ deadlineAt: 500 }), 1000);
	expect(check.apply).toBe(true);
	if (check.apply) {
		expect(check.disposition).toBe("shelve");
		expect(check.resumeCondition).toContain("30 分钟");
	}
});

test("已有结论的不再兜底（默认值可被事后推翻，不覆盖人的决定）", () => {
	const decided = payload({ deadlineAt: 500, disposition: "abandon", decidedBy: "human" });
	expect(shouldApplyTimeoutDefault(decided, 10_000)).toEqual({ apply: false });
});

// ── 落库（走真实运行时）──────────────────────────────────────────
//
// 这组测试要真的写 PendingDoc / AuditDoc，因此用真实运行时 + 临时库。

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createRegistry, openCompany, type CompanyRuntime } from "../../src/runtime/index.ts";
import { AuditDoc } from "../../src/company/docs.ts";
import { PendingDoc } from "../../src/company/escalation.ts";
import { createTestContext, type TestContext } from "../support.ts";
import { afterEach } from "vitest";

let contexts: TestContext[] = [];
let runtimes: CompanyRuntime[] = [];

async function setup(): Promise<CompanyRuntime> {
	const ctx = await createTestContext();
	contexts.push(ctx);
	const runtime = await openCompany(
		{ databasePath: ctx.databasePath, models: ctx.models, registry: createRegistry() },
		BACKGROUND_CONTEXT,
	);
	runtimes.push(runtime);
	return runtime;
}

afterEach(async () => {
	for (const runtime of runtimes.splice(0)) await runtime.close();
	for (const ctx of contexts.splice(0)) await ctx.cleanup();
});

function work(overrides: Partial<InterruptedWork> = {}): InterruptedWork {
	return {
		taskId: "42",
		taskKind: "pi.tool",
		conversationId: 1,
		startedAt: 1000,
		project: "ops-defect-loop",
		assignedBy: "老板",
		assignedByConversationId: null,
		progress: {
			completedToolCalls: 2,
			totalToolCalls: 5,
			step: 3,
			totalSteps: 5,
			tokensUsed: 12000,
		},
		...overrides,
	};
}

describe("落库：处置待办", () => {
	test("创建后可在待决文档里读到，且带默认值与期限", async () => {
		const runtime = await setup();
		const now = 1_000_000;
		const { key, created } = await createDispositionPending(runtime, work(), { now });
		expect(created).toBe(true);

		const read = await readDisposition(runtime, key, {});
		expect(read).toBeDefined();
		expect(read?.payload.defaultDisposition).toBe("shelve");
		expect(read?.payload.deadlineAt).toBe(now + DISPOSITION_DEADLINE_MS);
		expect(read?.payload.resumeAfterMs).toBe(DEFAULT_RESUME_AFTER_MS);
		expect(read?.item.question).toContain("第 3 步 / 共 5 步");
	});

	test("同一任务同一时刻重复创建不重复插入（打断可能被重试）", async () => {
		const runtime = await setup();
		const now = 1_000_000;
		const first = await createDispositionPending(runtime, work(), { now });
		const second = await createDispositionPending(runtime, work(), { now });
		expect(first.created).toBe(true);
		expect(second.created).toBe(false);

		const state = await runtime.harness.snapshot(PendingDoc, BACKGROUND_CONTEXT);
		const items = state?.items.filter((item) => item.key === first.key) ?? [];
		expect(items).toHaveLength(1);
	});

	test("人回答暂搁：留下 disposition 与恢复条件", async () => {
		const runtime = await setup();
		const { key } = await createDispositionPending(runtime, work(), { now: 1_000_000 });

		const result = await settleDisposition(runtime, {
			key,
			answer: "暂搁：等老板回来看",
			answeredBy: "老板",
		});
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.disposition).toBe("shelve");
			expect(result.resumeCondition).toContain("等老板回来看");
		}

		const read = await readDisposition(runtime, key, {});
		expect(read?.payload.disposition).toBe("shelve");
		expect(read?.payload.decidedBy).toBe("human");
	});

	test("人回答非法内容被拒绝，且不改变待办状态", async () => {
		const runtime = await setup();
		const { key } = await createDispositionPending(runtime, work(), { now: 1_000_000 });

		const result = await settleDisposition(runtime, { key, answer: "随便吧", answeredBy: "老板" });
		expect(result.ok).toBe(false);

		// 读回时注入「创建时刻」：否则已过 5 分钟期限，读时兜底会按默认结算成 shelve，
		// 就看不到「未定处置」这个待验证状态了。
		const read = await readDisposition(runtime, key, { now: 1_000_000 });
		expect(read?.payload.disposition).toBeUndefined();
	});

	test("超时兜底：按默认暂搁执行，且留痕标明是机器默认", async () => {
		const runtime = await setup();
		const now = 1_000_000;
		const { key } = await createDispositionPending(runtime, work(), { now });

		const beforeDue = await settleDueDispositions(runtime, now + 1000);
		expect(beforeDue).toBe(0);

		const afterDue = await settleDueDispositions(runtime, now + DISPOSITION_DEADLINE_MS + 1);
		expect(afterDue).toBe(1);

		const read = await readDisposition(runtime, key, {});
		expect(read?.payload.disposition).toBe("shelve");
		expect(read?.payload.decidedBy).toBe("timeout-default");
		expect(read?.payload.appliedDefault).toBe("shelve");
		expect(read?.item.answeredBy).toContain("超时默认");
	});

	test("留痕里写清 timing / disposition / 覆盖了什么 / 用了哪个默认值", async () => {
		const runtime = await setup();
		// 审计写在「下达人会话」里，所以必须有一个真实会话才验证得到留痕
		const root = await runtime.harness.root(BACKGROUND_CONTEXT, {
			agent: { model: { provider: "faux", modelId: "faux-1" } },
		});
		const { key } = await createDispositionPending(
			runtime,
			work({ conversationId: root.id, assignedByConversationId: root.id }),
			{ now: 1_000_000 },
		);
		await settleDisposition(runtime, { key, answer: "暂搁：30 分钟后再看", answeredBy: "老板" });

		const readBack = await readDisposition(runtime, key, { now: 1_000_000 });
		const item = readBack?.item;
		const audit = await runtime.harness.snapshot(AuditDoc, (item?.fromConversationId ?? root.id) as never, BACKGROUND_CONTEXT);
		const event = audit?.events.find((entry) => entry.ref === key);
		expect(event).toBeDefined();
		expect(event?.note).toContain("disposition=shelve");
		expect(event?.note).toContain("via=human");
		expect(event?.note).toContain("default=shelve");
		expect(event?.note).toContain("covered=pi.tool#42");
		expect(event?.note).toContain("tools=2/5");
		expect(event?.note).toContain("tokens=12000");
	});

	test("处置 key 带任务 id，便于按任务筛出", async () => {
		const key = dispositionKey("42", 1000);
		expect(key.startsWith("disp:")).toBe(true);
		expect(key).toContain("42");
	});
});

describe("D-01 读时兜底：不依赖看门狗也要到期生效", () => {
	test("只调用 readDisposition（不跑 watchdog）也会按暂搁结算到期项", async () => {
		const runtime = await setup();
		const createdAt = 1_000_000;
		const { key } = await createDispositionPending(runtime, work(), { now: createdAt });

		// ① 未到期：读回来仍是未定
		const notDue = await readDisposition(runtime, key, { now: createdAt + 1000 });
		expect(notDue?.payload.disposition).toBeUndefined();

		// ② 到期：**仅靠读**就结算（这里没有任何 watchdog 参与）
		const due = await readDisposition(runtime, key, { now: createdAt + DISPOSITION_DEADLINE_MS + 1 });
		expect(due?.payload.disposition).toBe("shelve");
		expect(due?.payload.decidedBy).toBe("timeout-default");
		// 超时兜底自带恢复条件（不能是空的，否则违反「必填」）
		expect(due?.payload.resumeCondition).toContain("30 分钟后提醒下达人");
	});

	test("listPending 也会触发读时兜底（所有读取路径同源）", async () => {
		const { listPending } = await import("../../src/company/escalation.ts");
		const runtime = await setup();
		const createdAt = 1_000_000;
		const { key } = await createDispositionPending(runtime, work(), { now: createdAt });

		// createdAt 已是「很久以前」，listPending 用真实 now → 必然到期
		const pending = await listPending(runtime, BACKGROUND_CONTEXT);
		expect(pending.some((item) => item.key === key), "结算后不该再留在未答复列表里").toBe(false);

		const read = await readDisposition(runtime, key, { now: Date.now() });
		expect(read?.payload.disposition).toBe("shelve");
	});

	test("已有人工结论的项不会被读时兜底覆盖（默认值可被事后推翻）", async () => {
		const runtime = await setup();
		const createdAt = 1_000_000;
		const { key } = await createDispositionPending(runtime, work(), { now: createdAt });
		await settleDisposition(runtime, { key, answer: "永久放弃", answeredBy: "老板", now: createdAt + 10 });

		const read = await readDisposition(runtime, key, { now: createdAt + DISPOSITION_DEADLINE_MS + 1 });
		expect(read?.payload.disposition, "人工结论必须保留").toBe("abandon");
		expect(read?.payload.decidedBy).toBe("human");
	});

	test("appliedAt 可断言（now 可注入，审计 D-06）", async () => {
		const runtime = await setup();
		const createdAt = 1_000_000;
		const dueAt = createdAt + DISPOSITION_DEADLINE_MS + 1;
		const { key } = await createDispositionPending(runtime, work(), { now: createdAt });

		await settleDueDispositions(runtime, dueAt);
		const read = await readDisposition(runtime, key, { now: dueAt });
		expect(read?.payload.appliedAt).toBe(dueAt);
		expect(read?.payload.appliedDefault).toBe("shelve");
	});
});

describe("D-02 level 必须是权限位，不是显示名", () => {
	test("下达人解析不到时不拿显示名冒充权限位", async () => {
		const runtime = await setup();
		const { key } = await createDispositionPending(
			runtime,
			work({ assignedBy: "某个外部人", assignedByConversationId: null, conversationId: 1 }),
			{ now: 1_000_000 },
		);
		const read = await readDisposition(runtime, key, { now: 1_000_000 });
		// 关键断言：**绝不会把显示名写进权限位**。
		// 这个 test fixture 没有 bootstrapCompany 的岗位表，反查不到 → 兜底到 ceo
		// （可答的一级），而不是留空串让这条处置永远没人答得了。
		expect(read?.item.level).not.toBe("某个外部人");
		expect(read?.item.level).toBe("ceo");
	});

	test("未知会话（反查不到）时兜底到 ceo，不写显示名也不留死锁", async () => {
		const runtime = await setup();
		const { key } = await createDispositionPending(
			runtime,
			work({ assignedBy: "外部人", assignedByConversationId: 999_999, conversationId: 999_999 }),
			{ now: 1_000_000 },
		);
		const read = await readDisposition(runtime, key, { now: 1_000_000 });
		// 空串会让 pending_list / answer_pending 的 level 精确匹配永远失败，
		// 这条处置谁都答不了、永久卡在待办里（违反决策 5）。
		expect(read?.item.level).toBe("ceo");
		expect(read?.item.from).toBe("外部人"); // 显示名只放在 from，不放 level
	});
});
