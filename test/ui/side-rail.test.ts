/**
 * 侧栏收起（56px 图标条）。node 里没有布局引擎，所以照旧读 CSS 原文断言规则，
 * 和 rows-style.test.ts 同一个做法 —— 盯的是「这条能力没被后来的改动悄悄拆掉」：
 *
 *   1. 收起只由 `.frame[data-side="rail"]` 这一个属性驱动（JS 不碰尺寸）；
 *   2. 收起后宽度是 56，不是 0（0 就等于把它删了）；
 *   3. 收起后名字/预览/时间要收起来，否则窄栏里会挤出半行字；
 *   4. 手机上不提供收起（侧栏本来就是整屏的一个区域）。
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");
const css = read("../../ui/app/src/styles/shell.css").replace(/\/\*[\s\S]*?\*\//g, "");
// React 重构后：本地存储与 `data-side` 在 store.ts / App.tsx，行标题在 Sidebar.tsx。
const app = read("../../ui/app/src/state/store.ts");
const frame = read("../../ui/app/src/App.tsx");
const sidebar = read("../../ui/app/src/sidebar/Sidebar.tsx");

function blocksOf(selector: string): string[] {
	const out: string[] = [];
	for (const match of css.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
		const prelude = match[1].split(",").map((part) => part.trim());
		if (prelude.includes(selector)) out.push(match[2]);
	}
	return out;
}

describe("侧栏收起", () => {
	it("收起宽度 56，由 data-side 驱动", () => {
		const rule = blocksOf('.frame[data-side="rail"]').join("\n");
		expect(rule).toContain("--sidebar: 56px");
	});

	it("展开时宽度来自 --sidebar，且换了列宽有过渡", () => {
		const frame = blocksOf(".frame").join("\n");
		expect(frame).toContain("grid-template-columns: var(--sidebar)");
		expect(frame).toContain("transition: grid-template-columns");
	});

	it("收起后藏起名字、预览与时间", () => {
		for (const part of [".ch-main", ".ch-time", ".brand-name"]) {
			expect(blocksOf('.frame[data-side="rail"] ' + part).join("\n")).toContain("display: none");
		}
	});

	it("收起后每行是 36×36 的方块，未读退化成点", () => {
		expect(blocksOf('.frame[data-side="rail"] .ch').join("\n")).toContain("width: 36px");
		const badge = blocksOf('.frame[data-side="rail"] .ch-badge').join("\n");
		expect(badge).toContain("font-size: 0");
		expect(badge).toContain("border-radius: 50%");
	});

	it("手机上不提供收起", () => {
		expect(css).toMatch(/@media \(max-width: 640px\)[\s\S]*?\.side-toggle\s*\{\s*display: none;/);
	});

	it("状态存在本地，刷新后保持", () => {
		expect(app).toContain('const SIDE_KEY = "ai-company.side"');
		expect(app).toContain("localStorage.setItem(SIDE_KEY, side)");
		// `.frame[data-side]` 是这套布局唯一的开关（JS 不碰列宽）。
		expect(frame).toContain("data-side={side}");
		// 收起后名字看不见，必须写进 title，否则那一栏就只剩一堆脸。
		expect(sidebar).toContain("title={parts.join(\" · \")}");
	});
});
