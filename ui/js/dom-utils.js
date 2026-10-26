/* 「无业务语义」的 DOM / 文本小工具。
 *
 * T-22 提取渲染函数时发现：`chat.js` 与 `feed-render.js` 都需要这几个函数，
 * 若让两者互相 import 会形成 ESM 循环依赖（实测会抛 TDZ:
 * `ReferenceError: Cannot access ... before initialization`）。
 * 所以抽到这个无依赖的叶子模块，两边各取所需，依赖图保持无环。
 *
 * 内容**逐字取自** chat.js（搬前 :55/:78/:91/:120），未改写。 */

import { escapeHtml, parseJsonish } from "./format.js";

const plainText = (value) => escapeHtml(String(value ?? "")).replace(/\n/g, "<br>");

const copyButtonHtml = (label) =>
	`<button class="copy-btn" type="button" data-copy="pane" aria-label="${label}" title="${label}"><span>复制</span></button>`;

function prettyArgs(raw) {
	const parsed = parseJsonish(raw);
	if (parsed !== undefined) {
		try {
			return JSON.stringify(parsed, null, 2);
		} catch {
			/* 不可序列化时退回原文 */
		}
	}
	return String(raw ?? "");
}

function elFromHtml(html) {
	const template = document.createElement("template");
	template.innerHTML = html.trim();
	return template.content.firstElementChild;
}

export { plainText, copyButtonHtml, prettyArgs, elFromHtml };
