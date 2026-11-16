/**
 * 发布闸：正文空着不许发。
 *
 * v2.9.18 的 Release 正文是「这一版没有 feat / fix 提交」——功能全被塞进
 * `chore(版本): 2.9.18` 那一笔里，`scripts/update-manifest.ts` 只认 `feat` / `fix` 标题，
 * 于是对外什么都没说（Solo 2026-11-14 查出来的根因）。
 *
 * 为什么读源码而不跑一遍 CI：这道闸是 `release.yml` 里几行 shell，本地跑不了 `gh`/打包。
 * 能盯住的是它的判据（空正文 + 真动了代码 = 红）和位置（必须在 `gh release create` 之前）。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const REPO = join(import.meta.dirname, "..", "..");
const workflow = readFileSync(join(REPO, ".github/workflows/release.yml"), "utf8");

describe("发布闸：notes 空着但真动了代码", () => {
	const start = workflow.indexOf("闸：notes 空着但真动了代码");
	const gate = workflow.slice(start, workflow.indexOf("发版（二进制先传，清单最后传）", start));

	it("这一步真的在 release.yml 里", () => {
		expect(start).toBeGreaterThan(0);
		expect(gate.length).toBeGreaterThan(200);
	});

	it("判据两条：正文是那句空话 + diff 动了代码，两条同时成立才红", () => {
		expect(gate).toContain("这一版没有 feat / fix 提交");
		expect(gate).toContain('git diff --name-only "${PREV}..${TAG}" -- src ui desktop');
		// 空正文但只改了文档/脚本/seed/测试的版本，不该被拦。
		expect(gate).toContain("放行");
		// 真要拦的时候必须非零退出，光打一行日志不算闸。
		expect(gate).toMatch(/exit 1/);
	});

	it("`desktop/` 也在扫的范围内（2.9.18 的功能有一半在壳那层）", () => {
		expect(gate).toMatch(/-- src ui desktop/);
	});

	it("排在 `release create` 之前——发出去之后才红，等于已经发出去了", () => {
		// 只认 `release create` 这段：create 那行现在经 `gh_publish` 包一层（dry_run 要在那儿拦），
		// 写死成 `gh release create` 的话，加壳就会被判成「没有创建这一步」。
		const create = workflow.indexOf("release create");
		expect(create).toBeGreaterThan(0);
		expect(start).toBeLessThan(create);
	});

	it("publish 仍只由 tag 触发（推 main 只打包，不发版）", () => {
		expect(workflow).toContain("if: github.ref_type == 'tag'");
	});

	it("推 main 只跑测试，打包只在推 tag / dispatch 时跑", () => {
		// 老板 2026-11-16 抱怨「每次推送后 git 都要折腾半天」：原来每笔 push 都跑 mac + win
		// 全套打包（十几分钟），还因为同组只留一个 pending，连推两笔就顶掉一轮。
		// 现在推 main 只出 `verify` 的结论；打包两步都守 tag / dispatch，publish 仍只认 tag。
		const onset = workflow.slice(workflow.indexOf("\non:"), workflow.indexOf("\npermissions:"));
		expect(onset).toContain("branches:");
		expect(onset).toContain("- main");
		expect(onset).toContain("- \"v*\"");
		// Windows 打包 2026-11-15 起停着（`build-win` 摘了），这里只查 mac 那一步；
		// 恢复 Windows 时把 "build-win" 加回来，技能 `发版` 那条一起改。
		for (const job of ["build-mac"]) {
			const start = workflow.indexOf(`\n  ${job}:`);
			expect(start).toBeGreaterThan(0);
			const guard = workflow.slice(start, workflow.indexOf("runs-on:", start));
			expect(guard).toContain("github.ref_type == 'tag'");
			expect(guard).toContain("github.event_name == 'workflow_dispatch'");
		}
	});

	it("并发组：tag 一组、推 main 每笔一组，谁都不顶掉谁", () => {
		// 共用一个组 + 同组只留一个 pending = 连推两笔，前一轮白跑。拆成两组：
		// tag 之间仍串行（publish 要全局串行），main 每笔独立（带 sha）各自跑完。
		expect(workflow).toContain("'release-tag'");
		expect(workflow).toContain("format('push-{0}', github.sha)");
		expect(workflow).not.toContain("cancel-in-progress: true");
	});
});
