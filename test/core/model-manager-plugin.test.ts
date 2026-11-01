/**
 * 出厂插件「模型管理」：三个接口的读写与校验。
 *
 * 它写的是 `workspace/settings.json` —— 写坏了等于全员不回话（`docs/DEPLOY.md` §3 的
 * 历史事故）。所以这里钉的是**拒绝**：不合格的提交一个字节都不落盘，密钥永远不回原文。
 * 「获取可用模型」要真实网络，不在这里测。
 */
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { loadPlugins } from "../../src/core/plugin/index.ts";
import { setupModels } from "../../src/core/runtime/index.ts";
import type { PluginRouteSpec } from "../../src/core/plugin/index.ts";

const boxes: string[] = [];

afterEach(async () => {
	for (const box of boxes.splice(0)) await rm(box, { recursive: true, force: true });
});

/** 一个装了「模型管理」的临时工作区。 */
async function boot(): Promise<{ workspace: string; routes: readonly PluginRouteSpec[] }> {
	const root = await mkdtemp(join(tmpdir(), "models-plugin-"));
	boxes.push(root);
	const workspace = join(root, "workspace");
	await mkdir(join(workspace, "plugins"), { recursive: true });
	const seed = fileURLToPath(new URL("../../seed/plugins/模型管理", import.meta.url));
	await cp(seed, join(workspace, "plugins", "模型管理"), { recursive: true });

	const host = await loadPlugins({ pluginsRoot: join(workspace, "plugins"), workspace, log: () => {} });
	expect(host.errors).toEqual([]);
	return { workspace, routes: host.routes };
}

function routeOf(routes: readonly PluginRouteSpec[], pattern: string, method: "GET" | "POST"): PluginRouteSpec {
	const route = routes.find((item) => item.pattern === pattern && item.method === method);
	if (route === undefined) throw new Error(`没有 ${method} ${pattern}`);
	return route;
}

const call = (route: PluginRouteSpec, body?: unknown) =>
	route.handle({ method: route.method, params: {}, query: {}, ...(body === undefined ? {} : { body }) }) as Promise<
		Record<string, unknown>
	>;

// 一把假密钥：断言只看尾号，所以它只要首两位与末四位固定。
const KEY = "sk-test-abcd";

const provider = (extra: Record<string, unknown> = {}) => ({
	id: "magpie",
	name: "本地网关",
	baseUrl: "http://127.0.0.1:3425/v1",
	models: ["auto/deepseek-v4.1-flash"],
	...extra,
});

describe("模型管理插件", () => {
	it("还没有 settings.json：列出空清单，说清现在靠什么兜底", async () => {
		const { routes } = await boot();

		const body = await call(routeOf(routes, "/api/p/models", "GET"));

		expect(body["providers"]).toEqual([]);
		expect(body["defaultModel"]).toBe("");
		expect(String(body["source"])).not.toBe("");
	});

	it("保存：写进 settings.json，读回来密钥只有尾号", async () => {
		const { workspace, routes } = await boot();

		const saved = await call(routeOf(routes, "/api/p/models", "POST"), {
			defaultModel: "magpie/auto/deepseek-v4.1-flash",
			providers: [provider({ apiKey: KEY })],
		});

		expect(saved["error"]).toBeUndefined();
		expect(saved["defaultModel"]).toBe("magpie/auto/deepseek-v4.1-flash");
		const listed = (saved["providers"] as readonly Record<string, unknown>[])[0]!;
		expect(listed["hasKey"]).toBe(true);
		expect(listed["keyHint"]).toBe("sk…abcd");
		expect(JSON.stringify(saved)).not.toContain(KEY);

		// 别的键原样留着：这份文件可能有别人写的东西。
		const onDisk = JSON.parse(await readFile(join(workspace, "settings.json"), "utf8")) as { defaultModel: string };
		expect(onDisk.defaultModel).toBe("magpie/auto/deepseek-v4.1-flash");
	});

	it("密钥留空 = 沿用已保存的那一份", async () => {
		const { workspace, routes } = await boot();
		const save = routeOf(routes, "/api/p/models", "POST");

		await call(save, { providers: [provider({ apiKey: KEY })] });
		await call(save, { providers: [provider({ name: "改了个名", apiKey: "" })] });

		const onDisk = JSON.parse(await readFile(join(workspace, "settings.json"), "utf8")) as {
			providers: { name: string; apiKey: string }[];
		};
		expect(onDisk.providers[0]!.name).toBe("改了个名");
		expect(onDisk.providers[0]!.apiKey).toBe(KEY);
	});

	it("不合格的提交：一个字都不写", async () => {
		const { workspace, routes } = await boot();
		const save = routeOf(routes, "/api/p/models", "POST");
		await call(save, { providers: [provider({ apiKey: "sk-1" })] });
		const before = await readFile(join(workspace, "settings.json"), "utf8");

		const cases: readonly unknown[] = [
			[{ id: "a/b", models: ["m"] }],
			[{ id: "ok", models: [] }],
			[provider(), provider()],
			[provider({ baseUrl: "127.0.0.1:3425" })],
			[],
		];
		for (const providers of cases) {
			const body = await call(save, { providers });
			expect(typeof body["error"]).toBe("string");
		}
		expect(await readFile(join(workspace, "settings.json"), "utf8")).toBe(before);
	});

	it("默认模型解析不到就拒绝", async () => {
		const { routes } = await boot();
		const body = await call(routeOf(routes, "/api/p/models", "POST"), {
			defaultModel: "magpie/没有这个模型",
			providers: [provider()],
		});
		expect(String(body["error"])).toContain("没有模型");
	});

	it("远端没有密钥就拒绝；本地网关省掉密钥存成占位符（否则每次生成立刻失败）", async () => {
		const { workspace, routes } = await boot();
		const save = routeOf(routes, "/api/p/models", "POST");

		const remote = await call(save, { providers: [{ ...provider(), baseUrl: "https://api.example.test/v1" }] });
		expect(String(remote["error"])).toContain("密钥");
		await expect(readFile(join(workspace, "settings.json"), "utf8")).rejects.toThrow();

		// 实测评：本地网关密钥留空存下去，两个 agent 全部哑掉（底座不接受空凭据）；
		// 这里存的是占位符，装配层才真的拿得到模型。
		const local = await call(save, { providers: [provider()] });
		expect(local["error"]).toBeUndefined();
		const onDisk = JSON.parse(await readFile(join(workspace, "settings.json"), "utf8")) as {
			providers: { apiKey: string }[];
		};
		expect(onDisk.providers[0]!.apiKey).toBe("magpie");
	});

	it("坏掉的 settings.json 被当成空的，不会把服务带崩", async () => {
		const { workspace, routes } = await boot();
		await writeFile(join(workspace, "settings.json"), "{ 不是 JSON", "utf8");

		const body = await call(routeOf(routes, "/api/p/models", "GET"));
		expect(body["providers"]).toEqual([]);
	});

	it("保存之后装配层认这一份：加进来的提供商就是会话能用的模型", async () => {
		const { workspace, routes } = await boot();
		await call(routeOf(routes, "/api/p/models", "POST"), {
			defaultModel: "other/m-three",
			providers: [provider({ models: ["m-one", "m-two"] }), { ...provider(), id: "other", name: "另一家", api: "openai", models: ["m-three"] }],
		});

		// 插件只写文件；「能不能用」由装配层说了算，这里问的就是它。
		const setup = setupModels({}, { workspace });
		expect(setup.defaultModel).toEqual({ provider: "other", modelId: "m-three" });
		expect(setup.models.getModels().map((model) => `${model.provider}/${model.id}`).sort()).toEqual([
			"magpie/m-one",
			"magpie/m-two",
			"other/m-three",
		]);
	});

	it("删掉一家之后：装配层只剩剩下的，默认由它接住", async () => {
		const { workspace, routes } = await boot();
		const save = routeOf(routes, "/api/p/models", "POST");
		await call(save, {
			defaultModel: "other/m-three",
			providers: [provider(), { ...provider(), id: "other", name: "另一家", api: "openai", models: ["m-three"] }],
		});

		const after = await call(save, { defaultModel: "", providers: [provider()] });
		expect(after["error"]).toBeUndefined();

		const setup = setupModels({}, { workspace });
		expect(setup.defaultModel).toEqual({ provider: "magpie", modelId: "auto/deepseek-v4.1-flash" });
		expect(setup.models.getModels().map((model) => model.provider)).toEqual(["magpie"]);
	});
});
