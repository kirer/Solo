/**
 * 消息流的折行契约：长链接 / 长命令不出横向滚动条。
 *
 * 这是纯 CSS 的事，node 环境没有布局引擎，所以这里读 stream.css 原文断言规则：
 *   1. .md 及其 a / code 后代继承 overflow-wrap:anywhere，长 URL 能断；
 *   2. .md pre、.md-code pre、.ev-body pre 用 pre-wrap，且**没有** overflow-x:auto。
 * 断的是「规则在不在、有没有被退回 auto」，不是像素 —— 像素留给手工验收。
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const raw = readFileSync(fileURLToPath(new URL("../../ui/app/src/styles/stream.css", import.meta.url)), "utf8");
// 注释里也写选择器（解释规则为什么这么写），先剥掉，免得被当成规则块的前导。
const css = raw.replace(/\/\*[\s\S]*?\*\//g, "");

/**
 * 取某个选择器的**所有**规则块（一个选择器可能在文件里出现多次，还可能在逗号组里）。
 * 断言时取「任意一块满足」的口径：只要有一条规则写了折行就算数。
 */
function blocksOf(selector: string): string[] {
	const out: string[] = [];
	for (const match of css.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
		const prelude = match[1].split(",").map((part) => part.trim());
		if (prelude.includes(selector)) out.push(match[2]);
	}
	if (out.length === 0) throw new Error(`没找到规则 ${selector}`);
	return out;
}

const anyBlock = (selector: string, needle: string) =>
	blocksOf(selector).some((rule) => rule.includes(needle));

describe("消息正文换行", () => {
	it(".md 与链接、行内代码都能在任意位置断行", () => {
		expect(anyBlock(".md", "overflow-wrap: anywhere")).toBe(true);
		for (const selector of [".md a", ".md code"]) {
			expect(anyBlock(selector, "overflow-wrap: anywhere")).toBe(true);
			expect(anyBlock(selector, "word-break: break-word")).toBe(true);
		}
	});

	it("三处 pre 都是 pre-wrap，且都不留横向滚动条", () => {
		for (const selector of [".md pre", ".md-code pre", ".ev-body pre"]) {
			expect(anyBlock(selector, "white-space: pre-wrap")).toBe(true);
			// 任何一条关于它的规则都不许再写回横向滚动
			for (const rule of blocksOf(selector)) {
				expect(rule).not.toContain("overflow-x: auto");
				expect(rule).not.toMatch(/overflow:\s*auto/);
			}
		}
		// .ev-body 限高要看展开的命令输出，只纵向滚
		expect(anyBlock(".ev-body pre", "overflow-x: hidden")).toBe(true);
	});
});
