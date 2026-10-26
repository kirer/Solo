/**
 * 投递回执（裁决 B4）：`deliver()` 只保证「进队了」，不等于「被处理了」。
 *
 * 这里钉三件事：
 * 1. 投递后消息上留下 `deliveredTo`（能反查到具体 submission）；
 * 2. 结算成 `unanswered` 的消息会被看门狗重投，并写一条 `app.alert`；
 * 3. 重投次数有上限，耗尽后只告一次，之后不再每轮重复——「放弃」也要安静。
 */
import { afterEach, expect, test } from "vitest";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createRegistry, openCompany, recover, type CompanyRuntime } from "../../src/runtime/index.ts";
import { bootstrapCompany, createProject, hireStaff } from "../../src/company/org.ts";
import { ensureAllChannels, postToChannel, readChannel } from "../../src/company/channels.ts";
import { OWNER_ID } from "../../src/domain/channels.ts";
import { createEscalationTask } from "../../src/company/escalation.ts";
import { ChannelDoc } from "../../src/company/channels-doc.ts";
import type { ChannelState } from "../../src/domain/channels.ts";
import { runWatchdogPass, unansweredDeliveryCounts } from "../../src/company/watchdog.ts";
import { createTestContext, TEST_MODEL_CATALOG, type TestContext } from "../support.ts";

const contexts: TestContext[] = [];
const runtimes: CompanyRuntime[] = [];

afterEach(async () => {
	for (const runtime of runtimes) await runtime.close().catch(() => undefined);
	for (const ctx of contexts) await ctx.cleanup();
	runtimes.length = 0;
	contexts.length = 0;
});

async function setup() {
	const ctx = await createTestContext();
	contexts.push(ctx);
	const registry = createRegistry();
	const runtime = await openCompany(
		{ databasePath: ctx.databasePath, models: ctx.models, registry },
		BACKGROUND_CONTEXT,
	);
	runtimes.push(runtime);
	await recover(runtime, BACKGROUND_CONTEXT);
	const escalationTask = createEscalationTask(runtime);
	registry.install({ name: "escalation", tasks: [escalationTask] } as never);
	const booted = await bootstrapCompany(
		runtime,
		{
			modelCatalog: [...TEST_MODEL_CATALOG],
			companyName: "回执测试公司",
			registry,
			workspaceRoot: join(ctx.dir, "projects"),
			escalationTask,
		},
		BACKGROUND_CONTEXT,
	);
	const { project } = await createProject(
		runtime,
		{ name: "Receipt", slug: "receipt", brief: "回执", workspaceRoot: join(ctx.dir, "projects") },
		BACKGROUND_CONTEXT,
	);
	await hireStaff(runtime, { project: "receipt", name: "甲", role: "开发", registry }, BACKGROUND_CONTEXT);
	await ensureAllChannels(runtime, BACKGROUND_CONTEXT);
	return { ctx, runtime, registry, booted, project };
}

test("deliver 写了 deliveredTo，且能反查到 submission 状态", async () => {
	const { runtime, project } = await setup();
	const posted = await postToChannel(
		runtime,
		"proj:receipt",
		{ from: OWNER_ID, fromLabel: "老板", kind: "chat", text: "看下进度", mentions: [project.leader] },
		{ context: BACKGROUND_CONTEXT },
	);
	expect(posted.delivery?.delivered).toContain(project.leader);
	expect(posted.delivery?.unanswered).toEqual([]);

	const channel = await readChannel(runtime, "proj:receipt", BACKGROUND_CONTEXT);
	const message = channel?.messages.at(-1);
	const receipt = message?.deliveredTo?.[0];
	expect(receipt).toBeDefined();
	expect(receipt?.conversationId).toBe(project.leader);
	expect(typeof receipt?.submissionId).toBe("number");

	const submission = await runtime.harness.submission(receipt?.submissionId as never, BACKGROUND_CONTEXT);
	expect(submission).toBeDefined();
	const record = await submission?.status(BACKGROUND_CONTEXT);
	console.log("[probe] status =", record?.status);
});

test("看门狗扫描不炸，计数可读", async () => {
	const { runtime } = await setup();
	const result = await runWatchdogPass(runtime, {
		context: BACKGROUND_CONTEXT,
		immediate: false,
		redeliverMs: 0,
	});
	expect(result.alerts.filter((alert) => alert.action === "redeliver")).toEqual([]);
	const counts = await unansweredDeliveryCounts(runtime, BACKGROUND_CONTEXT);
	expect(counts.size).toBeGreaterThanOrEqual(0);
});

test("unanswered → 看门狗重投并写 app.alert", async () => {
	const { runtime, project } = await setup();
	const posted = await postToChannel(
		runtime,
		"proj:receipt",
		{ from: OWNER_ID, fromLabel: "老板", kind: "chat", text: "这条要静默死亡", mentions: [project.leader] },
		{ context: BACKGROUND_CONTEXT },
	);
	const channel = await readChannel(runtime, "proj:receipt", BACKGROUND_CONTEXT);
	const message = channel?.messages.at(-1);
	const submissionId = message?.deliveredTo?.[0]?.submissionId as number;
	// 手动把它结算成 unanswered（等价于 no_model / abort）
	await runtime.harness.commit(async (tx) => {
		tx.settleSubmission(submissionId as never, { status: "unanswered", reason: "no_model" });
	}, BACKGROUND_CONTEXT);
	const countsBefore = await unansweredDeliveryCounts(runtime, BACKGROUND_CONTEXT);
	console.log("[probe] countsBefore =", [...countsBefore.entries()]);
	expect(countsBefore.get(project.leader)).toBe(1);

	const result = await runWatchdogPass(runtime, {
		context: BACKGROUND_CONTEXT,
		immediate: false,
		redeliverMs: 0,
	});
	const redelivered = result.alerts.filter((alert) => alert.action === "redeliver");
	console.log("[probe] redeliver alerts =", redelivered.map((a) => `${a.giveUp}:${a.attempt}:${a.message}`));
	expect(redelivered.length).toBe(1);
	expect(redelivered[0]?.giveUp).toBe(false);

	// 重投后消息上多了一份回执
	const after = await readChannel(runtime, "proj:receipt", BACKGROUND_CONTEXT);
	const afterMessage = after?.messages.find((entry) => entry.seq === message?.seq);
	console.log("[probe] receipts =", afterMessage?.deliveredTo);
	expect(afterMessage?.deliveredTo?.length).toBe(2);
	void posted;
});

test("重投上限：全 unanswered → 只告一次 giveUp，之后沉默", async () => {
	const { runtime, project } = await setup();
	await postToChannel(
		runtime,
		"proj:receipt",
		{ from: OWNER_ID, fromLabel: "老板", kind: "chat", text: "永远没人处理", mentions: [project.leader] },
		{ context: BACKGROUND_CONTEXT },
	);
	const channel = await readChannel(runtime, "proj:receipt", BACKGROUND_CONTEXT);
	const message = channel?.messages.at(-1);
	const seq = message?.seq as number;
	const firstId = message?.deliveredTo?.[0]?.submissionId as number;

	// 伪造「已重投 2 次」：造 2 个 fake submission 并全部结算成 unanswered。
	const extra: number[] = [];
	for (let i = 0; i < 2; i += 1) {
		const record = await runtime.harness.commit(
			async (tx) => tx.createSubmission({ type: "input", conversationId: project.leader as never, requestId: `probe:${i}`, status: "queued" } as never),
			BACKGROUND_CONTEXT,
		);
		extra.push(Number(record.id));
	}
	await runtime.harness.commit(async (tx) => {
		tx.settleSubmission(firstId as never, { status: "unanswered", reason: "no_model" });
		for (const id of extra) tx.settleSubmission(id as never, { status: "unanswered", reason: "no_model" });
	}, BACKGROUND_CONTEXT);
	await runtime.harness.commit(async (tx) => {
		const doc = (await tx.doc(ChannelDoc)) as ChannelState;
		const target = doc.channels["proj:receipt"]?.messages.find((entry) => entry.seq === seq);
		if (target !== undefined) {
			target.deliveredTo = [
				{ conversationId: project.leader, submissionId: firstId },
				...extra.map((id) => ({ conversationId: project.leader, submissionId: id })),
			];
		}
	}, BACKGROUND_CONTEXT);

	const pass1 = await runWatchdogPass(runtime, { context: BACKGROUND_CONTEXT, immediate: false, redeliverMs: 0 });
	const p1 = pass1.alerts.filter((a) => a.action === "redeliver");
	expect(p1.length).toBe(1);
	expect(p1[0]?.giveUp).toBe(true);
	expect(p1[0]?.attempt).toBe(3);
	const pass2 = await runWatchdogPass(runtime, { context: BACKGROUND_CONTEXT, immediate: false, redeliverMs: 0 });
	const p2 = pass2.alerts.filter((a) => a.action === "redeliver");
	expect(p2.length).toBe(0);
});
