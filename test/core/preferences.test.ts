/**
 * 界面偏好：只有「更新代理」一项，存在 `settings.json` 里。
 *
 * 守两件事：只动 `updateProxy` 这一个键（别把 providers 抹掉），以及空串 = 直连
 * （键要删掉，不是留一个空字符串让桌面壳去猜）。
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
		expect(await prefs.read()).toEqual({ updateProxy: "" });
	});

	test("存进去、读回来；其它键原样保留", async () => {
		const { prefs, settingsFile } = setup({ defaultModel: "anthropic/claude-opus-5-5" });
		expect(await prefs.save({ updateProxy: " http://127.0.0.1:7890 " })).toEqual({
			updateProxy: "http://127.0.0.1:7890",
		});
		expect(await prefs.read()).toEqual({ updateProxy: "http://127.0.0.1:7890" });
		const saved = JSON.parse(readFileSync(settingsFile, "utf8")) as Record<string, unknown>;
		expect(saved["defaultModel"]).toBe("anthropic/claude-opus-5-5");
		expect(saved["updateProxy"]).toBe("http://127.0.0.1:7890");
	});

	test("清空 = 直连：键被删掉", async () => {
		const { prefs, settingsFile } = setup({ updateProxy: "http://127.0.0.1:7890" });
		expect(await prefs.save({ updateProxy: "" })).toEqual({ updateProxy: "" });
		expect(JSON.parse(readFileSync(settingsFile, "utf8"))).not.toHaveProperty("updateProxy");
	});

	test("不是地址就拒绝，不写盘", async () => {
		const { prefs, settingsFile } = setup();
		await expect(prefs.save({ updateProxy: "127.0.0.1:7890" })).rejects.toThrow("http://");
		await expect(prefs.save({ updateProxy: 7890 })).rejects.toThrow("字符串");
		expect(() => readFileSync(settingsFile, "utf8")).toThrow();
	});
});
