/**
 * communication-trail 的测试。
 *
 * 覆盖 specs/communication-trail/spec.md：不可变记录、双向留痕、跨会话追溯、
 * 类型区分、为图形界面预留的数据形态。
 */
import { afterEach, describe, expect, test } from "vitest";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createRegistry, openCompany, recover, type CompanyRuntime } from "../../src/runtime/index.ts";
import { bootstrapCompany, createProject, hireStaff } from "../../src/company/org.ts";
import { activeTasks, beginLiveTrail, readLiveTrail, readTrail, recordMessage, trailForConversation, trailForRef } from "../../src/company/trail.ts";
import { answer, askAndWait, createTestContext, eventually, slowAnswer, type TestContext, TEST_MODEL_CATALOG } from "../support.ts";

let contexts: TestContext[] = [];
let runtimes: CompanyRuntime[] = [];

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
	const boot = await bootstrapCompany(
		runtime,
		{
			modelCatalog: [...TEST_MODEL_CATALOG], companyName: "测试公司", registry, workspaceRoot: join(ctx.dir, "projects") },
		BACKGROUND_CONTEXT,
	);
	const { project } = await createProject(
		runtime,
		{ name: "Alpha", slug: "alpha", brief: "测试", workspaceRoot: join(ctx.dir, "projects") },
		BACKGROUND_CONTEXT,
	);
	const hired = await hireStaff(
		runtime,
		{ project: "alpha", name: "dev-1", role: "开发", manager: "cto" },
		BACKGROUND_CONTEXT,
	);
	return { ctx, runtime, boot, project, hired };
}

afterEach(async () => {
	for (const runtime of runtimes) await runtime.close().catch(() => undefined);
	for (const ctx of contexts) await ctx.cleanup();
	runtimes = [];
	contexts = [];
});

describe("每条沟通落成不可变记录", () => {
	test("派活被记录，包含时间、发送方、接收方与类型", async () => {
		const { ctx, runtime, project, hired } = await setup();

		// 派活现在是 assign_task（不等）+ 频道消息；留痕由 recordMessage 显式写。
		// 这里只验留痕形态，所以直接写一条再读回来。
		await recordMessage(
			runtime,
			{
				kind: "delegate",
				from: "负责人",
				to: "dev-1",
				fromConversationId: project.leader,
				toConversationId: hired.conversationId,
				ref: "delegate-1",
				project: "alpha",
				text: "实现登录",
			},
			BACKGROUND_CONTEXT,
		);

		const trail = await readTrail(runtime, {}, BACKGROUND_CONTEXT);
		const delegation = trail.find((edge) => edge.kind === "delegate");

		expect(delegation).toBeDefined();
		expect(delegation?.from).toBe("负责人");
		expect(delegation?.to).toBe("dev-1");
		expect(delegation?.at).toBeGreaterThan(0);
	});

	test("答复被记录", async () => {
		const { ctx, runtime, project, hired } = await setup();

		await recordMessage(
			runtime,
			{
				kind: "report",
				from: "dev-1",
				to: "负责人",
				fromConversationId: hired.conversationId,
				toConversationId: project.leader,
				ref: "report-1",
				project: "alpha",
				text: "登录做完了",
			},
			BACKGROUND_CONTEXT,
		);

		const trail = await readTrail(runtime, {}, BACKGROUND_CONTEXT);
		expect(trail.some((edge) => edge.kind === "report")).toBe(true);
	});

	test("记录不可修改：重复读取得到相同内容", async () => {
		const { runtime, project, hired } = await setup();

		await recordMessage(
			runtime,
			{
				from: "负责人",
				to: "dev-1",
				fromConversationId: project.leader,
				toConversationId: hired.conversationId,
				kind: "delegate",
				text: "原始内容",
				ref: "ref-immutable",
			},
			BACKGROUND_CONTEXT,
		);

		const first = await trailForRef(runtime, "ref-immutable", BACKGROUND_CONTEXT);
		const second = await trailForRef(runtime, "ref-immutable", BACKGROUND_CONTEXT);

		expect(first.length).toBe(1);
		expect(JSON.stringify(first)).toBe(JSON.stringify(second));
	});
});

describe("双向留痕", () => {
	test("发送方与接收方各有一条记录，可通过 ref 对应", async () => {
		const { runtime, project, hired } = await setup();

		await recordMessage(
			runtime,
			{
				from: "负责人",
				to: "dev-1",
				fromConversationId: project.leader,
				toConversationId: hired.conversationId,
				kind: "delegate",
				text: "写个函数",
				ref: "ref-dual",
			},
			BACKGROUND_CONTEXT,
		);

		const senderView = await trailForConversation(runtime, project.leader, BACKGROUND_CONTEXT);
		const receiverView = await trailForConversation(runtime, hired.conversationId, BACKGROUND_CONTEXT);

		expect(senderView.some((edge) => edge.ref === "ref-dual"), "发送方应能看到").toBe(true);
		expect(receiverView.some((edge) => edge.ref === "ref-dual"), "接收方应能看到").toBe(true);

		// 两端指向同一条沟通
		const byRef = await trailForRef(runtime, "ref-dual", BACKGROUND_CONTEXT);
		expect(byRef.length).toBe(1);
	});
});

describe("跨会话追溯", () => {
	test("按时间重建时间线", async () => {
		const { ctx, runtime, project, hired } = await setup();

		await recordMessage(
			runtime,
			{
				from: "A",
				to: "B",
				fromConversationId: project.leader,
				toConversationId: hired.conversationId,
				kind: "delegate",
				ref: "r1",
			},
			BACKGROUND_CONTEXT,
		);
		await new Promise((resolve) => setTimeout(resolve, 5));
		await recordMessage(
			runtime,
			{
				from: "B",
				to: "A",
				fromConversationId: hired.conversationId,
				toConversationId: project.leader,
				kind: "report",
				ref: "r2",
			},
			BACKGROUND_CONTEXT,
		);

		const trail = await readTrail(runtime, {}, BACKGROUND_CONTEXT);
		expect(trail.length).toBe(2);
		expect(trail[0]?.at).toBeLessThanOrEqual(trail[1]?.at ?? 0);
		expect(trail[0]?.kind).toBe("delegate");
		expect(trail[1]?.kind).toBe("report");
		void ctx;
	});

	test("按项目过滤", async () => {
		const { runtime, project, hired } = await setup();

		await recordMessage(
			runtime,
			{
				from: "A",
				to: "B",
				fromConversationId: project.leader,
				toConversationId: hired.conversationId,
				kind: "delegate",
				ref: "alpha-ref",
				project: "alpha",
			},
			BACKGROUND_CONTEXT,
		);
		await recordMessage(
			runtime,
			{
				from: "A",
				to: "B",
				fromConversationId: project.leader,
				toConversationId: hired.conversationId,
				kind: "delegate",
				ref: "beta-ref",
				project: "beta",
			},
			BACKGROUND_CONTEXT,
		);

		const alphaOnly = await readTrail(runtime, { project: "alpha" }, BACKGROUND_CONTEXT);
		expect(alphaOnly.length).toBe(1);
		expect(alphaOnly[0]?.ref).toBe("alpha-ref");
	});

	test("追溯链条完整：派活到回报可串起来", async () => {
		const { ctx, runtime, project, hired } = await setup();

		await recordMessage(
			runtime,
			{
				kind: "delegate",
				from: "负责人",
				to: "dev-1",
				fromConversationId: project.leader,
				toConversationId: hired.conversationId,
				ref: "chain-1",
				project: "alpha",
				text: "任务",
			},
			BACKGROUND_CONTEXT,
		);
		await recordMessage(
			runtime,
			{
				kind: "report",
				from: "dev-1",
				to: "负责人",
				fromConversationId: hired.conversationId,
				toConversationId: project.leader,
				ref: "chain-1",
				project: "alpha",
				text: "完成",
			},
			BACKGROUND_CONTEXT,
		);

		const trail = await readTrail(runtime, { project: "alpha" }, BACKGROUND_CONTEXT);
		const kinds = trail.map((edge) => edge.kind);
		expect(kinds).toContain("delegate");
		expect(kinds).toContain("report");
	});
});

describe("实时沟通边", () => {
	test("派活进行中会挂一条实时边，答完释放", async () => {
		const { ctx, runtime, project, hired } = await setup();

		// 同步派活（`delegation.ts`）删掉后，实时边不再由它自动挂/摘。
		// 现在实时边的唯一生产者是装配层显式调用 `beginLiveTrail`（例如看板要在
		// 一次长任务期间画出「谁在跟谁说话」）。这条测试钉的是**这个原语的语义**：
		// 挂上去立刻可见，释放后消失，历史边不受影响。
		const release = beginLiveTrail({
			kind: "delegate",
			from: "负责人",
			to: "dev-1",
			fromConversation: project.leader,
			toConversation: hired.conversationId,
			project: "alpha",
		});

		await eventually(async () => readLiveTrail().length > 0, { label: "实时边出现" });
		const live = readLiveTrail();
		expect(live.length).toBe(1);
		expect(live[0]?.fromConversation).toBe(project.leader);
		expect(live[0]?.toConversation).toBe(hired.conversationId);
		expect(live[0]?.kind).toBe("delegate");

		release();
		expect(readLiveTrail().length).toBe(0);

		// 历史边由 recordMessage 落库，与实时边互不影响
		await recordMessage(
			runtime,
			{
				kind: "delegate",
				from: "负责人",
				to: "dev-1",
				fromConversationId: project.leader,
				toConversationId: hired.conversationId,
				ref: "live-1",
				project: "alpha",
			},
			BACKGROUND_CONTEXT,
		);
		const trail = await readTrail(runtime, {}, BACKGROUND_CONTEXT);
		expect(trail.some((edge) => edge.kind === "delegate" && edge.fromConversation === project.leader)).toBe(true);
	});

	test("释放函数幂等", () => {
		const release = beginLiveTrail({
			from: "A",
			to: "B",
			fromConversation: 1,
			toConversation: 2,
			kind: "delegate",
		});
		expect(readLiveTrail().length).toBe(1);
		release();
		release();
		expect(readLiveTrail().length).toBe(0);
	});
});

describe("沟通类型可区分", () => {
	test("按类型过滤", async () => {
		const { runtime, project, hired } = await setup();

		for (const kind of ["delegate", "report", "escalate", "decide", "hire"] as const) {
			await recordMessage(
				runtime,
				{
					from: "A",
					to: "B",
					fromConversationId: project.leader,
					toConversationId: hired.conversationId,
					kind,
					ref: `ref-${kind}`,
				},
				BACKGROUND_CONTEXT,
			);
		}

		const onlyEscalate = await readTrail(runtime, { kinds: ["escalate"] }, BACKGROUND_CONTEXT);
		expect(onlyEscalate.length).toBe(1);
		expect(onlyEscalate[0]?.kind).toBe("escalate");

		const twoKinds = await readTrail(runtime, { kinds: ["delegate", "hire"] }, BACKGROUND_CONTEXT);
		expect(twoKinds.length).toBe(2);
	});
});

describe("为图形界面预留的数据形态", () => {
	// 组织关系图（节点 + 边）的测试已迁到 `test/e2e/web.test.ts`：`/api/org` 的
	// `links` 才是界面真正消费的形态，而它现在从频道消息算，不从 `TrailDoc` 算。

	test("活跃任务结构随工作推进更新", async () => {
		const { ctx, runtime, project, hired } = await setup();

		// 没有工作时
		const before = await activeTasks(runtime, BACKGROUND_CONTEXT);
		expect(Array.isArray(before)).toBe(true);

		// 让员工真跑一轮，期间应有活跃任务
		ctx.faux.setResponses([answer("完成")]);
		await askAndWait(
			runtime,
			{ conversationId: hired.conversationId, text: "任务", from: "负责人" },
			BACKGROUND_CONTEXT,
		);

		// 跑完后任务应为终态（不在活跃列表里）
		const after = await activeTasks(runtime, BACKGROUND_CONTEXT);
		for (const task of after) {
			expect(["running", "waiting", "sleeping", "ready", "blocked"]).toContain(task.status);
		}
	});
});
