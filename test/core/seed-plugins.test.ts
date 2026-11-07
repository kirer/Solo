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
import { SEED_MANIFEST_FILE, seedPlugins } from "../../src/shell/seed.ts";
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

	it("删掉的插件重启后不会被塞回来", async () => {
		const root = await workspace();
		const layout = resolveLayout({ appRoot: root, userRoot: root });
		const first = await seedPlugins(layout);
		const gone = first[0]!;
		await rm(join(root, "plugins", gone), { recursive: true, force: true });

		expect(await seedPlugins(layout)).toEqual([]);
		expect(await installed(root)).not.toContain(gone);
		// 再启一次也一样（账本落盘了）。
		expect(await seedPlugins(layout)).toEqual([]);

		const manifest = JSON.parse(await readFile(join(root, SEED_MANIFEST_FILE), "utf8")) as { plugins: string[] };
		expect(manifest.plugins).toEqual([...first].sort());
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
