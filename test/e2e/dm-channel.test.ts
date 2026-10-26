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
import { createUniversalTools } from "../../src/company/tools/universal.ts";
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

describe("被私聊叫醒的人在私聊里回复（不是跑去群里）", () => {
	/**
	 * 老板实测的严重问题：私聊 CFO，CFO 的回复跑到领导层群去了。
	 *
	 * 根因：`say` / `ask` 不传 `channel` 时按**角色**推断频道（管理层 → leadership），
	 * 完全不知道叫醒自己的是哪条消息。修法是把「刚被谁在哪个频道叫醒」落进
	 * `ReplyContextDoc`，让 `resolveChannel` 优先采用。
	 *
	 * 这条测试锁的就是「回复落在 dm，而不是 leadership」。
	 */
	test("老板在私聊里说话，对方的 say 落在同一个私聊频道", async () => {
		const { runtime, boot, staff } = await setup();
		const tools = createUniversalTools({ runtime });
		const cfoId = boot.roleConversations.cfo;
		const dmId = dmChannelId(cfoId);

		// 老板在 dm 里 @CFO
		await postToChannel(
			runtime,
			dmId,
			{ from: 0, fromLabel: "老板", kind: "chat", text: "这个月成本怎么样" },
			{ context: BACKGROUND_CONTEXT },
		);

		// CFO 不传 channel 发言——应该落回 dm:13，而不是 leadership
		const result = await tools.say.execute(
			{ text: "这个月比上月低 12%" },
			{ conversationId: cfoId } as never,
			BACKGROUND_CONTEXT,
		);
		const body = typeof result === "string" ? result : JSON.stringify(result);
		// dm 频道的标题就是对方的名字（这里是 CFO）
		expect(body).toContain("已发到「CFO」");

		const dm = await readChannel(runtime, dmId, BACKGROUND_CONTEXT);
		expect(dm?.messages.at(-1)?.text).toBe("这个月比上月低 12%");
		expect(dm?.messages.at(-1)?.from).toBe(cfoId);

		// 领导层群**不能**多出这条
		const leadership = await readChannel(runtime, "leadership", BACKGROUND_CONTEXT);
		expect(leadership?.messages.some((message) => message.text === "这个月比上月低 12%")).toBe(false);
	});

	test("没人叫醒过时仍然按角色推断（旧行为不回归）", async () => {
		const { runtime, boot } = await setup();
		const tools = createUniversalTools({ runtime });
		const cfoId = boot.roleConversations.cfo;

		const result = await tools.say.execute(
			{ text: "主动汇报一句" },
			{ conversationId: cfoId } as never,
			BACKGROUND_CONTEXT,
		);
		const body = typeof result === "string" ? result : JSON.stringify(result);
		expect(body).toContain("领导层");

		const leadership = await readChannel(runtime, "leadership", BACKGROUND_CONTEXT);
		expect(leadership?.messages.at(-1)?.text).toBe("主动汇报一句");
	});

	test("显式 channel 参数优先于回复上下文", async () => {
		const { runtime, boot } = await setup();
		const tools = createUniversalTools({ runtime });
		const cfoId = boot.roleConversations.cfo;

		await postToChannel(
			runtime,
			dmChannelId(cfoId),
			{ from: 0, fromLabel: "老板", kind: "chat", text: "私聊一句" },
			{ context: BACKGROUND_CONTEXT },
		);
		// 明确要求发到领导层群
		await tools.say.execute(
			{ text: "这条要去群里", channel: "leadership" },
			{ conversationId: cfoId } as never,
			BACKGROUND_CONTEXT,
		);
		const leadership = await readChannel(runtime, "leadership", BACKGROUND_CONTEXT);
		expect(leadership?.messages.at(-1)?.text).toBe("这条要去群里");
	});
});
