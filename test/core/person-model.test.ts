/**
 * 给某一个人换模型：`POST /api/people/:slug/model`。
 *
 * 两件事都得成立，缺一件界面上就会「设置自己变回去」：
 * 1. **当场生效**：改的是会话的 `configure`，不是等重启；
 * 2. **重启也认**：记进 `settings.json` 的 `agentModels`，装配时那个人用这一只。
 *
 * 只认注册表里真有的模型：写一个解析不到的引用，这个人此后每轮都 `no_model`，
 * 界面上只留一句「他这一轮没答上来」。
 */
import { request as httpRequest } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BACKGROUND_CONTEXT, setupModels } from "../../src/core/runtime/index.ts";
import { serveCore, type CoreServer } from "../../src/core/shell/serve.ts";
import { sandboxPool } from "./support.ts";

const pool = sandboxPool();
const servers: CoreServer[] = [];

afterEach(async () => {
	for (const server of servers.splice(0)) await server.close().catch(() => undefined);
	await pool.cleanup();
});

const gateway = (models: readonly string[]) => ({
	id: "magpie",
	name: "本地网关",
	baseUrl: "http://127.0.0.1:3425/v1",
	api: "openai-responses",
	models: models.map((id) => ({ id })),
});

async function boot(): Promise<{ root: string; port: number; shell: Awaited<ReturnType<Awaited<ReturnType<typeof pool.make>>["assemble"]>> }> {
	const box = await pool.make("core-person-model-");
	await mkdir(join(box.agentsRoot, "林越"), { recursive: true });
	await writeFile(join(box.agentsRoot, "林越", "identity.md"), "---\nname: 林越\ntitle: 工程师\n---\n\n# 林越\n", "utf8");
	await writeFile(
		join(box.root, "settings.json"),
		`${JSON.stringify({ defaultModel: "magpie/m-one", providers: [gateway(["m-one", "m-two"])] }, null, 2)}\n`,
		"utf8",
	);

	const setup = setupModels({}, { workspace: box.root });
	const runtime = await box.open({ models: setup.models });
	const shell = await box.assemble(runtime, {
		...(setup.defaultModel === undefined ? {} : { defaultModel: setup.defaultModel }),
		...(setup.agentModels === undefined ? {} : { agentModels: setup.agentModels }),
		models: setup.models,
	});
	await shell.rescan();
	const server = await serveCore({ shell, port: 0 });
	servers.push(server);
	return { root: box.root, port: server.port, shell };
}

function post(port: number, path: string, body: unknown): Promise<{ status: number; body: string }> {
	return new Promise((resolve, reject) => {
		const payload = JSON.stringify(body);
		const req = httpRequest(
			{ host: "127.0.0.1", port, method: "POST", path, headers: { "content-type": "application/json", "content-length": Buffer.byteLength(payload) } },
			(response) => {
				let out = "";
				response.setEncoding("utf8");
				response.on("data", (chunk: string) => {
					out += chunk;
				});
				response.on("end", () => resolve({ status: response.statusCode ?? 0, body: out }));
			},
		);
		req.on("error", reject);
		req.end(payload);
	});
}

function get(port: number, path: string): Promise<string> {
	return new Promise((resolve, reject) => {
		const req = httpRequest({ host: "127.0.0.1", port, method: "GET", path }, (response) => {
			let out = "";
			response.setEncoding("utf8");
			response.on("data", (chunk: string) => {
				out += chunk;
			});
			response.on("end", () => resolve(out));
		});
		req.on("error", reject);
		req.end();
	});
}

const modelPath = (slug: string) => `/api/people/${encodeURIComponent(slug)}/model`;

describe("现在生效的模型清单", () => {
	it("GET /api/models 只列装配好的那些（不是 settings.json 里写的）", async () => {
		const { port } = await boot();
		const body = await get(port, "/api/models");
		expect(JSON.parse(body)).toEqual({ models: ["magpie/m-one", "magpie/m-two"], defaultModel: "magpie/m-one" });
	});
});

describe("改 settings.json 不用重启", () => {
	it("新加的模型下一次读注册表就在（ADR-025），当场能给某个人换上", async () => {
		const { root, port, shell } = await boot();
		expect(JSON.parse(await get(port, "/api/models")).models).toEqual(["magpie/m-one", "magpie/m-two"]);

		// 设置页写盘：多一只模型。进程不动，接着读。
		await writeFile(
			join(root, "settings.json"),
			`${JSON.stringify({ defaultModel: "magpie/m-one", providers: [gateway(["m-one", "m-two", "m-three"])] }, null, 2)}\n`,
			"utf8",
		);

		expect(JSON.parse(await get(port, "/api/models")).models).toContain("magpie/m-three");
		const response = await post(port, modelPath("林越"), { model: "magpie/m-three" });
		expect(response.status).toBe(200);
		const conversation = shell.conversations.get("林越");
		if (conversation === undefined) throw new Error("没有会话");
		expect((await conversation.agent(BACKGROUND_CONTEXT)).model).toMatchObject({ modelId: "m-three" });
	});

	it("删掉一家提供商：它从清单里消失，挂着它的人回到默认模型", async () => {
		const { root, port, shell } = await boot();
		await post(port, modelPath("林越"), { model: "magpie/m-two" });

		// 只留 m-one：m-two 这一只没了。
		await writeFile(
			join(root, "settings.json"),
			`${JSON.stringify({ defaultModel: "magpie/m-one", providers: [gateway(["m-one"])] }, null, 2)}\n`,
			"utf8",
		);

		expect(JSON.parse(await get(port, "/api/models")).models).toEqual(["magpie/m-one"]);
		const conversation = shell.conversations.get("林越");
		if (conversation === undefined) throw new Error("没有会话");
		expect((await conversation.agent(BACKGROUND_CONTEXT)).model).toMatchObject({ modelId: "m-one" });
	});
});

describe("给一个人换模型", () => {
	it("换了当场生效，并记进 settings.json（重启后装配认这一份）", async () => {
		const { root, port, shell } = await boot();

		const response = await post(port, modelPath("林越"), { model: "magpie/m-two" });
		expect(response.status).toBe(200);
		expect(JSON.parse(response.body)).toEqual({ model: "magpie/m-two" });

		const conversation = shell.conversations.get("林越");
		if (conversation === undefined) throw new Error("没有会话");
		expect((await conversation.agent(BACKGROUND_CONTEXT)).model).toMatchObject({ provider: "magpie", modelId: "m-two" });

		const settings = JSON.parse(await readFile(join(root, "settings.json"), "utf8")) as {
			agentModels?: Record<string, string>;
		};
		expect(settings.agentModels).toEqual({ 林越: "magpie/m-two" });
		// 「重启」：再装配一次，这个人用记下来的那一只。
		expect(setupModels({}, { workspace: root }).agentModels).toEqual({ 林越: { provider: "magpie", modelId: "m-two" } });
	});

	it("空串 = 跟默认：改回默认模型，记录删掉", async () => {
		const { root, port, shell } = await boot();
		await post(port, modelPath("林越"), { model: "magpie/m-two" });

		const response = await post(port, modelPath("林越"), { model: "" });
		expect(response.status).toBe(200);

		const conversation = shell.conversations.get("林越");
		if (conversation === undefined) throw new Error("没有会话");
		expect((await conversation.agent(BACKGROUND_CONTEXT)).model).toMatchObject({ provider: "magpie", modelId: "m-one" });

		const settings = JSON.parse(await readFile(join(root, "settings.json"), "utf8")) as { agentModels?: unknown };
		expect(settings.agentModels).toBeUndefined();
		expect(setupModels({}, { workspace: root }).agentModels).toBeUndefined();
	});

	it("没有的模型 / 没有的写法：拒绝，会话不动", async () => {
		const { port, shell } = await boot();

		expect((await post(port, modelPath("林越"), { model: "magpie/没有这个" })).status).toBe(400);
		expect((await post(port, modelPath("林越"), { model: "m-two" })).status).toBe(400);

		const conversation = shell.conversations.get("林越");
		if (conversation === undefined) throw new Error("没有会话");
		expect((await conversation.agent(BACKGROUND_CONTEXT)).model).toMatchObject({ modelId: "m-one" });
	});
});
