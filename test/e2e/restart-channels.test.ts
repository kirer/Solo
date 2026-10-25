/**
 * 重启后频道里的历史对话能接上。
 *
 * 这条不是「锦上添花」：频道是消息的唯一事实来源（ADR-029）。
 * 如果重启后历史丢了，那么「未读摘要」「@ 已读」「任务挂在哪个频道」全部失效，
 * 老板回来看到的是一个空壳，员工醒来也不知道之前聊到哪。
 *
 * 重启的语义由 pi-durable 保证（文档 + transcript 都落盘），这里验证的是
 * **我们的读路径没有依赖任何进程内状态**：不能有 `let` 缓存、不能有「启动时初始化一次」。
 */
import { afterEach, describe, expect, test } from "vitest";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createRegistry, openCompany, recover, type CompanyRuntime } from "../../src/runtime/index.ts";
import { bootstrapCompany, createProject, hireStaff } from "../../src/company/org.ts";
import { createEscalationTask } from "../../src/company/escalation.ts";
import { ensureAllChannels, postToChannel, readChannel, readChannels } from "../../src/company/channels.ts";
import { dmChannelId } from "../../src/domain/channels.ts";
import { listChannels, readChannelView } from "../../src/server/channels-view.ts";
import { createTestContext, type TestContext, TEST_MODEL_CATALOG } from "../support.ts";

let contexts: TestContext[] = [];
let runtimes: CompanyRuntime[] = [];

afterEach(async () => {
	for (const runtime of runtimes) await runtime.close();
	for (const ctx of contexts) await ctx.cleanup();
	runtimes = [];
	contexts = [];
});

/** 起一个公司，返回「关掉再开」需要的全部东西。 */
async function boot() {
	const ctx = await createTestContext();
	contexts.push(ctx);
	const registry = createRegistry();
	const runtime = await openCompany(
		{ databasePath: ctx.databasePath, models: ctx.models, registry },
		BACKGROUND_CONTEXT,
	);
	runtimes.push(runtime);
	await recover(runtime, BACKGROUND_CONTEXT);
	const task = createEscalationTask(runtime);
	registry.install({ name: "escalation", tasks: [task] } as never);
	const boot = await bootstrapCompany(
		runtime,
		{
			modelCatalog: [...TEST_MODEL_CATALOG],
			companyName: "重启测试公司",
			registry,
			workspaceRoot: join(ctx.dir, "projects"),
			escalationTask: task,
		},
		BACKGROUND_CONTEXT,
	);
	const project = await createProject(
		runtime,
		{ name: "Alpha", slug: "alpha", brief: "b", workspaceRoot: join(ctx.dir, "projects") },
		BACKGROUND_CONTEXT,
	);
	const staff = await hireStaff(
		runtime,
		{ project: "alpha", name: "林越", role: "工程师", manager: "cto" },
		BACKGROUND_CONTEXT,
	);
	await ensureAllChannels(runtime, BACKGROUND_CONTEXT);
	return { ctx, registry, task, runtime, boot, project, staff };
}

/** 关掉再开（模拟进程重启）。 */
async function restart(state: Awaited<ReturnType<typeof boot>>) {
	await state.runtime.close();
	runtimes = runtimes.filter((runtime) => runtime !== state.runtime);

	const registry = createRegistry();
	const runtime = await openCompany(
		{ databasePath: state.ctx.databasePath, models: state.ctx.models, registry },
		BACKGROUND_CONTEXT,
	);
	runtimes.push(runtime);
	await recover(runtime, BACKGROUND_CONTEXT);
	const task = createEscalationTask(runtime);
	registry.install({ name: "escalation", tasks: [task] } as never);
	return { runtime, registry, task };
}

describe("重启后频道历史接上", () => {
	test("消息一条不少，顺序不变", async () => {
		const state = await boot();
		const channelId = dmChannelId(state.staff.conversationId);
		for (const text of ["第一条", "第二条", "第三条"]) {
			await postToChannel(
				state.runtime,
				channelId,
				{ from: 0, fromLabel: "老板", kind: "chat", text },
				{ context: BACKGROUND_CONTEXT },
			);
		}

		const { runtime } = await restart(state);
		const channel = await readChannel(runtime, channelId, BACKGROUND_CONTEXT);
		expect(channel?.messages.map((message) => message.text)).toEqual(["第一条", "第二条", "第三条"]);
		// seq 单调递增（全局计数器，不从 0 起，因为频道创建/系统消息也占号）
		const seqs = channel?.messages.map((message) => message.seq) ?? [];
		expect(seqs.length).toBe(3);
		expect(seqs[1]).toBe(seqs[0]! + 1);
		expect(seqs[2]).toBe(seqs[1]! + 1);
	});

	test("重启后继续发消息，seq 接着涨（不会从 0 重新开始）", async () => {
		const state = await boot();
		const channelId = dmChannelId(state.staff.conversationId);
		const first = await postToChannel(
			state.runtime,
			channelId,
			{ from: 0, fromLabel: "老板", kind: "chat", text: "重启前" },
			{ context: BACKGROUND_CONTEXT },
		);

		const { runtime } = await restart(state);
		const posted = await postToChannel(
			runtime,
			channelId,
			{ from: 0, fromLabel: "老板", kind: "chat", text: "重启后" },
			{ context: BACKGROUND_CONTEXT },
		);
		// 关键：重启后的 seq 必须比重启前大（不是从 0 重新开始）
		expect(posted.message.seq).toBeGreaterThan(first.message.seq);

		const channel = await readChannel(runtime, channelId, BACKGROUND_CONTEXT);
		expect(channel?.messages.map((message) => message.text)).toEqual(["重启前", "重启后"]);
	});

	test("重启后频道列表还在（不用重新 bootstrap）", async () => {
		const state = await boot();
		const before = await readChannels(state.runtime, BACKGROUND_CONTEXT);
		const beforeIds = Object.keys(before.channels).sort();

		const { runtime } = await restart(state);
		const after = await readChannels(runtime, BACKGROUND_CONTEXT);
		expect(Object.keys(after.channels).sort()).toEqual(beforeIds);
		// nextSeq 也接上
		expect(after.nextSeq).toBe(before.nextSeq);
	});

	test("重启后已读位置保留（不会把读过的又变成未读）", async () => {
		const state = await boot();
		const channelId = dmChannelId(state.staff.conversationId);
		await postToChannel(
			state.runtime,
			channelId,
			{ from: 0, fromLabel: "老板", kind: "chat", text: "读过了" },
			{ context: BACKGROUND_CONTEXT },
		);
		const before = await readChannel(state.runtime, channelId, BACKGROUND_CONTEXT);
		const staffRead = before?.members[String(state.staff.conversationId)]?.lastReadSeq ?? 0;

		const { runtime } = await restart(state);
		const after = await readChannel(runtime, channelId, BACKGROUND_CONTEXT);
		expect(after?.members[String(state.staff.conversationId)]?.lastReadSeq).toBe(staffRead);
	});

	test("重启后频道视图（前端用的那个）能正常渲染历史", async () => {
		const state = await boot();
		const channelId = dmChannelId(state.staff.conversationId);
		await postToChannel(
			state.runtime,
			channelId,
			{ from: 0, fromLabel: "老板", kind: "chat", text: "历史消息" },
			{ context: BACKGROUND_CONTEXT },
		);

		const { runtime } = await restart(state);
		const list = await listChannels(runtime, BACKGROUND_CONTEXT);
		const item = list.find((entry) => entry.id === channelId);
		expect(item).toBeDefined();
		expect(item?.preview).toContain("历史消息");

		const view = await readChannelView(runtime, channelId, 0, {}, BACKGROUND_CONTEXT);
		expect(view?.messages.map((message) => message.text)).toContain("历史消息");
	});

	test("重启后私聊仍然免 @ 定向（成员关系也持久化了）", async () => {
		const state = await boot();
		const channelId = dmChannelId(state.staff.conversationId);

		const { runtime } = await restart(state);
		const posted = await postToChannel(
			runtime,
			channelId,
			{ from: 0, fromLabel: "老板", kind: "chat", text: "重启后也不用 @" },
			{ context: BACKGROUND_CONTEXT },
		);
		expect(posted.message.mentions).toEqual([state.staff.conversationId]);
	});
});
