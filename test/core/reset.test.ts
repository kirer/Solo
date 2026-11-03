/**
 * 一键重置的边界：删什么、留什么。
 *
 * 这一步不可撤销，判据只能钉在文件上：组织数据必须真的消失；模型配置与壳自己的
 * 缓存必须留下 —— 多删一个 `settings.json`，重置完就没人能回话；少删一份成员目录，
 * 「清空历史」就是假的。
 */
import { request as httpRequest } from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createReset, wipeAll } from "../../src/app/reset.ts";
import { AppError } from "../../src/app/errors.ts";
import { resolveLayout } from "../../src/core/layout.ts";
import { existsAt } from "../../src/core/runtime/io.ts";
import { serveCore } from "../../src/shell/serve.ts";
import { sandboxPool } from "./support.ts";

const pool = sandboxPool();
const extraRoots: string[] = [];

afterEach(async () => {
	await pool.cleanup();
	for (const root of extraRoots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function write(path: string, text = "x"): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, text, "utf8");
}

describe("重置所有数据", () => {
	it("删掉两个根里的组织数据，留下模型配置和应用根里不属于内核的东西", async () => {
		const box = await pool.make("reset-");
		const { layout } = box;
		await write(join(layout.membersRoot, "林越", "identity.md"));
		await write(join(layout.teamsRoot, "alpha", "README.md"));
		await write(join(layout.skillsRoot, "记忆整理", "SKILL.md"));
		await write(join(layout.logsRoot, "core.log"));
		await write(layout.rulesFile, "规矩");
		await write(layout.settingsFile, "{}");
		await write(layout.secretsFile, "{}");
		await write(layout.databasePath, "db");
		await write(join(layout.assistantRoot, "知言", "identity.md"));
		await write(join(layout.promptRoot, "01.md"));
		await write(join(layout.uploadsRoot, "a.png"));
		await write(join(layout.appRoot, "Cache", "data.bin"));

		await wipeAll(layout);

		// 组织数据一个不剩。
		expect(await existsAt(layout.membersRoot)).toBe(false);
		expect(await existsAt(layout.teamsRoot)).toBe(false);
		expect(await existsAt(layout.skillsRoot)).toBe(false);
		expect(await existsAt(layout.logsRoot)).toBe(false);
		expect(await existsAt(layout.rulesFile)).toBe(false);
		expect(await existsAt(layout.databasePath)).toBe(false);
		expect(await existsAt(layout.assistantRoot)).toBe(false);
		expect(await existsAt(layout.promptRoot)).toBe(false);
		expect(await existsAt(layout.uploadsRoot)).toBe(false);
		// 配置留下；壳的缓存不是内核的东西，不碰。
		expect(await existsAt(layout.settingsFile)).toBe(true);
		expect(await existsAt(layout.secretsFile)).toBe(true);
		expect(await existsAt(join(layout.appRoot, "Cache", "data.bin"))).toBe(true);
	});

	it("两个根是同一个目录时，settings.json 也不会被带走", async () => {
		const root = await mkdtemp(join(tmpdir(), "reset-one-"));
		extraRoots.push(root);
		const layout = resolveLayout({ appRoot: root, userRoot: root });
		await write(layout.settingsFile, "{}");
		await write(join(layout.membersRoot, "林越", "identity.md"));
		await write(layout.databasePath, "db");

		await wipeAll(layout);

		expect(await existsAt(layout.settingsFile)).toBe(true);
		expect(await existsAt(layout.membersRoot)).toBe(false);
		expect(await existsAt(layout.databasePath)).toBe(false);
	});

	it("没有明确确认就不让重置", async () => {
		const box = await pool.make("reset-confirm-");
		const reset = createReset(box.layout);
		expect(() => reset.request("true")).toThrow(AppError);
		expect(reset.request(true)).toEqual({ ok: true, restarting: true });
	});

	it("接口：不确认回 400，确认之后才把「该重置了」交给启动层", async () => {
		const box = await pool.make("reset-http-");
		const runtime = await box.open();
		const shell = await box.assemble(runtime);
		let resets = 0;
		const server = await serveCore({
			shell,
			port: 0,
			onReset: () => {
				resets += 1;
			},
		});
		const post = (body: unknown): Promise<number> =>
			new Promise((resolve, reject) => {
				const payload = JSON.stringify(body);
				const req = httpRequest(
					{
						host: "127.0.0.1",
						port: server.port,
						method: "POST",
						path: "/api/reset",
						headers: { "content-type": "application/json", "content-length": Buffer.byteLength(payload) },
					},
					(response) => {
						response.resume();
						response.on("end", () => resolve(response.statusCode ?? 0));
					},
				);
				req.on("error", reject);
				req.end(payload);
			});
		try {
			expect(await post({})).toBe(400);
			expect(await post({ confirm: true })).toBe(200);
			await new Promise((resolve) => setTimeout(resolve, 300));
			expect(resets).toBe(1);
		} finally {
			await server.close();
		}
	});

	it("重启接口：不确认回 400，确认之后才交给启动层重开", async () => {
		const box = await pool.make("restart-http-");
		const runtime = await box.open();
		const shell = await box.assemble(runtime);
		let restarts = 0;
		const server = await serveCore({
			shell,
			port: 0,
			onRestart: () => {
				restarts += 1;
			},
		});
		const post = (body: unknown): Promise<number> =>
			new Promise((resolve, reject) => {
				const payload = JSON.stringify(body);
				const req = httpRequest(
					{
						host: "127.0.0.1",
						port: server.port,
						method: "POST",
						path: "/api/restart",
						headers: { "content-type": "application/json", "content-length": Buffer.byteLength(payload) },
					},
					(response) => {
						response.resume();
						response.on("end", () => resolve(response.statusCode ?? 0));
					},
				);
				req.on("error", reject);
				req.end(payload);
			});
		try {
			expect(await post({})).toBe(400);
			expect(restarts).toBe(0);
			expect(await post({ confirm: true })).toBe(200);
			await new Promise((resolve) => setTimeout(resolve, 300));
			expect(restarts).toBe(1);
		} finally {
			await server.close();
		}
	});
});
