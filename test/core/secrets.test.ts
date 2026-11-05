import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SECRETS_FILE, loadSecrets, redact, redactor } from "../../src/core/secrets.ts";

/**
 * 密钥不进提示词。守的是一个不可逆的泄露：`identity.md` / 技能 / 记忆每一轮都会
 * 被渲染进 system 段，一把 key 写进去就是永久、每轮都发给模型。
 */
let root = "";

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "core-secrets-"));
});

afterEach(async () => {
	await rm(root, { recursive: true, force: true });
});

describe("读密钥", () => {
	it("没有文件就是空数组，不抛", () => {
		expect(loadSecrets(root)).toEqual([]);
	});

	it("只收字符串，太短的不算密钥", async () => {
		await writeFile(join(root, SECRETS_FILE), JSON.stringify({ A: "short", B: 1234, C: "long-enough-value" }), "utf8");
		expect(loadSecrets(root)).toEqual(["long-enough-value"]);
	});
});

describe("脱敏", () => {
	const value = "sk-live-abcdefghijklmnop";

	it("原值整个换掉", () => {
		expect(redactor([value])(`key 是 ${value} 别外传`)).toBe("key 是 [密钥已隐藏] 别外传");
	});

	it("JSON 转义形态也换掉", () => {
		const quoted = 'pa"ss/word-123456';
		const source = `config: ${JSON.stringify({ key: quoted })}`;
		expect(redactor([quoted])(source)).toBe('config: {"key":"[密钥已隐藏]"}');
	});

	it("URL 编码形态也换掉（agent 常把它拼进命令里）", () => {
		const source = `curl "http://x/?k=${encodeURIComponent(value)}"`;
		expect(redactor([value])(source)).toBe('curl "http://x/?k=[密钥已隐藏]"');
	});

	it("短值要求词边界，不误伤普通单词", () => {
		const apply = redactor(["abcdefgh"]);
		expect(apply("这里 abcdefgh 是密钥")).toBe("这里 [密钥已隐藏] 是密钥");
		expect(apply("xabcdefghy 不是")).toBe("xabcdefghy 不是");
	});

	it("长值优先：短值不会把长值切碎留下后半截", () => {
		const apply = redactor(["abcdefgh", "abcdefgh12345678"]);
		expect(apply("abcdefgh12345678")).toBe("[密钥已隐藏]");
	});

	it("整段提示词按 workspace 缓存，但文件变了立刻生效", async () => {
		expect(redact(`a ${value} b`, root)).toContain(value);
		await writeFile(join(root, SECRETS_FILE), JSON.stringify({ K: value }), "utf8");
		// mtime 精度可能到毫秒，等一拍保证版本号变化。
		await new Promise((resolve) => setTimeout(resolve, 10));
		await writeFile(join(root, SECRETS_FILE), JSON.stringify({ K: value, N: "another-secret-value" }), "utf8");
		expect(redact(`a ${value} b`, root)).toBe("a [密钥已隐藏] b");
	});
});
