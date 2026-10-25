/**
 * `shouldBeIn()` 与 `ensureAllChannels()` 必须说同一件事。
 *
 * 真实事故（贪吃蛇端到端实验）：员工入职后没有加入任何频道——公司大群还是
 * 9 人、项目群只有负责人一个。`@开发-游戏实现` 在 `parseMentions` 里被
 * 「只保留频道成员」过滤掉，**一个人都没被唤醒**，任务派下去了但对方永远
 * 不知道，界面上看不出任何异常。
 *
 * 这里用真实 boot 出来的公司做对拍：`ensureAllChannels()` 建好的成员集合，
 * 必须与 `shouldBeIn()` 的判断逐个一致。两边任何一处漂移都会被这里抓住。
 */
import { afterAll, describe, expect, test } from "vitest";
import { join } from "node:path";
import { BACKGROUND_CONTEXT, createRegistry, openCompany, recover } from "../../src/runtime/index.ts";
import { bootstrapCompany, createProject, hireStaff } from "../../src/company/org.ts";
import { createEscalationTask } from "../../src/company/escalation.ts";
import { ensureAllChannels, readChannels, readOrg, shouldBeIn } from "../../src/company/channels.ts";
import { OWNER_ID } from "../../src/domain/channels.ts";
import { createTestContext, TEST_MODEL_CATALOG, type TestContext } from "../support.ts";

const contexts: TestContext[] = [];
const runtimes: { close: () => Promise<void> }[] = [];

afterAll(async () => {
	for (const runtime of runtimes) await runtime.close().catch(() => undefined);
	for (const ctx of contexts) await ctx.cleanup().catch(() => undefined);
});

async function boot(): Promise<{
	runtime: Awaited<ReturnType<typeof openCompany>>;
	workspaceRoot: string;
}> {
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
	await bootstrapCompany(
		runtime,
		{
			modelCatalog: [...TEST_MODEL_CATALOG],
			companyName: "成员测试公司",
			registry,
			workspaceRoot: join(ctx.dir, "projects"),
			escalationTask,
		},
		BACKGROUND_CONTEXT,
	);
	return { runtime, workspaceRoot: join(ctx.dir, "projects") };
}

describe("频道成员：shouldBeIn 与 ensureAllChannels 对拍", () => {
	test("新招的员工立刻出现在公司大群和项目群", async () => {
		const booted = await boot();
		await createProject(
			booted.runtime,
			{ name: "贪吃蛇", slug: "snake", workspaceRoot: booted.workspaceRoot },
			BACKGROUND_CONTEXT,
		);
		const hired = await hireStaff(
			booted.runtime,
			{ project: "snake", name: "dev-1", role: "开发" },
			BACKGROUND_CONTEXT,
		);

		const channels = await readChannels(booted.runtime, BACKGROUND_CONTEXT);
		const company = channels.channels["company"];
		const project = channels.channels["proj:snake"];
		expect(company?.members[String(hired.conversationId)]).toBeDefined();
		expect(project?.members[String(hired.conversationId)]).toBeDefined();
		// 老板必须在项目群里（他要求在任何群都能派任务）
		expect(project?.members[String(OWNER_ID)]).toBeDefined();
	});

	test("每个频道的成员集合与 shouldBeIn 完全一致", async () => {
		const booted = await boot();
		await createProject(
			booted.runtime,
			{ name: "贪吃蛇", slug: "snake", workspaceRoot: booted.workspaceRoot },
			BACKGROUND_CONTEXT,
		);
		await createProject(
			booted.runtime,
			{ name: "俄罗斯方块", slug: "tetris", workspaceRoot: booted.workspaceRoot },
			BACKGROUND_CONTEXT,
		);
		await hireStaff(booted.runtime, { project: "snake", name: "dev-1", role: "开发" }, BACKGROUND_CONTEXT);
		await hireStaff(booted.runtime, { project: "tetris", name: "dev-2", role: "开发" }, BACKGROUND_CONTEXT);
		await ensureAllChannels(booted.runtime, BACKGROUND_CONTEXT);

		const { org } = await readOrg(booted.runtime, BACKGROUND_CONTEXT);
		const channels = await readChannels(booted.runtime, BACKGROUND_CONTEXT);
		const everyone = [...org.people.map((person) => person.conversationId), OWNER_ID];

		let checked = 0;
		for (const channel of Object.values(channels.channels)) {
			for (const id of everyone) {
				const inChannel = channel.members[String(id)] !== undefined;
				expect(
					inChannel,
					`频道 ${channel.id} 对会话 ${id}：实际在群=${String(inChannel)}，shouldBeIn=${String(shouldBeIn(channel.id, id, org))}`,
				).toBe(shouldBeIn(channel.id, id, org));
				checked += 1;
			}
		}
		expect(checked).toBeGreaterThan(20);
	});

	test("别的项目的人不在本项目群里", async () => {
		const booted = await boot();
		await createProject(
			booted.runtime,
			{ name: "贪吃蛇", slug: "snake", workspaceRoot: booted.workspaceRoot },
			BACKGROUND_CONTEXT,
		);
		await createProject(
			booted.runtime,
			{ name: "俄罗斯方块", slug: "tetris", workspaceRoot: booted.workspaceRoot },
			BACKGROUND_CONTEXT,
		);
		const snakeDev = await hireStaff(
			booted.runtime,
			{ project: "snake", name: "dev-1", role: "开发" },
			BACKGROUND_CONTEXT,
		);
		await ensureAllChannels(booted.runtime, BACKGROUND_CONTEXT);

		const channels = await readChannels(booted.runtime, BACKGROUND_CONTEXT);
		expect(channels.channels["proj:snake"]?.members[String(snakeDev.conversationId)]).toBeDefined();
		expect(channels.channels["proj:tetris"]?.members[String(snakeDev.conversationId)]).toBeUndefined();
		// 但公司大群里两个项目的人都在
		expect(channels.channels["company"]?.members[String(snakeDev.conversationId)]).toBeDefined();
	});

	test("私聊只有双方，别人不在", async () => {
		const booted = await boot();
		await createProject(
			booted.runtime,
			{ name: "贪吃蛇", slug: "snake", workspaceRoot: booted.workspaceRoot },
			BACKGROUND_CONTEXT,
		);
		const one = await hireStaff(booted.runtime, { project: "snake", name: "dev-1", role: "开发" }, BACKGROUND_CONTEXT);
		const two = await hireStaff(booted.runtime, { project: "snake", name: "dev-2", role: "开发" }, BACKGROUND_CONTEXT);
		await ensureAllChannels(booted.runtime, BACKGROUND_CONTEXT);

		const channels = await readChannels(booted.runtime, BACKGROUND_CONTEXT);
		const dm = channels.channels[`dm:${one.conversationId}`];
		expect(dm?.members[String(OWNER_ID)]).toBeDefined();
		expect(dm?.members[String(one.conversationId)]).toBeDefined();
		expect(dm?.members[String(two.conversationId)]).toBeUndefined();
	});
});
