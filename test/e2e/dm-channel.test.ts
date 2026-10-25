/**
 * 私聊：老板能直接跟任何一个人说话，不用 @。
 *
 * 老板拍板（ADR-030 决策 4）：「老板可以发起任务，而且是在任何地方、任何群、
 * 任何私聊，可以 @ 任何人派任务或询问信息。」
 *
 * 私聊是最直接的「任何地方」。如果要求老板手打「@许砚舟」才能定向，
 * 这个功能在实际使用中等于不可用——老板不会为了跟一个人说话先打一个 @。
 */
import { afterEach, describe, expect, test } from "vitest";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createRegistry, openCompany, recover, type CompanyRuntime } from "../../src/runtime/index.ts";
import { bootstrapCompany, createProject, hireStaff } from "../../src/company/org.ts";
import { createEscalationTask } from "../../src/company/escalation.ts";
import { ensureAllChannels, postToChannel, readChannel } from "../../src/company/channels.ts";
import { resolveMentions } from "../../src/domain/channels.ts";
import { dmChannelId } from "../../src/domain/channels.ts";
import { createTestContext, eventually, type TestContext, TEST_MODEL_CATALOG } from "../support.ts";

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
	const task = createEscalationTask(runtime);
	registry.install({ name: "escalation", tasks: [task] } as never);
	const boot = await bootstrapCompany(
		runtime,
		{
			modelCatalog: [...TEST_MODEL_CATALOG],
			companyName: "私聊测试公司",
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
	return { ctx, runtime, boot, project, staff };
}

afterEach(async () => {
	for (const runtime of runtimes) await runtime.close();
	for (const ctx of contexts) await ctx.cleanup();
	runtimes = [];
	contexts = [];
});

describe("私聊频道存在", () => {
	test("每个人都有一个 dm 频道", async () => {
		const { runtime, staff } = await setup();
		const channel = await readChannel(runtime, dmChannelId(staff.conversationId), BACKGROUND_CONTEXT);
		expect(channel).toBeDefined();
		expect(channel?.kind).toBe("dm");
	});

	test("私聊标题是被叫的那个人", async () => {
		const { runtime, staff } = await setup();
		const channel = await readChannel(runtime, dmChannelId(staff.conversationId), BACKGROUND_CONTEXT);
		expect(channel?.title).toBe("林越");
	});
});

describe("私聊不用 @ 也能定向", () => {
	test("纯函数：私聊里没写 @ 时，消息归对方", () => {
		const channel = {
			id: "dm:7",
			kind: "dm" as const,
			title: "林越",
			createdAt: 0,
			lastSeq: 0,
			messages: [],
			members: {
				"7": { conversationId: 7, role: "staff" as const, joinedAt: 0, lastReadSeq: 0, wakeOnAll: true },
			},
		};
		expect(resolveMentions(channel, 0, undefined)).toEqual([7]);
	});

	test("纯函数：群聊里没写 @ 时不兜底（否则一条闲聊唤醒全公司）", () => {
		const channel = {
			id: "company",
			kind: "company" as const,
			title: "公司大群",
			createdAt: 0,
			lastSeq: 0,
			messages: [],
			members: {
				"1": { conversationId: 1, role: "ceo" as const, joinedAt: 0, lastReadSeq: 0 },
				"2": { conversationId: 2, role: "staff" as const, joinedAt: 0, lastReadSeq: 0 },
			},
		};
		expect(resolveMentions(channel, 0, undefined)).toEqual([]);
	});

	test("纯函数：显式 @ 优先于兜底", () => {
		const channel = {
			id: "dm:7",
			kind: "dm" as const,
			title: "林越",
			createdAt: 0,
			lastSeq: 0,
			messages: [],
			members: {
				"7": { conversationId: 7, role: "staff" as const, joinedAt: 0, lastReadSeq: 0, wakeOnAll: true },
				"8": { conversationId: 8, role: "staff" as const, joinedAt: 0, lastReadSeq: 0 },
			},
		};
		expect(resolveMentions(channel, 0, [8])).toEqual([8]);
	});

	test("老板在私聊里发一句话，对方被唤醒并收到消息", async () => {
		const { runtime, staff } = await setup();
		const posted = await postToChannel(
			runtime,
			dmChannelId(staff.conversationId),
			{ from: 0, fromLabel: "老板", kind: "chat", text: "帮我看下这个" },
			{ context: BACKGROUND_CONTEXT },
		);
		// 没写 @，但 mentions 自动补上对方
		expect(posted.message.mentions).toEqual([staff.conversationId]);
		expect(posted.delivery?.delivered ?? []).toContain(staff.conversationId);
	});

	test("对方在私聊里回话，老板能看到", async () => {
		const { runtime, staff } = await setup();
		await postToChannel(
			runtime,
			dmChannelId(staff.conversationId),
			{ from: 0, fromLabel: "老板", kind: "chat", text: "在吗" },
			{ context: BACKGROUND_CONTEXT },
		);
		await postToChannel(
			runtime,
			dmChannelId(staff.conversationId),
			{ from: staff.conversationId, fromLabel: "林越", kind: "chat", text: "在的" },
			{ context: BACKGROUND_CONTEXT },
		);
		const channel = await readChannel(runtime, dmChannelId(staff.conversationId), BACKGROUND_CONTEXT);
		expect(channel?.messages.map((message) => message.text)).toEqual(["在吗", "在的"]);
	});

	test("私聊里的消息会唤醒老板（老板也是成员）", async () => {
		const { runtime, staff } = await setup();
		const posted = await postToChannel(
			runtime,
			dmChannelId(staff.conversationId),
			{ from: staff.conversationId, fromLabel: "林越", kind: "chat", text: "老板，有个事" },
			{ context: BACKGROUND_CONTEXT },
		);
		expect(posted.message.mentions).toEqual([0]);
	});
});
