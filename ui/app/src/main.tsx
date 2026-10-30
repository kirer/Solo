/**
 * 入口。**只做装配**：把样式装进来、把数据拉起来、把 `<App>` 挂上去。
 *
 * 首帧的主题由 `index.html` 里的内联脚本先定（否则会闪一下白），
 * 这里只负责之后跟着 store 变。
 */

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import { bootstrap } from "./state/store.ts";
import { fetchLastRuntimeReport } from "./api/client.ts";
import { installJankMonitor } from "./lib/jank.ts";
import { installCodeCopy } from "./lib/copy-code.ts";
import "./styles/index.css";

const host = document.getElementById("root");
if (host === null) throw new Error("找不到 #root");

createRoot(host).render(
	<StrictMode>
		<App />
	</StrictMode>,
);

// 卡顿自报要在第一次渲染之前装好，否则首屏那段最长的工作恰好没被观察到。
installJankMonitor();
// 代码块的「复制」按钮是 `dangerouslySetInnerHTML` 注入的，只能全局委托一次。
installCodeCopy();
void bootstrap();

// 底座上一轮留下的「不正常」报告（任务抛异常 / 重启超限被挂起 / storage 让会话关掉）。
// 以前这些事在界面上一个字都没有，表现只是「这个人忽然不说话了」；现在至少控制台里有
// 一句人话（全文在 `workspace/logs/runtime.jsonl`）。
void fetchLastRuntimeReport().then((report) => {
	if (report !== undefined) console.warn(`[core] 最近一条运行报告（${report.at}）：${report.text}`);
});
