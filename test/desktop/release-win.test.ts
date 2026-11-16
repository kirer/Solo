/**
 * Windows 打包是**停着的**：2026-11-15 老板拍，技能 `发版` 里写着「Windows 暂时不出」，
 * `build-win` job、x64 产物、`latest-win.json` 三样都摘了，现在只出 mac arm64。
 *
 * 2026-11-16 我把这件事当成「待办」反着做过一遍：`git revert` 接回来、补了「断了要红」的测试、
 * 跑了两轮 CI，还把线上 `latest-win.json` 是 404 当 bug 报了上去 —— 那正是拍板的结果。
 * 所以这份测试从「断了要红」翻成「加回来要红」：谁再接，先来这儿核技能那条。
 * 真要恢复（老板改主意）：技能那句和这份测试一起翻过来，别只改一半。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const REPO = join(import.meta.dirname, "..", "..");
const read = (relpath: string): string => readFileSync(join(REPO, relpath), "utf8");

const workflow = read(".github/workflows/release.yml");
/** 从 `publish:` 那一行读到文件尾：后半段的断言只看 publish 里写了什么。 */
const publish = workflow.slice(workflow.indexOf("\n  publish:"));

describe("Windows 这条链现在停着（2026-11-15 拍的）", () => {
	it("没有 `build-win` 这个 job（注释里提名字不算）", () => {
		expect(workflow).not.toContain("\n  build-win:");
	});

	it("`publish` 只等 `verify` + `build-mac`", () => {
		expect(publish).toContain("needs: [verify, build-mac]");
	});

	it("`publish` 不签 win 清单、也不传 x64 产物", () => {
		expect(publish).not.toContain("win32");
		expect(publish).not.toContain("latest-win.json");
		expect(publish).not.toContain("-x64.");
	});

	it("干跑那步的假产物只有 mac 两个", () => {
		const steps = read("scripts/verify-release-steps.mjs");
		expect(steps).toContain("`Solo-${version}-arm64.dmg`");
		expect(steps).toContain("`Solo-${version}-arm64.zip`");
		expect(steps).not.toContain("-x64.");
	});
});
