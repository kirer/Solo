/**
 * Windows 那条发版链还在不在。
 *
 * 2026-11-16 老板的 Windows 用户拿不到更新：2.9.21 起 `latest-win.json` 不在资产里
 * （前一天 `f9c3b69` 把 `build-win` 整段摘了）。那一笔的注释写着「要恢复 `git revert` 就够」，
 * 可**没有任何东西会提醒你回头去 revert** —— 断的三个版本里没人发现。
 *
 * 所以这里把「Windows 必须跟着发」钉成结构断言：谁再摘掉哪一段，测试当场红，
 * 而不是等用户报「我这儿不更新」。真跑 windows 打包的两条判据（产物出得来、
 * 旧版读得懂清单）本地钉不了，交给 CI 的 `build-win` 和 `update-manifest` 干跑。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const REPO = join(import.meta.dirname, "..", "..");
const read = (relpath: string): string => readFileSync(join(REPO, relpath), "utf8");

const workflow = read(".github/workflows/release.yml");

/** 从 `publish:` 那一行读到文件尾：后半段的断言只看 publish 里写了什么。 */
const publish = workflow.slice(workflow.indexOf("\n  publish:"));

describe("发版必须带上 Windows", () => {
	it("`build-win` job 在，而且真的产 x64 的 exe 和 zip", () => {
		expect(workflow).toContain("\n  build-win:");
		const job = workflow.slice(workflow.indexOf("\n  build-win:"), workflow.indexOf("\n  publish:"));
		expect(job).toContain("runs-on: windows-latest");
		expect(job).toContain("npm run desktop:dist:win");
		expect(job).toContain("Solo-${{ needs.verify.outputs.version }}-x64.exe");
		expect(job).toContain("Solo-${{ needs.verify.outputs.version }}-x64.zip");
		// 少一样就别上传空目录：上传那步必须卡「一个文件都没有」。
		expect(job).toContain("if-no-files-found: error");
	});

	it("`publish` 等 `build-win`：不等就会在没有 win 产物的前提下发版", () => {
		expect(publish).toContain("needs: [verify, build-mac, build-win]");
	});

	it("签清单带 `--file win32=`：不带就不生成 `latest-win.json`", () => {
		expect(publish).toContain('--file win32="dist/Solo-${VERSION}-x64.zip"');
	});

	it("上传里带 win 的两个包和 `latest-win.json` 加签名", () => {
		expect(publish).toContain('"dist/Solo-${VERSION}-x64.exe"');
		expect(publish).toContain('"dist/Solo-${VERSION}-x64.zip"');
		expect(publish).toContain("feed/latest-win.json feed/latest-win.json.sig");
	});

	it("发版那步的假产物也得有 win 两个：少造会掩盖「publish 还在等 win 文件」", () => {
		const steps = read("scripts/verify-release-steps.mjs");
		for (const name of ["arm64.dmg", "arm64.zip", "x64.exe", "x64.zip"]) {
			expect(steps, `假产物里缺 ${name}`).toContain("${version}-" + name);
		}
	});
});
