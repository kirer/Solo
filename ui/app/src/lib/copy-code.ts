/**
 * 代码块右上角那颗「复制」。
 *
 * 为什么监听要挂在 `document` 上：`markdown.ts` 只产出一段 HTML，正文走
 * `dangerouslySetInnerHTML` 注入 —— React 的事件系统接不到注入内容里的按钮，
 * 所以 `renderCode` 生成的 `.md-code-copy` 一直是一颗没人管的死按钮。
 * 一次全局委托就能同时覆盖消息流、右栏、以后任何渲染 Markdown 的地方。
 *
 * 类名只在这里定义一次，生成处（`markdown.ts`）与监听处共用，改名不会两边漂。
 */

import { copyText } from "./format.ts";

export const CODE_COPY_CLASS = "md-code-copy";

/** 要复制的原文：按钮所在 `<figure class="md-code">` 里 `<pre><code>` 的文本。 */
export function codeTextOf(button: HTMLElement): string {
	const code = button.closest(".md-code")?.querySelector("pre code");
	return code?.textContent ?? "";
}

/** 复制成功的反馈：1.2 秒「已复制」，然后回到原字。 */
function flash(button: HTMLElement): void {
	const original = button.textContent ?? "";
	button.dataset["done"] = "true";
	button.textContent = "已复制";
	window.setTimeout(() => {
		delete button.dataset["done"];
		button.textContent = original;
	}, 1200);
}

/**
 * 装上全局委托，返回卸载函数。
 *
 * 走 capture 阶段：代码块可能落在 `<a>` 或整行双击区里，先接住再截断，
 * 免得点「复制」顺带把整行复制一遍。
 */
export function installCodeCopy(): () => void {
	const onClick = (event: MouseEvent): void => {
		const target = event.target;
		if (!(target instanceof Element)) return;
		const button = target.closest(`.${CODE_COPY_CLASS}`);
		if (!(button instanceof HTMLElement)) return;
		event.preventDefault();
		event.stopPropagation();
		void copyText(codeTextOf(button)).then((ok) => {
			if (ok) flash(button);
		});
	};
	document.addEventListener("click", onClick, true);
	return () => document.removeEventListener("click", onClick, true);
}
