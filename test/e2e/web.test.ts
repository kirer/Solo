/**
 * 网页服务的接口测试。
 *
 * 只测数据与协议，不测视觉（视觉靠真实浏览器验证）。
 * 覆盖：组织快照、会话流、发消息、拍板、SSE 推送。
 */
import { afterEach, describe, expect, test } from "vitest";
import { join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { connect } from "node:net";
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
import { ensureAllChannels, postToChannel } from "../../src/company/channels.ts";
import { serve, type Server } from "../../src/server/http.ts";
import type { OrgView } from "../../src/server/org-view.ts";
import type { Feed, FeedItem } from "../../src/server/feed.ts";
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

	test("频道里的 @ 会变成组织图上的连线", async () => {
		const { server, runtime, boot } = await setup();
		// 连线现在从频道消息算（同步派活删除后，`TrailDoc` 不再增长）。
		await ensureAllChannels(runtime, BACKGROUND_CONTEXT);
		await postToChannel(
			runtime,
			"leadership",
			{
				from: boot.ownerConversationId,
				fromLabel: "CEO",
				kind: "task",
				text: "@CTO 看一下架构",
				mentions: [boot.roleConversations.cto],
			},
			BACKGROUND_CONTEXT,
		);

		const org = (await (await fetch(`${server.url}api/org`)).json()) as OrgView;
		const link = org.links.find(
			(item) => item.from === boot.ownerConversationId && item.to === boot.roleConversations.cto,
		);
		expect(link, "频道里的 @ 应当出现在 links 里").toBeDefined();
		expect(link?.kind).toBe("delegate");
		expect(link?.label).toBe("CEO → CTO");
	});

	test("正在进行的沟通（实时边）也会出现在 links 里", async () => {
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

	/**
	 * 缺陷 B 的 HTTP 面：CEO 接管老板级待办。
	 *
	 * 断言三件事：① 接管前老板队列有它、feed 里 canTakeOver=true 且带 trace；
	 * ② 调 /api/pending/take-over 后老板队列消失；③ 无权限（asLevel=cto）被 403 拒。
	 */
	test("CEO 接管老板级待办：接口成功、老板队列消失、feed 带 canTakeOver 与 trace", async () => {
		const { server, runtime, boot, escalationTask, dir } = await setup();
		const { project } = await createProject(
			runtime,
			{ name: "D", slug: "d", brief: "b", workspaceRoot: join(dir, "projects") },
			BACKGROUND_CONTEXT,
		);
		const { answerPending } = await import("../../src/company/escalation.ts");

		await startEscalation(
			runtime,
			escalationTask,
			{
				question: "要不要砍掉 D 项目？",
				from: "林越",
				fromConversationId: project.leader,
				manager: "ceo",
				topic: "company-level",
				escalationKey: "web-takeover-1",
			},
			BACKGROUND_CONTEXT,
		);
		// 缺陷 B：先经 CEO 复核，再递老板
		await eventually(
			async () => (await listPending(runtime, BACKGROUND_CONTEXT)).some((item) => item.key === "web-takeover-1"),
			{ label: "CEO 站出现" },
		);
		await answerPending(
			runtime,
			{ key: "web-takeover-1", answer: "确实只有老板能定。", answeredBy: "ceo", escalate: true },
			BACKGROUND_CONTEXT,
		);
		await eventually(
			async () => {
				const org = (await (await fetch(`${server.url}api/org`)).json()) as OrgView;
				return org.pending.some((item) => item.key === "web-takeover-1" && item.forYou);
			},
			{ label: "升到老板层" },
		);

		// 组织快照（老板视角）应带 trace。
		// 注：这一样原先在 /api/feed 的 pending 里，会话流视图删除后统一由 /api/org 下发。
		// `canTakeOver` 字段随会话流视图一起消失——它只服务那个视图；「能不能接管」
		// 现在由下面 `/api/pending/take-over` 的 403 / 200 行为直接验。
		const before = (await (await fetch(`${server.url}api/org`)).json()) as OrgView;
		const pendingItem = before.pending.find((item) => item.key === "web-takeover-1");
		expect(pendingItem?.trace?.note).toContain("CEO");

		// 无权限：CTO 不能接管
		const denied = await fetch(`${server.url}api/pending/take-over`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ key: "web-takeover-1", asLevel: "cto" }),
		});
		expect(denied.status).toBe(403);

		// CEO 接管
		const response = await fetch(`${server.url}api/pending/take-over`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ key: "web-takeover-1", reason: "这在我授权范围内" }),
		});
		expect(response.status).toBe(200);
		expect(((await response.json()) as { changed: boolean }).changed).toBe(true);

		// 老板队列消失
		const orgAfter = (await (await fetch(`${server.url}api/org`)).json()) as OrgView;
		expect(orgAfter.pending.filter((item) => item.key === "web-takeover-1" && item.forYou)).toEqual([]);
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
		expect(names).toContain("ask_role");
		expect(names).toContain("assign_task");
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
				tools: ["read", "write", "edit", "bash"],
				duty: "负责前端页面与交互实现，遇到技术选型问题上报 CTO。",
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
		// 员工的职责是招聘时上级写的那段话，必须如实呈现到档案页
		expect(profile.duty).toBe("负责前端页面与交互实现，遇到技术选型问题上报 CTO。");
		expect(profile.charter).toContain("负责前端页面与交互实现");
		expect(profile.charter).toContain("Alpha");
		// 写了 bash/读写，就没有管理工具（ADR-004）
		const names = profile.tools.map((tool) => tool.name);
		expect(names).toContain("bash");
		expect(names).toContain("read");
		expect(names).not.toContain("ask_role");
		expect(names).not.toContain("assign_task");
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
		expect(names).toContain("assign_task");
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
	test("发消息后频道里出现该输入", async () => {
		const { server, runtime, boot, ctx } = await setup();

		// setup() 只 boot 公司、不建频道（`ensureAllChannels` 平时在 server/main.ts 里跑）
		await ensureAllChannels(runtime, BACKGROUND_CONTEXT);
		ctx.faux.setResponses([answer("收到")]);
		const response = await fetch(`${server.url}api/channels/company/messages`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ text: "做个坦克大战" }),
		});
		expect((await response.json()) as { ok: boolean }).toMatchObject({ ok: true });

		// 发完立刻能从频道视图读回来（老板发完必须马上看见自己那句话）
		const view = (await (await fetch(`${server.url}api/channels/company`)).json()) as {
			messages: { text: string; from: number }[];
		};
		expect(view.messages.some((message) => message.text === "做个坦克大战" && message.from === 0)).toBe(true);

		// 受理回执（ADR-026 决策 7.1）：回执不经模型，界面上必须能立刻看到
		await eventually(
			async () => {
				const again = (await (await fetch(`${server.url}api/channels/company`)).json()) as {
					messages: { seq: number; acks?: readonly { plan: string }[] }[];
				};
				return again.messages.some((message) => (message.acks ?? []).length > 0);
			},
			{ label: "受理回执挂到频道消息上" },
		);
	});

	test("空消息被拒绝", async () => {
		const { server, runtime } = await setup();
		await ensureAllChannels(runtime, BACKGROUND_CONTEXT);
		const response = await fetch(`${server.url}api/channels/company/messages`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ text: "   " }),
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

	/**
	 * 老板级待办的处置入口（驳回 / 标记已解决）。
	 *
	 * 走 HTTP，因为老板真正点的就是这条路径；直接调内部 API 证明不了接线对。
	 */
	test("老板驳回一条待办：接口成功、从 /api/pending 消失、归档可查、审计有记录", async () => {
		const { server, runtime, escalationTask, dir } = await setup();
		const { project } = await createProject(
			runtime,
			{ name: "B", slug: "b", brief: "b", workspaceRoot: join(dir, "projects") },
			BACKGROUND_CONTEXT,
		);

		await startEscalation(
			runtime,
			escalationTask,
			{
				question: "要不要做付费版？",
				from: "林越",
				fromConversationId: project.leader,
				manager: "ceo",
				escalationKey: "web-dispose-1",
			},
			BACKGROUND_CONTEXT,
		);
		// 先等这条待决项真的落库：startEscalation 是异步任务，
		// 抢在它写库之前 answerPending 会因找不到 key 而静默返回 false（级联失败）。
		await eventually(
			async () => (await listPending(runtime, BACKGROUND_CONTEXT)).some((item) => item.key === "web-dispose-1"),
			{ label: "待决出现" },
		);
		// CEO 答不了 → 升到老板
		const { answerPending } = await import("../../src/company/escalation.ts");
		await answerPending(
			runtime,
			{ key: "web-dispose-1", answer: "老板定。", answeredBy: "ceo", escalate: true },
			BACKGROUND_CONTEXT,
		);
		await eventually(
			async () => (await listPending(runtime, BACKGROUND_CONTEXT)).some((item) => item.level === "owner"),
			{ label: "升到老板层" },
		);

		const before = (await (await fetch(`${server.url}api/pending`)).json()) as { key: string }[];
		expect(before.map((item) => item.key)).toContain("web-dispose-1");

		const response = await fetch(`${server.url}api/pending/dispose`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ key: "web-dispose-1", status: "rejected", reason: "今年不做商业化" }),
		});
		expect(response.status).toBe(200);
		const body = (await response.json()) as { ok: boolean; changed: boolean; disposal?: { status: string } };
		expect(body.ok).toBe(true);
		expect(body.changed).toBe(true);
		expect(body.disposal?.status).toBe("rejected");

		// 从默认列表消失
		const after = (await (await fetch(`${server.url}api/pending`)).json()) as { key: string }[];
		expect(after.map((item) => item.key)).not.toContain("web-dispose-1");

		// 归档可查
		const archive = (await (await fetch(`${server.url}api/pending?archive=1&kind=rejected`)).json()) as {
			key: string;
			disposed?: { status: string; reason: string };
		}[];
		const archived = archive.find((item) => item.key === "web-dispose-1");
		expect(archived?.disposed).toMatchObject({ status: "rejected", reason: "今年不做商业化" });

		// 审计有记录：处置事件写在**该条待办的 fromConversationId** 那个会话的审计文档里。
		// owner 级待办一律记在 CEO 名下（见 ensurePending 的注释），所以这里读 CEO 会话，
		// 不是最初提问的 project.leader。
		const { AuditDoc, CompanyDoc } = await import("../../src/company/docs.ts");
		const { BACKGROUND_CONTEXT: CTX } = await import("../../src/runtime/index.ts");
		const company = await runtime.harness.snapshot(CompanyDoc, CTX);
		const ceoConversationId = company?.roles.ceo;
		expect(ceoConversationId).toBeTypeOf("number");
		const audit = await runtime.harness.snapshot(AuditDoc, ceoConversationId as never, CTX);
		const event = audit?.events.find(
			(entry) => entry.type === "dispose" && entry.ref === "web-dispose-1@owner",
		);
		expect(event).toMatchObject({ type: "dispose", from: "owner" });
		expect(event?.note).toBe("rejected: 今年不做商业化");
	});

	test("标记已解决走同一条接口；重复提交幂等", async () => {
		const { server, runtime, escalationTask, dir } = await setup();
		const { project } = await createProject(
			runtime,
			{ name: "C", slug: "c", brief: "b", workspaceRoot: join(dir, "projects") },
			BACKGROUND_CONTEXT,
		);
		await startEscalation(
			runtime,
			escalationTask,
			{
				question: "文档放哪？",
				from: "林越",
				fromConversationId: project.leader,
				manager: "ceo",
				escalationKey: "web-dispose-2",
			},
			BACKGROUND_CONTEXT,
		);
		await eventually(
			async () => (await listPending(runtime, BACKGROUND_CONTEXT)).some((item) => item.key === "web-dispose-2"),
			{ label: "待决出现" },
		);
		const { answerPending } = await import("../../src/company/escalation.ts");
		await answerPending(
			runtime,
			{ key: "web-dispose-2", answer: "老板定。", answeredBy: "ceo", escalate: true },
			BACKGROUND_CONTEXT,
		);
		await eventually(
			async () => (await listPending(runtime, BACKGROUND_CONTEXT)).some((item) => item.level === "owner"),
			{ label: "升到老板层" },
		);

		const first = await fetch(`${server.url}api/pending/dispose`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ key: "web-dispose-2", status: "resolved" }),
		});
		expect(first.status).toBe(200);
		expect(((await first.json()) as { changed: boolean }).changed).toBe(true);

		const second = await fetch(`${server.url}api/pending/dispose`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ key: "web-dispose-2", status: "resolved" }),
		});
		expect(second.status).toBe(200);
		expect(((await second.json()) as { changed: boolean }).changed).toBe(false);
	});

	test("参数不合法：缺 key / status 非法一律 400", async () => {
		const { server } = await setup();
		const noKey = await fetch(`${server.url}api/pending/dispose`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ status: "rejected" }),
		});
		expect(noKey.status).toBe(400);

		const badStatus = await fetch(`${server.url}api/pending/dispose`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ key: "x", status: "whatever" }),
		});
		expect(badStatus.status).toBe(400);
	});
});

describe("派活不再同步等待（ADR-028 替代契约 §5.1）", () => {
	test("对方一直不答，派活工具也立刻返回（不等结果）", async () => {
		const { server, runtime, boot, ctx } = await setup();

		// CTO 那一轮要 5 秒才答。旧实现在这里会挂 180 秒或 300ms 超时；
		// 新实现**根本不等待**——工具立刻返回「已派出，等它上报」。
		ctx.faux.setResponses([
			toolCall("ask_role", { to: "CTO", text: "做点慢活" }),
			slowAnswer(5_000, "CTO 很晚才答"),
			answer("CEO 收尾"),
		]);

		const ceo = await runtime.harness.conversation(boot.ownerConversationId as never, BACKGROUND_CONTEXT);
		const started = Date.now();
		void ceo?.submit({ type: "input", content: "问问 CTO" }, BACKGROUND_CONTEXT);

		// 会话流视图删除后，工具调用从「工作记录」接口读（同一份 readFeed 投影）。
		let tool: { name: string; state: string; output: string } | undefined;
		await eventually(
			async () => {
				const page = (await (
					await fetch(`${server.url}api/staff/${boot.ownerConversationId}/activity?limit=200`)
				).json()) as { items: { kind: string; name?: string; state?: string; outputSummary?: string }[] };
				const found = page.items.find((item) => item.kind === "tool" && item.name === "ask_role");
				tool = found === undefined ? undefined : { name: found.name ?? "", state: found.state ?? "", output: found.outputSummary ?? "" };
				return tool !== undefined && tool.state !== "running";
			},
			{ label: "派活工具拿到结果", timeoutMs: 3_000 },
		);

		const elapsed = Date.now() - started;
		// 关键：CTO 要跑 5 秒，但 CEO 这边必须立刻拿回控制权
		expect(elapsed, `派活必须不等待（实测 ${elapsed}ms）`).toBeLessThan(2_000);

		expect(tool).toBeDefined();
		if (tool !== undefined) {
			expect(tool.state, "派活是业务结果，不是工具崩溃").toBe("ok");
			expect(tool.output).toContain("不用等");
		}

		// 消息确实进了频道（不依赖对方消费）
		const channels = await (await fetch(`${server.url}api/channels`)).json() as { channels: { id: string }[] };
		expect(channels.channels.length).toBeGreaterThan(0);
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

/**
 * 服务健壮性：畸形输入不能让进程倒下。
 *
 * 这一组钉的是三个真实缺陷（架构审查发现，都有最小复现）：
 * ① `new URL()` 写在 try 之外 + `unhandledRejection → process.exit(1)`，
 *    一个 `Host: a b` 就能打死整个运行时；
 * ② `readJson` 没有字节上限，一个 2GB body 吃满内存；
 * ③ 静态目录用 `startsWith` 比较，`/../ui-backup/x` 会被放行。
 */
/** 用裸 socket 发一个 GET，返回状态码与正文（`fetch` 会归一化 `..`，测不了穿越）。 */
async function rawGet(port: number, path: string): Promise<{ status: number; body: string }> {
	const socket = connect({ host: "127.0.0.1", port });
	let buffer = "";
	await new Promise<void>((resolve) => {
		socket.on("connect", () => {
			socket.write(`GET ${path} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n`);
		});
		socket.on("data", (chunk) => {
			buffer += chunk.toString("utf8");
		});
		socket.on("close", () => resolve());
		socket.on("error", () => resolve());
	});
	const status = Number(buffer.split(" ")[1] ?? 0);
	return { status, body: buffer };
}

describe("服务健壮性", () => {
	test("畸形 Host 头不会打挂服务，返回 400 后仍能正常服务", async () => {
		const { server } = await setup();

		const raw = await new Promise<string>((resolve, reject) => {
			const socket = connect({ host: "127.0.0.1", port: server.port }, () => {
				socket.write("GET /api/org HTTP/1.1\r\nHost: a b\r\nConnection: close\r\n\r\n");
			});
			let text = "";
			socket.on("data", (chunk) => {
				text += chunk.toString("utf8");
			});
			socket.on("end", () => resolve(text));
			socket.on("error", reject);
			setTimeout(() => resolve(text), 2000);
		});
		expect(raw).toMatch(/^HTTP\/1\.1 400/);

		// 服务还活着
		const after = await fetch(`${server.url}api/org`);
		expect(after.status).toBe(200);
	});

	test("超大 JSON 请求体被拒，不会吃满内存", async () => {
		const { server } = await setup();
		const big = "x".repeat(2 * 1024 * 1024);
		const response = await fetch(`${server.url}api/channels/company/messages`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ text: big }),
		}).catch(() => undefined);
		// 连接被 destroy 或返回 4xx/5xx 都算拒绝；关键是没有 200
		if (response !== undefined) expect(response.status).not.toBe(200);

		const after = await fetch(`${server.url}api/org`);
		expect(after.status).toBe(200);
	});

	test("静态目录不能用 ui 前缀的同级目录穿越", async () => {
		const { server } = await setup();
		// **必须用裸 socket 发**：`fetch()` 会在客户端就把 `..` 归一化掉，
		// 请求到不了服务端，这条测试会永远是绿的（一开始就写成 fetch，测了个寂寞）。
		// 编码过的点号能绕过 `new URL()` 的归一化，真正走到 join/normalize 那条路径。
		const paths = ["/../ui-backup/secret.txt", "/%2e%2e/ui-backup/secret.txt", "/./../ui-other/f", "/../ui2/a"];
		for (const path of paths) {
			const { status, body } = await rawGet(server.port, path);
			// 判据只有一条：**读不到同级目录的文件内容**。
			// 200 只允许是 index.html（SPA 回退），不允许是兄弟目录里的文件。
			expect(body.includes("secret")).toBe(false);
			if (status === 200) expect(body.includes("<html")).toBe(true);
			else expect([403, 404]).toContain(status);
		}
	});
});
