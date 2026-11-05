/**
 * 插件：清单怎么读、怎么装、坏了怎么办。
 *
 * 这里测的都是**机械部分**：一个文件夹变成几条注册。插件真的能加能力（模型会不会用
 * `clock`）只有真模型能测，那归 `npm run live`。
 *
 * 入口写成 `.js` 而不是 `.ts`：`loadPlugins` 的原生 `import` 在测试进程里跑的是
 * vite 的模块图，临时目录里的 `.ts` 不归它管 —— 这是测试环境的事，不是插件的事。
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	installPluginFiles,
	listPluginSlugs,
	loadPlugins,
	readPluginManifest,
	removePluginFolder,
	writePluginEnabled,
} from "../../src/core/plugin/index.ts";
import { sandboxPool } from "./support.ts";

const boxes: string[] = [];

afterEach(async () => {
	for (const box of boxes.splice(0)) await rm(box, { recursive: true, force: true });
});

/** 一个临时工作区，返回它的 `plugins/` 根。 */
async function pluginsRoot(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "plugin-"));
	boxes.push(root);
	const dir = join(root, "plugins");
	await mkdir(dir, { recursive: true });
	return dir;
}

async function writePlugin(root: string, slug: string, files: Record<string, string>): Promise<void> {
	for (const [name, text] of Object.entries(files)) {
		const path = join(root, slug, name);
		await mkdir(join(path, ".."), { recursive: true });
		await writeFile(path, text, "utf8");
	}
}

describe("清单", () => {
	it("YAML 头给什么就是什么，没给的用默认", async () => {
		const root = await pluginsRoot();
		await writePlugin(root, "clock", {
			"plugin.md": "---\nname: 时钟\ndescription: 看几点\n---\n\n正文不算说明。\n",
			"plugin.ts": "export function apply() {}",
			"client.js": "export default { apply() {} }",
		});

		const read = await readPluginManifest(root, "clock");
		if ("error" in read) throw new Error(read.error);
		expect(read.manifest).toMatchObject({
			slug: "clock",
			name: "时钟",
			description: "看几点",
			enabled: true,
			server: "plugin.ts",
			client: "client.js",
		});
	});

	it("头里没写 name 就用 slug，没写 description 就用正文第一行", async () => {
		const root = await pluginsRoot();
		await writePlugin(root, "hello", { "plugin.md": "打一行字。\n\n后面还有。\n" });

		const read = await readPluginManifest(root, "hello");
		if ("error" in read) throw new Error(read.error);
		expect(read.manifest.name).toBe("hello");
		expect(read.manifest.description).toBe("打一行字。");
		// 两个入口都没有：纯清单也能装（它只是被列出来）。
		expect(read.manifest.server).toBeUndefined();
		expect(read.manifest.client).toBeUndefined();
	});

	it("没有 plugin.md 是一条错误，不是异常", async () => {
		const root = await pluginsRoot();
		await mkdir(join(root, "空目录"), { recursive: true });

		const read = await readPluginManifest(root, "空目录");
		expect("error" in read && read.error).toContain("plugin.md");
	});

	it("只把目录当插件，散落文件不算", async () => {
		const root = await pluginsRoot();
		await writeFile(join(root, "说明.txt"), "x", "utf8");
		await writePlugin(root, "a", { "plugin.md": "a" });
		await writePlugin(root, "b", { "plugin.md": "b" });

		expect(await listPluginSlugs(root)).toEqual(["a", "b"]);
	});
});

describe("开关", () => {
	it("关掉只改头里那一行，正文和别的字段原样留着", async () => {
		const root = await pluginsRoot();
		await writePlugin(root, "clock", {
			"plugin.md": "---\nname: 时钟\ndescription: 看几点\n---\n\n正文不算说明。\n",
		});

		await writePluginEnabled(root, "clock", false);

		const read = await readPluginManifest(root, "clock");
		if ("error" in read) throw new Error(read.error);
		expect(read.manifest).toMatchObject({ name: "时钟", description: "看几点", enabled: false });
		expect(await readFile(join(root, "clock", "plugin.md"), "utf8")).toContain("正文不算说明。");
	});

	it("再打开就回到缺省：头里有 enabled: true，读出来是开着的", async () => {
		const root = await pluginsRoot();
		await writePlugin(root, "clock", { "plugin.md": "---\nname: 时钟\nenabled: false\n---\n\n说明\n" });

		await writePluginEnabled(root, "clock", true);

		const read = await readPluginManifest(root, "clock");
		if ("error" in read) throw new Error(read.error);
		expect(read.manifest.enabled).toBe(true);
	});

	it("名字越界 / 没有清单：报错，不写文件", async () => {
		const root = await pluginsRoot();
		await expect(writePluginEnabled(root, "../逃逸", false)).rejects.toThrow();
		await expect(writePluginEnabled(root, "不存在", false)).rejects.toThrow("plugin.md");
	});
});

describe("装 / 卸", () => {
	/** 一份文件树 → 界面发上来的那种形状（`path` 相对文件夹根，内容 base64）。 */
	function folder(slug: string, files: Record<string, string>) {
		return {
			slug,
			files: Object.entries(files).map(([path, text]) => ({ path, base64: Buffer.from(text, "utf8").toString("base64") })),
		};
	}

	it("装：文件夹原样落盘，二进制也不坏", async () => {
		const root = await pluginsRoot();
		const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff]);

		await installPluginFiles(root, "天气", [
			...folder("x", {
				"plugin.md": "---\nname: 天气\ndescription: 看天气\n---\n\n说明。\n",
				"plugin.ts": "export function apply() {}",
			}).files,
			{ path: "assets/icon.png", base64: bytes.toString("base64") },
		]);

		const read = await readPluginManifest(root, "天气");
		if ("error" in read) throw new Error(read.error);
		expect(read.manifest).toMatchObject({ slug: "天气", name: "天气", description: "看天气", enabled: true });
		expect(await readFile(join(root, "天气", "assets", "icon.png"))).toEqual(bytes);
	});

	it("没有 plugin.md 就不是插件：一个字都不写", async () => {
		const root = await pluginsRoot();
		const pack = folder("随便", { "index.js": "export const x = 1;" });

		await expect(installPluginFiles(root, pack.slug, pack.files)).rejects.toThrow("plugin.md");
		expect(await listPluginSlugs(root)).toEqual([]);
	});

	it("不安全的路径 / 重名 / 怪名字：报错，不写文件", async () => {
		const root = await pluginsRoot();
		await writePlugin(root, "已有", { "plugin.md": "---\nname: 已有\n---\n\n别动我。\n" });

		await expect(installPluginFiles(root, "已有", folder("x", { "plugin.md": "x" }).files)).rejects.toThrow("已经有");
		await expect(
			installPluginFiles(root, "逃逸", [
				{ path: "plugin.md", base64: "" },
				{ path: "../逃出.txt", base64: "" },
			]),
		).rejects.toThrow("不安全");
		await expect(installPluginFiles(root, "a/b", folder("x", { "plugin.md": "x" }).files)).rejects.toThrow();

		expect(await readFile(join(root, "已有", "plugin.md"), "utf8")).toContain("别动我。");
	});

	it("删除：整个目录一起没，别的插件不动", async () => {
		const root = await pluginsRoot();
		await writePlugin(root, "留", { "plugin.md": "留" });
		await writePlugin(root, "删", { "plugin.md": "删", "plugin.js": "export function apply() {}" });

		await removePluginFolder(root, "删");

		expect(await listPluginSlugs(root)).toEqual(["留"]);
		await expect(removePluginFolder(root, "删")).rejects.toThrow("没有叫");
	});
});

describe("加载", () => {
	it("五个动作都收得下", async () => {
		const root = await pluginsRoot();
		await writePlugin(root, "demo", {
			"plugin.md": "---\nname: demo\n---\n",
			"plugin.js": `
				export function apply(api) {
					api.tool({
						name: "demo_tool",
						description: "示范",
						parameters: api.Type.Object({}),
						execute: async () => api.text("ok"),
					});
					api.prompt("demo 插件在跑。");
					api.prompt("   ");
					api.route({ method: "GET", pattern: "/api/p/demo", handle: async () => ({ ok: true }) });
					api.on("message", () => {});
					api.on("别的", () => {});
					api.flow({ kind: "router", run: () => ({ kind: "targets", targets: ["b"], reason: "demo" }) });
					api.flow({ kind: "settle", run: () => undefined });
					api.log("装好了");
				}
			`,
		});

		const logs: string[] = [];
		const host = await loadPlugins({ pluginsRoot: root, workspace: join(root, ".."), logsRoot: join(root, "..", "logs"), log: (line) => logs.push(line) });

		expect(host.errors).toEqual([]);
		expect(host.tools).toHaveLength(1);
		// 空串被忽略：插件想「有条件地加一段」时写 `api.prompt(x ?? "")` 不用特判。
		expect(host.prompt).toEqual(["demo 插件在跑。"]);
		expect(host.routes.map((route) => route.pattern)).toEqual(["/api/p/demo"]);
		expect(host.messages).toHaveLength(1);
		expect(host.flow.map((policy) => policy.kind)).toEqual(["router", "settle"]);
		expect(logs).toEqual(["[plugin demo] 装好了"]);
		// `brings` 就是界面上那行「它带来了什么」：装完之后才拿得到，所以从 sinks 里数。
		expect(host.plugins).toEqual([
			{
				slug: "demo",
				name: "demo",
				description: "",
				enabled: true,
				brings: { tools: ["demo_tool"], prompt: true, routes: 1, listens: true, policies: 2 },
			},
		]);
	});

	it("关掉的插件不装，但还列着", async () => {
		const root = await pluginsRoot();
		await writePlugin(root, "off", {
			"plugin.md": "---\nname: off\nenabled: false\n---\n",
			"plugin.js": `
				export function apply(api) {
					api.prompt("不该出现。");
				}
			`,
		});

		const host = await loadPlugins({ pluginsRoot: root, workspace: join(root, ".."), logsRoot: join(root, "..", "logs"), log: () => {} });
		expect(host.prompt).toEqual([]);
		expect(host.plugins[0]).toMatchObject({ slug: "off", enabled: false });
	});

	it("坏插件只坏它自己", async () => {
		const root = await pluginsRoot();
		await writePlugin(root, "boom", {
			"plugin.md": "---\nname: boom\n---\n",
			"plugin.js": "export function apply() { throw new Error('炸了'); }",
		});
		await writePlugin(root, "没有入口", { "plugin.md": "---\nname: 缺\n---\n", "plugin.js": "export const x = 1;" });
		await writePlugin(root, "好的", {
			"plugin.md": "---\nname: 好的\n---\n",
			"plugin.js": "export function apply(api) { api.prompt('我在。'); }",
		});

		const host = await loadPlugins({ pluginsRoot: root, workspace: join(root, ".."), logsRoot: join(root, "..", "logs"), log: () => {} });

		expect(host.prompt).toEqual(["我在。"]);
		expect(host.errors).toHaveLength(2);
		expect(host.errors.join("\n")).toContain("炸了");
		expect(host.errors.join("\n")).toContain("apply");
		// 列表照列，带上原因：界面上要能看出「这个没生效」。
		expect(host.plugins.find((plugin) => plugin.slug === "boom")?.error).toContain("炸了");
		expect(host.plugins.find((plugin) => plugin.slug === "好的")?.error).toBeUndefined();
	});

	it("装完之后：工具进注册表、提示词进那一份清单", async () => {
		const pool = sandboxPool();
		try {
			const box = await pool.make("plugin-shell-");
			await writePlugin(box.layout.pluginsRoot, "demo", {
				"plugin.md": "---\nname: demo\n---\n",
				"plugin.js": `
					export function apply(api) {
						api.tool({
							name: "demo_tool",
							description: "示范",
							parameters: api.Type.Object({}),
							execute: async () => api.text("ok"),
						});
						api.prompt("demo 插件在跑。");
					}
				`,
			});

			const runtime = await box.open();
			const shell = await box.assemble(runtime);

			const names = runtime.registry.snapshot().tools().map(({ tool }) => (tool as { name?: string }).name);
			expect(names).toContain("demo_tool");
			expect(shell.plugins?.prompt).toEqual(["demo 插件在跑。"]);
		} finally {
			await pool.cleanup();
		}
	});

	it("工具名冲突：整个插件不装，核心与插件之间都不许重名", async () => {
		const root = await pluginsRoot();
		const plugin = (name: string, word: string) => `
			export function apply(api) {
				api.tool({
					name: ${JSON.stringify(name)},
					description: "示范",
					parameters: api.Type.Object({}),
					execute: async () => api.text(${JSON.stringify(word)}),
				});
				api.prompt(${JSON.stringify(word)});
			}
		`;
		await writePlugin(root, "a", { "plugin.md": "---\nname: a\n---\n", "plugin.js": plugin("clash", "a 在。") });
		await writePlugin(root, "b", { "plugin.md": "---\nname: b\n---\n", "plugin.js": plugin("clash", "b 也来了。") });
		await writePlugin(root, "c", { "plugin.md": "---\nname: c\n---\n", "plugin.js": plugin("say", "c 想抢 say。") });

		const host = await loadPlugins({
			pluginsRoot: root,
			workspace: join(root, ".."),
			logsRoot: join(root, "..", "logs"),
			reservedTools: ["say"],
			log: () => {},
		});

		// 后装的那个整个不装：它的工具和提示词都不该漏进来。
		expect(host.tools.map((tool) => (tool as { name?: string }).name)).toEqual(["clash"]);
		expect(host.prompt).toEqual(["a 在。"]);
		expect(host.plugins.filter((item) => item.error !== undefined).map((item) => item.slug)).toEqual(["b", "c"]);
		expect(host.errors.join("\n")).toContain("和插件「a」重名");
		expect(host.errors.join("\n")).toContain("和核心工具重名");
	});

	it("一个插件听消息抛错：只留一行，别的插件照跑", async () => {
		const root = await pluginsRoot();
		await writePlugin(root, "a", {
			"plugin.md": "---\nname: a\n---\n",
			"plugin.js": `export function apply(api) {
				api.on("message", () => { throw new Error("听消息炸了"); });
			}`,
		});
		await writePlugin(root, "b", {
			"plugin.md": "---\nname: b\n---\n",
			"plugin.js": `export function apply(api) {
				api.on("message", () => { globalThis.__pluginHeard = (globalThis.__pluginHeard ?? 0) + 1; });
			}`,
		});

		const lines: string[] = [];
		const host = await loadPlugins({
			pluginsRoot: root,
			workspace: join(root, ".."),
			logsRoot: join(root, "..", "logs"),
			log: (line) => lines.push(line),
		});

		// 不 reject：坏的那条被包成了日志，投递不会被它打断。
		await Promise.all(host.messages.map((listener) => listener({} as never, "all")));
		expect(lines.join("\n")).toContain("听消息炸了");
		expect((globalThis as Record<string, unknown>)["__pluginHeard"]).toBe(1);
	});

	it("有前端入口就标出来", async () => {
		const root = await pluginsRoot();
		await writePlugin(root, "ui", { "plugin.md": "ui", "client.js": "export default { apply() {} }" });

		const host = await loadPlugins({ pluginsRoot: root, workspace: join(root, ".."), logsRoot: join(root, "..", "logs"), log: () => {} });
		expect(host.plugins[0]).toMatchObject({ slug: "ui", client: true });
	});
});
