/**
 * 平台能力接口测试：设置 / 模型 / 附件 / 看板 / IM / 局域网。
 *
 * 全部走真实 HTTP 与真实运行时（faux 模型），只使用临时数据库与临时
 * workspace：绝不碰仓库里的 workspace/。
 */
import { afterEach, describe, expect, test } from "vitest";
import { createServer, type Server as HttpServer } from "node:http";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import {
	BACKGROUND_CONTEXT,
	createRegistry,
	openCompany,
	recover,
	type CompanyRuntime,
} from "../../src/runtime/index.ts";
import { bootstrapCompany, COMPANY_TASKS_EXTENSION, createProject } from "../../src/company/org.ts";
import { createEscalationTask, listPending, startEscalation } from "../../src/company/escalation.ts";
import { serve, type Server } from "../../src/server/http.ts";
import type { BoardView } from "../../src/server/board.ts";
import type { SettingsView } from "../../src/server/settings.ts";
import type { Feed } from "../../src/server/feed.ts";
import { lanAddresses } from "../../src/server/network.ts";
import {
	answer,
	createTestContext,
	eventually,
	slowAnswer,
	TEST_MODEL_CATALOG,
	type TestContext,
} from "../support.ts";

type SetupOptions = {
	readonly host?: string;
};

let contexts: TestContext[] = [];
let runtimes: CompanyRuntime[] = [];
let servers: Server[] = [];
let dirs: string[] = [];

/** 起一套完整的公司 + 服务（临时目录 + 临时库）。 */
async function setup(options: SetupOptions = {}) {
	const ctx = await createTestContext();
	contexts.push(ctx);
	const dir = await mkdtemp(join(tmpdir(), "ai-company-platform-"));
	dirs.push(dir);
	const workspace = join(dir, "workspace");

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

	const server = await serve({
		runtime,
		port: 0,
		// 看门狗只该由「真的在跑服务」的入口拥有，测试里关掉
		watchdog: false,
		uiDir: join(process.cwd(), "ui"),
		workspace,
		models: {
			models: ctx.models,
			defaultModel: { provider: "faux", modelId: "faux-1" },
			catalog: [...TEST_MODEL_CATALOG],
		},
		...(options.host === undefined ? {} : { host: options.host }),
	});
	servers.push(server);

	return { ctx, runtime, boot, server, escalationTask, dir, workspace };
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

async function readSettings(server: Server): Promise<SettingsView> {
	return (await (await fetch(`${server.url}api/settings`)).json()) as SettingsView;
}

describe("设置接口", () => {
	test("GET 返回 network / models 两段，端口是实际监听值", async () => {
		const { server } = await setup();
		const settings = await readSettings(server);

		expect(settings.network.port).toBe(server.port);
		expect(settings.network.host).toBe("127.0.0.1");
		expect(settings.network.lanUrls).toEqual([]);
		expect(settings.network.url).toBe(`http://127.0.0.1:${server.port}/`);
		expect(settings.models.catalog.map((item) => item.id)).toContain("faux-1");
		expect(settings.models.catalog.every((item) => item.source === "builtin")).toBe(true);
		expect(settings.models.restartRequired).toBe(false);
	});

	test("PATCH 往返：network 落盘，未提到的段保留原值", async () => {
		const { server, workspace } = await setup();
		const response = await fetch(`${server.url}api/settings`, {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ network: { host: "0.0.0.0" } }),
		});
		expect(response.status).toBe(200);
		const updated = (await response.json()) as SettingsView;
		// 改了 network 才需要重启
		expect(updated.models.restartRequired).toBe(true);

		// 设置写进了 workspace/settings.json，不碰真实 workspace。
		// 注意 GET network.host 报的是「实际监听值」，持久化的期望值要看文件。
		const raw = JSON.parse(await readFile(join(workspace, "settings.json"), "utf8")) as SettingsView;
		expect(raw.network.host).toBe("0.0.0.0");
	});

	test("非法 PATCH 返回 400 而不是 500", async () => {
		const { server } = await setup();
		const response = await fetch(`${server.url}api/settings`, {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify("nope"),
		});
		expect(response.status).toBe(400);
	});
});

describe("模型接口", () => {
	test("POST 新增 → GET catalog 可见 → DELETE 删除", async () => {
		const { server } = await setup();
		const payload = {
			id: "gpt-5-mini",
			name: "GPT-5 mini",
			provider: "openai",
			baseUrl: "https://api.openai.com/v1",
			apiKey: "sk-test",
			inputPerMTok: 0.25,
			outputPerMTok: 2,
			contextWindow: 400_000,
			maxOutput: 128_000,
		};
		const created = await fetch(`${server.url}api/models`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(payload),
		});
		expect(created.status).toBe(200);
		const createdBody = (await created.json()) as {
			ok: boolean;
			restartRequired: boolean;
			model: { id: string; source: string; inputPerMTok: number };
		};
		expect(createdBody.ok).toBe(true);
		expect(createdBody.restartRequired).toBe(true);
		expect(createdBody.model).toMatchObject({ id: "gpt-5-mini", source: "custom", inputPerMTok: 0.25 });

		const settings = await readSettings(server);
		expect(settings.models.catalog.some((item) => item.id === "gpt-5-mini" && item.source === "custom")).toBe(true);
		expect(settings.models.restartRequired).toBe(true);
		// 默认模型仍是启动时的默认（新模型要重启才可用）
		expect(settings.models.default).toBe("faux/faux-1");
	});

	test("重复 / 与内置重名 / 非法 baseUrl 分别返回 409 与 400", async () => {
		const { server } = await setup();
		const post = (body: unknown) =>
			fetch(`${server.url}api/models`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(body),
			});

		expect((await post({ id: "dup" })).status).toBe(200);
		expect((await post({ id: "dup" })).status).toBe(409);
		expect((await post({ id: "faux-1" })).status).toBe(409);
		expect((await post({ id: "bad", baseUrl: "ftp://x" })).status).toBe(400);
		expect((await post({ id: "" })).status).toBe(400);
	});

	test("DELETE：自定义模型真删，内置模型软隐藏，不存在返回 404", async () => {
		const { server } = await setup();
		await fetch(`${server.url}api/models`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ id: "temp-model" }),
		});
		const removed = await fetch(`${server.url}api/models?id=temp-model`, { method: "DELETE" });
		expect(removed.status).toBe(200);
		expect((await removed.json()) as { restartRequired: boolean }).toMatchObject({ restartRequired: true });
		expect((await readSettings(server)).models.catalog.some((item) => item.id === "temp-model")).toBe(false);

		expect((await fetch(`${server.url}api/models?id=temp-model`, { method: "DELETE" })).status).toBe(404);

		// 内置模型不能真删（它来自代码里的内建目录），但老板要求「设置里能删掉
		// 用不上的内置模型」，所以走**软隐藏**：写一条 hidden 覆盖项，视图里不再列出。
		const hideBuiltin = await fetch(`${server.url}api/models?id=${encodeURIComponent("faux-1")}`, { method: "DELETE" });
		expect(hideBuiltin.status).toBe(200);
		expect((await hideBuiltin.json()) as { restartRequired: boolean }).toMatchObject({ restartRequired: true });
		expect((await readSettings(server)).models.catalog.some((item) => item.id === "faux-1")).toBe(false);

		// 完全没见过的 id 依旧是 404
		expect((await fetch(`${server.url}api/models?id=never-existed`, { method: "DELETE" })).status).toBe(404);
	});
});

describe("看板接口", () => {
	test("三列结构固定，最近完成的一轮回复进 done", async () => {
		const { server, boot, ctx, runtime } = await setup();
		ctx.faux.setResponses([answer("第一件事已经做完了。")]);
		// 会话流视图与 POST /api/message 已删除（ADR-040），这里直接投给会话。
		const conversation = await runtime.harness.conversation(boot.ownerConversationId as never, BACKGROUND_CONTEXT);
		await conversation?.submit({ type: "input", content: "做第一件事" }, BACKGROUND_CONTEXT);

		await eventually(
			async () => {
				const board = (await (await fetch(`${server.url}api/board`)).json()) as BoardView;
				return board.columns[2]?.items.some((item) => item.conversationId === boot.ownerConversationId) === true;
			},
			{ label: "done 出现完成项" },
		);

		const board = (await (await fetch(`${server.url}api/board`)).json()) as BoardView;
		expect(board.generatedAt).toBeGreaterThan(0);
		expect(board.columns.map((column) => column.id)).toEqual(["doing", "todo", "done"]);
		const done = board.columns[2]?.items.find((item) => item.conversationId === boot.ownerConversationId);
		expect(done).toMatchObject({
			status: "done",
			ownerLabel: "CEO",
			conversationId: boot.ownerConversationId,
			href: `#/c/${boot.ownerConversationId}`,
		});
		expect(done?.title).toContain("第一件事");
		expect(typeof done?.at).toBe("number");
	});

	test("忙碌会话进 doing；排队消息进 todo（status=queued）", async () => {
		const { server, boot, ctx, runtime } = await setup();
		ctx.faux.setResponses([slowAnswer(3_000, "慢慢做")]);
		const conversation = await runtime.harness.conversation(boot.ownerConversationId as never, BACKGROUND_CONTEXT);
		await conversation?.submit({ type: "input", content: "干个长活" }, BACKGROUND_CONTEXT);

		await eventually(
			async () => {
				const board = (await (await fetch(`${server.url}api/board`)).json()) as BoardView;
				return board.columns[0]?.items.some((item) => item.conversationId === boot.ownerConversationId) === true;
			},
			{ label: "doing 出现忙碌会话" },
		);
		const doing = (await (await fetch(`${server.url}api/board`)).json()) as BoardView;
		const busy = doing.columns[0]?.items.find((item) => item.conversationId === boot.ownerConversationId);
		expect(busy?.status).toBe("busy");
		expect(busy?.owner).toBe(boot.ownerConversationId);

		// steer 档不会打断当前轮：消息留在队列里
		await conversation?.submit(
			{ type: "input", content: "排队的第二件事", whenBusy: "steer" },
			BACKGROUND_CONTEXT,
		);

		await eventually(
			async () => {
				const board = (await (await fetch(`${server.url}api/board`)).json()) as BoardView;
				return board.columns[1]?.items.some((item) => item.title.includes("排队的第二件事")) === true;
			},
			{ label: "todo 出现排队项" },
		);
		const board = (await (await fetch(`${server.url}api/board`)).json()) as BoardView;
		const queued = board.columns[1]?.items.find((item) => item.title.includes("排队的第二件事"));
		expect(queued?.status).toBe("queued");
		expect(queued?.conversationId).toBe(boot.ownerConversationId);
	}, 30_000);

	test("待拍板的问题进 todo（status=waiting）", async () => {
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
				question: "要不要加联机？",
				from: "林越",
				fromConversationId: project.leader,
				manager: "ceo",
				escalationKey: "board-esc",
			},
			BACKGROUND_CONTEXT,
		);
		await eventually(async () => (await listPending(runtime, BACKGROUND_CONTEXT)).length > 0, { label: "待决出现" });

		const board = (await (await fetch(`${server.url}api/board`)).json()) as BoardView;
		const waiting = board.columns[1]?.items.find((item) => item.title.includes("联机"));
		expect(waiting).toMatchObject({
			status: "waiting",
			conversationId: project.leader,
			href: `#/c/${project.leader}`,
		});
		expect(waiting?.owner).toBe(project.leader);
		expect(waiting?.project).toBe("a");
		expect(waiting?.projectName).toBe("A");
		expect(typeof waiting?.at).toBe("number");
	});
});

describe("局域网访问", () => {
	test("host=0.0.0.0 时 lanUrls 列出非回环 IPv4，url 仍是本机回环", async () => {
		const { server } = await setup({ host: "0.0.0.0" });
		const settings = await readSettings(server);

		expect(server.host).toBe("0.0.0.0");
		expect(settings.network.host).toBe("0.0.0.0");
		expect(settings.network.url).toBe(`http://127.0.0.1:${server.port}/`);

		const expected = lanAddresses().map((address) => `http://${address}:${server.port}/`);
		expect(server.lanUrls).toEqual(expected);
		expect(settings.network.lanUrls).toEqual(expected);
		if (expected.length > 0) {
			expect(server.lanUrls.length).toBeGreaterThan(0);
		}
	});

	test("默认只监听 127.0.0.1，不给局域网地址", async () => {
		const { server } = await setup();
		expect(server.host).toBe("127.0.0.1");
		expect(server.lanUrls).toEqual([]);
	});
});
