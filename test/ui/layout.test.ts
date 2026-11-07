/**
 * 布局约定：node 里没有布局引擎，所以读 CSS / 组件源码断言「这条规则还在」。
 *
 * 四个方向合在一个文件里，因为它们是同一种测试、同一套读法：输入框的居中轨道、
 * 一列到底的骨架、整屏页、消息正文的折行。每个 describe 开头的注释写着它是为了
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
const settingsSource = read("../../ui/app/src/panels/SettingsPage.tsx");
const pluginsSource = read("../../ui/app/src/panels/PluginsPage.tsx");

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

describe("一列到底的骨架（手机稿，桌面上也照这个来）", () => {
	it("框只有一列，内容最宽 860 居中", () => {
		expect(blocksOf(shellCss, ".frame").join("\n")).toContain("grid-template-columns: minmax(0, 1fr)");
		// 最左那一列导航整组删掉了，别让它长回来。
		expect(shellCss).not.toContain("--rail");
		expect(appSource).not.toContain("<Rail");
		expect(appSource).not.toContain("data-right");
		for (const selector of [".sidebar", ".sheet", ".page", ".detail-panel"]) {
			const blocks = blocksOf(shellCss, selector).join("\n");
			expect(blocks).toContain("max-width: 860px");
			expect(blocks).toContain("margin: 0 auto");
		}
	});

	it("列表与对话叠在同一格，靠 body[data-pane] 互斥", () => {
		const stacked = shellCss.slice(shellCss.indexOf(".sidebar,\n.sheet {"), shellCss.indexOf("body[data-pane"));
		expect(stacked).toContain("grid-column: 1");
		expect(stacked).toContain("grid-row: 1");
		expect(shellCss).toMatch(/body\[data-pane="list"\] \.sheet \{\s*\n\s*display: none;/);
		expect(shellCss).toMatch(/body\[data-pane="chat"\] \.sidebar \{\s*\n\s*display: none;/);
		expect(appSource).toContain('document.body.dataset["pane"] = detail === null ? "list" : "chat"');
	});

	it("资料 / 后台任务是一整屏，不占列、不挤压", () => {
		expect(shellCss).toMatch(/\.detail \{[^}]*position: fixed;[^}]*inset: 0;[^}]*z-index: 60;/);
		expect(blocksOf(shellCss, ".detail").join("\n")).not.toContain("grid-column");
	});

	it("首屏是和助理的对话；没有助理才停在列表", () => {
		expect(storeSource).toContain("person.assistant === true");
		expect(storeSource).toContain("await openChannel(dm.id)");
	});
});

describe("顶栏的门", () => {
	it("助理那屏没有返回，门是「对话 / 设置」", () => {
		expect(appSource).toContain("assistantChat");
		expect(appSource).toContain('id="list-btn"');
		expect(appSource).toContain('id="sheet-settings"');
	});

	it("别的对话：返回列表 + 资料与后台任务", () => {
		expect(appSource).toContain('id="back"');
		expect(appSource).toContain('id="detail-btn"');
		expect(appSource).toContain("openChannel(null)");
	});

	it("对话抬头三格：名字真居中；助理那屏没有状态行", () => {
		expect(blocksOf(shellCss, ".sheet-head").join("\n")).toContain(
			"grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr)",
		);
		expect(blocksOf(shellCss, ".sheet-head-main").join("\n")).toContain("text-align: center");
		expect(appSource).toContain('sub === "" || assistantChat');
	});

	it("列表这一屏能回到助理，标题就叫对话", () => {
		expect(sidebarSource).toContain('id="list-back"');
		expect(sidebarSource).toContain("对话");
		expect(sidebarSource).toContain('id="new-group"');
	});

	it("列表脚下不再有团队 / 插件 / 设置三行", () => {
		expect(sidebarSource).not.toContain('id="team-btn"');
		expect(sidebarSource).not.toContain('id="plugins-btn"');
		expect(sidebarSource).not.toContain('id="settings-btn"');
		expect(sidebarSource).not.toContain("side-action");
	});
});

describe("整屏页：桌面上是弹窗，窄窗口里铺满", () => {
	it("设置与插件都是盖在聊天上的一张弹窗", () => {
		for (const source of [pluginsSource, settingsSource]) {
			expect(source).toContain('className="overlay"');
			expect(source).toContain('role="dialog"');
			expect(source).toContain('aria-modal="true"');
			expect(source).toContain('className="modal-head"');
			expect(source).toContain('className="modal-title"');
		}
		expect(pluginsSource).toContain('className="modal modal-wide"');
		expect(settingsSource).toContain('className="modal"');
		expect(pluginsSource).toContain('id="plugins-back"');
		expect(appSource).toContain("<PluginsPage");
		expect(appSource).toContain("<SettingsPage");
	});

	it("插件页的「+」在标题右边，装的是文件夹", () => {
		const head = pluginsSource.slice(pluginsSource.indexOf('className="modal-head"'), pluginsSource.indexOf('className="modal-body"'));
		expect(head).toContain("pl-add");
		expect(head).toContain("webkitdirectory");
		expect(pluginsSource).not.toContain("page-side-foot");
	});

	it("插件那一页不另浮一颗返回：出口就在插件自己画的标题栏里", () => {
		expect(appSource).toContain('<Slot name="app.page" />');
		expect(appSource).not.toContain('id="plugin-exit"');
		expect(shellCss).not.toContain(".page-exit");
	});

	it("后台任务是右栏的一态，不是另一屏", () => {
		expect(appSource).not.toContain("<TasksPanel");
		expect(rightPanelSource).toContain("<TasksView");
		expect(rightPanelSource).toContain('data-tasks={tasksOpen ? "true" : "false"}');
		expect(tasksCss).toContain(".tasks-row");
		expect(tasksCss).not.toContain(".tasks-list-head");
	});
});

describe("后台任务的一步：时刻 / 圆点 / 正文对齐", () => {
	it("圆点与正文同一基线，行高只写一处", () => {
		expect(blocksOf(tasksCss, ".task-step").join("\n")).toContain("align-items: start");
		expect(blocksOf(tasksCss, ".task-step-title").join("\n")).toContain("line-height: 22px");
		expect(blocksOf(tasksCss, ".task-step-line").join("\n")).toContain("min-height: 22px");
	});

	it("展开的步骤就在那一行里，不是另起一张卡", () => {
		expect(tasksCss).toContain(".tasks-open");
		expect(tasksCss).not.toContain(".tasks-two");
		expect(tasksCss).not.toContain(".tasks-list");
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

describe("手机与桌面是同一份摆法", () => {
	it("全面屏还是让出刘海与手势条", () => {
		expect(shellCss).toContain("env(safe-area-inset-top)");
		expect(shellCss).toContain("env(safe-area-inset-bottom)");
		expect(blocksOf(baseCss, ":root").join("\n")).toContain("--sidebar");
	});

	it("设置只在助理那屏：列表头没有设置按钮，多一个搜索框", () => {
		expect(appSource).toContain('id="sheet-settings"');
		expect(sidebarSource).not.toContain('id="side-settings"');
		expect(sidebarSource).toContain('id="chat-search"');
		expect(sidebarSource).toContain("搜索对话");
	});

	it("列表一行一条细线，标题栏下面不画线", () => {
		expect(blocksOf(shellCss, ".ch + .ch::before").join("\n")).toContain("height: 0.5px");
		for (const selector of [".sheet-head", ".nav", ".detail-bar"]) {
			expect(blocksOf(shellCss, selector).join("\n")).not.toContain("border-bottom");
		}
	});

	it("引用条再长也撑不宽整张纸：纸的隐式列钉死在可用宽度", () => {
		// 实测事故：引用一条长消息后，nowrap 的引文把 .sheet 的隐式列（auto = max-content）
		// 撑到 772px，手机上整屏消息被裁掉右半截。
		expect(blocksOf(shellCss, ".sheet").join("\n")).toContain("grid-template-columns: minmax(0, 1fr)");
		expect(blocksOf(composerCss, ".reply").join("\n")).toContain("min-width: 0");
	});

	it("换屏有动画：进来的那一屏都会浮进来", () => {
		const animated = blocksOf(shellCss, ".sidebar").join("\n");
		expect(animated).toContain("animation: page-in");
		expect(shellCss).toContain("@keyframes page-in");
		expect(shellCss).toContain(".detail-panel > .tasks");
	});
});
