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
	test("GET 返回 network / models / im 三段，端口是实际监听值", async () => {
		const { server } = await setup();
		const settings = await readSettings(server);

		expect(settings.network.port).toBe(server.port);
		expect(settings.network.host).toBe("127.0.0.1");
		expect(settings.network.lanUrls).toEqual([]);
		expect(settings.network.url).toBe(`http://127.0.0.1:${server.port}/`);
		expect(settings.models.catalog.map((item) => item.id)).toContain("faux-1");
		expect(settings.models.catalog.every((item) => item.source === "builtin")).toBe(true);
		expect(settings.models.restartRequired).toBe(false);
		expect(settings.im).toEqual({ enabled: false, outboundWebhook: "", inboundToken: "", accounts: [] });
	});

	test("PATCH 往返：im 与 network 落盘，accounts 整段替换", async () => {
		const { server, workspace } = await setup();
		const patch = {
			network: { host: "0.0.0.0" },
			im: {
				enabled: true,
				outboundWebhook: "http://127.0.0.1:9/hook",
				inboundToken: "tok",
				accounts: [{ id: "a1", channel: "wechat", name: "老板微信", enabled: true, note: "备注" }],
			},
		};
		const response = await fetch(`${server.url}api/settings`, {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(patch),
		});
		expect(response.status).toBe(200);
		const updated = (await response.json()) as SettingsView;
		expect(updated.im.accounts).toHaveLength(1);
		expect(updated.im.accounts[0]).toMatchObject({ id: "a1", channel: "wechat", name: "老板微信" });

		// 只改 IM 不需要重启；改了 network 才需要
		expect(updated.models.restartRequired).toBe(true);

		await fetch(`${server.url}api/settings`, {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ im: { accounts: [] } }),
		});
		const again = await readSettings(server);
		expect(again.im.accounts).toEqual([]);
		// PATCH 不会把 enabled 顺手改掉
		expect(again.im.enabled).toBe(true);

		// 设置写进了 workspace/settings.json，不碰真实 workspace。
		// 注意 GET network.host 报的是「实际监听值」，持久化的期望值要看文件。
		const raw = JSON.parse(await readFile(join(workspace, "settings.json"), "utf8")) as SettingsView;
		expect(raw.network.host).toBe("0.0.0.0");
		expect(raw.im.accounts).toEqual([]);
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

describe("附件接口", () => {
	test("上传原始字节 → 下载内容一致（中文名 URL 编码）", async () => {
		const { server, dir } = await setup();
		const bytes = Buffer.from("附件内容 hello", "utf8");
		const response = await fetch(`${server.url}api/upload`, {
			method: "POST",
			headers: {
				"Content-Type": "text/plain; charset=utf-8",
				"x-file-name": encodeURIComponent("季度报告 2026.txt"),
				"x-file-size": String(bytes.byteLength),
			},
			body: bytes,
		});
		expect(response.status).toBe(200);
		const uploaded = (await response.json()) as { id: string; name: string; size: number; mime: string; url: string };
		expect(uploaded.name).toBe("季度报告 2026.txt");
		expect(uploaded.size).toBe(bytes.byteLength);
		expect(uploaded.mime).toBe("text/plain");
		expect(uploaded.url).toBe(`/uploads/${uploaded.id}/${encodeURIComponent("季度报告 2026.txt")}`);

		const download = await fetch(`${server.url}${uploaded.url.replace(/^\//, "")}`);
		expect(download.status).toBe(200);
		expect(Buffer.from(await download.arrayBuffer()).toString("utf8")).toBe("附件内容 hello");
		expect(download.headers.get("content-disposition")).toContain("UTF-8");
		void dir;
	});

	test("超限 413、名字对不上 404、未知路径 404", async () => {
		const { server } = await setup();
		const tooLarge = await fetch(`${server.url}api/upload`, {
			method: "POST",
			headers: { "Content-Type": "application/octet-stream", "x-file-name": "big.bin", "x-file-size": String(21 * 1024 * 1024) },
			body: Buffer.from("x"),
		});
		expect(tooLarge.status).toBe(413);

		const uploaded = (await (
			await fetch(`${server.url}api/upload`, {
				method: "POST",
				headers: { "Content-Type": "text/plain", "x-file-name": "a.txt" },
				body: Buffer.from("x"),
			})
		).json()) as { id: string };
		expect((await fetch(`${server.url}uploads/${uploaded.id}/other.txt`)).status).toBe(404);
		expect((await fetch(`${server.url}uploads/not-an-id/a.txt`)).status).toBe(404);
	});

	test("发消息带附件：注入 [附件] 文本引用，绝对路径真实存在", async () => {
		const { server, boot } = await setup();
		const uploaded = (await (
			await fetch(`${server.url}api/upload`, {
				method: "POST",
				headers: { "Content-Type": "text/markdown", "x-file-name": "report.md" },
				body: Buffer.from("# 报告"),
			})
		).json()) as { id: string; name: string; mime: string; size: number };

		const response = await fetch(`${server.url}api/message`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				conversationId: boot.ownerConversationId,
				text: "看看这个附件",
				attachments: [uploaded],
			}),
		});
		expect(response.status).toBe(200);

		const feed = (await (await fetch(`${server.url}api/feed/${boot.ownerConversationId}`)).json()) as Feed;
		const message = feed.items.find(
			(item) => item.kind === "user" && item.text.includes("[附件] report.md"),
		);
		expect(message).toBeDefined();
		const match = /\[附件\] report\.md → (.+)$/m.exec(message?.kind === "user" ? message.text : "");
		expect(match).not.toBeNull();
		await access(match?.[1] ?? "");
	});

	test("文本附件带内联摘录：CEO 通道没有 read 工具也能看到内容", async () => {
		const { server, boot } = await setup();
		const uploaded = (await (
			await fetch(`${server.url}api/upload`, {
				method: "POST",
				headers: { "Content-Type": "text/csv", "x-file-name": "q3.csv" },
				body: Buffer.from("区域,收入\n华东,1200\n华南,900\n"),
			})
		).json()) as { id: string; name: string };

		await fetch(`${server.url}api/message`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				conversationId: boot.ownerConversationId,
				text: "看一下这个季报",
				attachments: [uploaded],
			}),
		});

		const feed = (await (await fetch(`${server.url}api/feed/${boot.ownerConversationId}`)).json()) as Feed;
		const message = feed.items.find((item) => item.kind === "user" && item.text.includes("[附件] q3.csv"));
		expect(message, "附件引用必须出现在消息里").toBeDefined();
		const text = message?.kind === "user" ? message.text : "";
		// 内容本身也要在：只给路径的话，没有 read/bash 的 CEO 通道等于看不到文件
		expect(text).toContain("内容摘录");
		expect(text).toContain("华东,1200");
	});

	test("二进制附件不做摘录（只给路径，不塞乱码 token）", async () => {
		const { server, boot } = await setup();
		const uploaded = (await (
			await fetch(`${server.url}api/upload`, {
				method: "POST",
				headers: { "Content-Type": "image/png", "x-file-name": "shot.png" },
				body: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01]),
			})
		).json()) as { id: string; name: string };

		await fetch(`${server.url}api/message`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				conversationId: boot.ownerConversationId,
				text: "看截图",
				attachments: [uploaded],
			}),
		});

		const feed = (await (await fetch(`${server.url}api/feed/${boot.ownerConversationId}`)).json()) as Feed;
		const message = feed.items.find((item) => item.kind === "user" && item.text.includes("[附件] shot.png"));
		const text = message?.kind === "user" ? message.text : "";
		expect(text).toContain("[附件] shot.png");
		expect(text).not.toContain("内容摘录");
	});

	test("附件不存在时明确 400，不静默丢弃", async () => {
		const { server, boot } = await setup();
		const response = await fetch(`${server.url}api/message`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				conversationId: boot.ownerConversationId,
				text: "看附件",
				attachments: [{ id: "deadbeefdeadbeef", name: "gone.pdf" }],
			}),
		});
		expect(response.status).toBe(400);
	});
});

describe("看板接口", () => {
	test("三列结构固定，最近完成的一轮回复进 done", async () => {
		const { server, boot, ctx } = await setup();
		ctx.faux.setResponses([answer("第一件事已经做完了。")]);
		await fetch(`${server.url}api/message`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ conversationId: boot.ownerConversationId, text: "做第一件事" }),
		});

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
		const { server, boot, ctx } = await setup();
		ctx.faux.setResponses([slowAnswer(3_000, "慢慢做")]);
		await fetch(`${server.url}api/message`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ conversationId: boot.ownerConversationId, text: "干个长活" }),
		});

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
		await fetch(`${server.url}api/message`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ conversationId: boot.ownerConversationId, text: "排队的第二件事", mode: "steer" }),
		});

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

describe("IM 接口", () => {
	async function startWebhook(): Promise<{
		server: HttpServer;
		port: number;
		received: { text: string; conversationId: number; at: number }[];
		close(): Promise<void>;
	}> {
		const received: { text: string; conversationId: number; at: number }[] = [];
		const server = createServer((request, response) => {
			const chunks: Buffer[] = [];
			request.on("data", (chunk: Buffer) => chunks.push(chunk));
			request.on("end", () => {
				try {
					received.push(JSON.parse(Buffer.concat(chunks).toString("utf8")) as never);
				} catch {
					// 忽略坏请求
				}
				response.writeHead(200, { "Content-Type": "text/plain" });
				response.end("ok");
			});
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
		const port = (server.address() as AddressInfo).port;
		return {
			server,
			port,
			received,
			async close() {
				await new Promise<void>((resolve) => server.close(() => resolve()));
			},
		};
	}

	test("入站：未启用 / token 错 → 403；正确 token 投进老板通道", async () => {
		const { server, boot } = await setup();

		const disabled = await fetch(`${server.url}api/im/inbound?token=whatever`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ text: "在吗" }),
		});
		expect(disabled.status).toBe(403);

		await fetch(`${server.url}api/settings`, {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ im: { enabled: true, inboundToken: "secret-token" } }),
		});

		const wrong = await fetch(`${server.url}api/im/inbound?token=wrong`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ text: "在吗" }),
		});
		expect(wrong.status).toBe(403);

		const accepted = await fetch(`${server.url}api/im/inbound?token=secret-token`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ text: "从微信来的消息", from: "微信" }),
		});
		expect(accepted.status).toBe(200);
		const body = (await accepted.json()) as { ok: boolean; conversationId: number };
		expect(body.ok).toBe(true);
		expect(body.conversationId).toBe(boot.ownerConversationId);

		await eventually(
			async () => {
				const feed = (await (await fetch(`${server.url}api/feed/${boot.ownerConversationId}`)).json()) as Feed;
				return feed.items.some((item) => item.kind === "user" && item.text.includes("[IM · 微信] 从微信来的消息"));
			},
			{ label: "IM 消息进入老板通道" },
		);
	});

	test("出站：老板通道的助手回复 POST 到 outboundWebhook", async () => {
		const webhook = await startWebhook();
		try {
			const { server, boot, ctx } = await setup();
			await fetch(`${server.url}api/settings`, {
				method: "PATCH",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					im: { enabled: true, outboundWebhook: `http://127.0.0.1:${webhook.port}/hook`, inboundToken: "t" },
				}),
			});

			ctx.faux.setResponses([answer("这是给老板的回复。")]);
			await fetch(`${server.url}api/message`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ conversationId: boot.ownerConversationId, text: "回我一句" }),
			});

			await eventually(async () => webhook.received.some((item) => item.text.includes("这是给老板的回复")), {
				label: "webhook 收到助手回复",
				timeoutMs: 10_000,
			});
			const payload = webhook.received.find((item) => item.text.includes("这是给老板的回复"));
			expect(payload?.conversationId).toBe(boot.ownerConversationId);
			expect(typeof payload?.at).toBe("number");
		} finally {
			await webhook.close();
		}
	}, 30_000);

	test("出站失败静默：webhook 不可达时发消息仍然成功", async () => {
		const { server, boot, ctx } = await setup();
		await fetch(`${server.url}api/settings`, {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				// 127.0.0.1:9 基本永远连不上
				im: { enabled: true, outboundWebhook: "http://127.0.0.1:9/hook", inboundToken: "t" },
			}),
		});
		ctx.faux.setResponses([answer("正常回复")]);
		const response = await fetch(`${server.url}api/message`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ conversationId: boot.ownerConversationId, text: "在吗" }),
		});
		expect(response.status).toBe(200);
		// 会话仍然能正常结束（出站失败不阻塞提交）
		await eventually(
			async () => {
				const feed = (await (await fetch(`${server.url}api/feed/${boot.ownerConversationId}`)).json()) as Feed;
				return feed.items.some((item) => item.kind === "assistant" && item.text.includes("正常回复"));
			},
			{ label: "助手回复正常落库", timeoutMs: 10_000 },
		);
	}, 30_000);
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
