/**
 * 右侧栏（第三列）。布局靠 CSS，node 里没有布局引擎，
 * 所以照旧读原文断言规则 —— 盯的是四件容易被后来改动弄坏的事：
 *
 *   1. 右栏是**列**不是浮层：`.frame` 必须是三列，且宽度来自 `--rightbar`；
 *   2. `--rightbar` 必须有 0 的定义 —— 否则 `var()` 解析失败，整条
 *      `grid-template-columns` 作废，三列会塌成一列；
 *   3. 收起时 `hidden` 真的不占位（`display: flex` 会盖掉 hidden 的默认规则）；
 *   4. 动画是「列先让开、字后进来」（列 300ms，内容 240ms 带 60ms 延迟）。
 *
 * 文件页已删（ADR-091），右栏只剩详情。
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");
const shell = read("../../ui/app/src/styles/shell.css").replace(/\/\*[\s\S]*?\*\//g, "");
const base = read("../../ui/app/src/styles/base.css").replace(/\/\*[\s\S]*?\*\//g, "");
// React 重构后：`data-right` 由 App.tsx 的 `.frame` 渲染，关闭要等动画由 RightPanel.tsx 的
// 延迟卸载负责。
const app = read("../../ui/app/src/App.tsx");
const files = read("../../ui/app/src/panels/RightPanel.tsx");

function blocksOf(css: string, selector: string): string[] {
	const out: string[] = [];
	for (const match of css.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
		const prelude = match[1].split(",").map((part) => part.trim());
		if (prelude.includes(selector)) out.push(match[2]);
	}
	return out;
}

describe("右侧栏", () => {
	it("是三列布局，第三列宽度来自 --rightbar", () => {
		expect(blocksOf(shell, ".frame").join("\n")).toContain(
			"grid-template-columns: var(--sidebar) minmax(0, 1fr) var(--rightbar)",
		);
		expect(blocksOf(shell, '.frame[data-right="open"]').join("\n")).toContain("--rightbar: 360px");
	});

	it("--rightbar 有一个 0 的定义（否则整条声明作废）", () => {
		expect(base).toContain("--rightbar: 0px");
	});

	it("右栏落在第三列，不是 fixed", () => {
		const rule = blocksOf(shell, ".detail").join("\n");
		expect(rule).toContain("grid-column: 3");
		expect(rule).not.toContain("position: fixed");
	});

	it("收起时 hidden 真的不占位", () => {
		expect(shell).toMatch(/\.detail\[hidden\],\s*\n\s*\.detail-body\[hidden\]\s*\{\s*\n\s*display: none;/);
	});

	it("动画：列 300ms，内容 240ms 且带 60ms 延迟", () => {
		expect(blocksOf(shell, ".frame").join("\n")).toContain("transition: grid-template-columns 300ms");
		const content = blocksOf(shell, ".detail-panel > .detail-body").join("\n");
		expect(content).toContain("animation: detail-in 240ms");
		expect(content).toContain("60ms both");
	});

	it("关闭要等滑完再 hidden（否则动画被剪掉）", () => {
		// `.frame[data-right]` 由 App.tsx 渲染；关的时候先让列宽过渡跑完，再真正卸载内容。
		expect(app).toContain('data-right={right.open ? "open" : "closed"}');
		expect(files).toContain("window.setTimeout(() => setMounted(false), 300)");
	});
});
