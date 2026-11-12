/**
 * 一把钥匙签所有清单：`src/core/update-key.ts` 与 `desktop/src/update-key.ts` 必须一字不差。
 *
 * 为什么会有两份：桌面壳的 `desktop/tsconfig.json` 把 `rootDir` 钉在 `desktop/src`，引不到 `src/` 下
 * 任何文件（硬引会把主进程输出目录冲掉）。所以钥匙只能各存一份 —— 但**改了一份忘了另一份**，
 * 结果就是「插件清单验得过、更新清单验不过」（或者反过来），而且只在用户机器上才发现。
 * 这条断言让它在 CI 里当场红（路远 2026-11-12）。
 */
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

	it("两边都是真 PEM，不是空串", async () => {
		for (const rel of ["src/core/update-key.ts", "desktop/src/update-key.ts"]) {
			const key = keyIn(await readFile(join(REPO, rel), "utf8")).slice(1, -2).replaceAll("\\n", "\n");
			expect(key).toContain("BEGIN PUBLIC KEY");
			expect(key.trim().split("\n")).toHaveLength(3);
		}
	});
});
