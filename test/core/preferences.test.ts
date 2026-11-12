/**
 * 界面偏好：更新代理与额外工作目录，都存在 `settings.json` 里。
 *
 * 守三件事：只动请求里给了的键（别把 providers 抹掉）、空串 = 直连（键要删掉）、
 * 工作目录必须是用户亲手加的绝对路径且真的存在（ADR-126）。
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { createPreferences } from "../../src/app/preferences.ts";
import type { CoreServices } from "../../src/app/types.ts";

let dir: string | undefined;

function setup(existing?: Record<string, unknown>) {
	dir = mkdtempSync(join(tmpdir(), "solo-prefs-"));
	const settingsFile = join(dir, "settings.json");
	if (existing !== undefined) writeFileSync(settingsFile, JSON.stringify(existing), "utf8");
	const prefs = createPreferences({ layout: { settingsFile } } as unknown as CoreServices);
	return { prefs, settingsFile };
}

afterEach(() => {
	if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
	dir = undefined;
});

describe("更新代理", () => {
	test("没有配置时读出来是空串", async () => {
		const { prefs } = setup();
		expect(await prefs.read()).toEqual({ updateProxy: "", workDirs: [] });
	});

	test("存进去、读回来；其它键原样保留", async () => {
		const { prefs, settingsFile } = setup({ defaultModel: "anthropic/claude-opus-5-5" });
		expect(await prefs.save({ updateProxy: " http://127.0.0.1:7890 " })).toEqual({
			updateProxy: "http://127.0.0.1:7890",
			workDirs: [],
		});
		expect(await prefs.read()).toEqual({ updateProxy: "http://127.0.0.1:7890", workDirs: [] });
		const saved = JSON.parse(readFileSync(settingsFile, "utf8")) as Record<string, unknown>;
		expect(saved["defaultModel"]).toBe("anthropic/claude-opus-5-5");
		expect(saved["updateProxy"]).toBe("http://127.0.0.1:7890");
	});

	test("清空 = 直连：键被删掉", async () => {
		const { prefs, settingsFile } = setup({ updateProxy: "http://127.0.0.1:7890" });
		expect(await prefs.save({ updateProxy: "" })).toEqual({ updateProxy: "", workDirs: [] });
		expect(JSON.parse(readFileSync(settingsFile, "utf8"))).not.toHaveProperty("updateProxy");
	});

	test("不是地址就拒绝，不写盘", async () => {
		const { prefs, settingsFile } = setup();
		await expect(prefs.save({ updateProxy: "127.0.0.1:7890" })).rejects.toThrow("http://");
		await expect(prefs.save({ updateProxy: 7890 })).rejects.toThrow("字符串");
		expect(() => readFileSync(settingsFile, "utf8")).toThrow();
	});
});

describe("额外工作目录", () => {
	test("加一个存在的目录：存绝对路径，读回来就有", async () => {
		const { prefs, settingsFile } = setup({ defaultModel: "x" });
		const toolDir = join(dir ?? "", "code", "solo");
		mkdirSync(toolDir, { recursive: true });
		expect(await prefs.save({ workDirs: [toolDir] })).toEqual({ updateProxy: "", workDirs: [toolDir] });
		expect(await prefs.read()).toEqual({ updateProxy: "", workDirs: [toolDir] });
		const saved = JSON.parse(readFileSync(settingsFile, "utf8")) as Record<string, unknown>;
		expect(saved["workDirs"]).toEqual([toolDir]);
		// 只动给了的键：没发 updateProxy，它就不该被抹掉/新建。
		expect(saved["defaultModel"]).toBe("x");
		expect(saved["updateProxy"]).toBeUndefined();
	});

	test("删光 = 键被删掉（回到未配置）", async () => {
		const { prefs, settingsFile } = setup();
		const toolDir = join(dir ?? "", "code");
		mkdirSync(toolDir, { recursive: true });
		await prefs.save({ workDirs: [toolDir] });
		expect(await prefs.save({ workDirs: [] })).toEqual({ updateProxy: "", workDirs: [] });
		expect(JSON.parse(readFileSync(settingsFile, "utf8"))).not.toHaveProperty("workDirs");
	});

	test("相对路径、不存在的目录、文件、磁盘根都拒绝，且一个都不写进去", async () => {
		const { prefs, settingsFile } = setup();
		const toolDir = join(dir ?? "", "code");
		mkdirSync(toolDir, { recursive: true });
		await expect(prefs.save({ workDirs: ["code/solo"] })).rejects.toThrow("绝对路径");
		await expect(prefs.save({ workDirs: [join(toolDir, "没有这个")] })).rejects.toThrow("不存在");
		const file = join(toolDir, "a.md");
		writeFileSync(file, "x", "utf8");
		await expect(prefs.save({ workDirs: [file] })).rejects.toThrow("不是目录");
		await expect(prefs.save({ workDirs: ["/"] })).rejects.toThrow("根目录");
		await expect(prefs.save({ workDirs: "nope" })).rejects.toThrow("数组");
		// 一份里有一条坏的：整份拒绝，好目录也不写进去（否则用户以为全加上了）。
		await expect(prefs.save({ workDirs: [toolDir, "bad"] })).rejects.toThrow("绝对路径");
		expect(() => readFileSync(settingsFile, "utf8")).toThrow();
	});

	test("只更新代理时，已有的工作目录原样保留", async () => {
		const { prefs } = setup();
		const toolDir = join(dir ?? "", "code");
		mkdirSync(toolDir, { recursive: true });
		await prefs.save({ workDirs: [toolDir] });
		expect(await prefs.save({ updateProxy: "http://127.0.0.1:7890" })).toEqual({
			updateProxy: "http://127.0.0.1:7890",
			workDirs: [toolDir],
		});
	});
});
