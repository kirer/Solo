/**
 * 缺陷 B：升级路径绕过 CEO 直落老板。
 *
 * 现象（老板报告）：老板看板出现待拍板条目，但 CEO 待决队列为空——
 * 条目未经 CEO 直接跳到老板。
 *
 * 根因（已复核）：
 * 1. `escalation.ts` 的 `initial`：`startAtOwner || topic === "company-level"` → 直接
 *    `ask-owner`，跳过 ask-manager 与 ask-ceo；且 path 写死 `[from, "ceo"]`，
 *    **路径里有 ceo 却从没问过 CEO**（「看起来经过了、实际没经过」）。
 * 2. `startEscalation`：`startAtOwner = ownerLevel === "owner"`，而
 *    `decideOwner(company-level)` 恒为 owner，于是**任何**声明 company-level 的上报
 *    都被译成 startAtOwner=true，绕过了第 1 点已改的 initial 分支。
 *
 * 修法（本文件锁死）：
 * - 非 CEO 声明 company-level → 先落 **ask-ceo 复核**，老板队列不出现；
 * - CEO 确认 → 才进老板队列，且 path 含真实的 ceo；
 * - CEO 接管 → 老板队列消失，回到 CEO 处理；
 * - CEO 自己发起 → 仍可直达老板（这是 CEO 的职责，不是绕过）。
 *
 * 全部用临时库，绝不碰真实 workspace/company.sqlite。
 */
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
	BACKGROUND_CONTEXT,
	createRegistry,
	openCompany,
	recover,
	type CompanyRuntime,
} from "../../src/runtime/index.ts";
import { bootstrapCompany, createProject, escalateUp, readCompany } from "../../src/company/org.ts";
import {
	answerPending,
	createEscalationTask,
	decisionOwnerOfItem,
	listPending,
	PendingDoc,
	startEscalation,
	takeOverPendingAtCeo,
} from "../../src/company/escalation.ts";
import { buildOrgView } from "../../src/server/org-view.ts";
import { createTestContext, eventually, type TestContext, TEST_MODEL_CATALOG } from "../support.ts";

const contexts: TestContext[] = [];
const runtimes: CompanyRuntime[] = [];

afterEach(async () => {
	for (const runtime of runtimes.splice(0)) await runtime.close().catch(() => undefined);
	for (const ctx of contexts.splice(0)) await ctx.cleanup();
});

async function setup(): Promise<{
	runtime: CompanyRuntime;
	roles: Record<string, number>;
	project: { leader: number; leaderName: string };
	escalationTask: ReturnType<typeof createEscalationTask>;
}> {
	const ctx = await createTestContext();
	contexts.push(ctx);
	const registry = createRegistry();
	const runtime = await openCompany({ databasePath: ctx.databasePath, models: ctx.models, registry }, BACKGROUND_CONTEXT);
	runtimes.push(runtime);
	await recover(runtime, BACKGROUND_CONTEXT);
	const escalationTask = createEscalationTask(runtime);
	registry.install({ name: "escalation", tasks: [escalationTask] } as never);
	await bootstrapCompany(
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
	const { project } = await createProject(
		runtime,
		{ name: "Alpha", slug: "alpha", brief: "测试", workspaceRoot: join(ctx.dir, "projects") },
		BACKGROUND_CONTEXT,
	);
	const state = await readCompany(runtime, BACKGROUND_CONTEXT);
	return { runtime, roles: (state?.roles ?? {}) as Record<string, number>, project, escalationTask };
}

/** 老板侧「待你拍板」条目（org 视图口径：forYou）。 */
async function ownerQueue(runtime: CompanyRuntime) {
	const org = await buildOrgView(runtime, BACKGROUND_CONTEXT);
	return org.pending.filter((item) => item.forYou);
}

/** CEO 待决队列条目（按 decisionOwner 口径，与 pending_list 一致）。 */
async function ceoQueue(runtime: CompanyRuntime, ceoId: number) {
	const items = await listPending(runtime, BACKGROUND_CONTEXT);
	void ceoId;
	return items.filter((item) => decisionOwnerOfItem(item) === "ceo");
}

describe("缺陷 B：非 CEO 声明 company-level 不再直达老板", () => {
	test("CTO 声明 company-level → CEO 队列出现、老板队列不出现", async () => {
		const { runtime, roles, escalationTask } = await setup();
		const ctoId = roles.cto as number;

		await startEscalation(
			runtime,
			escalationTask,
			{
				question: "要不要砍掉 Alpha 项目？",
				from: "CTO",
				fromConversationId: ctoId,
				manager: "ceo",
				topic: "company-level",
				escalationKey: "B-1",
			},
			BACKGROUND_CONTEXT,
		);

		await eventually(
			async () => (await listPending(runtime, BACKGROUND_CONTEXT)).some((item) => item.key === "B-1"),
			{ label: "待办出现", timeoutMs: 10_000 },
		);

		// 核心断言：落在 CEO，不是老板
		const items = await listPending(runtime, BACKGROUND_CONTEXT);
		const item = items.find((entry) => entry.key === "B-1");
		expect(item?.level).toBe("ceo");
		expect(await ceoQueue(runtime, roles.ceo as number)).toHaveLength(1);
		expect(await ownerQueue(runtime)).toHaveLength(0);
	}, 30_000);

	test("经真实上报入口 escalateUp（非直调）同样不直达老板", async () => {
		const { runtime, roles, escalationTask } = await setup();
		const ctoId = roles.cto as number;

		const reply = await escalateUp(
			runtime,
			{ question: "要不要对客户承诺三个月上线？", from: "CTO", conversationId: ctoId, topic: "company-level" },
			escalationTask,
			BACKGROUND_CONTEXT,
		);
		// 回复文案也不能再骗人说「已上报老板」
		expect(reply).toContain("CEO");
		expect(reply).not.toContain("已上报老板");

		await eventually(
			async () => (await listPending(runtime, BACKGROUND_CONTEXT)).some((item) => item.question.includes("三个月上线")),
			{ label: "待办出现", timeoutMs: 10_000 },
		);
		expect(await ownerQueue(runtime)).toHaveLength(0);
	}, 30_000);

	test("来源可追溯：CEO 站的条目带 trace，说明这是自证的声明请 CEO 复核", async () => {
		const { runtime, roles, escalationTask } = await setup();
		await startEscalation(
			runtime,
			escalationTask,
			{
				question: "要不要改公司名？",
				from: "CTO",
				fromConversationId: roles.cto as number,
				topic: "company-level",
				escalationKey: "B-trace",
			},
			BACKGROUND_CONTEXT,
		);
		await eventually(
			async () => (await listPending(runtime, BACKGROUND_CONTEXT)).some((item) => item.key === "B-trace"),
			{ label: "待办出现", timeoutMs: 10_000 },
		);
		const item = (await listPending(runtime, BACKGROUND_CONTEXT)).find((entry) => entry.key === "B-trace");
		expect(item?.trace?.declaredTopic).toBe("company-level");
		expect(item?.trace?.ceoReviewed).toBe(false);
		expect(item?.trace?.note).toContain("复核");
	}, 30_000);
});

describe("缺陷 B：CEO 确认后才进老板队列，path 真实", () => {
	test("CEO 确认 escalate → 老板队列出现，path 含真实的 ceo 一站", async () => {
		const { runtime, roles, escalationTask } = await setup();
		await startEscalation(
			runtime,
			escalationTask,
			{
				question: "要不要砍掉 Alpha 项目？",
				from: "CTO",
				fromConversationId: roles.cto as number,
				topic: "company-level",
				escalationKey: "B-2",
			},
			BACKGROUND_CONTEXT,
		);
		await eventually(
			async () => (await listPending(runtime, BACKGROUND_CONTEXT)).some((item) => item.key === "B-2"),
			{ label: "CEO 站出现", timeoutMs: 10_000 },
		);
		expect(await ownerQueue(runtime)).toHaveLength(0);

		// CEO 复核确认
		expect(
			await answerPending(runtime, { key: "B-2", answer: "确实只有老板能定。", answeredBy: "ceo", escalate: true }, BACKGROUND_CONTEXT),
		).toBe(true);

		await eventually(
			async () => (await listPending(runtime, BACKGROUND_CONTEXT)).some((item) => item.key === "B-2" && item.level === "owner"),
			{ label: "递到老板站", timeoutMs: 10_000 },
		);
		expect(await ownerQueue(runtime)).toHaveLength(1);

		// 来源可追溯：owner 条目带「CEO 已复核」的说明
		const ownerItem = (await listPending(runtime, BACKGROUND_CONTEXT)).find(
			(entry) => entry.key === "B-2" && entry.level === "owner",
		);
		expect(ownerItem?.trace?.ceoReviewed).toBe(true);
	}, 30_000);

	test("CEO 自己发起 → 仍可直达老板（这是职责，不是绕过）", async () => {
		const { runtime, roles, escalationTask } = await setup();
		await startEscalation(
			runtime,
			escalationTask,
			{
				question: "要不要对外承诺三个月上线？",
				from: "CEO",
				fromConversationId: roles.ceo as number,
				startAtOwner: true,
				escalationKey: "B-ceo-direct",
			},
			BACKGROUND_CONTEXT,
		);
		await eventually(
			async () => (await listPending(runtime, BACKGROUND_CONTEXT)).some((item) => item.key === "B-ceo-direct"),
			{ label: "老板待办出现", timeoutMs: 10_000 },
		);
		expect(await ownerQueue(runtime)).toHaveLength(1);
	}, 30_000);
});

describe("缺陷 B：CEO 接管老板级待办", () => {
	test("CEO 接管 → 老板队列消失、CEO 队列出现、审计有记录", async () => {
		const { runtime, roles, escalationTask } = await setup();
		const { AuditDoc } = await import("../../src/company/docs.ts");
		await startEscalation(
			runtime,
			escalationTask,
			{
				question: "要不要砍掉 Alpha 项目？",
				from: "CTO",
				fromConversationId: roles.cto as number,
				topic: "company-level",
				escalationKey: "B-3",
			},
			BACKGROUND_CONTEXT,
		);
		await eventually(
			async () => (await listPending(runtime, BACKGROUND_CONTEXT)).some((item) => item.key === "B-3"),
			{ label: "CEO 站出现", timeoutMs: 10_000 },
		);
		await answerPending(runtime, { key: "B-3", answer: "递老板。", answeredBy: "ceo", escalate: true }, BACKGROUND_CONTEXT);
		await eventually(
			async () => (await ownerQueue(runtime)).length === 1,
			{ label: "老板待办出现", timeoutMs: 10_000 },
		);

		// CEO 接管（认为这在自己授权范围内）
		const outcome = await takeOverPendingAtCeo(
			runtime,
			{ key: "B-3", reason: "项目去留我已获授权，不必占用老板注意力", operatorLevel: "ceo" },
			BACKGROUND_CONTEXT,
		);
		expect(outcome.ok).toBe(true);
		if (!outcome.ok) throw new Error("unreachable");
		expect(outcome.changed).toBe(true);
		expect(outcome.item.level).toBe("ceo");
		expect(outcome.item.takenOver?.reason).toContain("已获授权");

		// 老板队列消失、CEO 队列出现
		expect(await ownerQueue(runtime)).toHaveLength(0);
		expect((await ceoQueue(runtime, roles.ceo as number)).some((item) => item.key === "B-3")).toBe(true);

		// 审计有记录
		const { BACKGROUND_CONTEXT: CTX } = await import("../../src/runtime/index.ts");
		const audit = await runtime.harness.snapshot(AuditDoc, roles.ceo as never, CTX);
		const event = audit?.events.find((entry) => entry.note?.startsWith("taken-over"));
		expect(event).toMatchObject({ type: "dispose", from: "ceo", ref: "B-3@owner" });
	}, 40_000);

	test("接管是幂等的：重复接管不报错、不重复留痕", async () => {
		const { runtime, roles, escalationTask } = await setup();
		await startEscalation(
			runtime,
			escalationTask,
			{
				question: "要不要砍掉 Alpha 项目？",
				from: "CTO",
				fromConversationId: roles.cto as number,
				topic: "company-level",
				escalationKey: "B-4",
			},
			BACKGROUND_CONTEXT,
		);
		await eventually(
			async () => (await listPending(runtime, BACKGROUND_CONTEXT)).some((item) => item.key === "B-4"),
			{ label: "CEO 站出现", timeoutMs: 10_000 },
		);
		await answerPending(runtime, { key: "B-4", answer: "递老板。", answeredBy: "ceo", escalate: true }, BACKGROUND_CONTEXT);
		await eventually(async () => (await ownerQueue(runtime)).length === 1, { label: "老板待办出现", timeoutMs: 10_000 });

		const first = await takeOverPendingAtCeo(runtime, { key: "B-4", operatorLevel: "ceo" }, BACKGROUND_CONTEXT);
		expect(first.ok && first.changed).toBe(true);

		const second = await takeOverPendingAtCeo(runtime, { key: "B-4", operatorLevel: "ceo" }, BACKGROUND_CONTEXT);
		expect(second.ok).toBe(true);
		if (!second.ok) throw new Error("unreachable");
		expect(second.changed).toBe(false); // 幂等命中
	}, 40_000);

	test("无权限：非 CEO 不能接管老板级待办", async () => {
		const { runtime, roles, escalationTask } = await setup();
		await startEscalation(
			runtime,
			escalationTask,
			{
				question: "要不要砍掉 Alpha 项目？",
				from: "CTO",
				fromConversationId: roles.cto as number,
				topic: "company-level",
				escalationKey: "B-5",
			},
			BACKGROUND_CONTEXT,
		);
		await eventually(
			async () => (await listPending(runtime, BACKGROUND_CONTEXT)).some((item) => item.key === "B-5"),
			{ label: "CEO 站出现", timeoutMs: 10_000 },
		);
		await answerPending(runtime, { key: "B-5", answer: "递老板。", answeredBy: "ceo", escalate: true }, BACKGROUND_CONTEXT);
		await eventually(async () => (await ownerQueue(runtime)).length === 1, { label: "老板待办出现", timeoutMs: 10_000 });

		const outcome = await takeOverPendingAtCeo(runtime, { key: "B-5", operatorLevel: "cto" }, BACKGROUND_CONTEXT);
		expect(outcome.ok).toBe(false);
		if (outcome.ok) throw new Error("unreachable");
		expect(outcome.code).toBe("forbidden");
		expect(outcome.reason).toContain("只有 CEO");
		// 老板队列没变
		expect(await ownerQueue(runtime)).toHaveLength(1);
	}, 40_000);
});

describe("缺陷 B：排查过的其他「直达老板」候选路径", () => {
	/**
	 * 诊断文件列出的候选：`answer_pending` 的 `escalate: true`。
	 *
	 * 复核结论：**不是绕过**。它只在调用者自己那一级把条目标记 escalate，
	 * 状态机再沿 ask-manager → ask-ceo → ask-owner 逐级推进。
	 * 这条测试把结论钉住：CTO 在自己的层级 escalate，条目只会到 CEO，不会到老板。
	 */
	test("answer_pending + escalate 逐级上走：CTO 升级后停在 CEO，不直达老板", async () => {
		const { runtime, roles, escalationTask } = await setup();
		const ctoId = roles.cto as number;

		// CTO 管辖范围内的 domain 类问题（落在 cto 级）
		await startEscalation(
			runtime,
			escalationTask,
			{
				question: "日志要用 pino 还是 winston？",
				from: "dev",
				fromConversationId: ctoId,
				manager: "cto",
				topic: "domain",
				escalationKey: "B-esc-1",
			},
			BACKGROUND_CONTEXT,
		);
		await eventually(
			async () => (await listPending(runtime, BACKGROUND_CONTEXT)).some((item) => item.key === "B-esc-1"),
			{ label: "CTO 站出现", timeoutMs: 10_000 },
		);

		// CTO 拍不了 → escalate（这是 CTO 自己层级的升级，不是直达老板）
		expect(
			await answerPending(runtime, { key: "B-esc-1", answer: "拿不准。", answeredBy: "cto", escalate: true }, BACKGROUND_CONTEXT),
		).toBe(true);

		// 只到 CEO，不到老板
		await eventually(
			async () => (await listPending(runtime, BACKGROUND_CONTEXT)).some((item) => item.key === "B-esc-1" && item.level === "ceo"),
			{ label: "升到 CEO", timeoutMs: 10_000 },
		);
		expect(await ownerQueue(runtime)).toHaveLength(0);
	}, 40_000);

	/**
	 * 诊断文件列出的候选：没有升级任务时 `recordPendingDirectly` 兜底落库。
	 * 复核结论：它**写死 level: "ceo"**，老板永远不是兜底接收人。不是绕过。
	 */
	test("没有升级任务时的兜底落库：只落 CEO，不落老板", async () => {
		const { runtime, roles } = await setup();
		const ctoId = roles.cto as number;
		// 不传 escalationTask → 走 recordPendingDirectly
		const reply = await escalateUp(
			runtime,
			{ question: "兜底路径测试", from: "CTO", conversationId: ctoId, topic: "company-level" },
			undefined,
			BACKGROUND_CONTEXT,
		);
		expect(reply).toContain("已记录上报");
		const items = await listPending(runtime, BACKGROUND_CONTEXT);
		expect(items.every((item) => item.level === "ceo")).toBe(true);
		expect(await ownerQueue(runtime)).toHaveLength(0);
	}, 30_000);
});

describe("缺陷 B：存量老板级待办仍可被识别与处置（向后兼容）", () => {
	test("手工造的旧式 owner 条目（无 trace）能被 CEO 接管、也能被老板驳回", async () => {
		const { runtime, roles } = await setup();
		const ceoId = roles.ceo as number;

		// 模拟「修复前就挂在老板级」的存量数据：没有 trace、没有 disposed。
		await runtime.harness.commit(async (tx) => {
			const pending = await tx.doc(PendingDoc);
			pending.items.push(
				{
					key: "legacy-owner-1",
					question: "历史遗留：要不要搬家？",
					level: "owner",
					from: "CEO",
					fromConversationId: ceoId,
					askedAt: Date.now(),
					decisionOwner: "owner",
				},
				{
					key: "legacy-owner-2",
					question: "历史遗留：要不要改名？",
					level: "owner",
					from: "CEO",
					fromConversationId: ceoId,
					askedAt: Date.now(),
					decisionOwner: "owner",
				},
			);
		}, BACKGROUND_CONTEXT);

		expect(await ownerQueue(runtime)).toHaveLength(2);

		// ① 存量条目能被 CEO 接管
		const taken = await takeOverPendingAtCeo(runtime, { key: "legacy-owner-1", operatorLevel: "ceo" }, BACKGROUND_CONTEXT);
		expect(taken.ok).toBe(true);

		// ② 存量条目也能被老板正常驳回（走缺陷 A 的处置通道）
		const { disposePending } = await import("../../src/company/escalation.ts");
		const rejected = await disposePending(
			runtime,
			{ key: "legacy-owner-2", status: "rejected", reason: "存量清理", disposedBy: "owner", operatorLevel: "owner" },
			BACKGROUND_CONTEXT,
		);
		expect(rejected.ok).toBe(true);

		// 两条都不再占老板看板
		expect(await ownerQueue(runtime)).toHaveLength(0);
	}, 40_000);
});
