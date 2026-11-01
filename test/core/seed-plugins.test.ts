/**
 * 出厂插件「补一次、删了不回来」。
 *
 * 只看目录在不在的话，删掉的出厂插件下次启动会被重新拷回来 —— 界面上的「删除」只在
 * 这次进程里生效，重启就复活。账本（`.seed-manifest.json` 的 `plugins`）就是为这一条：
 * 见过一次的插件，之后不再碰。
 */
import { mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SEED_MANIFEST_FILE, seedPlugins } from "../../src/core/shell/seed.ts";
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
});
