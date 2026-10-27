/**
 * 受理回执投影进频道视图（ACCEPTANCE-dino 二.4）。
 *
 * 痛点：`app.ack` 是写进**对方会话流**的 `write` 条目，`/api/feed/:id` 能看见，
 * 频道视图看不见——老板在自己发的消息下面**没有任何反馈**。
 *
 * 这里钉三件事：
 * 1. 老板发一条频道消息，`GET /api/channels/:id` 那条消息带 `acks`，`plan` 符合预期；
 * 2. `messageSeq` 不匹配的回执**不会串**到别的消息上（关联网是这条测试守的）；
 * 3. 别的频道、别的会话的回执不会漏进来。
 */
import { afterEach, expect, test } from "vitest";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createRegistry, openCompany, recover, type CompanyRuntime } from "../../src/runtime/index.ts";
import { bootstrapCompany, COMPANY_TASKS_EXTENSION, createProject, hireStaff } from "../../src/company/org.ts";
import { ensureAllChannels } from "../../src/company/channels.ts";
import { createEscalationTask } from "../../src/company/escalation.ts";
import { serve, type Server } from "../../src/server/http.ts";
import type { ChannelView } from "../../src/server/channels-view.ts";
import { createTestContext, eventually, slowAnswer, answer, TEST_MODEL_CATALOG, type TestContext } from "../support.ts";

let contexts: TestContext[] = [];
let runtimes: CompanyRuntime[] = [];
let servers: Server[] = [];

afterEach(async () => {
	for (const server of servers) await server.close().catch(() => undefined);
	for (const runtime of runtimes) await runtime.close().catch(() => undefined);
	for (const ctx of contexts) await ctx.cleanup();
	servers = [];
	runtimes = [];
	contexts = [];
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

	registry.install(COMPANY_TASKS_EXTENSION);
	const escalationTask = createEscalationTask(runtime);
	registry.install({ name: "escalation", tasks: [escalationTask] } as never);

	await bootstrapCompany(
		runtime,
		{
			companyName: "回执测试公司",
			modelCatalog: [...TEST_MODEL_CATALOG],
			registry,
			workspaceRoot: join(ctx.dir, "projects"),
			escalationTask,
		},
		BACKGROUND_CONTEXT,
	);
	const { project } = await createProject(
		runtime,
		{ name: "Ack", slug: "ack", brief: "回执", workspaceRoot: join(ctx.dir, "projects") },
		BACKGROUND_CONTEXT,
	);
	await hireStaff(runtime, { project: "ack", name: "甲", role: "开发", registry }, BACKGROUND_CONTEXT);
	await ensureAllChannels(runtime, BACKGROUND_CONTEXT);

	const server = await serve({ runtime, port: 0, uiDir: join(process.cwd(), "ui") });
	servers.push(server);

	return { ctx, runtime, project, server };
}

/** 读一次频道视图（走真 HTTP，钉的是前端真正吃到的形状）。 */
async function channelView(server: Server, channelId: string): Promise<ChannelView> {
	const response = await fetch(`${server.url}api/channels/${encodeURIComponent(channelId)}`);
	expect(response.status).toBe(200);
	return (await response.json()) as ChannelView;
}

/** 老板在频道里说一句话。 */
async function ownerSays(server: Server, channelId: string, text: string, mentions: readonly number[] = []) {
	const response = await fetch(`${server.url}api/channels/${encodeURIComponent(channelId)}/messages`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ text, mentions }),
	});
	expect(response.status).toBe(200);
	return (await response.json()) as { ok: boolean; seq: number };
}

test("老板发频道消息后，那条消息带 acks，plan 是「立即处理」", async () => {
	const { server, project } = await setup();
	const posted = await ownerSays(server, "proj:ack", "看下进度", [project.leader]);

	const view = await channelView(server, "proj:ack");
	const message = view.messages.find((item) => item.seq === posted.seq);
	expect(message, "刚发的消息应该在频道视图里").toBeDefined();
	expect(message?.from, "是老板自己发的").toBe(0);
	expect(message?.acks, "老板消息必须带受理回执").toBeDefined();
	expect(message?.acks?.length).toBe(1);
	const ack = message?.acks?.[0];
	expect(ack?.conversationId, "回执发给了被 @ 的项目负责人").toBe(project.leader);
	expect(ack?.plan).toBe("立即处理");
	expect(ack?.busy).toBe(false);
	expect(ack?.busyWith).toBeNull();
	// 不回显 ack 的 text（那只是原消息前 280 字，频道里已有全文）。
	expect(Object.keys(ack ?? {})).not.toContain("text");
}, 30_000);

test("messageSeq 不匹配的回执不会串到别的消息上", async () => {
	const { server, runtime, project } = await setup();
	const first = await ownerSays(server, "proj:ack", "第一条", [project.leader]);
	const second = await ownerSays(server, "proj:ack", "第二条", [project.leader]);
	expect(first.seq).not.toBe(second.seq);

	// 往同一个会话里塞三张伪造回执：
	// a) 指向一个不存在的 seq（“别人的”回执）——任何消息都不该拿到它；
	// b) 指向第一条（新的一张）——只该换掉第一条自己的那张；
	// 如果实现是「按顺序 / 按时间」而不是按 `messageSeq` 配对，
	// a) 会落到第二条上、b) 会让第一条拿到两张。
	const now = Date.now();
	await runtime.harness.commit(async (tx) => {
		await tx.appendEntry(project.leader as never, {
			kind: "app.ack",
			data: { text: "伪造", channelId: "proj:ack", messageSeq: first.seq + 1000, busy: true, busyWith: "bash", plan: "当前工具结束后处理", at: now + 1 },
		});
		await tx.appendEntry(project.leader as never, {
			kind: "app.ack",
			data: { text: "伪造", channelId: "proj:ack", messageSeq: first.seq, busy: true, busyWith: "read", plan: "当前工具结束后处理", at: now + 2 },
		});
	}, BACKGROUND_CONTEXT);

	const view = await channelView(server, "proj:ack");
	const one = view.messages.find((item) => item.seq === first.seq);
	const two = view.messages.find((item) => item.seq === second.seq);
	expect(one?.acks?.length, "第一条：只有自己那张（同一个人只留最新一张）").toBe(1);
	expect(one?.acks?.[0]?.busyWith, "第一条拿到的是它自己的最新回执").toBe("read");
	expect(two?.acks?.length, "第二条：没被来历不明的回执污染").toBe(1);
	expect(two?.acks?.[0]?.busyWith).toBeNull();
	expect(two?.acks?.[0]?.plan).toBe("立即处理");
	// 指向不存在 seq 的那张回执谁也没拿到。
	expect(view.messages.some((item) => item.acks?.some((ack) => ack.busyWith === "bash"))).toBe(false);
}, 30_000);

test("对方忙的时候，回执记的是「当前工具结束后处理」和它在跑的工具", async () => {
	const { server, runtime, ctx, project } = await setup();
	// 先把它叫起来干一个慢活，再发第二条：第二条的回执应该看到「它在忙」。
	ctx.faux.setResponses([slowAnswer(2_500, "慢慢做"), answer("收到")]);
	await ownerSays(server, "proj:ack", "干个长活", [project.leader]);
	await eventually(
		async () => {
			const inspection = await runtime.harness.inspect(BACKGROUND_CONTEXT);
			return inspection.tasks.some((task) => task.state.kind === "running");
		},
		{ label: "负责人开始干活", timeoutMs: 5_000 },
	);

	const second = await ownerSays(server, "proj:ack", "再补一句", [project.leader]);
	const view = await channelView(server, "proj:ack");
	const message = view.messages.find((item) => item.seq === second.seq);
	expect(message?.acks?.[0]?.busy, "写回执时对方确实在忙").toBe(true);
	expect(message?.acks?.[0]?.plan).toBe("当前工具结束后处理");
}, 30_000);

test("别的频道的回执不会漏进这个频道", async () => {
	const { server, project } = await setup();
	await ownerSays(server, "proj:ack", "项目群说话", [project.leader]);
	await ownerSays(server, "dm:1", "私聊说话", []);

	const projectView = await channelView(server, "proj:ack");
	const dmView = await channelView(server, "dm:1");

	const projectAcks = projectView.messages.flatMap((item) => item.acks ?? []);
	const dmAcks = dmView.messages.flatMap((item) => item.acks ?? []);
	expect(projectAcks.length, "项目群那条有自己的回执").toBe(1);
	expect(dmAcks.length, "私聊那条有自己的回执（发给 CEO）").toBe(1);
	// 两条回执的落库时刻不同、指向的消息不同，不是同一张。
	expect(projectAcks[0]?.conversationId).toBe(project.leader);
	expect(dmAcks[0]?.conversationId).not.toBe(project.leader);
}, 30_000);
