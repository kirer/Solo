/**
 * 自建更新源：清单现取、产物长缓存、目录外的东西一个字节都拿不到。
 *
 * 这三条就是客户端会不会装上一个「旧版本 / 半个包 / 别人机器上的文件」的全部防线。
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createUpdateServer, type UpdateServer } from "../../scripts/update-server.ts";

const servers: UpdateServer[] = [];
const dirs: string[] = [];

afterEach(async () => {
	for (const server of servers.splice(0)) await server.close();
	for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function feed(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "core-update-feed-"));
	dirs.push(dir);
	await writeFile(join(dir, "latest-mac.yml"), "version: 0.1.0\n", "utf8");
	await writeFile(join(dir, "solo-0.1.0.zip"), "zip", "utf8");
	return dir;
}

function get(port: number, path: string): Promise<{ status: number; headers: Record<string, string>; body: string }> {
	return new Promise((resolve, reject) => {
		const req = httpRequest({ host: "127.0.0.1", port, method: "GET", path }, (response) => {
			let body = "";
			response.setEncoding("utf8");
			response.on("data", (chunk: string) => (body += chunk));
			response.on("end", () =>
				resolve({ status: response.statusCode ?? 0, headers: response.headers as Record<string, string>, body }),
			);
		});
		req.on("error", reject);
		req.end();
	});
}

async function boot(root: string): Promise<number> {
	const server = await createUpdateServer({ dir: root, port: 0, host: "127.0.0.1", log: () => undefined });
	servers.push(server);
	return server.port;
}

describe("更新源", () => {
	it("清单不缓存、产物长缓存、根路径列出发布了什么", async () => {
		const port = await boot(await feed());

		const yml = await get(port, "/latest-mac.yml");
		expect(yml.status).toBe(200);
		expect(yml.body).toBe("version: 0.1.0\n");
		expect(yml.headers["cache-control"]).toBe("no-cache");

		const zip = await get(port, "/solo-0.1.0.zip");
		expect(zip.status).toBe(200);
		expect(zip.headers["cache-control"]).toContain("immutable");

		const index = await get(port, "/");
		expect(index.body).toContain("latest-mac.yml");
		expect(index.body).toContain("solo-0.1.0.zip");
	});

	it("目录外的文件（含编码过的 ../）一律 404", async () => {
		const root = await feed();
		await mkdir(join(root, "sub"), { recursive: true });
		const port = await boot(root);

		expect((await get(port, "/../package.json")).status).toBe(404);
		expect((await get(port, "/sub/%2e%2e/%2e%2e/package.json")).status).toBe(404);
		expect((await get(port, "/nope.yml")).status).toBe(404);
	});
});
