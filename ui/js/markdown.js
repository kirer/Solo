/** Markdown 渲染（占位，由 chat-dev 替换为完整安全实现）。 */
import { escapeHtml } from "./format.js";
export function renderMarkdown(text) {
	return `<p>${escapeHtml(text).replace(/\n/g, "<br>")}</p>`;
}
