/**
 * 源码里接没接上：界面上看着有、实际不动的地方。
 *
 * 与 `layout.test.ts` 的区别：那边读 CSS 的「规则」，这边读源码与生成结果，
 * 守的是「按钮真的有人监听」「事件名对得上」「属性名两边一致」。
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { renderMarkdown } from "../../ui/app/src/lib/markdown.ts";
import { CODE_COPY_CLASS } from "../../ui/app/src/lib/copy-code.ts";

const read = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");

/**
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
describe("代码块的复制按钮", () => {
	it("生成的 HTML 里有复制按钮，类名来自同一个常量", () => {
		const html = renderMarkdown("```ts\nconst a = 1;\n```");
		expect(html).toContain(`class="${CODE_COPY_CLASS}"`);
		expect(html).toContain('data-copy="code"');
		expect(html).toContain("const a = 1;");
	});

	it("启动时装上了全局委托", () => {
		expect(read("../../ui/app/src/main.tsx")).toContain("installCodeCopy()");
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
		expect(overlays).toContain("aria-checked={props.theme === item.value}");
		expect(overlays).not.toContain("aria-pressed");
	});
});

/**
 * 类名写进 JSX 却没写进 CSS —— 页面上就是一堆没样式的 div。
 *
 * 空频道真出过这个事故：`Stream.tsx` 用的是 `ch-empty*`，而 `stream.css` 里
 * 只有旧版的 `.empty`，于是「这个频道还没有消息」挤在左上角，像加载失败。
 * 这条测试拿 JSX 里出现的类名去 CSS 里对，缺一个就红。
 */
describe("空频道的样式真的存在", () => {
	const css = read("../../ui/app/src/styles/stream.css").replace(/\/\*[\s\S]*?\*\//g, "");

	it("Stream.tsx 用到的每个 ch-empty 类都在 CSS 里", () => {
		const source = read("../../ui/app/src/stream/Stream.tsx");
		const used = new Set([...source.matchAll(/className="(ch-empty[\w-]*)"/g)].map((match) => match[1]));
		expect(used.size).toBeGreaterThan(0);
		for (const name of used) expect(css).toContain(`.${name}`);
	});
});

/**
 * 菜单的定位：`position: fixed` 不写 `top`/`left` 时按「静态位置」摆，
 * 而菜单在 DOM 里排在页面最后 —— 整张会掉到视口外面（＋ 菜单真掉过）。
 * 所以菜单必须是绝对定位、挂在触发它的 `.menu-anchor` 上；输入卡贴着屏幕底边，
 * ＋ 菜单只能往上开。
 */
describe("菜单贴着按钮长", () => {
	const css = read("../../ui/app/src/styles/shell.css").replace(/\/\*[\s\S]*?\*\//g, "");
	const rule = (selector: string): string => {
		const at = css.indexOf(`\n${selector} {`);
		expect(at).toBeGreaterThan(-1);
		return css.slice(at, css.indexOf("}", at));
	};

	it(".menu 是 absolute，不是 fixed", () => {
		expect(rule(".menu")).toContain("position: absolute");
		expect(rule(".menu")).not.toContain("position: fixed");
	});

	it("＋ 菜单往上开（bottom 100% + 8）", () => {
		expect(rule("#plus-menu")).toContain("bottom: calc(100% + 8px)");
	});

	it("「找你」清单挂在顶栏按钮的锚点里，不是一个裸浮层", () => {
		expect(read("../../ui/app/src/panels/Overlays.tsx")).toContain("export function NeedMenu");
		expect(read("../../ui/app/src/App.tsx")).toContain("<NeedMenu />");
	});
});

/**
 * 频道 SSE 只认 create（新消息落库），外加 error 用来标断线。
 *
 * 删掉假流式（`token` / `done`）与「正在说」草稿（`draft`）之后，服务端只推两类事件。
 * 这条测试静态扫 `hooks/useStreams.ts`：留着监听器会让人以为正文是流式写的，
 * 于是去优化一个不存在的问题。
 */
describe("频道 EventSource 的事件", () => {
	const source = read("../../ui/app/src/hooks/useStreams.ts");

	it("只注册 create / error", () => {
		const events = [...source.matchAll(/addEventListener\("([a-z]+)"/g)].map((match) => match[1]);
		expect(events).toContain("create");
		expect(events).toContain("error");
		for (const gone of ["token", "done", "draft"]) {
			expect(events).not.toContain(gone);
		}
	});

	it("没有残留的 delta / 假流式拼接", () => {
		expect(source).not.toContain("payload.delta");
		expect(source).not.toMatch(/createTextNode\(/);
	});
});

/**
 * `@某人` 要有颜色：派活的消息里常常一句里@好几个人，不点亮就要逐字找。
 * 只认行首或空白之后的 `@`，否则邮箱会被误伤；代码里的 `@` 不点亮（它已经进了占位符）。
 */
describe("@ 人的高亮", () => {
	const css = read("../../ui/app/src/styles/stream.css").replace(/\/\*[\s\S]*?\*\//g, "");

	it("行内 @ 名字包成 md-at", () => {
		expect(renderMarkdown("@林越 开干")).toContain('<span class="md-at">@林越</span>');
		expect(renderMarkdown("叫一下 @沈舟，别等")).toContain('<span class="md-at">@沈舟</span>');
		expect(renderMarkdown("直接叫@林越，开干")).toContain('<span class="md-at">@林越</span>');
	});

	it("邮箱与行内代码不点亮", () => {
		expect(renderMarkdown("a@b.com")).not.toContain("md-at");
		expect(renderMarkdown("`@林越`")).not.toContain("md-at");
	});

	it("CSS 里有 md-at 的样式", () => {
		expect(css).toContain(".md .md-at");
	});
});
