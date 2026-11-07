/**
 * 出厂插件「悬浮球」：纯前端的一颗球。
 *
 * 这里钉的是「装得上、不越界」：
 * - 清单读得出来，且**没有后端入口** —— 不加工具、不加路由、不加提示词；
 * - 前端只往宿主已有的 `overlays` 插槽里注册自己的格子（插槽表在 DESIGN §2.8）。
 *
 * 交互（悬停 / 拖动 / 贴边）在页面里，单测看不见；它读的数据是助理私聊那一条，
 * 没有自己的账本 —— 那正是这里要守住的边界。
 */
import { cp, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { loadPlugins } from "../../src/core/plugin/index.ts";

const boxes: string[] = [];

afterEach(async () => {
	for (const box of boxes.splice(0)) await rm(box, { recursive: true, force: true });
});

const SEED = fileURLToPath(new URL("../../seed/plugins/悬浮球", import.meta.url));

async function boot(): Promise<Awaited<ReturnType<typeof loadPlugins>>> {
	const root = await mkdtemp(join(tmpdir(), "orb-plugin-"));
	boxes.push(root);
	const workspace = join(root, "workspace");
	await mkdir(join(workspace, "plugins"), { recursive: true });
	await cp(SEED, join(workspace, "plugins", "悬浮球"), { recursive: true });
	return loadPlugins({
		pluginsRoot: join(workspace, "plugins"),
		workspace,
		logsRoot: join(root, "logs"),
		log: () => {},
	});
}

describe("悬浮球", () => {
	it("装得上：纯前端，不注册工具 / 路由 / 提示词", async () => {
		const host = await boot();
		expect(host.errors).toEqual([]);
		expect(host.tools).toEqual([]);
		expect(host.routes).toEqual([]);
		expect(host.prompt).toEqual([]);
		expect(host.messages).toEqual([]);
		expect(host.flow).toEqual([]);

		const summary = host.plugins.find((plugin) => plugin.slug === "悬浮球");
		expect(summary?.enabled).toBe(true);
		expect(summary?.client).toBe(true);
		expect(summary?.error).toBeUndefined();
	});

	it("只放进宿主已有的插槽，不自己 import 别的模块", async () => {
		const source = await readFile(join(SEED, "client.js"), "utf8");
		// 前端入口是浏览器直接 import 的一段 ESM：它拿到的只有宿主递过来的 `ui`，
		// 想 import 别的模块就会 404（没有打包器）。
		expect(source).not.toMatch(/^\s*import\s/m);
		const slots = [...source.matchAll(/register\("([^"]+)"/gu)].map((match) => match[1]);
		expect(slots).toEqual(["overlays"]);
	});
});
