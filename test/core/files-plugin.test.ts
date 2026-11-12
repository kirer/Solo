/**
 * 出厂插件「文件树」：只读地看一个频道的工作区。
 *
 * 这里钉的是**守卫**：根外面的路径、指向外面的软链接、隐藏目录、软链接文件 ——
 * 界面能不能画不在这里测，但「读不到不该读的东西」必须钉死。
 */
import { cp, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { loadPlugins } from "../../src/core/plugin/index.ts";
import type { PluginRouteSpec } from "../../src/core/plugin/index.ts";

const boxes: string[] = [];

afterEach(async () => {
	for (const box of boxes.splice(0)) await rm(box, { recursive: true, force: true });
});

type Entry = { name: string; path: string; dir: boolean; children?: readonly Entry[] };
type Tree = { kind: string; label?: string; root?: string; entries?: readonly Entry[] };
type Preview = { kind: string; name?: string; path?: string; size?: number; mtime?: number; text?: string; dataUrl?: string };

type Routes = { tree: PluginRouteSpec; preview: PluginRouteSpec };

/** 一套装了「文件树」的临时工作区：工作区里有几个文件，根外面有一个诱饵。 */
async function boot(): Promise<Routes> {
	const root = await mkdtemp(join(tmpdir(), "files-plugin-"));
	boxes.push(root);
	const workspace = join(root, "workspace");
	const area = join(workspace, "space");
	await mkdir(join(workspace, "plugins"), { recursive: true });
	await mkdir(join(area, "src"), { recursive: true });
	await mkdir(join(area, ".git"), { recursive: true });
	await writeFile(join(area, "README.md"), "# 标题\n\n正文。\n");
	await writeFile(join(area, "src", "main.ts"), "export const x = 1;\n");
	await writeFile(join(area, ".git", "config"), "不该出现\n");
	await writeFile(join(root, "secret.txt"), "根外面\n");
	await symlink(join(root, "secret.txt"), join(area, "escape.txt"));
	const seed = fileURLToPath(new URL("../../plugins-src/文件树", import.meta.url));
	await cp(seed, join(workspace, "plugins", "文件树"), { recursive: true });

	const host = await loadPlugins({
		pluginsRoot: join(workspace, "plugins"),
		workspace,
		logsRoot: join(root, "logs"),
		scope: async (channelId) =>
			channelId === "c1" ? { kind: "group", title: "测试频道", root: area, label: "测试" } : undefined,
		log: () => {},
	});
	expect(host.errors).toEqual([]);
	const tree = host.routes.find((item) => item.pattern === "/api/p/files/tree");
	const preview = host.routes.find((item) => item.pattern === "/api/p/files/preview");
	if (tree === undefined || preview === undefined) throw new Error("文件树没注册路由");
	return { tree, preview };
}

async function treeOf(route: PluginRouteSpec, channel = "c1"): Promise<Tree> {
	return (await route.handle({ method: "GET", params: {}, query: { channel } })) as Tree;
}

async function previewOf(route: PluginRouteSpec, path: string, channel = "c1"): Promise<Preview> {
	return (await route.handle({ method: "GET", params: {}, query: { channel, path } })) as Preview;
}

describe("文件树", () => {
	it("没有工作区的人：说「没有」，不是报错", async () => {
		const { tree } = await boot();
		expect(await treeOf(tree, "别的频道")).toEqual({ kind: "none", label: "", entries: [] });
	});

	it("列目录：目录在前、隐藏目录不出现", async () => {
		const { tree } = await boot();
		const result = await treeOf(tree);
		expect(result.kind).toBe("tree");
		expect(result.label).toBe("测试");
		// 界面上的路径行读它（绝对路径）：给的是工作区根，不是猜的。
		// 比的是「最后一段」，Windows 的分隔符是 `\`。
		expect(result.root?.split(/[\\/]/).at(-1)).toBe("space");
		const names = (result.entries ?? []).map((entry) => entry.name);
		expect(names).toEqual(["src", "escape.txt", "README.md"]);
		expect((result.entries ?? []).find((entry) => entry.name === "src")?.children?.[0]?.name).toBe("main.ts");
	});

	it("预览：markdown / 文本都带大小与时间，软链接不跟", async () => {
		const { preview } = await boot();
		const md = await previewOf(preview, "README.md");
		expect(md.kind).toBe("markdown");
		expect(md.text).toContain("正文");
		expect(md.size).toBeGreaterThan(0);
		expect(md.mtime).toBeGreaterThan(0);

		expect((await previewOf(preview, "src/main.ts")).kind).toBe("text");
		expect((await previewOf(preview, "escape.txt")).kind).toBe("error");
	});

	it("越界：`../` 与指向根外的软链接都读不到", async () => {
		const { preview } = await boot();
		expect((await previewOf(preview, "../secret.txt")).kind).toBe("error");
		expect((await previewOf(preview, "../../secret.txt")).kind).toBe("error");
	});
});
