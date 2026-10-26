/* 工具调用 / 思考过程的渲染。
 *
 * T-22：从 `chat.js` 的 initChat 闭包里**纯搬家**出来（不重构、不改行为），
 * 目的有二：① 让私聊的「工作记录」区和组织页聊天复用同一套渲染；
 * ② 为 UX-7 的 activity 数据接入做准备。
 *
 * 已核实这两个 render 是**纯函数**：只依赖传入的 item，不读任何闭包状态
 * （对比 `renderAssistant` 要读闭包 `feed`，因此它**没被搬**，仍留在 chat.js）。
 *
 * 内容逐字取自 chat.js（搬前 :942/:956/:984），仅去掉闭包的一层 tab 缩进。 */

import { escapeAttr, escapeHtml, toolMeta } from "./format.js";
import { icon } from "./icons.js";
import { copyButtonHtml, elFromHtml, plainText, prettyArgs } from "./dom-utils.js";

function argsSummary(item) {
	const meta = toolMeta(item.name, item.args);
	if (meta.detail !== "") return meta.detail;
	const raw = prettyArgs(item.args).replace(/\s+/g, " ").trim();
	return raw.slice(0, 120);
}

function toolStateOf(item) {
	if (item.state === "running") return "running";
	if (item.state === "error") return "error";
	if (item.state === "interrupted") return "interrupted";
	return "ok";
}

const stateTextOf = (state) =>
	state === "running" ? "运行中" : state === "error" ? "失败" : state === "interrupted" ? "已中断" : "完成";

function renderThinking(item) {
	const live = item.live === true;
	return elFromHtml(`
		<details class="think"${live ? ' data-live="true"' : ""}>
			<summary>
				${icon("brain", 13)}
				<span class="think-kicker">${live ? "正在思考" : "思考"}</span>
				<span class="think-meta">· ${item.text.length} 字</span>
				<span class="think-chev">${icon("chevronDown", 12)}</span>
			</summary>
			<div class="think-body">${plainText(item.text)}</div>
		</details>`);
}

function renderTool(item) {
	const meta = toolMeta(item.name, item.args);
	const state = toolStateOf(item);
	const detail = argsSummary(item);
	const el = elFromHtml(`
		<details class="tool" data-state="${state}">
			<summary>
				<span class="tool-icon">${icon(meta.icon, 13)}</span>
				<span class="tool-label">${escapeHtml(meta.label)}</span>
				<span class="tool-detail mono" title="${escapeAttr(detail)}">${escapeHtml(detail)}</span>
				<span class="tool-state" data-state="${state}">${stateTextOf(state)}</span>
				<span class="tool-chev">${icon("chevronDown", 12)}</span>
			</summary>
			<div class="tool-body">
				<div class="tool-pane" data-pane="args">
					<div class="pane-head"><span class="pane-k">参数</span>${copyButtonHtml("复制参数")}</div>
					<pre class="mono"></pre>
				</div>
				<div class="tool-pane" data-pane="output">
					<div class="pane-head"><span class="pane-k">输出</span>${copyButtonHtml("复制输出")}</div>
					<pre class="mono"></pre>
				</div>
			</div>
		</details>`);
	fillToolPanes(el, item);
	return el;
}

function fillToolPanes(el, item) {
	const state = toolStateOf(item);
	const args = prettyArgs(item.args);
	const output = String(item.output ?? "");
	const argsPre = el.querySelector('[data-pane="args"] pre');
	const outputPre = el.querySelector('[data-pane="output"] pre');
	argsPre.textContent = args === "" ? "（无参数）" : args;
	argsPre.classList.toggle("is-empty", args === "");
	const placeholder = state === "running" ? "等待输出…" : "（没有输出）";
	outputPre.textContent = output === "" || output === undefined ? placeholder : output;
	outputPre.classList.toggle("is-empty", output === "" || output === undefined);
}

// `fillToolPanes` / `argsSummary` / `toolStateOf` / `stateTextOf` 同时被 chat.js 的
// patchTool()（增量更新已存在 DOM 的工具行）使用，因此一并导出，供 chat.js import。
// 这不是「为搬干净而制造循环依赖」——chat.js 只单向 import 本模块，本模块不 import chat.js。
export { renderThinking, renderTool, fillToolPanes, argsSummary, toolStateOf, stateTextOf };
