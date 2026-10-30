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
import { installJankMonitor } from "./lib/jank.ts";
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
void bootstrap();
