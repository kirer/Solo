/**
 * 插件重装：开关 / 装 / 卸 / 改后端代码，**不重启进程**就生效（ADR-026）。
 *
 * 三处各自要测，因为它们是三条不同的路：
 * 1. 工具按同名换掉 `core-tools`，会话按名字解析，下一次生成才看得见；
 * 2. 插件接口在 `*rest` 兜底里现查，重启前就能打到；
 * 3. 提示词段要重装身份扩展才算数（它是装的时候拍下来的快照）。
 */
import { request as httpRequest } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { writePluginEnabled } from "../../src/core/plugin/index.ts";
import { serveCore, type CoreServer } from "../../src/core/shell/serve.ts";
import { sandboxPool } from "./support.ts";

const pool = sandboxPool();
const servers: CoreServer[] = [];

afterEach(async () => {
	for (const server of servers.splice(0)) await server.close().catch(() => undefined);
	await pool.cleanup();
});

const PLUGIN = (tool: string) => `
	export function apply(api) {
		api.tool({ name: "${tool}", description: "示范", parameters: api.Type.Object({}), execute: async () => api.text("ok") });
		api.prompt("时钟插件在跑。");
		api.route({ method: "GET", pattern: "/api/p/clock", handle: async () => ({ tool: "${tool}" }) });
	}
`;

async function writeClock(pluginsRoot: string, tool: string, enabled: boolean): Promise<void> {
	const dir = join(pluginsRoot, "clock");
	await mkdir(dir, { recursive: true });
	await writeFile(
		join(dir, "plugin.md"),
		`---\nname: 时钟\ndescription: 看几点\n${enabled ? "" : "enabled: false\n"}---\n`,
		"utf8",
	);
	await writeFile(join(dir, "plugin.js"), PLUGIN(tool), "utf8");
}

function get(port: number, path: string): Promise<{ status: number; body: string }> {
	return new Promise((resolve, reject) => {
		const req = httpRequest({ host: "127.0.0.1", port, method: "GET", path }, (response) => {
			let out = "";
			response.setEncoding("utf8");
			response.on("data", (chunk: string) => (out += chunk));
			response.on("end", () => resolve({ status: response.statusCode ?? 0, body: out }));
		});
		req.on("error", reject);
		req.end();
	});
}

async function boot(tool = "clock_now") {
	const box = await pool.make("core-plugin-reload-");
	await mkdir(join(box.agentsRoot, "林越"), { recursive: true });
	await writeFile(join(box.agentsRoot, "林越", "identity.md"), "---\nname: 林越\ntitle: 工程师\n---\n\n# 林越\n", "utf8");
	await writeClock(box.layout.pluginsRoot, tool, false);

	const runtime = await box.open();
	const shell = await box.assemble(runtime);
	await shell.rescan();
	const server = await serveCore({ shell, port: 0 });
	servers.push(server);
	const toolNames = () => shell.registry.snapshot().tools().map((entry) => entry.tool.name);
	return { box, shell, port: server.port, toolNames };
}

describe("插件不重启就生效", () => {
	it("打开开关：工具进注册表、接口当场能打到、提示词里有那一段", async () => {
		const { box, shell, port, toolNames } = await boot();
		// 关着的时候：什么都没有。
		expect(toolNames()).not.toContain("clock_now");
		expect((await get(port, "/api/p/clock")).status).toBe(404);
		expect(await shell.promptOf("林越")).not.toContain("时钟插件在跑");

		await writePluginEnabled(box.layout.pluginsRoot, "clock", true);
		await shell.reloadPlugins();

		expect(toolNames()).toContain("clock_now");
		expect(JSON.parse((await get(port, "/api/p/clock")).body)).toEqual({ tool: "clock_now" });
		expect(await shell.promptOf("林越")).toContain("时钟插件在跑");
	});

	it("改后端代码再重装：读到的是新代码，不是 import 缓存里那份", async () => {
		const { box, shell, toolNames } = await boot();
		await writePluginEnabled(box.layout.pluginsRoot, "clock", true);
		await shell.reloadPlugins();
		expect(toolNames()).toContain("clock_now");

		await writeClock(box.layout.pluginsRoot, "clock_later", true);
		await shell.reloadPlugins();

		expect(toolNames()).toContain("clock_later");
		expect(toolNames()).not.toContain("clock_now");
	});
});
