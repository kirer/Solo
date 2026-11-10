/**
 * 出厂插件「缺了补、没动过的升、动过的留着、删了不回来」。
 *
 * 只看目录在不在的话，删掉的出厂插件下次启动会被重新拷回来 —— 界面上的「删除」只在
 * 这次进程里生效，重启就复活。账本（`.seed-manifest.json` 的 `plugins`）就是为这一条。
 * 升版判的是**整个目录**：每个文件都和上次播种时一样才整份换新（`pluginFiles` 的 hash）。
 */
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SEED_MANIFEST_FILE, isShippedPlugin, markRemoved, removedPlugins, restorePlugin, seedPlugins } from "../../src/shell/seed.ts";
import { createDiag } from "../../src/app/diag.ts";
import { createPlugins } from "../../src/app/plugins.ts";
import { resolveLayout } from "../../src/core/layout.ts";

const boxes: string[] = [];

afterEach(async () => {
	for (const box of boxes.splice(0)) await rm(box, { recursive: true, force: true });
});

async function workspace(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "seed-plugins-"));
	boxes.push(root);
	await mkdir(join(root, "plugins"), { recursive: true });
	return root;
}

const hashOf = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex").slice(0, 16);

const installed = async (root: string): Promise<string[]> =>
	(await readdir(join(root, "plugins"), { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name);

describe("出厂插件", () => {
	it("第一次补进工作区，之后不再动", async () => {
		const root = await workspace();
		const layout = resolveLayout({ appRoot: root, userRoot: root });
		const first = await seedPlugins(layout);
		expect(first.length).toBeGreaterThan(0);
		expect(await installed(root)).toEqual([...first].sort());

		// 第二次：一个都不写（磁盘上已经有了）。
		expect(await seedPlugins(layout)).toEqual([]);
	});

	it("走过删除入口的插件，重启后不会被塞回来", async () => {
		const root = await workspace();
		const layout = resolveLayout({ appRoot: root, userRoot: root });
		const first = await seedPlugins(layout);
		const gone = first[0]!;
		// 走删除入口：删目录 + 记账（界面上的「删除」就是这两步）。
		await rm(join(root, "plugins", gone), { recursive: true, force: true });
		await markRemoved(layout, gone);

		expect(await seedPlugins(layout)).toEqual([]);
		expect(await installed(root)).not.toContain(gone);
		// 再启一次也一样（账本落盘了）。
		expect(await seedPlugins(layout)).toEqual([]);

		const manifest = JSON.parse(await readFile(join(root, SEED_MANIFEST_FILE), "utf8")) as { removed: string[] };
		expect(manifest.removed).toEqual([gone]);
	});

	it("目录被手删 / 迁丢的插件，重启时补回来（那不是「用户删的」）", async () => {
		const root = await workspace();
		const layout = resolveLayout({ appRoot: root, userRoot: root });
		const first = await seedPlugins(layout);
		const gone = first[0]!;
		// 只删目录、不记账：手删目录、换机器没带过来、应用重装没覆盖 —— 都长这样。
		// 早先这条会被当成「用户删的」永久记住，老板删了悬浮球就再也装不回来。
		await rm(join(root, "plugins", gone), { recursive: true, force: true });

		expect(await seedPlugins(layout)).toContain(gone);
		expect(await installed(root)).toContain(gone);
	});

	it("删掉的能被装回来，装完就不再是「删掉的」", async () => {
		const root = await workspace();
		const layout = resolveLayout({ appRoot: root, userRoot: root });
		const first = await seedPlugins(layout);
		const gone = first[0]!;
		await rm(join(root, "plugins", gone), { recursive: true, force: true });
		await markRemoved(layout, gone);
		expect(await removedPlugins(layout)).toEqual([gone]);

		expect(await restorePlugin(layout, gone)).toBe(true);
		expect(await installed(root)).toContain(gone);
		expect(await removedPlugins(layout)).toEqual([]);
		// 装回来之后再启动：不会又补一遍、也不会被当成新的。
		expect(await seedPlugins(layout)).toEqual([]);
	});

	it("没删过的装不回来（免得成了一条往插件目录写代码的路）", async () => {
		const root = await workspace();
		const layout = resolveLayout({ appRoot: root, userRoot: root });
		const first = await seedPlugins(layout);
		expect(await restorePlugin(layout, first[0]!)).toBe(false);
		expect(await restorePlugin(layout, "../../etc")).toBe(false);
	});

	it("删和装回都留在日志里：删的是哪个、是出厂还是自己装的、装回来没有", async () => {
		const root = await workspace();
		const layout = resolveLayout({ appRoot: root, userRoot: root });
		const seeded = await seedPlugins(layout);
		const shipped = seeded[0] ?? "";
		expect(shipped).not.toBe("");

		const diag = createDiag(join(root, "logs"));
		const app = createPlugins({
			layout,
			diag,
			plugins: { plugins: [], tools: [], prompts: [], routes: [], policies: [] },
			reloadPlugins: async () => {},
			seededPlugins: {
				markRemoved: (name: string) => markRemoved(layout, name),
				removed: () => removedPlugins(layout),
				restore: (name: string) => restorePlugin(layout, name),
				isShipped: (name: string) => isShippedPlugin(layout, name),
			},
		} as never);

		// 自己装的那种：出厂没有这份代码，删了就真没了 —— 日志里得说清楚，别让人以为还能装回来。
		await mkdir(join(root, "plugins", "自己装的"), { recursive: true });
		await app.remove("自己装的");
		await app.remove(shipped);
		await app.restore(shipped);

		// recordFlow 是「写下去不管」，等它落盘。
		await new Promise((resolve) => setTimeout(resolve, 300));
		const lines = (await readFile(join(root, "logs", "runtime.jsonl"), "utf8"))
			.split("\n")
			.filter((line) => line.trim() !== "")
			.map((line) => JSON.parse(line) as { type: string; at: string; message: string });

		expect(lines).toHaveLength(3);
		expect(lines.every((line) => line.type === "plugin")).toBe(true);
		// 时间：每一条都带，不然事后问「什么时候删的」答不上来。
		expect(lines.every((line) => !Number.isNaN(Date.parse(line.at)))).toBe(true);
		expect(lines[0]?.message).toContain("自己装的");
		expect(lines[0]?.message).toContain("装不回来了");
		expect(lines[1]?.message).toContain(shipped);
		expect(lines[1]?.message).toContain("可以在插件页装回来");
		expect(lines[2]?.message).toContain(shipped);
		expect(lines[2]?.message).toContain("装回来了");
	});

	it("没人动过的出厂插件跟着新版走", async () => {
		const root = await workspace();
		const layout = resolveLayout({ appRoot: root, userRoot: root });
		const first = await seedPlugins(layout);
		const name = first[0]!;
		const target = join(root, "plugins", name);
		// 盘上这份「旧版」正是上次播种的内容（账本记的 hash 也对得上它）：
		// 等于出厂升了版、我没动过 → 该整份换新。
		await writeFile(join(target, "plugin.md"), "旧版\n");
		const manifestPath = join(root, SEED_MANIFEST_FILE);
		const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
			pluginFiles: Record<string, Record<string, string>>;
		};
		manifest.pluginFiles[name]!["plugin.md"] = hashOf("旧版\n");
		await writeFile(manifestPath, JSON.stringify(manifest));

		expect(await seedPlugins(layout)).toEqual([name]);
		expect(await readFile(join(target, "plugin.md"), "utf8")).not.toBe("旧版\n");
	});

	it("动过一个文件的插件整份留着", async () => {
		const root = await workspace();
		const layout = resolveLayout({ appRoot: root, userRoot: root });
		const first = await seedPlugins(layout);
		const name = first[0]!;
		await writeFile(join(root, "plugins", name, "client.js"), "// 我改的\n");

		// 账本说「没动过」，但盘上有文件对不上 → 判为我改过，整份不动。
		expect(await seedPlugins(layout)).toEqual([]);
		expect(await readFile(join(root, "plugins", name, "client.js"), "utf8")).toBe("// 我改的\n");
	});
});
