/**
 * 一把钥匙签所有清单：`src/core/update-key.ts` 与 `desktop/src/update-key.ts` 必须一字不差。
 *
 * 为什么会有两份：桌面壳的 `desktop/tsconfig.json` 把 `rootDir` 钉在 `desktop/src`，引不到 `src/` 下
 * 任何文件（硬引会把主进程输出目录冲掉）。所以钥匙只能各存一份 —— 但**改了一份忘了另一份**，
 * 结果就是「插件清单验得过、更新清单验不过」（或者反过来），而且只在用户机器上才发现。
 * 这条断言让它在 CI 里当场红（路远 2026-11-12）。
 */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const REPO = join(import.meta.dirname, "..", "..");

/** 抠出公钥本体：注释和排版可以不同，钥匙必须一字节不差。 */
function keyIn(source: string): string {
	const match = /"-----BEGIN PUBLIC KEY-----[\s\S]*?-----END PUBLIC KEY-----\\n"/.exec(source);
	expect(match, "没找到公钥字面量").not.toBeNull();
	return match?.[0] ?? "";
}

describe("发布公钥", () => {
	it("src 侧和 desktop 侧是同一把", async () => {
		const core = await readFile(join(REPO, "src", "core", "update-key.ts"), "utf8");
		const desktop = await readFile(join(REPO, "desktop", "src", "update-key.ts"), "utf8");
		expect(keyIn(core)).toBe(keyIn(desktop));
	});

	/**
	 * **发布公钥钉死在这儿。**
	 *
	 * 只比两份是否一致是不够的：两份**一起**换成测试钥匙，上面那条照样绿 —— 而老客户端
	 * 全部验不过更新，正是「不报错」那种坏法（程砚-2 2026-11-12）。所以这里再钉两个常量：
	 * 换钥匙必须同时动 `src/core/update-key.ts`、`desktop/src/update-key.ts`、这条断言，
	 * 动常量那一下在 diff 里看得见。
	 *
	 * 常量口径（可复现，`node -e` 一行就能核对）：
	 * - `PUBLISHED_KEY_SHA256` = sha256(PEM 原文，含末尾那个 `\n`)，取小写 hex；
	 * - `PUBLISHED_KEY_BODY` = PEM 中间那行 base64，一个字不差。
	 */
	const PUBLISHED_KEY_SHA256 = "37948f5336776e30701ba21d5aca72f71b8d7afc18c320e9e443f57a368e814d";
	const PUBLISHED_KEY_BODY = "MCowBQYDK2VwAyEAgnk+uz+e4fvO8ZvWLqh6jtYH7rY6G39PFOxeUzkrjjQ=";

	it("公钥就是发出去的那把（两份一起换也会红）", async () => {
		for (const rel of ["src/core/update-key.ts", "desktop/src/update-key.ts"]) {
			const pem = JSON.parse(keyIn(await readFile(join(REPO, rel), "utf8")));
			expect(createHash("sha256").update(pem, "utf8").digest("hex"), rel).toBe(PUBLISHED_KEY_SHA256);
			expect(pem.startsWith("-----BEGIN PUBLIC KEY-----\n"), rel).toBe(true);
			expect(pem.endsWith("-----END PUBLIC KEY-----\n"), rel).toBe(true);
		}
	});

	it("两边都是真 PEM，不是空串", async () => {
		for (const rel of ["src/core/update-key.ts", "desktop/src/update-key.ts"]) {
			const key = keyIn(await readFile(join(REPO, rel), "utf8")).slice(1, -2).replaceAll("\\n", "\n");
			expect(key).toContain("BEGIN PUBLIC KEY");
			expect(key.trim().split("\n")).toHaveLength(3);
		}
	});
});
