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

	it("排在 `gh release create` 之前——发出去之后才红，等于已经发出去了", () => {
		const create = workflow.indexOf("gh release create");
		expect(create).toBeGreaterThan(0);
		expect(start).toBeLessThan(create);
	});

	it("publish 仍只由 tag 触发（手动 dispatch 只验打包）", () => {
		expect(workflow).toContain("if: github.ref_type == 'tag'");
	});
});
