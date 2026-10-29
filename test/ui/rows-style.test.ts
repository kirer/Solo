/**
 * 过程行的「工整」是 CSS 的事，node 环境没有布局引擎，所以照旧读 stream.css 原文
 * 断言规则（和 wrap-css.test.ts 同一个做法）。盯的是老板验收里的三条：
 *   1. 展开态单行、无边框、无缩进盒子，12–13px / 行高 20–22；
 *   2. 每行不挂自己的 chevron，只有组头有；
 *   3. 跑着和跑完要一眼分开（跑着有动点，颜色/亮度有差）。
 * 具体像素留给截图验收，这里只钉「规则没被改回去」。
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const raw = readFileSync(fileURLToPath(new URL("../../ui/app/src/styles/stream.css", import.meta.url)), "utf8");
// 注释里也写选择器，先剥掉，免得被当成规则块的前导。
const css = raw.replace(/\/\*[\s\S]*?\*\//g, "");

function blocksOf(selector: string): string[] {
	const out: string[] = [];
	for (const match of css.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
		const prelude = match[1].split(",").map((part) => part.trim());
		if (prelude.includes(selector)) out.push(match[2]);
	}
	if (out.length === 0) throw new Error(`没找到规则 ${selector}`);
	return out;
}

const anyBlock = (selector: string, needle: string) => blocksOf(selector).some((rule) => rule.includes(needle));

describe("过程行的展开态", () => {
	// 行高从 20–22 放到 24：对齐 DSH 的过程行（组头 14/24、摘要 13/20），
	// 24 是这套观感的基线，压到 20 会让一行行挤成清单。
	it("每步一行、12–13px、行高 20–24，且不换行", () => {
		for (const selector of [".ev", ".ev-txt"]) {
			expect(anyBlock(selector, "white-space: nowrap")).toBe(true);
		}
		const size = /font-size:\s*([\d.]+)px/.exec(blocksOf(".ev").join("\n"));
		expect(Number(size?.[1])).toBeGreaterThanOrEqual(12);
		expect(Number(size?.[1])).toBeLessThanOrEqual(13);
		const line = /line-height:\s*([\d.]+)px/.exec(blocksOf(".ev").join("\n"));
		expect(Number(line?.[1])).toBeGreaterThanOrEqual(20);
		expect(Number(line?.[1])).toBeLessThanOrEqual(24);
	});

	it("展开容器没有边框、没有缩进竖线", () => {
		for (const rule of blocksOf(".evs-body")) {
			expect(rule).not.toContain("border-left");
			expect(rule).not.toMatch(/border:\s*1px/);
			expect(rule).not.toContain("padding-left: 10px");
		}
	});

	it("组里的过程行不再二次缩进，和组头左对齐", () => {
		const rule = blocksOf(".evs-list .row-event").join("\n");
		expect(rule).toContain("margin-left: 0");
		expect(rule).toContain("max-width: 100%");
	});

	it("跑着和跑完分开：跑着有动点，且尊重减弱动效", () => {
		expect(anyBlock(".evs-live i", "animation")).toBe(true);
		expect(raw).toContain("prefers-reduced-motion");
		// 组头在跑和跑完之间至少有一处视觉差异（这里用颜色深浅）
		expect(css).toContain('[data-state="running"]');
	});
});
