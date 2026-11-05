/**
 * 记忆留痕里的「操作者」必须能分清来源（审计 P2-4）。
 *
 * P0-4 之后 HTTP 侧只剩我一个身份，所以**不造多用户模型**：面板上的改动记
 * `owner:web`，agent 自己 `remember` 记 `agent`。出错时能一眼分开就够了。
 */
import { request as httpRequest } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { serveCore, type CoreServer } from "../../src/shell/serve.ts";
import { JOURNAL_FILE } from "../../src/core/documents/person/journal.ts";
import { sandboxPool } from "./support.ts";

const pool = sandboxPool();
const servers: CoreServer[] = [];

afterEach(async () => {
	for (const server of servers.splice(0)) await server.close().catch(() => undefined);
	await pool.cleanup();
});

async function setup(): Promise<{ root: string; port: number }> {
	const box = await pool.make("core-memory-actor-");
	const root = box.root;
	const agentsRoot = box.agentsRoot;
	await mkdir(join(agentsRoot, "林越"), { recursive: true });
	await writeFile(
		join(agentsRoot, "林越", "identity.md"),
		["---", "name: 林越", "title: 前端工程师", "owner: 知言", "---", "", "负责界面。", ""].join("\n"),
		"utf8",
	);
	await writeFile(join(agentsRoot, "林越", "memory.md"), "# 记忆\n", "utf8");
	const runtime = await box.open();
	const shell = await box.assemble(runtime, { defaultModel: { provider: "test", modelId: "test" } });
	await shell.rescan();
	const server = await serveCore({ shell, port: 0 });
	servers.push(server);
	return { root, port: server.port };
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

async function lastJournal(root: string): Promise<{ by: string; op: string }> {
	const raw = await readFile(join(root, "members", "林越", JOURNAL_FILE), "utf8");
	const lines = raw.trim().split("\n");
	return JSON.parse(lines[lines.length - 1] ?? "{}") as { by: string; op: string };
}

describe("记忆面板的留痕写上真实来源", () => {
	it("面板加一条：留痕是 owner:web，不是含糊的 owner", async () => {
		const { root, port } = await setup();
		const added = await post(port, `/api/people/${encodeURIComponent("林越")}/memory`, { op: "add", text: "面板加的一条" });
		expect(added.status).toBe(200);
		const entry = await lastJournal(root);
		expect(entry.by).toBe("owner:web");
		expect(entry.op).toBe("append");
	});

	it("面板删一条：留痕同样是 owner:web", async () => {
		const { root, port } = await setup();
		await post(port, `/api/people/${encodeURIComponent("林越")}/memory`, { op: "add", text: "要被删的一条" });
		const source = await readFile(join(root, "members", "林越", "memory.md"), "utf8");
		const heading = source.split("\n").find((line) => line.startsWith("## "))?.slice(3).trim() ?? "";
		const forgotten = await post(port, `/api/people/${encodeURIComponent("林越")}/memory`, { op: "forget", heading });
		expect(forgotten.status).toBe(200);
		const entry = await lastJournal(root);
		expect(entry.by).toBe("owner:web");
		expect(entry.op).toBe("replace");
	});
});
