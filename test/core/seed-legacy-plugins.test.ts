/**
 * 从老账本升级：盘上那份插件到底算不算「用户改过」。
 *
 * 审计发现（程砚 2026-11-11）：判据是「整份文件的 hash 都命中 `LEGACY_PLUGIN_HASHES`」，
 * 而 2.9.3 / 2.9.4 / 2.9.5 三份 `悬浮球/client.js` 一个都没在表里。于是还停在老账本的机器
 * 升上来会被判成「用户改过」、整份留旧插件 —— 版本号变了、日志干净、行为还是老的。
 * 这条比声音那个 bug 更隐蔽：它让「修好了」变成一句无从证实的话。
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { LEGACY_PLUGIN_HASHES } from "../../src/shell/seed-legacy.ts";
import { SEED_MANIFEST_FILE, seedPlugins } from "../../src/shell/seed.ts";
import { resolveLayout, type Layout } from "../../src/core/layout.ts";

const ORB = "悬浮球";
const roots: string[] = [];

function hashOf(content: string | Buffer): string {
	return createHash("sha256").update(content).digest("hex").slice(0, 16);
}

async function makeLayout(): Promise<Layout> {
	const root = await mkdtemp(join(tmpdir(), "core-seed-legacy-"));
	roots.push(root);
	const layout = resolveLayout({ appRoot: root, userRoot: root });
	await mkdir(layout.pluginsRoot, { recursive: true });
	return layout;
}

afterEach(async () => {
	// 临时目录由系统回收；这里只清数组，别把别的东西删掉。
	roots.length = 0;
});

/**
 * 老账本：`plugins` 只记「见过」，**整块没有 `pluginFiles`**，这样才走 `record === undefined` 那条。
 * 这正是 2.9.2 及更早那批机器留在盘上的样子。
 */
async function writeOldLedger(layout: Layout): Promise<void> {
	const ledger = { version: 2, skills: {}, files: {}, plugins: [ORB] };
	expect("pluginFiles" in ledger).toBe(false);
	await writeFile(layout.seedManifestFile, `${JSON.stringify(ledger, null, 2)}\n`, "utf8");
}

/** 把当前出厂那份插件原样拷到「盘上」，模拟「用户没改过、只是版本旧」。 */
async function copyCurrentSeed(layout: Layout): Promise<void> {
	// 用 `fileURLToPath`，别用 `.pathname`：URL 会把中文百分号编码，`readdir` 直接 ENOENT。
	const from = fileURLToPath(new URL(`../../seed/plugins/${ORB}/`, import.meta.url));
	const { readdir, copyFile } = await import("node:fs/promises");
	const to = join(layout.pluginsRoot, ORB);
	await mkdir(to, { recursive: true });
	for (const name of await readdir(from)) {
		await copyFile(join(from, name), join(to, name));
	}
}

/** 仓库里某一次提交的 `seed/plugins/<插件>/<文件>` 内容；拿不到就返回 null（例如深克隆 / 无 git）。 */
function gitShow(rev: string, path: string): Buffer {
	// 取不到就让它炸。**不要 try/catch 成 null 再 continue**：中文路径被 `ls-tree` 打了引号时
	// 这里会全炸、但断言还是绿的 —— 一个能空过的断言比没断言更坏（Solo 2026-11-11）。
	return execFileSync("git", ["-c", "core.quotepath=false", "show", `${rev}:${path}`], { maxBuffer: 8 << 20 });
}

/**
 * 某个修订（tag 名或 `HEAD`）里 `seed/plugins/**` 每个文件的 hash 有没有都在表里。
 *
 * `core.quotepath=false`：默认中文路径会被打成 `"seed/plugins/\346\202\254..."` 带引号的转义串，
 * 后面 `git show` 一个都取不到 —— 而取不到的失败一旦被吞掉，断言就是空的绿。
 */
function missingAt(rev: string): string[] {
	const files = execFileSync("git", ["-c", "core.quotepath=false", "ls-tree", "-r", "--name-only", rev, "--", "seed/plugins/"], {
		encoding: "utf8",
	})
		.split("\n")
		.filter((line) => line !== "");
	expect(files.length, `${rev} 里没找到任何出厂插件文件`).toBeGreaterThan(0);
	return files.filter((path) => !LEGACY_PLUGIN_HASHES.has(hashOf(gitShow(rev, path)))).map((path) => `${path} (${hashOf(gitShow(rev, path))})`);
}

describe("老账本升级", () => {
	// 防以后再漏：每一次发版都会动 seed/plugins，忘了更新表就意味着「这一版的修复到不了老用户机器」。
	// 盯的是 **HEAD**：真正要保护的是「即将发出去的那一版」，tag 是已经发出去的下限。
	// 只看 tag 的话，改动提交了但还没打 tag 的那段时间，这条测试是瞎的（程砚 2026-11-11）。
	it("HEAD 里每个出厂插件文件都在 LEGACY_PLUGIN_HASHES 里", () => {
		const missing = missingAt("HEAD");
		expect(missing, `HEAD 里这些出厂文件不在 LEGACY_PLUGIN_HASHES：老账本机器升上来会被判成「用户改过」`).toEqual([]);
	});

	// 下限：最近一个 tag 发出去的那份也必须认得。补表补晚了，已经发出去的用户就再也升不动了。
	it("最近一个 tag 的出厂插件 hash 也在 LEGACY_PLUGIN_HASHES 里", () => {
		let tag = "";
		try {
			tag = execFileSync("git", ["describe", "--tags", "--abbrev=0"], { encoding: "utf8" }).trim();
		} catch {
			return; // 没有 git 或没有 tag：这条在那种环境下没有意义。
		}
		expect(tag).not.toBe("");
		const missing = missingAt(tag);
		expect(missing, `${tag} 里这些出厂文件不在 LEGACY_PLUGIN_HASHES：老账本机器升上来会被判成「用户改过」`).toEqual([]);
	});

	it("盘上就是出厂那份、只是版本旧：整份升到新版，并记下基线", async () => {
		const layout = await makeLayout();
		await writeOldLedger(layout);
		await copyCurrentSeed(layout);
		const before = await readFile(join(layout.pluginsRoot, ORB, "client.js"));
		expect(LEGACY_PLUGIN_HASHES.has(hashOf(before))).toBe(true);

		await seedPlugins(layout);

		const manifest = JSON.parse(await readFile(layout.seedManifestFile, "utf8")) as {
			pluginFiles?: Record<string, Record<string, string>>;
		};
		// 关键：判成「没改过」之后要写出 `pluginFiles` 基线，否则下次启动还在这个坑里。
		expect(manifest.pluginFiles?.[ORB]?.["client.js"]).toBe(hashOf(before));
	});

	it("用户真改过一个文件：整份原样留着，不动", async () => {
		const layout = await makeLayout();
		await writeOldLedger(layout);
		await copyCurrentSeed(layout);
		const path = join(layout.pluginsRoot, ORB, "client.js");
		// 真改：不是加一行注释就算改 —— 改完的 hash 必须**真的不在**历史出厂集合里，
		// 否则「留着不动」是假绿（文件本来就和出厂不一样也照样能过）。
		const mine = (await readFile(path, "utf8")).replace("if (!speakOn) return;", "if (!speakOn || true) return;");
		expect(mine).not.toBe(await readFile(path, "utf8"));
		expect(LEGACY_PLUGIN_HASHES.has(hashOf(mine))).toBe(false);
		await writeFile(path, mine, "utf8");

		await seedPlugins(layout);

		expect(await readFile(path, "utf8")).toBe(mine);
		const manifest = JSON.parse(await readFile(layout.seedManifestFile, "utf8")) as {
			pluginFiles?: Record<string, Record<string, string>>;
		};
		// 记的是**他这份**的基线：以后他对 seed 的改动就靠这条分辨。
		expect(manifest.pluginFiles?.[ORB]?.["client.js"]).toBe(hashOf(mine));
	});
});
