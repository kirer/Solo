/**
 * 网页服务的接口测试。
 *
 * 只测数据与协议，不测视觉（视觉靠真实浏览器验证）。
 * 覆盖：组织快照、会话流、发消息、拍板、SSE 推送。
 */
import { afterEach, describe, expect, test } from "vitest";
import { join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import {
	BACKGROUND_CONTEXT,
	createRegistry,
	openCompany,
	recover,
	type CompanyRuntime,
} from "../../src/runtime/index.ts";
import { bootstrapCompany, COMPANY_TASKS_EXTENSION, createProject, hireStaff } from "../../src/company/org.ts";
import { createEscalationTask, listPending, startEscalation } from "../../src/company/escalation.ts";
import { beginLiveTrail } from "../../src/company/trail.ts";
import { serve, type Server } from "../../src/server/http.ts";
import type { OrgView } from "../../src/server/org-view.ts";
import type { Feed } from "../../src/server/feed.ts";
import type { ActorProfile } from "../../src/server/profile.ts";
import { answer, createTestContext, eventually, slowAnswer, TEST_MODEL_CATALOG, toolCall, type TestContext } from "../support.ts";

let contexts: TestContext[] = [];
let runtimes: CompanyRuntime[] = [];
let servers: Server[] = [];
let dirs: string[] = [];

/** 起一套完整的公司 + 服务。 */
async function setup() {
	const ctx = await createTestContext();
	contexts.push(ctx);

	const dir = await mkdtemp(join(tmpdir(), "ai-company-web-"));
	dirs.push(dir);

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

	const boot = await bootstrapCompany(
		runtime,
		{
			companyName: "测试公司",
			modelCatalog: [...TEST_MODEL_CATALOG],
			registry,
			workspaceRoot: join(dir, "projects"),
			escalationTask,
		},
		BACKGROUND_CONTEXT,
	);

	const server = await serve({ runtime, port: 0, uiDir: join(process.cwd(), "ui") });
	servers.push(server);

	return { ctx, runtime, boot, server, escalationTask, dir };
}

afterEach(async () => {
	for (const server of servers) await server.close().catch(() => undefined);
	for (const runtime of runtimes) await runtime.close().catch(() => undefined);
	for (const ctx of contexts) await ctx.cleanup();
	for (const dir of dirs) await rm(dir, { recursive: true, force: true });
	servers = [];
	runtimes = [];
	contexts = [];
	dirs = [];
});

describe("组织快照接口", () => {
	test("返回 CEO、六个高管、项目与成本", async () => {
		const { server, runtime, dir } = await setup();

		// 加一个项目与两名员工
		await createProject(
			runtime,
			{ name: "坦克大战", slug: "tank-battle", brief: "网页游戏", workspaceRoot: join(dir, "projects") },
			BACKGROUND_CONTEXT,
		);
		const { registry } = await import("../../src/runtime/index.ts");
		void registry;

		const response = await fetch(`${server.url}api/org`);
		const org = (await response.json()) as OrgView;

		expect(org.company.name).toBe("测试公司");
		expect(org.ceo.label).toBe("CEO");
		expect(org.roles.length).toBe(6);
		expect(org.roles.map((role) => role.label)).toEqual(["CTO", "CFO", "CPO", "COO", "CMO", "CHRO"]);
		expect(org.projects.length).toBe(1);
		expect(org.projects[0]?.slug).toBe("tank-battle");
		expect(typeof org.costs.totalTokens).toBe("number");
	});

	test("节点带档案需要的最小信息（模型/上级/项目/角色）", async () => {
		const { server, runtime, dir } = await setup();
		await createProject(
			runtime,
			{ name: "A", slug: "a", brief: "b", workspaceRoot: join(dir, "projects"), leaderName: "陆沉" },
			BACKGROUND_CONTEXT,
		);
		const registryMod = await import("../../src/runtime/index.ts");
		await hireStaff(
			runtime,
			{ project: "a", name: "林越", role: "开发", manager: "cto", registry: registryMod.createRegistry() },
			BACKGROUND_CONTEXT,
		);

		const org = (await (await fetch(`${server.url}api/org`)).json()) as OrgView;
		expect(org.ceo.parent).toBe("老板");
		expect(org.ceo.model, "模型要能显示成 provider/modelId").toMatch(/\//);
		expect(org.roles.every((role) => role.parent === "CEO")).toBe(true);

		const projectView = org.projects.find((item) => item.slug === "a");
		expect(projectView?.lead.project).toBe("a");
		const person = projectView?.staff.find((staff) => staff.label === "林越");
		expect(person?.role).toBe("开发");
		expect(person?.project).toBe("a");
		expect(person?.parent).toBe("CTO");
		expect(person?.model).toMatch(/\//);
	});

	test("节点状态只可能是四态之一（含故障态）", async () => {
		const { server } = await setup();
		const org = (await (await fetch(`${server.url}api/org`)).json()) as OrgView;
		const all = [org.ceo, ...org.roles, ...org.projects.flatMap((p) => [p.lead, ...p.staff])];
		for (const node of all) {
			expect(["busy", "waiting", "error", "idle"]).toContain(node.status);
		}
	});

	test("组织快照带沟通连线字段", async () => {
		const { server } = await setup();
		const org = (await (await fetch(`${server.url}api/org`)).json()) as OrgView;
		expect(Array.isArray(org.links)).toBe(true);
	});

	test("正在进行的沟通会出现在 links 里", async () => {
		const { server, boot } = await setup();
		const release = beginLiveTrail({
			kind: "delegate",
			from: "CEO",
			to: "CTO",
			fromConversation: boot.ownerConversationId,
			toConversation: boot.roleConversations.cto,
		});
		try {
			const org = (await (await fetch(`${server.url}api/org`)).json()) as OrgView;
			const live = org.links.find(
				(link) => link.from === boot.ownerConversationId && link.to === boot.roleConversations.cto,
			);
			expect(live).toBeDefined();
			expect(live?.kind).toBe("delegate");
		} finally {
			release();
		}
	});

	test("员工出现在项目的 staff 里，且带角色", async () => {
		const { server, runtime, dir, ctx } = await setup();
		const { project } = await createProject(
			runtime,
			{ name: "A", slug: "a", brief: "b", workspaceRoot: join(dir, "projects"), leaderName: "陆沉" },
			BACKGROUND_CONTEXT,
		);
		const registryMod = await import("../../src/runtime/index.ts");
		await hireStaff(
			runtime,
			{ project: "a", name: "林越", role: "开发", manager: "cto", registry: registryMod.createRegistry() },
			BACKGROUND_CONTEXT,
		);
		void ctx;

		const org = (await (await fetch(`${server.url}api/org`)).json()) as OrgView;
		const projectView = org.projects.find((item) => item.slug === "a");
		expect(projectView?.lead.label).toBe("陆沉");
		expect(projectView?.lead.conversationId).toBe(project.leader);
		expect(projectView?.staff.map((person) => person.label)).toContain("林越");
	});

	test("待你拍板的问题会出现在 pending 里并标记 forYou", async () => {
		const { server, runtime, boot, escalationTask, dir } = await setup();
		const { project } = await createProject(
			runtime,
			{ name: "A", slug: "a", brief: "b", workspaceRoot: join(dir, "projects") },
			BACKGROUND_CONTEXT,
		);

		await startEscalation(
			runtime,
			escalationTask,
			{
				question: "要不要加联机？",
				from: "林越",
				fromConversationId: project.leader,
				manager: "ceo",
				escalationKey: "web-esc",
			},
			BACKGROUND_CONTEXT,
		);

		// 等 CEO 层的待决出现，再假装 CEO 拍不了
		await eventually(async () => (await listPending(runtime, BACKGROUND_CONTEXT)).length > 0, {
			label: "待决出现",
		});
		const { answerPending } = await import("../../src/company/escalation.ts");
		await answerPending(
			runtime,
			{ key: "web-esc", answer: "老板定。", answeredBy: "ceo", escalate: true },
			BACKGROUND_CONTEXT,
		);

		await eventually(
			async () => {
				const org = (await (await fetch(`${server.url}api/org`)).json()) as OrgView;
				return org.pending.some((item) => item.forYou);
			},
			{ label: "升到老板层" },
		);

		const org = (await (await fetch(`${server.url}api/org`)).json()) as OrgView;
		const mine = org.pending.find((item) => item.forYou);
		expect(mine?.question).toContain("联机");
		void boot;
	});
});

describe("会话流接口", () => {
	test("返回老板与助手的消息", async () => {
		const { server, runtime, boot, ctx } = await setup();

		ctx.faux.setResponses([answer("我能帮你安排事情。")]);
		const ceo = await runtime.harness.conversation(boot.ownerConversationId as never, BACKGROUND_CONTEXT);
		await (
			await ceo?.submit({ type: "input", content: "你能做什么" }, BACKGROUND_CONTEXT)
		)?.wait(BACKGROUND_CONTEXT);

		const feed = (await (await fetch(`${server.url}api/feed/${boot.ownerConversationId}`)).json()) as Feed;

		expect(feed.title).toBe("CEO");
		expect(feed.kind).toBe("owner");
		expect(feed.items.some((item) => item.kind === "user" && item.text === "你能做什么")).toBe(true);
		expect(feed.items.some((item) => item.kind === "assistant" && item.text.includes("安排"))).toBe(true);
	});

	test("工具调用被合并成一条，含参数与结果", async () => {
		const { server, runtime, boot, ctx } = await setup();

		ctx.faux.setResponses([
			{
				role: "assistant",
				content: [
					{
						type: "toolCall",
						id: "call-1",
						name: "org_tree",
						arguments: {},
					},
				],
				api: "faux",
				provider: "faux",
				model: "faux-1",
				usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15 },
				stopReason: "toolUse",
				timestamp: Date.now(),
			} as never,
			answer("组织里有七个岗位。"),
		]);

		const ceo = await runtime.harness.conversation(boot.ownerConversationId as never, BACKGROUND_CONTEXT);
		await (
			await ceo?.submit({ type: "input", content: "看看组织" }, BACKGROUND_CONTEXT)
		)?.wait(BACKGROUND_CONTEXT);

		const feed = (await (await fetch(`${server.url}api/feed/${boot.ownerConversationId}`)).json()) as Feed;
		const tools = feed.items.filter((item) => item.kind === "tool");

		expect(tools.length).toBeGreaterThan(0);
		const tree = tools.find((item) => item.kind === "tool" && item.name === "org_tree");
		expect(tree).toBeDefined();
		if (tree?.kind === "tool") {
			expect(tree.state).toBe("ok");
			expect(tree.output.length).toBeGreaterThan(0);
		}
	});

	test("运行中的工具不重复出卡，参数从已提交调用回填", async () => {
		const { server, runtime, boot, ctx } = await setup();

		ctx.faux.setResponses([
			toolCall("delegate_to_role", { role: "cto", task: "看看首页" }),
			slowAnswer(700, "CTO 已收到"),
			answer("已转交 CTO"),
		]);

		const ceo = await runtime.harness.conversation(boot.ownerConversationId as never, BACKGROUND_CONTEXT);
		void ceo?.submit({ type: "input", content: "转给 CTO" }, BACKGROUND_CONTEXT);

		await eventually(
			async () => {
				const inspection = await runtime.harness.inspect(BACKGROUND_CONTEXT);
				return inspection.tasks.some(
					(task) => task.record.kind === "pi.tool" && task.state.kind === "running",
				);
			},
			{ label: "工具开始跑" },
		);

		const feed = (await (await fetch(`${server.url}api/feed/${boot.ownerConversationId}`)).json()) as Feed;
		const calls = feed.items.filter((item) => item.kind === "tool" && item.name === "delegate_to_role");

		expect(calls.length, "同一工具调用只应出现一张卡").toBe(1);
		if (calls[0]?.kind === "tool") {
			expect(calls[0].args).toContain("看看首页");
			expect(calls[0].state).toBe("running");
		}
		expect(
			feed.running.some((tool) => tool.name === "delegate_to_role"),
			"已提交的调用不应再出现在 running 里",
		).toBe(false);
	});

	test("不存在的会话返回 404", async () => {
		const { server } = await setup();
		const response = await fetch(`${server.url}api/feed/999999`);
		expect(response.status).toBe(404);
	});

	/* ── 契约第 3 节：每条消息都要能显示发送者 ── */

	test("feed 带 actor（会话主人），老板通道是 CEO", async () => {
		const { server, boot } = await setup();
		const feed = (await (await fetch(`${server.url}api/feed/${boot.ownerConversationId}`)).json()) as Feed;

		expect(feed.actor).toBeDefined();
		expect(feed.actor.label, "老板通道的助手是 CEO").toBe("CEO");
		expect(feed.actor.kind).toBe("owner");
		expect(feed.actor.conversationId).toBe(boot.ownerConversationId);
	});

	test("高管会话的 actor 是自己，不是老板", async () => {
		const { server, boot } = await setup();
		const feed = (await (await fetch(`${server.url}api/feed/${boot.roleConversations.cto}`)).json()) as Feed;

		expect(feed.actor.label).toBe("CTO");
		expect(feed.actor.kind).toBe("role");
	});

	test("老板发的消息带 from = 老板", async () => {
		const { server, runtime, boot, ctx } = await setup();

		ctx.faux.setResponses([answer("收到")]);
		const ceo = await runtime.harness.conversation(boot.ownerConversationId as never, BACKGROUND_CONTEXT);
		await (await ceo?.submit({ type: "input", content: "你能做什么" }, BACKGROUND_CONTEXT))?.wait(BACKGROUND_CONTEXT);

		const feed = (await (await fetch(`${server.url}api/feed/${boot.ownerConversationId}`)).json()) as Feed;
		const mine = feed.items.find((item) => item.kind === "user" && item.text === "你能做什么");

		expect(mine).toBeDefined();
		if (mine?.kind !== "user") throw new Error("应为 user 条目");
		expect(mine.from.label).toBe("老板");
		expect(mine.from.kind).toBe("owner");
	});

	test("别的 agent 派来的消息带 from = 派活方，note 带 from/to", async () => {
		const { server, runtime, boot, dir } = await setup();
		const { project } = await createProject(
			runtime,
			{ name: "Alpha", slug: "alpha", brief: "b", workspaceRoot: join(dir, "projects"), leaderName: "周牧" },
			BACKGROUND_CONTEXT,
		);

		// 模拟一次派活：条目是 app.delegate，发送方是 CEO
		const leader = await runtime.harness.conversation(project.leader as never, BACKGROUND_CONTEXT);
		await leader?.submit(
			{
				type: "input",
				content: "把登录页做出来",
				entry: {
					kind: "app.delegate",
					data: { from: "CEO", to: "周牧", text: "把登录页做出来" },
				},
				whenBusy: "reject",
			},
			BACKGROUND_CONTEXT,
		);

		const feed = (await (await fetch(`${server.url}api/feed/${project.leader}`)).json()) as Feed;

		// 负责人会话的 actor 是这位负责人本人
		expect(feed.actor.label).toBe("周牧");
		expect(feed.actor.kind).toBe("project");

		const note = feed.items.find((item) => item.kind === "note");
		expect(note, "派活应留一条 note").toBeDefined();
		if (note?.kind !== "note") throw new Error("应为 note 条目");
		expect(note.from?.label).toBe("CEO");
		expect(note.from?.kind).toBe("role");
		expect(note.to?.label).toBe("周牧");
		expect(note.to?.kind).toBe("project");
		// 正文里不再重复「谁 → 谁」，只留动词与内容
		expect(note.text).toContain("登录页");
		void boot;
	});

	test("看门狗写的告警在会话流里是 alert 条目，带发送者", async () => {
		const { server, runtime, boot } = await setup();

		// 模拟看门狗落一条留痕（与 watchdog.writeAlert 同形状）
		await runtime.harness.commit(async (tx) => {
			await tx.appendEntry(boot.ownerConversationId as never, {
				kind: "app.alert",
				data: {
					text: "这一轮卡了 10 分钟没有进展，已中断并重试。",
					from: "看门狗",
					action: "abort",
					reason: "overdue",
					taskId: "42",
					taskKind: "pi.generation",
					attempt: 1,
					giveUp: false,
				},
			});
		}, BACKGROUND_CONTEXT);

		const feed = (await (await fetch(`${server.url}api/feed/${boot.ownerConversationId}`)).json()) as Feed;
		const alert = feed.items.find((item) => item.kind === "alert" && item.text.includes("卡了 10 分钟"));

		expect(alert, "看门狗告警不能退化成 note").toBeDefined();
		if (alert?.kind !== "alert") throw new Error("应为 alert 条目");
		expect(alert.from?.label).toBe("看门狗");
	});
});

describe("职工档案接口", () => {
	test("CEO 的档案带角色预制提示词与技能", async () => {
		const { server, boot } = await setup();
		const response = await fetch(`${server.url}api/profile/${boot.ownerConversationId}`);
		expect(response.status).toBe(200);

		const profile = (await response.json()) as ActorProfile;
		expect(profile.conversationId).toBe(boot.ownerConversationId);
		expect(profile.label).toBe("CEO");
		expect(profile.kind).toBe("owner");
		expect(profile.subtitle.length).toBeGreaterThan(0);
		// charter 是角色预制提示词：必须真的有内容，不能是占位
		expect(profile.charter).toContain("CEO");
		expect(profile.guide, "通用工作准则要有").toBeTruthy();
		expect(profile.model).toMatch(/\//);
		expect(profile.parent).toBe("老板");
		// 工具是这台会话实际装的能力包，不是「全部工具」
		const names = profile.tools.map((tool) => tool.name);
		expect(names).toContain("org_tree");
		expect(names).toContain("delegate_to_role");
		expect(names).not.toContain("staff_hire");
		expect(profile.tools.every((tool) => tool.description.length > 0)).toBe(true);
	});

	test("高管的档案说明向 CEO 汇报，且没有招聘权限", async () => {
		const { server, boot } = await setup();
		const profile = (await (await fetch(`${server.url}api/profile/${boot.roleConversations.cto}`)).json()) as ActorProfile;

		expect(profile.label).toBe("CTO");
		expect(profile.kind).toBe("role");
		expect(profile.parent).toBe("CEO");
		expect(profile.charter).toContain("CTO");
		expect(profile.tools.map((tool) => tool.name)).not.toContain("staff_hire");
	});

	test("员工的档案带角色、项目、上级与按角色分配的工具", async () => {
		const { server, runtime, dir } = await setup();
		const { project } = await createProject(
			runtime,
			{ name: "Alpha", slug: "alpha", brief: "b", workspaceRoot: join(dir, "projects"), leaderName: "周牧" },
			BACKGROUND_CONTEXT,
		);
		const registryMod = await import("../../src/runtime/index.ts");
		const hired = await hireStaff(
			runtime,
			{
				project: "alpha",
				name: "林越",
				role: "开发",
				manager: "cto",
				registry: registryMod.createRegistry(),
			},
			BACKGROUND_CONTEXT,
		);

		const profile = (await (await fetch(`${server.url}api/profile/${hired.conversationId}`)).json()) as ActorProfile;

		expect(profile.label).toBe("林越");
		expect(profile.kind).toBe("staff");
		expect(profile.role).toBe("开发");
		expect(profile.project).toBe("Alpha");
		expect(profile.parent).toBe("CTO");
		// 员工的实际提示词 = 角色模板 + 汇报关系，必须是真内容
		expect(profile.charter).toContain("开发");
		expect(profile.charter).toContain("Alpha");
		// 开发有 bash/读写，没有管理工具（ADR-004）
		const names = profile.tools.map((tool) => tool.name);
		expect(names).toContain("bash");
		expect(names).toContain("read");
		expect(names).not.toContain("delegate_to_role");
		expect(names).not.toContain("project_create");
		void project;
	});

	test("项目负责人的档案带负责人章程与项目名", async () => {
		const { server, runtime, dir } = await setup();
		const { project } = await createProject(
			runtime,
			{ name: "Beta", slug: "beta", brief: "b", workspaceRoot: join(dir, "projects"), leaderName: "陆沉" },
			BACKGROUND_CONTEXT,
		);

		const profile = (await (await fetch(`${server.url}api/profile/${project.leader}`)).json()) as ActorProfile;

		expect(profile.label).toBe("陆沉");
		expect(profile.kind).toBe("project");
		expect(profile.project).toBe("Beta");
		expect(profile.charter).toContain("Beta");
		expect(profile.charter).toContain("负责人");
		// 负责人有派活能力，但没有公司级立项/招聘
		const names = profile.tools.map((tool) => tool.name);
		expect(names).toContain("staff_assign");
		expect(names).not.toContain("staff_hire");
		expect(names).not.toContain("project_create");
	});

	test("不在组织里的会话返回 404 与 error", async () => {
		const { server } = await setup();
		const response = await fetch(`${server.url}api/profile/999999`);
		expect(response.status).toBe(404);
		const body = (await response.json()) as { error: string };
		expect(typeof body.error).toBe("string");
		expect(body.error.length).toBeGreaterThan(0);
	});

	test("会话标识不合法返回 400", async () => {
		const { server } = await setup();
		const response = await fetch(`${server.url}api/profile/abc`);
		expect(response.status).toBe(400);
	});
});

describe("发消息与拍板", () => {
	test("发消息后会话流里出现该输入", async () => {
		const { server, runtime, boot, ctx } = await setup();

		ctx.faux.setResponses([answer("收到")]);
		const response = await fetch(`${server.url}api/message`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ conversationId: boot.ownerConversationId, text: "做个坦克大战" }),
		});
		expect((await response.json()) as { ok: boolean }).toEqual({ ok: true });

		await eventually(
			async () => {
				const conversation = await runtime.harness.conversation(boot.ownerConversationId as never, BACKGROUND_CONTEXT);
				const page = await conversation?.entries({ order: "ascending" }, 20, undefined, BACKGROUND_CONTEXT);
				return (page?.items.length ?? 0) > 0;
			},
			{ label: "消息落库" },
		);

		const feed = (await (await fetch(`${server.url}api/feed/${boot.ownerConversationId}`)).json()) as Feed;
		expect(feed.items.some((item) => item.kind === "user" && item.text === "做个坦克大战")).toBe(true);
	});

	test("空消息被拒绝", async () => {
		const { server, boot } = await setup();
		const response = await fetch(`${server.url}api/message`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ conversationId: boot.ownerConversationId, text: "   " }),
		});
		expect(response.status).toBe(400);
	});

	test("拍板后待决问题消失", async () => {
		const { server, runtime, escalationTask, dir } = await setup();
		const { project } = await createProject(
			runtime,
			{ name: "A", slug: "a", brief: "b", workspaceRoot: join(dir, "projects") },
			BACKGROUND_CONTEXT,
		);

		await startEscalation(
			runtime,
			escalationTask,
			{
				question: "要加联机吗？",
				from: "林越",
				fromConversationId: project.leader,
				manager: "ceo",
				escalationKey: "web-esc-2",
			},
			BACKGROUND_CONTEXT,
		);
		await eventually(async () => (await listPending(runtime, BACKGROUND_CONTEXT)).length > 0, { label: "待决出现" });
		const { answerPending } = await import("../../src/company/escalation.ts");
		await answerPending(runtime, { key: "web-esc-2", answer: "老板定。", answeredBy: "ceo", escalate: true }, BACKGROUND_CONTEXT);
		await eventually(
			async () => (await listPending(runtime, BACKGROUND_CONTEXT)).some((item) => item.level === "owner"),
			{ label: "升到老板层" },
		);

		// 通过接口拍板
		const response = await fetch(`${server.url}api/answer`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ key: "web-esc-2", text: "先不加，把本地双人做扎实。" }),
		});
		expect((await response.json()) as { ok: boolean }).toEqual({ ok: true });

		const org = (await (await fetch(`${server.url}api/org`)).json()) as OrgView;
		expect(org.pending.filter((item) => item.forYou)).toEqual([]);
	});
});

describe("忙碌时发消息", () => {
	/** 让 CEO 忙起来：跑一个慢活。 */
	async function makeBusy(
		server: Server,
		runtime: CompanyRuntime,
		boot: { ownerConversationId: number },
		ctx: TestContext,
	) {
		ctx.faux.setResponses([slowAnswer(2_500, "慢慢做")]);
		await fetch(`${server.url}api/message`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ conversationId: boot.ownerConversationId, text: "干个长活" }),
		});
		await eventually(
			async () => {
				const inspection = await runtime.harness.inspect(BACKGROUND_CONTEXT);
				return inspection.tasks.some((task) => task.state.kind === "running");
			},
			{ label: "开始干活" },
		);
	}

	test("忙碌时发的消息出现在 queued 里，不会凭空消失", async () => {
		const { server, runtime, boot, ctx } = await setup();
		await makeBusy(server, runtime, boot, ctx);

		await fetch(`${server.url}api/message`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ conversationId: boot.ownerConversationId, text: "终止这个项目" }),
		});

		await eventually(
			async () => {
				const feed = (await (await fetch(`${server.url}api/feed/${boot.ownerConversationId}`)).json()) as Feed;
				return (feed.queued ?? []).some((item) => item.text === "终止这个项目");
			},
			{ label: "排队可见" },
		);

		const feed = (await (await fetch(`${server.url}api/feed/${boot.ownerConversationId}`)).json()) as Feed;
		const queued = feed.queued?.find((item) => item.text === "终止这个项目");
		expect(queued).toBeDefined();
		expect(queued?.mode, "老板的话应排成 steer，早于 followUp 处理").toBe("steer");
		expect(queued?.origin, "老板自己发的消息标记为 owner").toBe("owner");
	}, 30_000);

	test("agent 派来的排队任务标出来源，不会伪装成老板的消息", async () => {
		const { server, runtime, boot, ctx } = await setup();
		await makeBusy(server, runtime, boot, ctx);

		const ceo = await runtime.harness.conversation(boot.ownerConversationId as never, BACKGROUND_CONTEXT);
		await ceo?.submit(
			{
				type: "input",
				content: "这是 CTO 派来的任务",
				whenBusy: "followUp",
				entry: { kind: "app.delegate", data: { from: "CTO", to: "CEO" } },
			},
			BACKGROUND_CONTEXT,
		);

		await eventually(
			async () => {
				const feed = (await (await fetch(`${server.url}api/feed/${boot.ownerConversationId}`)).json()) as Feed;
				return (feed.queued ?? []).some((item) => item.text === "这是 CTO 派来的任务");
			},
			{ label: "代理任务排队可见" },
		);

		const feed = (await (await fetch(`${server.url}api/feed/${boot.ownerConversationId}`)).json()) as Feed;
		const queued = feed.queued?.find((item) => item.text === "这是 CTO 派来的任务");
		expect(queued?.origin).toBe("agent");
		expect(queued?.from).toBe("CTO");
	}, 30_000);

	test("立即处理会打断当前工作并让消息生效", async () => {
		const { server, runtime, boot, ctx } = await setup();
		await makeBusy(server, runtime, boot, ctx);

		await fetch(`${server.url}api/message`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ conversationId: boot.ownerConversationId, text: "急事：立刻停下" }),
		});
		await eventually(
			async () => {
				const feed = (await (await fetch(`${server.url}api/feed/${boot.ownerConversationId}`)).json()) as Feed;
				return (feed.queued ?? []).length > 0;
			},
			{ label: "已排队" },
		);

		const response = await fetch(`${server.url}api/interrupt`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ conversationId: boot.ownerConversationId, text: "急事：立刻停下" }),
		});
		const result = (await response.json()) as { ok: boolean; interrupted?: boolean };
		expect(result.ok).toBe(true);
		expect(result.interrupted, "模型慢调用可以被中断，abort 应当完成").toBe(true);

		// 队列清空，消息进入对话
		await eventually(
			async () => {
				const feed = (await (await fetch(`${server.url}api/feed/${boot.ownerConversationId}`)).json()) as Feed;
				return (
					(feed.queued ?? []).length === 0 &&
					feed.items.some((item) => item.kind === "user" && item.text === "急事：立刻停下")
				);
			},
			{ label: "打断后生效" },
		);
	}, 30_000);

	test("CEO 卡在同步转交里时，立即处理也能返回并把消息补回去", async () => {
		const { server, runtime, boot, ctx } = await setup();

		// CEO 转交 CTO，CTO 的模型慢 8 秒：CEO 的工具 await 会一直挂着
		ctx.faux.setResponses([
			toolCall("delegate_to_role", { role: "cto", task: "慢慢做" }),
			slowAnswer(8_000, "CTO 很慢"),
			answer("CEO 收尾"),
		]);

		await fetch(`${server.url}api/message`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ conversationId: boot.ownerConversationId, text: "转给 CTO" }),
		});
		await eventually(
			async () => {
				const inspection = await runtime.harness.inspect(BACKGROUND_CONTEXT);
				return inspection.tasks.some(
					(task) =>
						task.record.kind === "pi.tool" &&
						Number(task.record.conversationId) === boot.ownerConversationId &&
						task.state.kind === "running",
				);
			},
			{ label: "CEO 卡在转交工具里" },
		);

		// 再排一条老板消息，然后点「立即处理」
		await fetch(`${server.url}api/message`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ conversationId: boot.ownerConversationId, text: "急事：先处理我" }),
		});
		await eventually(
			async () => {
				const feed = (await (await fetch(`${server.url}api/feed/${boot.ownerConversationId}`)).json()) as Feed;
				return (feed.queued ?? []).some((item) => item.text === "急事：先处理我");
			},
			{ label: "急事已排队" },
		);

		const started = Date.now();
		const response = await fetch(`${server.url}api/interrupt`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ conversationId: boot.ownerConversationId, text: "急事：先处理我" }),
		});
		const elapsed = Date.now() - started;

		expect(response.status).toBe(200);
		expect(elapsed, "abort 不能无限等同步转交结束").toBeLessThan(5_000);

		// 消息不能像以前那样被 abort 撤掉后消失
		await eventually(
			async () => {
				const feed = (await (await fetch(`${server.url}api/feed/${boot.ownerConversationId}`)).json()) as Feed;
				return feed.items.some((item) => item.kind === "user" && item.text === "急事：先处理我");
			},
			{ label: "中断后消息进入对话", timeoutMs: 10_000 },
		);
	}, 40_000);

	test("打断不存在的会话返回 404", async () => {
		const { server } = await setup();
		const response = await fetch(`${server.url}api/interrupt`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ conversationId: 999999, text: "x" }),
		});
		expect(response.status).toBe(404);
	});
});

describe("SSE 推送", () => {
	test("组织流会立刻推送一帧", async () => {
		const { server } = await setup();

		const response = await fetch(`${server.url}api/stream/org`);
		expect(response.headers.get("content-type")).toContain("text/event-stream");

		const reader = response.body?.getReader();
		expect(reader).toBeDefined();

		const chunks: string[] = [];
		const deadline = Date.now() + 5_000;
		while (Date.now() < deadline) {
			const { value, done } = await reader!.read();
			if (done) break;
			chunks.push(new TextDecoder().decode(value));
			if (chunks.join("").includes("event: org")) break;
		}
		await reader!.cancel();

		const payload = chunks.join("");
		expect(payload).toContain("event: org");
		const dataLine = payload.split("\n").find((line) => line.startsWith("data: "));
		expect(dataLine).toBeDefined();
		const org = JSON.parse(dataLine!.slice(6)) as OrgView;
		expect(org.ceo.label).toBe("CEO");
	});

	test("会话流会立刻推送一帧", async () => {
		const { server, boot } = await setup();

		const response = await fetch(`${server.url}api/stream/feed/${boot.ownerConversationId}`);
		expect(response.headers.get("content-type")).toContain("text/event-stream");

		const reader = response.body?.getReader();
		const chunks: string[] = [];
		const deadline = Date.now() + 5_000;
		while (Date.now() < deadline) {
			const { value, done } = await reader!.read();
			if (done) break;
			chunks.push(new TextDecoder().decode(value));
			if (chunks.join("").includes("event: feed")) break;
		}
		await reader!.cancel();

		const payload = chunks.join("");
		expect(payload).toContain("event: feed");
		const dataLine = payload.split("\n").find((line) => line.startsWith("data: "));
		const feed = JSON.parse(dataLine!.slice(6)) as Feed;
		expect(feed.conversationId).toBe(boot.ownerConversationId);
	});
});

describe("静态资源", () => {
	test("根路径返回界面", async () => {
		const { server } = await setup();
		const response = await fetch(server.url);
		expect(response.status).toBe(200);
		const html = await response.text();
		expect(html).toContain("一人公司");
		expect(html).toContain("app.js");
	});

	test("禁止目录穿越", async () => {
		const { server } = await setup();
		const response = await fetch(`${server.url}..%2f..%2fpackage.json`);
		// 被拦或回退到 index.html，都不能返回 package.json 的内容
		const text = await response.text();
		expect(text).not.toContain('"name": "ai-company"');
	});
});
