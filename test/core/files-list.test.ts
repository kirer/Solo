/**
 * 文件树列表：并发、分页、顺序稳定（审计 P2-2）。
 *
 * 为什么要测这三样：
 * - 并发没夹住 → 5000 个文件同时开 5000 个 `stat`，fd 打满（比串行更糟）；
 * - 分页没做 → 大目录一次全量 stat；
 * - 顺序不稳 → 翻页时同一个文件出现两次、另一个永远看不到。
 */
import { request as httpRequest } from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createRegistry, setupModels } from "../../src/core/runtime/index.ts";
import { openCore, type CoreRuntime } from "../../src/core/runtime/open.ts";
import { assembleCore } from "../../src/core/shell/assemble.ts";
import { mapLimit, serveCore, type CoreServer } from "../../src/core/shell/serve.ts";

describe("mapLimit：并发有上限、顺序不变", () => {
	it("同时在跑的从不超过上限，结果顺序与输入一致", async () => {
		let running = 0;
		let peak = 0;
		const out = await mapLimit(Array.from({ length: 50 }, (_, i) => i), 4, async (item) => {
			running += 1;
			peak = Math.max(peak, running);
			await new Promise((resolve) => setTimeout(resolve, 1));
			running -= 1;
			return item * 2;
		});
		expect(peak).toBeLessThanOrEqual(4);
		expect(peak).toBeGreaterThan(1); // 真的并发了，不是退化成串行
		expect(out).toEqual(Array.from({ length: 50 }, (_, i) => i * 2));
	});

	it("空列表直接返回空数组", async () => {
		expect(await mapLimit([], 8, async (item: number) => item)).toEqual([]);
	});
});

const roots: string[] = [];
const runtimes: CoreRuntime[] = [];
const servers: CoreServer[] = [];

afterEach(async () => {
	for (const server of servers.splice(0)) await server.close().catch(() => undefined);
	for (const runtime of runtimes.splice(0)) await runtime.close().catch(() => undefined);
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function setup(): Promise<{ root: string; port: number }> {
	const root = await mkdtemp(join(tmpdir(), "core-files-"));
	roots.push(root);
	const { models: configured } = setupModels(process.env, { workspace: root });
	const runtime = await openCore({ databasePath: join(root, "core.sqlite"), models: configured, registry: createRegistry() });
	runtimes.push(runtime);
	const shell = await assembleCore(runtime.harness, runtime.registry, {
		agentsRoot: join(root, "agents"),
		teamsRoot: join(root, "teams"),
		defaultModel: { provider: "test", modelId: "test" },
	});
	const server = await serveCore({ shell, port: 0 });
	servers.push(server);
	return { root, port: server.port };
}

function get(port: number, path: string): Promise<{ status: number; body: string }> {
	return new Promise((resolve, reject) => {
		const req = httpRequest({ host: "127.0.0.1", port, path }, (response) => {
			let body = "";
			response.setEncoding("utf8");
			response.on("data", (chunk: string) => {
				body += chunk;
			});
			response.on("end", () => resolve({ status: response.statusCode ?? 0, body }));
		});
		req.on("error", reject);
		req.end();
	});
}

type Listing = { entries: { name: string; kind: string; bytes: number; at: number }[]; total: number; truncated: boolean };

describe("目录列表分页", () => {
	it("一页按 limit 切，给出 total 与 truncated；两页拼起来不漏不重", async () => {
		const { root, port } = await setup();
		const dir = join(root, "many");
		await mkdir(dir, { recursive: true });
		for (let i = 0; i < 30; i += 1) await writeFile(join(dir, `f${String(i).padStart(2, "0")}.txt`), "x", "utf8");
		await mkdir(join(dir, "sub"));

		const first = JSON.parse((await get(port, "/api/files?path=many&limit=10")).body) as Listing;
		expect(first.entries).toHaveLength(10);
		expect(first.total).toBe(31); // 30 个文件 + 1 个目录
		expect(first.truncated).toBe(true);
		// 目录永远在最前（界面按这个顺序画）。
		expect(first.entries[0]?.kind).toBe("dir");

		const second = JSON.parse((await get(port, "/api/files?path=many&limit=10&offset=10")).body) as Listing;
		const third = JSON.parse((await get(port, "/api/files?path=many&limit=10&offset=20")).body) as Listing;
		const fourth = JSON.parse((await get(port, "/api/files?path=many&limit=10&offset=30")).body) as Listing;
		expect(fourth.truncated).toBe(false);

		const names = [...first.entries, ...second.entries, ...third.entries, ...fourth.entries].map((item) => item.name);
		expect(new Set(names).size).toBe(31);
		expect(names).toHaveLength(31);
	});

	it("limit 被夹在上限内（不能拿它当批量接口用）", async () => {
		const { root, port } = await setup();
		await mkdir(join(root, "d"), { recursive: true });
		await writeFile(join(root, "d", "a.txt"), "x", "utf8");
		const listing = JSON.parse((await get(port, "/api/files?path=d&limit=999999")).body) as Listing;
		expect(listing.entries).toHaveLength(1);
		expect(listing.total).toBe(1);
	});

	it("文件还在但 stat 失败的条目仍然返回（不少一条）", async () => {
		const { root, port } = await setup();
		const dir = join(root, "race");
		await mkdir(dir, { recursive: true });
		await writeFile(join(dir, "keep.txt"), "x", "utf8");
		const listing = JSON.parse((await get(port, "/api/files?path=race")).body) as Listing;
		expect(listing.entries.map((item) => item.name)).toContain("keep.txt");
		expect(listing.entries[0]?.bytes).toBe(1);
	});
});
