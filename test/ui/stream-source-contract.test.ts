/**
 * `Stream.tsx` 的源码契约（虚拟化重做 2026-11-11）。
 *
 * 这几条不是「有没有写对」，是**不许再长回去**：前三轮返工的死因全部集中在
 * 「四条 effect 里偷偷写 `scrollTop` / 偷偷挂 `rAF` 狂补」这一处。单测钉住源码文本，
 * 以后谁想加回来，测试先红。
 *
 * 用文本判而不是渲染判，是因为这里要挡的东西恰恰是「渲染看不出来的那一层」：
 * 多挂一个监听器、多一个长驻 rAF，界面照样是对的，直到用户滚起来才发现。
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("../../ui/app/src/stream/Stream.tsx", import.meta.url), "utf8");

/**
 * 去掉注释和字符串之后的源码。
 *
 * 这些约定要挡的是**代码**，不是说明文字：把「以前这儿是 `scrollTop += delta`」
 * 写在注释里是应该的（后来的⼈得知道为什么删），不能因此让测试变红。
 */
const code = source
	// 块注释
	.replace(/\/\*[\s\S]*?\*\//g, "")
	// 行注释（前面不是冒号，免得切到 `https://`）
	.replace(/(^|[^:])\/\/[^\n]*/g, "$1")
	// 模板字符串里的东西不算代码
	.replace(/`(?:[^`\\]|\\.)*`/g, "``");

describe("写 `scrollTop` 只许有一个口（设计 §1.4）", () => {
	it("`scrollTop` 的赋值只出现在仲裁者的 `write` 里", () => {
		const assignments = code.match(/\.scrollTop\s*(\+=|-=|=)(?!=)/g) ?? [];
		expect(assignments).toHaveLength(1);
		// 那一处必须在 `write: (top) => { flow.scrollTop = top; }` 里。
		expect(code).toMatch(/write:\s*\(top\)\s*=>\s*\{\s*flow\.scrollTop = top;/);
	});

	it("没有 `scrollTop +=` / `scrollTop -=` 这种就地加减（补偿必须走 setScrollTop 记账）", () => {
		expect(code).not.toMatch(/\.scrollTop\s*[+-]=/);
	});
});

describe("狂补引擎不许长回来（设计 §1.2）", () => {
	it("没有 `notFilled`（前三轮狂补的开关）", () => {
		expect(code).not.toContain("notFilled");
	});

	it("没有 `requestAnimationFrame(maybeLoad)` 这种「每帧自己补一页」的循环", () => {
		expect(code).not.toMatch(/requestAnimationFrame\(\s*maybeLoad\s*\)/);
	});

	it("`scroll` 事件里不再直接判「快贴顶了就补」", () => {
		// 补页入口只剩：① 一次动作结算（`settleOnce`）② 进频道填满（`fillOnEnter`）。
		expect(code).not.toMatch(/addEventListener\(\s*"scroll",\s*maybeLoad/);
	});
});

describe("新消息到达不许把位置拽走（验收第 26 条）", () => {
	it("`messages` 变化的那条 effect 里没有 `toBottom`", () => {
		// 抓 `useLayoutEffect(..., [messages, ...])` 这一段的作用域。
		const start = code.indexOf("}, [messages, compensate]);");
		expect(start).toBeGreaterThan(-1);
		const body = code.slice(code.lastIndexOf("useLayoutEffect(() => {", start), start);
		expect(body).not.toContain("toBottom");
		expect(body).toContain("compensate()");
	});
});

describe("进频道先到底、再后台补（Solo 2026-11-11 纠的顺序）", () => {
	it("`fillOnEnter` 出现在 `setScrollTop(flow.scrollHeight, \"enter\")` 之后", () => {
		const enter = code.indexOf('setScrollTop(flow.scrollHeight, "enter")');
		const fill = code.indexOf("void fillOnEnter()");
		expect(enter).toBeGreaterThan(-1);
		expect(fill).toBeGreaterThan(enter);
	});

	it("`fillOnEnter` 自己不许写 `scrollTop`（补回来的页只走锚点补偿）", () => {
		const start = code.indexOf("const fillOnEnter = useCallback(async () => {");
		const end = code.indexOf("}, [pageSize]);", start);
		const body = code.slice(start, end);
		expect(body).not.toContain("scrollTop");
	});
});

describe("占位行是真行，不是藏起来的行", () => {
	it("`.row-placeholder` 没有用 `visibility: hidden` / `opacity: 0` 藏起来", () => {
		const css = readFileSync(new URL("../../ui/app/src/styles/stream.css", import.meta.url), "utf8");
		const start = css.indexOf(".row-placeholder {");
		const end = css.indexOf("}", start);
		const block = css.slice(start, end);
		expect(start).toBeGreaterThan(-1);
		expect(block).not.toContain("visibility");
		expect(block).not.toContain("opacity");
		// 定高：跟 `heights.ts` 的 `PLACEHOLDER_HEIGHT` 一致，页回来换真行才不跳。
		expect(block).toContain("height: 76px");
	});
});
