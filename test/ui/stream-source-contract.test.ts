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
	it("`fillOnEnter` 出现在「到底那一次」之后", () => {
		// 到底那一次现在包在 `land()` 里（要等容器布局完），所以取它的**调用**而不是那行赋值。
		const enter = code.indexOf("\n\t\tland();");
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

describe("键盘：PageUp / PageDown / Home / End（验收第 15–18 条）", () => {
	const src = (): string => readFileSync(new URL("../../ui/app/src/stream/Stream.tsx", import.meta.url), "utf8");
	const body = (): string => {
		const text = src();
		const start = text.indexOf("const onKey = useCallback(");
		const end = text.indexOf("[setAtBottom, setScrollTop, wake],", start);
		expect(start).toBeGreaterThan(-1);
		return text.slice(start, end);
	};

	it("四个键都自己接管了，不吃默认行为就等于把「一步跳到 0」原样带回来", () => {
		const block = body();
		for (const key of ["PageUp", "PageDown", "Home", "End"]) expect(block).toContain(`case "${key}":`);
		expect(block).toContain("event.preventDefault()");
	});

	it("位移只走 `setScrollTop`，而且是 `user-return`（人在动）", () => {
		const block = body();
		expect(block).toContain('setScrollTop(clamped, "user-return")');
		// 不许在这里另开一条写 `scrollTop` 的路 —— 那等于把「只有一个入口」拆了。
		expect(block).not.toContain("scrollTop =");
		expect(block).not.toContain("scrollTo(");
	});

	it("监听挂在 `window` 上，不挂在 `.flow` 上", () => {
		// 真机实测：焦点在 `body`（`tgt: BODY`），`.flow` 没有 tabIndex、永远不是焦点，
		// 挂在它身上的 keydown 一次都收不到 —— 表现就是「键到了页面、scrollTop 恒 0」。
		const text = src();
		expect(text).toContain('window.addEventListener("keydown", onKeyWindow)');
		const mount = text.indexOf('window.addEventListener("keydown"');
		const block = text.slice(Math.max(0, mount - 600), mount);
		expect(block).toContain("onKey(event)");
		// 不许再有挂在 flow 上的 keydown（挂着也不报错，只是永远不响，最容易骗过人）。
		expect(text).not.toMatch(/flow\.addEventListener\("keydown"/);
	});

	it("不在输入框里抢键位", () => {
		expect(src()).toContain("isContentEditable");
		expect(src()).toMatch(/tag === "INPUT" \|\| tag === "TEXTAREA" \|\| tag === "SELECT"/);
	});

	it("键盘撞顶也报给 `push()`，跟滚轮同一条路（别另开一套）", () => {
		// 贴顶后按 PageUp：`clamped === flow.scrollTop`，位置没动 —— `sample()` 看不见，
		// 补页就不会发生。真机实测：贴顶后 PageUp 三下 + Home 两下，191 条、first 9619 一动不动，
		// 而同一个位置用滚轮撞是会补的（106→134→163→191），差别只在滚轮报了 `push()`。
		const block = body();
		expect(block).toContain("arbiter.current?.push(");
		// 只在「这次按键没让位置动」时才算撞，动了就是正常位移，交给结算看位移。
		expect(block).toContain("clamped === flow.scrollTop");
		// 方向和位移方向一致：PageUp/Home 是 up，PageDown/End 是 down。
		expect(block).toMatch(/direction\s*=\s*event\.key === "PageUp" \|\| event\.key === "Home" \? "up" : "down"/);
		// 一条路：不许再自己开一个补页调用。
		expect(block).not.toContain("loadEarlier(");
	});

	it("PageUp 的位移是按一屏算的，不是一整段", () => {
		const block = body();
		expect(block).toContain("flow.clientHeight");
		expect(block).toContain("DEFAULT_ROW_HEIGHT");
		// 一屏 = 视口减两行留白：上一次最上面那行还得看得见。
		expect(block).toContain("2 * DEFAULT_ROW_HEIGHT");
	});
});

/**
 * 首屏「一开始就在底部」（验收第 1、2 条）。
 *
 * 曾经的写法是 `setScrollTop(flow.scrollHeight, "enter")` —— 进频道那一刻 DOM 里还没有
 * 这一批行，`scrollHeight` 是上一次渲染的值，等于「先滚到错的地方再纠正」。Solo 已否掉，
 * 这条钉住它不许长回去。
 */
describe("进频道那一次到底，按模型算不按 scrollHeight", () => {
	const enter = (): string => {
		// 到底那一次包在 `land()` 里：先等容器有高度，再量真行高，最后才写。
		const start = code.indexOf('setScrollTop(Math.max(model, real), "enter")');
		expect(start).toBeGreaterThan(-1);
		return code.slice(Math.max(0, start - 700), start + 120);
	};

	it("进去那一次写的是模型算的底，不是 `scrollHeight`", () => {
		expect(code).not.toMatch(/setScrollTop\(\s*flow\.scrollHeight\s*,\s*"enter"/);
		expect(enter()).toContain("bottomOf(flow)");
	});

	it("容器还没布局时不许落笔（新挂的 `.flow-wrap` 第一次写会被夹回 0）", () => {
		// 实测：进频道那一刻 `.flow-wrap` 的 key 从 "none" 换成频道 id，容器是新挂的，
		// scrollHeight / clientHeight 都是 0 —— 这时候写 scrollTop 会被浏览器夹回 0，
		// 「到底」压根没发生。这条钉住「先等有高度，再写」。
		const body = enter();
		expect(body).toContain("flow.scrollHeight > 0");
		expect(body).toContain("flow.clientHeight > 0");
	});

	it("算底之前先量一次真行高（模型这时还是 76 的估值，真行只有 68）", () => {
		// 不先量：`bottomOf` 用估算行高算出来的底会停在半空 —— 实测 top=544 / max=1215。
		const body = enter();
		const measure = body.indexOf("measureRows()");
		const write = body.indexOf('setScrollTop(Math.max(model, real), "enter")');
		expect(measure).toBeGreaterThan(-1);
		expect(measure).toBeLessThan(write);
	});

	it("布局落地后以真容器为准，模型只兜底（模型少算 `solo-hero` 和行间距）", () => {
		// `.feed` 里除了消息行还有不归模型管的块：频道开头 `solo-hero` 164px + 40px 上边距，
		// 行与行之间 4px 外边距。`bottomOf` 只算「末行偏移 + 末行高」，这些全在模型外面 ——
		// 实测模型算 524，真实 max 1215，差 691px。布局已经是真的时候就没理由还按估算写。
		const body = enter();
		expect(body).toContain("flow.scrollHeight - flow.clientHeight");
		expect(body).toContain("Math.max(model, real)");
		expect(body).toContain("const model = bottomOf(flow)");
	});

	it("模型算总高用的是末行偏移 + 末行高（不是行的条数乘平均高）", () => {
		const start = code.indexOf("const bottomOf = useCallback(");
		expect(start).toBeGreaterThan(-1);
		const block = code.slice(start, start + 900);
		expect(block).toContain("offsetOf(layout.current, last.key)");
		expect(block).toContain("last.height");
		expect(block).toContain("flow.clientHeight");
	});
});
