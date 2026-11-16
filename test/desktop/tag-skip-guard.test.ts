import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// 2026-11-16：文档全改成「bump 别带 `[skip ci]`」了，这一版自己还是带着它发出去 ——
// 文档拦不住，得机器拦。闸挂在 `create` 事件上（push 被 skip 时 GitHub 根本不建 run）。
const root = join(__dirname, "..", "..");
const script = join(root, "scripts", "tag-skip-guard.sh");
const guardYml = readFileSync(join(root, ".github/workflows/tag-skip-guard.yml"), "utf8");

function check(text: string): { code: number | null; out: string } {
	const r = spawnSync("bash", [script, "--stdin"], { input: text, encoding: "utf8" });
	return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

describe("发版闸：tag 不许被 skip 指令静默跳过", () => {
	it("GitHub 认的五种写法全拦得住（大小写不敏感）", () => {
		for (const msg of [
			"chore(版本): 2.9.24 [skip ci]",
			"chore(版本): 2.9.24 [ci skip]",
			"chore(版本): 2.9.24 [no ci]",
			"chore(版本): 2.9.24 [skip actions]",
			"chore(版本): 2.9.24 [actions skip]",
			"chore(版本): 2.9.24 [SKIP CI]",
		]) {
			const r = check(msg);
			expect(r.code, msg).toBe(1);
			expect(r.out).toContain("不会启动");
		}
	});

	it("正常提交信息放得过去", () => {
		for (const msg of [
			"chore(版本): 2.9.24",
			"fix(悬浮球): 没按说话的时候不再占着麦克风\n\n菜单栏的麦克风不会一直亮着",
			"docs: 去掉 skip 这个词也不算指令",
		]) {
			const r = check(msg);
			expect(r.code, msg).toBe(0);
			expect(r.out).toContain("没有 skip 指令");
		}
	});

	it("闸挂在 `create` 上，不是 push —— push 被 skip 时那趟 run 根本不存在", () => {
		expect(guardYml).toContain("\non:\n  create:\n");
		expect(guardYml).not.toMatch(/\non:\n  push:/);
		// 判红要留日志，不能只是退出码。
		expect(guardYml).toContain("::error::");
		// 手动也能跑一遍（dispatch 没有 event.ref，要退回 github.ref_name）。
		expect(guardYml).toContain("workflow_dispatch:");
		expect(guardYml).toContain("EVENT_REF:-");
	});

	it("`release.yml` 里不塞这类检查（塞了也跑不到）", () => {
		const release = readFileSync(join(root, ".github/workflows/release.yml"), "utf8");
		expect(release).not.toContain("tag-skip-guard");
	});
});
