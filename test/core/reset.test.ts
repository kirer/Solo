/**
 * 一键重置的边界：删什么、留什么。
 *
 * 这一步不可撤销，判据只能钉在文件上：组织数据、模型配置与密钥必须真的消失
 * （重启后进引导页，ADR-089）；壳自己的缓存留下。少删一份成员目录，「清空历史」就是假的。
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

/**
 * 等条件成立，最多等 5 秒。
 *
 * 别用「等固定时长」：这条路是 `setTimeout(200)` 之后才回调，写死等 300ms 只留 100ms
 * 余量，并行跑全套时定时器一挤就红 —— 红的不是坏掉的功能，是这次跑得慢。轮询条件
 * 则慢到多慢都不误判，真的没回调也照样超时失败。
 */
async function waitFor(check: () => boolean, what: string): Promise<void> {
	const deadline = Date.now() + 5000;
	while (!check()) {
		if (Date.now() > deadline) throw new Error(`等了 5 秒还没成：${what}`);
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
}

async function write(path: string, text = "x"): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, text, "utf8");
}

describe("重置所有数据", () => {
	it("删掉两个根里的组织数据与模型配置，留下应用根里不属于内核的东西", async () => {
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
		// 模型配置和密钥也一起清掉（ADR-089）：重启后没有模型，界面进引导页。
		expect(await existsAt(layout.settingsFile)).toBe(false);
		expect(await existsAt(layout.secretsFile)).toBe(false);
		// 壳的缓存不是内核的东西，不碰。
		expect(await existsAt(join(layout.appRoot, "Cache", "data.bin"))).toBe(true);
	});

	it("两个根是同一个目录时，settings.json 一样会被清掉", async () => {
		const root = await mkdtemp(join(tmpdir(), "reset-one-"));
		extraRoots.push(root);
		const layout = resolveLayout({ appRoot: root, userRoot: root });
		await write(layout.settingsFile, "{}");
		await write(join(layout.membersRoot, "林越", "identity.md"));
		await write(layout.databasePath, "db");

		await wipeAll(layout);

		expect(await existsAt(layout.settingsFile)).toBe(false);
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
			// 等条件成立，别赌固定时长：接口先把「好」发出去，再 `setTimeout(200)` 才调
			// `onReset`（库还开着的时候删不掉 core.sqlite）。以前这里写死等 300ms —— 余量
			// 只有 100ms，并行跑全套时定时器一挤就红。
			await waitFor(() => resets === 1, "等 onReset 被调用");
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
