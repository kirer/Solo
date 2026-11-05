/**
 * 桌面壳读更新代理：只认 `settings.json` 的 `updateProxy`。
 *
 * 读不出来（文件没了 / 坏了 / 字段不是字符串）一律当直连 —— 更新这条路不能因为
 * 一个配置字段坏掉就彻底走不通。
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { readUpdateProxy } from "../../desktop/src/update-proxy.ts";

let dir: string | undefined;

function fileWith(content: string): string {
	dir = mkdtempSync(join(tmpdir(), "solo-update-proxy-"));
	const file = join(dir, "settings.json");
	writeFileSync(file, content, "utf8");
	return file;
}

afterEach(() => {
	if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
	dir = undefined;
});

describe("readUpdateProxy", () => {
	test("有代理就用它（去空格）", () => {
		expect(readUpdateProxy(fileWith(JSON.stringify({ updateProxy: " http://127.0.0.1:7890 " })))).toBe(
			"http://127.0.0.1:7890",
		);
	});

	test("空串 / 没这个键 = 直连", () => {
		expect(readUpdateProxy(fileWith(JSON.stringify({ updateProxy: "" })))).toBeUndefined();
		expect(readUpdateProxy(fileWith(JSON.stringify({ defaultModel: "x/y" })))).toBeUndefined();
	});

	test("文件不存在 / 不是 JSON / 字段类型不对都不抛", () => {
		expect(readUpdateProxy(join(tmpdir(), "solo-no-such-settings.json"))).toBeUndefined();
		expect(readUpdateProxy(fileWith("{oops"))).toBeUndefined();
		expect(readUpdateProxy(fileWith(JSON.stringify({ updateProxy: 7890 })))).toBeUndefined();
	});
});
