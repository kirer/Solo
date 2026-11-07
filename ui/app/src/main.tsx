/**
 * 入口。**只做装配**：把样式装进来、把数据拉起来、把 `<App>` 挂上去。
 *
 * 首帧的主题由 `index.html` 里的内联脚本先定（否则会闪一下白），
 * 这里只负责之后跟着 store 变。
 */

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import { bootstrap, openBrowser, openDock } from "./state/store.ts";
import { installLinkBrowser } from "./lib/links.ts";
import { fetchLastRuntimeReport } from "./api/client.ts";
import { installJankMonitor } from "./lib/jank.ts";
import { installCodeCopy } from "./lib/copy-code.ts";
import { bootPlugins, cellsOf } from "./plugin/registry.ts";
import "./styles/index.css";

const host = document.getElementById("root");
if (host === null) throw new Error("找不到 #root");

// 桌面壳（`desktop/src/main.ts`）用 `?shell=desktop&platform=…` 加载本页：标题栏藏进界面里，
// macOS 的红绿灯落在侧栏左上角，Windows 则画一条标题带；那几行留白与拖拽把手只在壳里要有
// （浏览器里不要）。平台写进 `data-os`，CSS 和 `App.tsx` 都只看这一个标记。
{
	const params = new URLSearchParams(location.search);
	if (params.get("shell") === "desktop") {
		document.documentElement.dataset["shell"] = "desktop";
		const platform = params.get("platform");
		if (platform !== null) document.documentElement.dataset["os"] = platform;
		// 首帧就把系统窗口按钮的颜色对到界面主题上，别等 React 挂完才变。
		if (platform === "win32") {
			window.soloDesktop?.setTheme(document.documentElement.dataset["theme"] === "dark" ? "dark" : "light");
		}
	}
}

// 卡顿自报要在第一次渲染之前装好，否则首屏那段最长的工作恰好没被观察到。
installJankMonitor();
// 代码块的「复制」按钮是 `dangerouslySetInnerHTML` 注入的，只能全局委托一次。
installCodeCopy();
// 正文里的外链同理：全局委托一次，普通左键在 Solo 里开（⌘/Ctrl 点照旧交给系统）。
installLinkBrowser((url) => {
	openBrowser(url);
	const cell = cellsOf("dock")[0];
	if (cell !== undefined && cell.plugin !== undefined) openDock(cell.plugin);
});
void bootstrap();

// 插件先装、组件后挂：插槽在首帧就是满的，不会「先空一下再长出来」。
// `finally` 不是 `then`：插件拉不到或某个插件炸了，界面照常出来。
void bootPlugins().finally(() => {
	createRoot(host).render(
		<StrictMode>
			<App />
		</StrictMode>,
	);
});

// 底座上一轮留下的「不正常」报告（任务抛异常 / 重启超限被挂起 / storage 让会话关掉）。
// 以前这些事在界面上一个字都没有，表现只是「这个人忽然不说话了」；现在至少控制台里有
// 一句人话（全文在 `<appRoot>/logs/runtime.jsonl`）。
void fetchLastRuntimeReport().then((report) => {
	if (report !== undefined) console.warn(`[core] 最近一条运行报告（${report.at}）：${report.text}`);
});
