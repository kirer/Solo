/**
 * 布局约定：node 里没有布局引擎，所以读 CSS / 组件源码断言「这条规则还在」。
 *
 * 四个方向合在一个文件里，因为它们是同一种测试、同一套读法：输入框的居中轨道、
 * 右侧栏的三列、侧栏收起、消息正文的折行。每个 describe 开头的注释写着它是为了
 * 防哪一次回归 —— 断言的是「规则在不在、有没有被改回去」，像素留给手工验收。
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");
/** 注释里也写选择器（解释规则为什么这么写），先剥掉，免得被当成规则块的前导。 */
const strip = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, "");

const composerCss = strip(read("../../ui/app/src/styles/composer.css"));
const shellCss = strip(read("../../ui/app/src/styles/shell.css"));
const baseCss = strip(read("../../ui/app/src/styles/base.css"));
const streamCss = strip(read("../../ui/app/src/styles/stream.css"));
const tasksCss = strip(read("../../ui/app/src/styles/tasks.css"));
const appSource = read("../../ui/app/src/App.tsx");
const storeSource = read("../../ui/app/src/state/store.ts");
const sidebarSource = read("../../ui/app/src/sidebar/Sidebar.tsx");
const rightPanelSource = read("../../ui/app/src/panels/RightPanel.tsx");

/**
 * 取某个选择器的**所有**规则块（一个选择器可能在文件里出现多次，还可能在逗号组里）。
 * 断言时取「任意一块满足」的口径：只要有一条规则写了就算数。
 */
function blocksOf(css: string, selector: string): string[] {
	const out: string[] = [];
	for (const match of css.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
		const prelude = (match[1] ?? "").split(",").map((part) => part.trim());
		if (prelude.includes(selector)) out.push(match[2] ?? "");
	}
	if (out.length === 0) throw new Error(`没找到规则 ${selector}`);
	return out;
}

const anyBlock = (css: string, selector: string, needle: string) =>
	blocksOf(css, selector).some((rule) => rule.includes(needle));

describe("引用条与附件托盘的居中轨道", () => {
	it("两边都用 composer 的内边距变量，宽度公式同源", () => {
		expect(blocksOf(composerCss, ":root").join("\n")).toContain("--composer-pad: 16px");
		// 引用条：clamp 的百分比按 composer 内容宽算，并让出卡片那 32px
		const reply = blocksOf(composerCss, ".reply").join("\n");
		expect(reply).toContain("width: 100%");
		expect(reply).toContain("var(--composer-pad, 16px)");
		expect(reply).toContain("32px");
		// 托盘同理
		const tray = blocksOf(composerCss, ".attach-tray").join("\n");
		expect(tray).toContain("width: 100%");
		expect(tray).toContain("margin: 0 auto");
	});

	it("手机（<=640px）把同一份内边距改成 12", () => {
		const mobile = /@media \(max-width: 640px\) \{([\s\S]*)\n\}/.exec(composerCss)?.[1] ?? "";
		expect(mobile).toContain("--composer-pad: 12px");
		expect(mobile).toContain("padding: 0 var(--composer-pad) 12px");
	});
});

describe("右侧栏", () => {
	it("是四列布局（导航 + 侧栏 + 纸 + 右栏），第三列宽度来自 --rightbar", () => {
		expect(blocksOf(shellCss, ".frame").join("\n")).toContain(
			"grid-template-columns: var(--rail) var(--sidebar) minmax(0, 1fr) var(--rightbar)",
		);
		expect(blocksOf(shellCss, '.frame[data-right="open"]').join("\n")).toContain("--rightbar: 360px");
	});

	it("--rightbar 有一个 0 的定义（否则整条声明作废）", () => {
		expect(baseCss).toContain("--rightbar: 0px");
	});

	it("右栏落在第四列（第一列是导航），不是 fixed", () => {
		const rule = blocksOf(shellCss, ".detail").join("\n");
		expect(rule).toContain("grid-column: 4");
		expect(rule).not.toContain("position: fixed");
	});

	it("收起时 hidden 真的不占位", () => {
		expect(shellCss).toMatch(/\.detail\[hidden\],\s*\n\s*\.detail-body\[hidden\]\s*\{\s*\n\s*display: none;/);
	});

	it("动画：列 300ms，内容 240ms 且带 60ms 延迟", () => {
		expect(blocksOf(shellCss, ".frame").join("\n")).toContain("transition: grid-template-columns 300ms");
		const content = blocksOf(shellCss, ".detail-panel > .detail-body").join("\n");
		expect(content).toContain("animation: detail-in 240ms");
		expect(content).toContain("60ms both");
	});

	it("关闭要等滑完再 hidden（否则动画被剪掉）", () => {
		// `.frame[data-right]` 由 App.tsx 渲染；关的时候先让列宽过渡跑完，再真正卸载内容。
		expect(appSource).toContain('data-right={right.open ? "open" : "closed"}');
		expect(rightPanelSource).toContain("window.setTimeout(() => setMounted(false), 300)");
	});
});

describe("侧栏收起", () => {
	it("收起宽度 56，由 data-side 驱动", () => {
		expect(blocksOf(shellCss, '.frame[data-side="rail"]').join("\n")).toContain("--sidebar: 56px");
	});

	it("展开时宽度来自 --sidebar，且换了列宽有过渡", () => {
		const frame = blocksOf(shellCss, ".frame").join("\n");
		expect(frame).toContain("var(--sidebar) minmax(0, 1fr)");
		expect(frame).toContain("transition: grid-template-columns");
	});

	it("收起后藏起名字、预览与时间", () => {
		for (const part of [".ch-main", ".ch-time", ".brand-name"]) {
			expect(blocksOf(shellCss, '.frame[data-side="rail"] ' + part).join("\n")).toContain("display: none");
		}
	});

	it("收起后每行是 36×36 的方块，未读退化成点", () => {
		expect(blocksOf(shellCss, '.frame[data-side="rail"] .ch').join("\n")).toContain("width: 36px");
		const badge = blocksOf(shellCss, '.frame[data-side="rail"] .ch-badge').join("\n");
		expect(badge).toContain("font-size: 0");
		expect(badge).toContain("border-radius: 50%");
	});

	it("手机上不提供收起", () => {
		expect(shellCss).toMatch(/@media \(max-width: 640px\)[\s\S]*?\.side-toggle\s*\{\s*display: none;/);
	});

	it("状态存在本地，刷新后保持", () => {
		expect(storeSource).toContain('const SIDE_KEY = "solo.side"');
		expect(storeSource).toContain("localStorage.setItem(SIDE_KEY, side)");
		// `.frame[data-side]` 是这套布局唯一的开关（JS 不碰列宽）。
		expect(appSource).toContain("data-side={side}");
		// 收起后名字看不见，必须写进 title，否则那一栏就只剩一堆脸。
		expect(sidebarSource).toContain('title={parts.join(" · ")}');
	});
});

describe("消息正文换行", () => {
	it(".md 与链接、行内代码都能在任意位置断行", () => {
		expect(anyBlock(streamCss, ".md", "overflow-wrap: anywhere")).toBe(true);
		for (const selector of [".md a", ".md code"]) {
			expect(anyBlock(streamCss, selector, "overflow-wrap: anywhere")).toBe(true);
			expect(anyBlock(streamCss, selector, "word-break: break-word")).toBe(true);
		}
	});

	it("两处 pre 都是 pre-wrap，且都不留横向滚动条", () => {
		for (const selector of [".md pre", ".md-code pre"]) {
			expect(anyBlock(streamCss, selector, "white-space: pre-wrap")).toBe(true);
			// 任何一条关于它的规则都不许再写回横向滚动
			for (const rule of blocksOf(streamCss, selector)) {
				expect(rule).not.toContain("overflow-x: auto");
				expect(rule).not.toMatch(/overflow:\s*auto/);
			}
		}
	});
});

describe("最左导航与后台任务（第二屏）", () => {
	it("两屏共用一列导航：data-view 由 tasks.open 驱动", () => {
		expect(appSource).toContain('data-view={tasksOpen ? "tasks" : "chat"}');
		expect(appSource).toContain("<Rail />");
	});

	it("导航五格：聊天 / 通讯录 / 后台任务 / 插件，设置单独压在最底", () => {
		const rail = read("../../ui/app/src/sidebar/Rail.tsx");
		for (const id of ["rail-chat", "team-btn", "rail-tasks", "plugins-btn", "settings-btn"]) {
			expect(rail).toContain(`id="${id}"`);
		}
		expect(rail.match(/className="rail-item"/g)?.length).toBe(5);
		// 顺序写死：聊天 → 通讯录（团队）→ 后台任务 → 插件；设置不在这一段里。
		const order = ["rail-chat", "team-btn", "rail-tasks", "plugins-btn"].map((id) => rail.indexOf(`id="${id}"`));
		expect(order).toEqual([...order].sort((left, right) => left - right));
		// 贴底的那一段只有设置。
		const foot = rail.slice(rail.indexOf('className="rail-group rail-foot"'));
		expect(foot).toContain('id="settings-btn"');
		expect(foot).not.toContain('id="plugins-btn"');
		expect(foot).not.toContain('id="rail-tasks"');
		expect(blocksOf(shellCss, ".rail-foot").join("\n")).toContain("margin-top: auto");
		// 只有图标，名字靠悬停提示：五格各有一条 data-tip，顺序和图标一致。
		expect(rail).toContain('data-tip="聊天"');
		expect(rail).toContain('data-tip="通讯录"');
		expect(rail).toContain('data-tip="任务"');
		expect(rail).toContain('data-tip="插件"');
		expect(rail).toContain('data-tip="设置"');
		expect(blocksOf(shellCss, ".rail-item::after").join("\n")).toContain("attr(data-tip)");
	});

	it("侧栏脚下不再有团队 / 插件 / 设置三行", () => {
		const sidebar = read("../../ui/app/src/sidebar/Sidebar.tsx");
		expect(sidebar).not.toContain('id="team-btn"');
		expect(sidebar).not.toContain('id="plugins-btn"');
		expect(sidebar).not.toContain('id="settings-btn"');
		expect(sidebar).not.toContain("side-action");
	});

	it("后台任务那一屏占掉侧栏 + 纸 + 右栏，不和聊天并存", () => {
		expect(blocksOf(shellCss, '.frame[data-view="tasks"]').join("\n")).toContain(
			"grid-template-columns: var(--rail) minmax(0, 1fr)",
		);
		for (const part of [".sidebar", ".sheet", ".detail"]) {
			expect(blocksOf(shellCss, '.frame[data-view="tasks"] ' + part).join("\n")).toContain("display: none");
		}
	});

	it("手机上是底部一条：导航不再隐藏，第二屏仍有自己的返回键", () => {
		// 管理三格搬进导航之后，藏起来就没处点 —— 手机上改成一条横的底栏。
		const phone = shellCss.slice(shellCss.indexOf("@media (max-width: 640px)"));
		expect(phone).toMatch(/\.rail \{[\s\S]*?position: fixed;[\s\S]*?flex-direction: row;/);
		expect(phone).toContain("padding-bottom: calc(56px + env(safe-area-inset-bottom))");
		expect(shellCss).not.toMatch(/\.frame \.rail \{\s*display: none;/);
		expect(tasksCss).toContain(".tasks-back");
	});
});
