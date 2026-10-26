/**
 * 静态目录选择：`ui/dist/`（构建产物）优先，源码兜底。
 *
 * 这一层是「打包」与「无构建」两条约定的接缝，坏掉的后果都是静默的：
 * - 产物过期却仍被选中 → 改了源码刷新不生效，看上去像「代码没保存」；
 * - 没产物时不回退源码 → `git clone` 完 `npm start` 白屏。
 *
 * 所以两条都要有测试钉住。
 */
import { mkdir, mkdtemp, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { resolveStaticRoot } from "../../src/server/static-root.ts";

describe("resolveStaticRoot", () => {
	let ui = "";

	beforeEach(async () => {
		ui = await mkdtemp(join(tmpdir(), "ai-company-root-"));
		await mkdir(join(ui, "js"), { recursive: true });
		await mkdir(join(ui, "dist"), { recursive: true });
		await writeFile(join(ui, "index.html"), "<html></html>");
		await writeFile(join(ui, "js", "app.js"), "// source");
	});

	afterEach(async () => {
		await rm(ui, { recursive: true, force: true });
	});

	/** 把某个路径的 mtime 固定到指定时间，避免依赖真实时钟与文件顺序。 */
	async function touchAt(path: string, secondsFromNow: number) {
		const at = new Date(Date.now() + secondsFromNow * 1000);
		await utimes(path, at, at);
	}

	async function writeDist(stamp: number) {
		await writeFile(join(ui, "dist", "index.html"), "<html>built</html>");
		await writeFile(join(ui, "dist", "app.js"), "// built");
		await writeFile(join(ui, "dist", ".stamp"), String(stamp));
	}

	test("没有 ui/dist/ 时回退源码，并说明原因", async () => {
		await rm(join(ui, "dist"), { recursive: true, force: true });
		const choice = await resolveStaticRoot(ui);
		expect(choice.kind).toBe("source");
		expect(choice.dir).toBe(ui);
		expect(choice.reason).toContain("ui/dist/");
	});

	test("产物比源码新 → 用产物", async () => {
		await touchAt(join(ui, "js", "app.js"), -60);
		await touchAt(join(ui, "index.html"), -60);
		await writeDist(Date.now());
		const choice = await resolveStaticRoot(ui);
		expect(choice.kind).toBe("dist");
		expect(choice.dir).toBe(join(ui, "dist"));
	});

	test("源码比产物新 → 回退源码（改了没重新构建）", async () => {
		await writeDist(Date.now() - 120_000);
		await touchAt(join(ui, "js", "app.js"), 0);
		const choice = await resolveStaticRoot(ui);
		expect(choice.kind).toBe("source");
		expect(choice.reason).toContain("新");
	});

	test("改 CSS / index.html 也算源码变更", async () => {
		await writeDist(Date.now() - 120_000);
		await writeFile(join(ui, "js", "app.js"), "// old");
		await touchAt(join(ui, "js", "app.js"), -60);
		await touchAt(join(ui, "index.html"), 0);
		expect((await resolveStaticRoot(ui)).kind).toBe("source");
	});

	test("dist 目录自身不参与新旧比较（否则永远判过期）", async () => {
		await touchAt(join(ui, "js", "app.js"), -600);
		await touchAt(join(ui, "index.html"), -600);
		await writeDist(Date.now() - 300_000);
		// 构建写入产物后，dist 里文件 mtime 必然比 .stamp 新 —— 若把 dist 算进
		// 「源码最新 mtime」，产物就会永远被判过期。
		const choice = await resolveStaticRoot(ui);
		expect(choice.kind).toBe("dist");
	});

	test(".stamp 缺失 → 回退源码，不猜", async () => {
		await writeFile(join(ui, "dist", "index.html"), "<html>built</html>");
		await writeFile(join(ui, "dist", "app.js"), "// built");
		const choice = await resolveStaticRoot(ui);
		expect(choice.kind).toBe("source");
		expect(choice.reason).toContain(".stamp");
	});

	test(".stamp 是垃圾值 → 回退源码", async () => {
		await writeDist(Number.NaN);
		expect((await resolveStaticRoot(ui)).kind).toBe("source");
	});

	test("index.html 缺失的产物不算产物", async () => {
		await writeFile(join(ui, "dist", "app.js"), "// built");
		await writeFile(join(ui, "dist", ".stamp"), String(Date.now()));
		expect((await resolveStaticRoot(ui)).kind).toBe("source");
	});

	test("刚构建完（时间戳几乎相等）视为有效，不会因微秒误差误判过期", async () => {
		const now = (await stat(join(ui, "js", "app.js"))).mtimeMs;
		await writeDist(now);
		expect((await resolveStaticRoot(ui)).kind).toBe("dist");
	});

	test("任何异常都不抛错，最差退回源码", async () => {
		// uiDir 根本不存在
		await expect(resolveStaticRoot(join(ui, "nope"))).resolves.toMatchObject({ kind: "source" });
	});
});
