/**
 * 安全 Markdown 渲染。
 *
 * 原则：模型文本先全部转义，再拼接受控 HTML；不解释原始 HTML，不引入依赖。
 * 支持：h1–h3、粗体 / 斜体 / 删除线、链接、行内代码、围栏代码（语言 + 复制）、
 * 有序 / 无序 / 嵌套列表、任务列表、表格（可横向滚）、引用、分割线。
 *
 * 只导出 renderMarkdown(text) -> string。
 */
import { escapeHtml, escapeAttr } from "./format.js";

/** 行内占位符：先抽走代码与链接，避免它们的内部符号被当成 Markdown。 */
const SLOT = "\u0000";

/* ── 行内 ───────────────────────────────────────────────────────────────── */

function safeUrl(raw) {
	const value = String(raw ?? "")
		.trim()
		// 控制符与空白不能在协议前出现，否则 javascript: 可以靠换行绕过
		.replace(/[\u0000-\u001f\u007f\s]+/g, "");
	if (value === "") return "";
	// 协议相对链接（//host）会跳到站外，直接拒绝；站内路径只允许单个斜杠
	if (value.startsWith("//")) return "";
	return /^(https?:\/\/|mailto:|\/|#|\.{1,2}\/)/i.test(value) ? value : "";
}

function emphasis(text) {
	return text
		.replace(/~~([^~\n]+?)~~/g, "<del>$1</del>")
		.replace(/\*\*([^*\n]+?)\*\*/g, "<strong>$1</strong>")
		.replace(/__([^_\n]+?)__/g, "<strong>$1</strong>")
		.replace(/(^|[^*])\*([^*\n]+?)\*(?!\*)/g, "$1<em>$2</em>")
		.replace(/(^|[\s(（，。、：；])_([^_\n]+?)_($|[\s)）,.，。、：；])/g, "$1<em>$2</em>$3");
}

/** 行内渲染：raw 是原始文本（未转义）。 */
function renderInline(raw) {
	const slots = [];
	let text = String(raw ?? "");

	// 1. 行内代码（代码里的一切都不再解释）
	text = text.replace(/`([^`\n]+)`/g, (_, code) => {
		slots.push(`<code>${escapeHtml(code)}</code>`);
		return `${SLOT}${slots.length - 1}${SLOT}`;
	});

	// 2. 链接：只允许安全协议，文本重新转义
	text = text.replace(/\[([^\]]*)\]\(([^)\s]+)\)/g, (whole, label, url) => {
		const href = safeUrl(url);
		if (href === "") {
			slots.push(escapeHtml(whole));
			return `${SLOT}${slots.length - 1}${SLOT}`;
		}
		slots.push(
			`<a href="${escapeAttr(href)}" target="_blank" rel="noopener noreferrer">${escapeHtml(label)}</a>`,
		);
		return `${SLOT}${slots.length - 1}${SLOT}`;
	});

	// 3. 其余先转义，再做强调
	let html = emphasis(escapeHtml(text));

	// 4. 还原占位符
	html = html.replace(new RegExp(`${SLOT}(\\d+)${SLOT}`, "g"), (_, index) => slots[Number(index)] ?? "");
	return html;
}

/** 纯文本行（保留换行）。 */
function escapeText(raw) {
	return escapeHtml(String(raw ?? "")).replace(/\n/g, "<br>");
}

/* ── 块级 ───────────────────────────────────────────────────────────────── */

function isFence(line) {
	return /^\s{0,3}```/.test(line);
}

function fenceInfo(line) {
	const match = /^\s{0,3}```([\w+#.-]*)\s*$/.exec(line);
	return match === null ? "" : match[1];
}

function isHeading(line) {
	return /^\s{0,3}#{1,3}\s+\S/.test(line);
}

function isHr(line) {
	return /^\s{0,3}(?:(?:-\s*){3,}|(?:\*\s*){3,}|(?:_\s*){3,})$/.test(line);
}

function isQuote(line) {
	return /^\s{0,3}>/.test(line);
}

function isListLine(line) {
	return /^\s*(?:[-*+]|\d{1,9}[.)])\s+\S/.test(line);
}

function indentOf(line) {
	const match = /^[ \t]*/.exec(line);
	const raw = match === null ? "" : match[0];
	let width = 0;
	for (const character of raw) width += character === "\t" ? 4 : 1;
	return width;
}

function splitRow(line) {
	let text = line.trim();
	if (text.startsWith("|")) text = text.slice(1);
	if (text.endsWith("|")) text = text.slice(0, -1);
	return text.split("|").map((cell) => cell.trim());
}

function isTableSeparator(line) {
	const cells = splitRow(line);
	if (cells.length === 0) return false;
	return cells.every((cell) => /^:?-{2,}:?$/.test(cell));
}

function isTableStart(lines, index) {
	const line = lines[index];
	if (line === undefined || !line.includes("|")) return false;
	const next = lines[index + 1];
	return next !== undefined && next.includes("|") && isTableSeparator(next);
}

function startsBlock(lines, index) {
	const line = lines[index];
	if (line === undefined) return true;
	return (
		isFence(line) ||
		isHeading(line) ||
		isHr(line) ||
		isQuote(line) ||
		isListLine(line) ||
		isTableStart(lines, index)
	);
}

function renderCode(lang, code) {
	const language = String(lang ?? "").trim().slice(0, 24);
	const label = language === "" ? "代码" : language;
	return `<figure class="md-code" data-lang="${escapeAttr(language)}"><figcaption class="md-code-bar"><span class="md-code-lang mono">${escapeHtml(label)}</span><button class="md-code-copy" type="button" data-copy="code" aria-label="复制代码" title="复制代码">复制</button></figcaption><pre><code>${escapeHtml(code.replace(/\n$/, ""))}</code></pre></figure>`;
}

function alignClass(cell) {
	if (/^:-+:$/.test(cell)) return "ta-c";
	if (/^:-+$/.test(cell)) return "";
	if (/^-+:$/.test(cell)) return "ta-r";
	return "";
}

function renderTable(headerLine, separatorLine, bodyLines) {
	const headers = splitRow(headerLine);
	const aligns = splitRow(separatorLine);
	const head = headers
		.map((cell, index) => {
			const align = alignClass(aligns[index] ?? "");
			return `<th${align === "" ? "" : ` class="${align}"`}>${renderInline(cell)}</th>`;
		})
		.join("");
	const body = bodyLines
		.map((line) => {
			const cells = splitRow(line);
			const row = headers
				.map((_, index) => {
					const align = alignClass(aligns[index] ?? "");
					return `<td${align === "" ? "" : ` class="${align}"`}>${renderInline(cells[index] ?? "")}</td>`;
				})
				.join("");
			return `<tr>${row}</tr>`;
		})
		.join("");
	return `<div class="md-table-wrap"><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
}

function collectFence(lines, start) {
	const language = fenceInfo(lines[start]);
	const code = [];
	let index = start + 1;
	while (index < lines.length && !/^\s{0,3}```\s*$/.test(lines[index])) {
		code.push(lines[index]);
		index += 1;
	}
	if (index < lines.length) index += 1;
	return { html: renderCode(language, code.join("\n")), next: index };
}

function collectQuote(lines, start) {
	const inner = [];
	let index = start;
	while (index < lines.length) {
		const line = lines[index];
		if (isQuote(line)) {
			inner.push(line.replace(/^\s{0,3}>\s?/, ""));
			index += 1;
		} else if (line.trim() === "" && isQuote(lines[index + 1] ?? "")) {
			inner.push("");
			index += 1;
		} else {
			break;
		}
	}
	return { html: `<blockquote>${renderBlocks(inner)}</blockquote>`, next: index };
}

function collectTable(lines, start) {
	const headerLine = lines[start];
	const separatorLine = lines[start + 1];
	const body = [];
	let index = start + 2;
	while (index < lines.length) {
		const line = lines[index];
		if (line.trim() === "" || !line.includes("|")) break;
		if (isTableSeparator(line)) break;
		body.push(line);
		index += 1;
	}
	return { html: renderTable(headerLine, separatorLine, body), next: index };
}

/** 收集一个列表块（含缩进续行），空行后若仍是列表则继续。 */
function collectList(lines, start) {
	const block = [];
	let index = start;
	while (index < lines.length) {
		const line = lines[index];
		if (line.trim() === "") {
			let next = index + 1;
			while (next < lines.length && lines[next].trim() === "") next += 1;
			if (next < lines.length && isListLine(lines[next])) {
				index = next;
				continue;
			}
			break;
		}
		if (isListLine(line) || /^[ \t]{2,}\S/.test(line)) {
			block.push(line);
			index += 1;
			continue;
		}
		break;
	}
	return { html: renderList(block), next: index };
}

function parseListEntries(lines) {
	const entries = [];
	for (const line of lines) {
		const match = /^([ \t]*)([-*+]|\d{1,9}[.)])\s+(.*)$/.exec(line);
		if (match !== null) {
			let content = match[3];
			let task = null;
			const taskMatch = /^\[([ xX])\]\s+(.*)$/.exec(content);
			if (taskMatch !== null) {
				task = taskMatch[1].toLowerCase() === "x";
				content = taskMatch[2];
			}
			entries.push({
				indent: indentOf(match[1]),
				ordered: /\d/.test(match[2][0]),
				content,
				task,
				extra: [],
			});
		} else {
			const last = entries[entries.length - 1];
			if (last !== undefined) last.extra.push(line.trim());
		}
	}
	return entries;
}

function parseListTree(entries, start, indent) {
	const node = { ordered: entries[start]?.ordered === true, items: [] };
	let index = start;
	while (index < entries.length) {
		const entry = entries[index];
		if (entry.indent < indent) break;
		// 同一层换列表类型（ul ↔ ol）就收尾，交给外层开新列表
		if (entry.indent === indent && node.items.length > 0 && entry.ordered !== node.ordered) break;
		const item = { content: entry.content, task: entry.task, extra: entry.extra, sublists: [] };
		index += 1;
		while (index < entries.length && entries[index].indent > indent) {
			const childIndent = entries[index].indent;
			const child = parseListTree(entries, index, childIndent);
			item.sublists.push(child.node);
			index = child.next;
		}
		node.items.push(item);
	}
	return { node, next: index };
}

function renderListTree(node) {
	const tag = node.ordered ? "ol" : "ul";
	const items = node.items
		.map((item) => {
			let body = renderInline(item.content);
			for (const extra of item.extra) body += `<br>${renderInline(extra)}`;
			if (item.task !== null) {
				body = `<label class="md-task"><input type="checkbox" disabled${item.task ? " checked" : ""}><span>${body}</span></label>`;
			}
			const children = item.sublists.map(renderListTree).join("");
			return `<li>${body}${children}</li>`;
		})
		.join("");
	return `<${tag}>${items}</${tag}>`;
}

function renderList(lines) {
	const entries = parseListEntries(lines);
	if (entries.length === 0) return "";
	const baseIndent = Math.min(...entries.map((entry) => entry.indent));
	const parts = [];
	let index = 0;
	while (index < entries.length) {
		const tree = parseListTree(entries, index, baseIndent);
		if (tree.next === index) break;
		parts.push(renderListTree(tree.node));
		index = tree.next;
	}
	return parts.join("");
}

function renderBlocks(lines) {
	const output = [];
	let index = 0;

	while (index < lines.length) {
		const line = lines[index];

		if (line.trim() === "") {
			index += 1;
			continue;
		}

		if (isFence(line)) {
			const block = collectFence(lines, index);
			output.push(block.html);
			index = block.next;
			continue;
		}

		if (isHeading(line)) {
			const match = /^\s{0,3}(#{1,3})\s+(.*?)(?:\s+#+)?\s*$/.exec(line);
			const level = match === null ? 3 : match[1].length;
			output.push(`<h${level}>${renderInline(match?.[2] ?? "")}</h${level}>`);
			index += 1;
			continue;
		}

		if (isHr(line)) {
			output.push("<hr>");
			index += 1;
			continue;
		}

		if (isQuote(line)) {
			const block = collectQuote(lines, index);
			output.push(block.html);
			index = block.next;
			continue;
		}

		if (isTableStart(lines, index)) {
			const block = collectTable(lines, index);
			output.push(block.html);
			index = block.next;
			continue;
		}

		if (isListLine(line)) {
			const block = collectList(lines, index);
			output.push(block.html);
			index = block.next;
			continue;
		}

		// 段落：直到空行或下一个块开始
		const paragraph = [];
		while (index < lines.length && lines[index].trim() !== "" && !startsBlock(lines, index)) {
			paragraph.push(lines[index]);
			index += 1;
		}
		if (paragraph.length === 0) {
			// 兜底：不认识的块起始行，按普通段落消费，避免死循环
			paragraph.push(lines[index]);
			index += 1;
		}
		output.push(`<p>${paragraph.map(renderInline).join("<br>")}</p>`);
	}

	return output.join("");
}

/**
 * 把 Markdown 文本渲染成安全的 HTML 字符串。
 * 流式调用时由聊天面板自行节流（≤80ms），这里保持纯函数。
 */
export function renderMarkdown(text) {
	return renderBlocks(String(text ?? "").replace(/\r\n?/g, "\n").split("\n"));
}
