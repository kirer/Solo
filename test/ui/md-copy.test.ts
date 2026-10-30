/**
 * 两处「界面看着有、实际不动」的地方，各钉一条断言。
 *
 * 1. **代码块那颗「复制」**：`markdown.ts` 只产出 HTML，正文走
 *    `dangerouslySetInnerHTML` 注入 —— React 的事件系统接不到注入内容里的按钮。
 *    生成的 HTML 里一直有 `.md-code-copy`，但没有任何监听，点了没反应。
 *    修法是在 `main.tsx` 里装一次全局委托（`installCodeCopy`）。
 *    这里能测到的只有两件事：**按钮确实在生成的 HTML 里**（类名与 `markdown.ts`
 *    共用同一个常量，改名不会两边漂），**并且启动时真的装上了监听**。
 *
 * 2. **设置面板的选中态**：CSS 按 `.settings-options .opt[aria-checked="true"]`
 *    画那颗勾，而按钮写的是 `aria-pressed` —— 选择器永远匹配不上，勾一直不出现。
 *    同样只能读源码断言：属性名两边必须一致。
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { renderMarkdown } from "../../ui/app/src/lib/markdown.ts";
import { CODE_COPY_CLASS } from "../../ui/app/src/lib/copy-code.ts";

const read = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");

describe("代码块的复制按钮", () => {
	it("生成的 HTML 里有复制按钮，类名来自同一个常量", () => {
		const html = renderMarkdown("```ts\nconst a = 1;\n```");
		expect(html).toContain(`class="${CODE_COPY_CLASS}"`);
		expect(html).toContain('data-copy="code"');
		expect(html).toContain("const a = 1;");
	});

	it("启动时装上了全局委托", () => {
		const main = read("../../ui/app/src/main.tsx");
		expect(main).toContain("installCodeCopy()");
	});

	it("监听器按同一个类名找按钮，且复制的是 code 里的原文", () => {
		const source = read("../../ui/app/src/lib/copy-code.ts");
		expect(source).toContain("target.closest(`.${CODE_COPY_CLASS}`)");
		expect(source).toContain('querySelector("pre code")');
	});
});

describe("设置面板的选中态", () => {
	const overlays = read("../../ui/app/src/panels/Overlays.tsx");
	const css = read("../../ui/app/src/styles/shell.css").replace(/\/\*[\s\S]*?\*\//g, "");

	it("CSS 按 aria-checked 画勾", () => {
		expect(css).toContain('.settings-options .opt[aria-checked="true"]');
	});

	it("按钮写的是 aria-checked，不是 aria-pressed", () => {
		expect(overlays).toContain("aria-checked={props.layout === item.value}");
		expect(overlays).toContain("aria-checked={props.theme === item.value}");
		expect(overlays).not.toContain("aria-pressed");
	});
});
