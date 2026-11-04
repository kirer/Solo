/**
 * Windows 标题带：菜单动作、渲染位置、拖拽 / 让位那几条 CSS。
 *
 * 和 `layout.test.ts` 一样读源码断言 —— 标题带只在 Windows 桌面壳里出现，
 * 开发机是 macOS，跑不到那条分支；这里守的是「动作对得上主进程」「它真的跨整窗」
 * 「右栏和手机断点没有压到它」。
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { TITLEBAR_MENUS } from "../../ui/app/src/titlebar/menu.ts";

const read = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");
const strip = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, "");

function blocksOf(css: string, selector: string): string[] {
	const out: string[] = [];
	for (const match of css.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
		// 媒体查询里的第一条规则，prelude 前面带着 `@media … {`，剥掉它。
		const prelude = (match[1] ?? "")
			.split(",")
			.map((part) => part.trim().replace(/^@media[^{]*\{\s*/, ""));
		if (prelude.includes(selector)) out.push(match[2] ?? "");
	}
	if (out.length === 0) throw new Error(`没找到规则 ${selector}`);
	return out;
}

describe("Windows 标题带的菜单", () => {
	it("和原生菜单是同一套字：Solo / 视图", () => {
		expect(TITLEBAR_MENUS.map((menu) => menu.label)).toEqual(["Solo", "视图"]);
	});

	it("每个动作主进程都认得", () => {
		const main = read("../../desktop/src/main.ts");
		for (const menu of TITLEBAR_MENUS) {
			for (const item of menu.items) {
				if ("action" in item) expect(main).toContain(`case "${item.action}"`);
			}
		}
	});

	it("原生菜单栏隐藏了，但菜单对象还在（加速键靠它）", () => {
		const main = read("../../desktop/src/main.ts");
		expect(main).toContain("win.setMenuBarVisibility(false)");
		expect(main).toContain("installMenu(");
		expect(main).toContain("preload.cjs");
	});

	it("平台写进 data-os，标题带只在 Windows 桌面壳里画", () => {
		expect(read("../../ui/app/src/main.tsx")).toContain('document.documentElement.dataset["os"] = platform');
		const app = read("../../ui/app/src/App.tsx");
		expect(app).toContain('document.documentElement.dataset["os"] === "win32"');
		// 首屏与正常界面都画（启动时也要能拖窗口）。
		expect(app.match(/<Titlebar \/>/g)).toHaveLength(2);
	});

	it("preload 只开菜单与取色两个口", () => {
		const preload = read("../../desktop/src/preload.cts");
		expect(preload).toContain('exposeInMainWorld("soloDesktop"');
		expect(preload).toContain("solo:menu");
		expect(preload).toContain("solo:theme");
	});
});

describe("Windows 标题带的布局", () => {
	const css = strip(read("../../ui/app/src/styles/shell.css"));
	const win = (selector: string) => `html[data-shell="desktop"][data-os="win32"] ${selector}`;

	it("占整窗第一行，40px，并且是拖拽把手", () => {
		expect(blocksOf(css, win(".frame")).join("\n")).toContain(
			"grid-template-rows: var(--titlebar-h) minmax(0, 1fr)",
		);
		const titlebar = blocksOf(css, win(".titlebar")).join("\n");
		expect(titlebar).toContain("grid-column: 1 / -1");
		expect(titlebar).toContain("grid-row: 1");
		expect(titlebar).toContain("height: var(--titlebar-h)");
		expect(titlebar).toContain("-webkit-app-region: drag");
		// 右边让给系统的三个按钮。
		expect(titlebar).toContain("padding: 0 140px");
	});

	it("菜单按钮退出拖动，菜单从按钮左缘往下长", () => {
		expect(blocksOf(css, win(".titlebar-menu")).join("\n")).toContain("-webkit-app-region: no-drag");
		const pop = blocksOf(css, win(".titlebar-pop")).join("\n");
		expect(pop).toContain("left: 0");
		expect(pop).toContain("right: auto");
		expect(pop).toContain("transform-origin: top left");
	});

	it("右栏下移到第二行，手机断点的侧栏 / 纸也下移", () => {
		expect(blocksOf(css, win(".detail")).join("\n")).toContain("grid-row: 2");
		// 手机那条在 @media 里，`blocksOf` 的正则会把媒体查询的壳当成规则吃掉，直接对整段。
		expect(css).toMatch(
			/@media \(max-width: 640px\) \{\s*html\[data-shell="desktop"\]\[data-os="win32"\] \.sidebar,\s*html\[data-shell="desktop"\]\[data-os="win32"\] \.sheet \{\s*grid-row: 2;/,
		);
	});

	it("macOS 那组拖拽 / 让位规则只给 darwin，不漏到 Windows", () => {
		// 所有桌面壳选择器都必须带 data-os；否则 Windows 也会拿到红绿灯的 32px 顶部留白。
		expect(css).not.toMatch(/html\[data-shell="desktop"\](?!\[data-os=)/);
		expect(css).toContain('html[data-shell="desktop"][data-os="darwin"] .rail');
		expect(css).toContain('html[data-shell="desktop"][data-os="darwin"] .sheet-head');
	});

	it("Titlebar.tsx 用到的类名都在 CSS 里", () => {
		const source = read("../../ui/app/src/titlebar/Titlebar.tsx");
		const used = new Set(
			[...source.matchAll(/className="([^"]+)"/g)].flatMap((match) => (match[1] ?? "").split(/\s+/)),
		);
		for (const name of ["titlebar", "titlebar-menus", "titlebar-anchor", "titlebar-menu", "titlebar-pop", "menu-sep"]) {
			expect(used.has(name)).toBe(true);
			expect(css).toContain(`.${name}`);
		}
	});
});
