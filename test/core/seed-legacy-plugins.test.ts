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
	const from = fileURLToPath(new URL(`../../plugins-src/${ORB}/`, import.meta.url));
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
/** 所有 `v2.*` tag，按版本号排。 */
function listTags(): string[] {
	return execFileSync("git", ["tag", "--list", "v2.*"], { encoding: "utf8" })
		.split("\n")
		.filter((line) => line !== "")
		.sort((a, b) => a.localeCompare(b, "en", { numeric: true }));
}

/**
 * 某个修订里某个目录下的所有文件（目录在那个修订里不存在 → 空数组，`ls-tree` 不报错）。
 *
 * `core.quotepath=false`：默认中文路径会被打成 `"seed/plugins/\346\202\254..."` 带引号的转义串，
 * 后面 `git show` 一个都取不到 —— 而取不到的失败一旦被吞掉，断言就是空的绿。
 */
function treeFiles(rev: string, dir: string): string[] {
	return execFileSync("git", ["-c", "core.quotepath=false", "ls-tree", "-r", "--name-only", rev, "--", dir], { encoding: "utf8" })
		.split("\n")
		.filter((line) => line !== "");
}

/**
 * 某个修订里每个**出厂插件文件**的 hash，两处都扫：`seed/plugins/`（随包发）+ `plugins-src/`
 * （2.9.17 起改成首启联网取）。
 *
 * 只扫前者的时候，2.9.17 之后那些 tag 的出厂内容一个都读不到：`v2.9.17` / `v2.9.18` 的
 * `悬浮球/client.js` 明明发过，扫不到就被判成「表里这条没人用」（假红），也让「新 hash 该不该登」
 * 判不出来。这条一直靠 HEAD 兜着，直到有人改 client.js 才露出来。（沈迟 2026-11-14）
 */
function seedPluginsAt(rev: string): { path: string; hash: string }[] {
	const rows: { path: string; hash: string }[] = [];
	for (const dir of ["seed/plugins/", "plugins-src/"]) {
		for (const path of treeFiles(rev, dir)) rows.push({ path, hash: hashOf(gitShow(rev, path)) });
	}
	return rows;
}

/**
 * 某个修订里的**出厂源**，两处都算：`seed/plugins/`（随包发）+ `plugins-src/`（首启联网取）。
 *
 * 2.9.17 起五个出厂插件全在后者。只看 `seed/plugins/` 的话，那条「HEAD 里每个出厂插件文件
 * 都在表里」会恒绿 —— 假绿比没断言更坏（Solo 2026-11-12）。所以这里合起来扫，扫到的条数
 * 由调用方兜底（不许空手通过）。
 */
function shippedSourcesAt(rev: string): { path: string; hash: string }[] {
	const rows: { path: string; hash: string }[] = [];
	for (const dir of ["seed/plugins/", "plugins-src/"]) {
		for (const path of treeFiles(rev, dir)) rows.push({ path, hash: hashOf(gitShow(rev, path)) });
	}
	return rows;
}

describe("老账本升级", () => {
	// 防以后再漏：每一次发版都会动 seed/plugins，忘了更新表就意味着「这一版的修复到不了老用户机器」。
	// 盯的是 **HEAD**：真正要保护的是「即将发出去的那一版」，tag 是已经发出去的下限。
	// 只看 tag 的话，改动提交了但还没打 tag 的那段时间，这条测试是瞎的（程砚 2026-11-11）。
	it("HEAD 里每个出厂插件文件都在 LEGACY_PLUGIN_HASHES 里", () => {
		const rows = shippedSourcesAt("HEAD");
		// 先钉「真扫到了东西」：五个出厂插件 20 个文件，全在 `plugins-src/`。
		// 少了这一句，`seed/plugins/` 空掉之后这条会一路绿到底（假绿）。
		expect(rows.length, "HEAD 里一个出厂插件文件都没扫到：seed/plugins 与 plugins-src 都是空的？").toBeGreaterThan(10);
		const missing = rows
			.filter((row) => !LEGACY_PLUGIN_HASHES.has(row.hash))
			.map((row) => `${row.path} (${row.hash})`);
		expect(missing, `HEAD 里这些出厂文件不在 LEGACY_PLUGIN_HASHES：老账本机器升上来会被判成「用户改过」`).toEqual([]);
	});

	// 下限：**每一个历史 tag** 发出去的那份都必须认得。
	// 只看最近一个 tag 会漏掉整整一段：2.9.0–2.9.4 每一版的 `client.js` 都改过，表里却只有
	// 2.9.5 和 2.9.6 的 —— 停在 2.9.0–2.9.4 的机器升上来照样被判「用户改过」、整份留旧，
	// 等于修复只送到一小半人（路远 2026-11-11）。
	it("每一个历史 tag 的出厂插件 hash 都在 LEGACY_PLUGIN_HASHES 里", () => {
		const tags = listTags();
		expect(tags.length, "一个 v2.* tag 都没读到").toBeGreaterThan(0);
		const problems: string[] = [];
		for (const tag of tags) {
			// 很早的 tag 里还没有 seed/plugins，跳过。
			for (const row of seedPluginsAt(tag)) {
				if (!LEGACY_PLUGIN_HASHES.has(row.hash)) problems.push(`${tag} ${row.path} (${row.hash})`);
			}
		}
		// 指名到「哪个 tag、哪个文件、哪个 hash」。笼统一条红等于没红，人看到还得自己猜缺哪个。
		expect(problems, "这些历史出厂文件不在 LEGACY_PLUGIN_HASHES：停在那些版本的机器升上来会被判成「用户改过」").toEqual([]);
	}, 180_000); // Windows 上跑全 tag 扫描超 30s（2026-11-12 build-win 红）

	// 反过来也要守住：表里不许塞没人用的 hash。
	// 不然将来为了让上面那条绿，最省事的办法就是「什么 hash 都往里塞」—— 那等于回到
	// 「分不清谁是用户改的」，整份留旧的老毛病会以另一种方式回来（Solo 2026-11-11）。
	it("表里每一个 hash 都对应某个真实出厂文件", () => {
		const seen = new Set<string>();
		for (const rev of [...listTags(), "HEAD"]) {
			for (const row of seedPluginsAt(rev)) seen.add(row.hash);
		}
		// HEAD 上「出厂源」是两处（`seed/plugins/` + `plugins-src/`），tag 上只有前者：
		// 只扫 seed/plugins 会把搬走的五个 hash 误判成「没人用的白塞」。
		const shipped = shippedSourcesAt("HEAD");
		expect(shipped.length, "HEAD 里一个出厂插件文件都没读到").toBeGreaterThan(10);
		for (const row of shipped) seen.add(row.hash);
		const idle = [...LEGACY_PLUGIN_HASHES].filter((hash) => !seen.has(hash)).sort();
		expect(idle, "这些 hash 在任何一个 tag / HEAD 的出厂插件里都找不到：别为了让测试绿往里塞").toEqual([]);
	}, 180_000); // Windows 上跑全 tag 扫描超 30s（2026-11-12 build-win 红）

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

/**
 * 2.9.15 起 `Token统计` / `模型管理` 不随包发，2.9.17 起 `悬浮球` / `文件树` / `IM机器人` 也搬过去：
 * 五个出厂插件全在 `plugins-src/`，`seed/plugins/` 这个目录整个不存在了，用户首次启动时联网下载。
 *
 * **这版故意不推升级**（盘上目录在就整份跳过，老用户零请求、零字节改动）。所以这几个 hash
 * 现在只在「以后要推升级」时才用得上 —— 但那一天真到了，如果它们不在历史出厂集合里，
 * 所有老用户都会被判成「用户改过」整份留旧，版本号变了、日志干净、行为还是老的。
 * 留债可以，**静默留债不行**：这条断言会自己变红（Solo 2026-11-12）。
 */
describe("搬到 plugins-src 的五个插件", () => {
	const names = ["IM机器人", "Token统计", "悬浮球", "文件树", "模型管理"];

	it("出厂源真搬了：五个都在 plugins-src，seed/plugins 里一个都没有", async () => {
		const src = fileURLToPath(new URL("../../plugins-src/", import.meta.url));
		const fromSeed = fileURLToPath(new URL("../../seed/plugins/", import.meta.url));
		const { readdir } = await import("node:fs/promises");
		const { existsSync } = await import("node:fs");
		expect((await readdir(src)).sort()).toEqual([...names].sort());
		// `seed/plugins/` 整个目录这次跟着没了；万一哪天被人塞回来，这条会红。
		const left = existsSync(fromSeed) ? await readdir(fromSeed) : [];
		expect(left).toEqual([]);
	});

	it("plugins-src 里每个文件的 hash 都在历史出厂集合里", async () => {
		const { readdir } = await import("node:fs/promises");
		const src = fileURLToPath(new URL("../../plugins-src/", import.meta.url));
		const missing: string[] = [];
		let seen = 0;
		for (const name of names) {
			for (const file of await readdir(join(src, name))) {
				const hash = hashOf(await readFile(join(src, name, file), "utf8"));
				seen += 1;
				if (!LEGACY_PLUGIN_HASHES.has(hash)) missing.push(`${name}/${file} ${hash}`);
			}
		}
		expect(seen).toBe(20);
		expect(missing).toEqual([]);
	});
});
