/**
 * 安全 Markdown 渲染。
 *
 * 原则：模型文本先全部转义，再拼接受控 HTML；不解释原始 HTML，不引入依赖。
 * 支持：h1–h3、粗体 / 斜体 / 删除线、链接、**图片**、行内代码、围栏代码（语言 + 复制）、
 * 有序 / 无序 / 嵌套列表、任务列表、表格（可横向滚）、引用、分割线。
 *
 * 只导出 renderMarkdown(text) -> string。
 */
import { CODE_COPY_CLASS } from "./copy-code.ts";
import { clipText, escapeHtml, escapeAttr } from "./format.js";

/** 行内占位符：先抽走代码与链接，避免它们的内部符号被当成 Markdown。 */
const SLOT = "\u0000";

/* ── 行内 ───────────────────────────────────────────────────────────────── */

function safeUrl(raw: unknown): string {
	const value = String(raw ?? "")
		.trim()
		// 控制符与空白不能在协议前出现，否则 javascript: 可以靠换行绕过
		.replace(/[\u0000-\u001f\u007f\s]+/g, "");
	if (value === "") return "";
	// 协议相对链接（//host）会跳到站外，直接拒绝；站内路径只允许单个斜杠
	if (value.startsWith("//")) return "";
	// 带协议的只认 http(s) / mailto；其余（javascript:、data:…）一律不要。
	if (/^[a-z][a-z0-9+.-]*:/i.test(value)) {
		return /^(https?:\/\/|mailto:)/i.test(value) ? value : "";
	}
	// 剩下的都是相对写法（`teams/x.md`、`/`、`#`）：是不是能点由 `pathOf` 再判一次。
	return value;
}

/**
 * 一段文字像不像「这个仓库里的一个文件」。
 *
 * 命中的才变成可点的路径：带斜杠的相对路径（`teams/x/workspace/a.md`），或者一个
 * `名字.扩展名`。协议 / 绝对路径 / 带空格的一律不算 —— 宁可少点一个，也别让
 * `v2.1.0`、`node:fs` 这种东西变成死链接。
 */
function pathOf(raw: string): string {
	const value = raw.trim();
	if (value === "" || value.length > 200) return "";
	if (value.startsWith("/") || value.startsWith("~")) return "";
	if (value.includes("..") || /\s/.test(value)) return "";
	if (/^[a-z][a-z0-9+.-]*:/i.test(value)) return "";
	const slashy = /^[^/`'"：:]+(?:\/[^/`'"：:]+)+$/.test(value);
	const filey = /^[A-Za-z0-9_.@-]+\.[a-z]{1,6}$/.test(value);
	return slashy || filey ? value : "";
}

/**
 * 一段路径**看起来是不是这张图**：图片后缀才内联，其余照旧「点了去右栏看」。
 *
 * 只看后缀，不看文件在不在 —— 生成 HTML 时没有 IO。真的不认识这份字节也没关系：
 * `/api/files/preview` 回的不是 `image/*` 时 `img` 会 onError，外面挂一层
 * 「看不了，点这里」的兜底（见 `Stream.tsx` 的 `installBrokenImages`）。
 * 这一步只决定「要不要把路径画成图」，**不放宽任何校验**：路径能不能读仍然由
 * `src/app/files.ts` 的三条硬线说了算。
 */
const IMAGE_SUFFIX = /\.(?:png|jpe?g|gif|webp|bmp|avif)$/i;

function imagePathOf(raw: string): string {
	const path = pathOf(raw);
	return path !== "" && IMAGE_SUFFIX.test(path) ? path : "";
}

/**
 * 正文里「看起来是图」的路径统一长这样：外层 `.md-img` 承担样式与「点击放大」的落点
 * （和 `![alt](url)` 那条同一个类名），`data-path` 让点击仍然能落到右栏预览上。
 */
export const MD_IMAGE_FAIL_CLASS = "md-img-fail";

/** 本地图也走同一条预览接口（它比 `<a href>` 多一层：三条硬底线在后端）。 */
function filePreviewUrl(path: string): string {
	return `/api/files/preview?path=${encodeURIComponent(path)}`;
}

function emphasis(text: string): string {
	return text
		.replace(/~~([^~\n]+?)~~/g, "<del>$1</del>")
		.replace(/\*\*([^*\n]+?)\*\*/g, "<strong>$1</strong>")
		.replace(/__([^_\n]+?)__/g, "<strong>$1</strong>")
		.replace(/(^|[^*])\*([^*\n]+?)\*(?!\*)/g, "$1<em>$2</em>")
		.replace(/(^|[\s(（，。、：；])_([^_\n]+?)_($|[\s)）,.，。、：；])/g, "$1<em>$2</em>$3");
}

/** 行内渲染：raw 是原始文本（未转义）。 */
function renderInline(raw: unknown): string {
	const slots: string[] = [];
	let text = String(raw ?? "");

	// 1. 行内代码（代码里的一切都不再解释）
	text = text.replace(/`([^`\n]+)`/g, (_whole: string, code: string) => {
		const image = imagePathOf(code);
		// 图片路径直接画成图（老板 2026-11-10）：`\`a/b.png\`` 就是那张图，不再只是可点的一行字。
		if (image !== "") {
			slots.push(
				`<span class="md-img"><img src="${escapeAttr(filePreviewUrl(image))}" alt="${escapeAttr(image)}" title="${escapeAttr(image)}" loading="lazy" decoding="async"></span>`,
			);
			return `${SLOT}${slots.length - 1}${SLOT}`;
		}
		const path = pathOf(code);
		// 像文件的那一段 code 多带一个 `data-path`：点它是「预览这个文件」，不是选字。
		slots.push(
			path === ""
				? `<code>${escapeHtml(code)}</code>`
				: `<code class="md-path" data-path="${escapeAttr(path)}" title="点击预览">${escapeHtml(code)}</code>`,
		);
		return `${SLOT}${slots.length - 1}${SLOT}`;
	});

	// 2. 图片（需求 #6）：必须在链接**之前**处理，否则 `![alt](url)` 会被当成
	//    `[alt](url)` 前面多一个 `!`。仍然只允许安全协议——图片是外链请求，
	//    放行 `javascript:` 或协议相对地址等于给正文开一个任意 URL 的口子。
	text = text.replace(/!\[([^\]\n]*)\]\(([^)\s]+)\)/g, (whole: string, alt: string, url: string) => {
		const src = safeUrl(url);
		if (src === "") {
			slots.push(escapeHtml(whole));
			return `${SLOT}${slots.length - 1}${SLOT}`;
		}
		// `loading=lazy`：一条消息里贴十张图也不会把首屏拖慢。
		// 外层 span 承担样式与「点击放大」的落点（见 channels.js 的 deck 事件）。
		slots.push(
			`<span class="md-img"><img src="${escapeAttr(src)}" alt="${escapeAttr(alt)}" loading="lazy" decoding="async"></span>`,
		);
		return `${SLOT}${slots.length - 1}${SLOT}`;
	});

	// 3. 链接：只允许安全协议，文本重新转义。相对路径（`[周报](teams/x/report.md)`）
	//    不跳出页面，而是标成可预览的文件。
	text = text.replace(/\[([^\]]*)\]\(([^)\s]+)\)/g, (whole: string, label: string, url: string) => {
		const href = safeUrl(url);
		if (href === "") {
			slots.push(escapeHtml(whole));
			return `${SLOT}${slots.length - 1}${SLOT}`;
		}
		if (!/^(?:https?:\/\/|mailto:)/i.test(href)) {
			const image = imagePathOf(href);
			if (image !== "") {
				slots.push(
					`<span class="md-img"><img src="${escapeAttr(filePreviewUrl(image))}" alt="${escapeAttr(label)}" title="${escapeAttr(image)}" loading="lazy" decoding="async"></span>`,
				);
				return `${SLOT}${slots.length - 1}${SLOT}`;
			}
			const path = pathOf(href);
			slots.push(
				path === ""
					? escapeHtml(whole)
					: `<a class="md-path" data-path="${escapeAttr(path)}" href="#" title="点击预览">${escapeHtml(label)}</a>`,
			);
			return `${SLOT}${slots.length - 1}${SLOT}`;
		}
		slots.push(
			`<a href="${escapeAttr(href)}" target="_blank" rel="noopener noreferrer">${escapeHtml(label)}</a>`,
		);
		return `${SLOT}${slots.length - 1}${SLOT}`;
	});

	// 3.5 裸 URL：模型常常直接贴 `https://…`，没有 `[]()` 也得能点（点了开内置浏览器）。
	//     只认行首 / 空格 / 左括号后面的，别把句子中间的半个词当成链接。
	text = text.replace(/(^|[\s(（\[【])(https?:\/\/[^\s<>"'`]+)/g, (_whole: string, lead: string, raw: string) => {
		// 句末标点不算 URL 的一部分（中文句号、右括号最常见）。
		const url = raw.replace(/[)）\]】。，、；：！？,.;:!?]+$/, "");
		const trailing = raw.slice(url.length);
		if (url.length <= "https://".length) return `${lead}${raw}`;
		slots.push(`<a href="${escapeAttr(url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(url)}</a>`);
		return `${lead}${SLOT}${slots.length - 1}${SLOT}${trailing}`;
	});

	// 3.6 裸路径：模型写「第一份周报在 teams/x/workspace/report.md，约…」时并不包反引号。
	//     只认空格 / 左括号后、带斜杠、以 1–6 位扩展名结尾的一段；后面紧跟着路径字符的不算
	//     （`a/b/c.ts:42` 的行号留在外面）。宁可少点亮一个，也别把正文变成一片死链接。
	text = text.replace(
		/(^|[\s(（\[【：:，,、])((?:[A-Za-z0-9_.@+\-一-龥]+\/)+[A-Za-z0-9_.@+\-一-龥]*\.[a-z]{1,6})(?![A-Za-z0-9_./-])/g,
		(_whole: string, lead: string, raw: string) => {
			const image = imagePathOf(raw);
			// 一段独占的图片路径（`teams/x/workspace/shot.png`）就画成图；其余照旧是可点的路径。
			if (image !== "") {
				slots.push(
					`<span class="md-img"><img src="${escapeAttr(filePreviewUrl(image))}" alt="${escapeAttr(image)}" title="${escapeAttr(image)}" loading="lazy" decoding="async"></span>`,
				);
				return `${lead}${SLOT}${slots.length - 1}${SLOT}`;
			}
			const path = pathOf(raw);
			if (path === "") return `${lead}${raw}`;
			slots.push(`<a class="md-path" data-path="${escapeAttr(path)}" href="#" title="点击预览">${escapeHtml(raw)}</a>`);
			return `${lead}${SLOT}${slots.length - 1}${SLOT}`;
		},
	);

	// 4. 其余先转义，再做强调
	let html = emphasis(escapeHtml(text));

	// 5. `@某人` 高亮：前面不能是邮箱/句柄会用的字符（`a@b.com`、`user@host` 不点亮），
	//    中文里「叫@林越」不空格也点亮。代码里的 `@` 早在第 1 步就进了占位符，不会被误伤。
	html = html.replace(/(^|[^A-Za-z0-9._%+-])@([^\s@<>，。：；！？、（）()「」『』《》"'*_~`]{1,24})/g, (_whole, lead: string, name: string) => `${lead}<span class="md-at">@${name}</span>`);

	// 6. 还原占位符
	html = html.replace(new RegExp(`${SLOT}(\\d+)${SLOT}`, "g"), (_whole: string, index: string) => slots[Number(index)] ?? "");
	return html;
}

/* ── 块级 ───────────────────────────────────────────────────────────────── */

function isFence(line: string): boolean {
	return /^\s{0,3}```/.test(line);
}

function fenceInfo(line: string): string {
	const match = /^\s{0,3}```([\w+#.-]*)\s*$/.exec(line);
	// 分组 1 是 `*` 量词，未匹配时也在、只是空串；`??` 只为把 `string | undefined` 收窄。
	return match === null ? "" : (match[1] ?? "");
}

function isHeading(line: string): boolean {
	return /^\s{0,3}#{1,3}\s+\S/.test(line);
}

function isHr(line: string): boolean {
	return /^\s{0,3}(?:(?:-\s*){3,}|(?:\*\s*){3,}|(?:_\s*){3,})$/.test(line);
}

function isQuote(line: string): boolean {
	return /^\s{0,3}>/.test(line);
}

function isListLine(line: string): boolean {
	return /^\s*(?:[-*+]|\d{1,9}[.)])\s+\S/.test(line);
}

function indentOf(line: string): number {
	const match = /^[ \t]*/.exec(line);
	const raw = match === null ? "" : match[0];
	let width = 0;
	for (const character of raw) width += character === "\t" ? 4 : 1;
	return width;
}

function splitRow(line: string): string[] {
	let text = line.trim();
	if (text.startsWith("|")) text = text.slice(1);
	if (text.endsWith("|")) text = text.slice(0, -1);
	return text.split("|").map((cell) => cell.trim());
}

function isTableSeparator(line: string): boolean {
	const cells = splitRow(line);
	if (cells.length === 0) return false;
	return cells.every((cell) => /^:?-{2,}:?$/.test(cell));
}

function isTableStart(lines: readonly string[], index: number): boolean {
	const line = lines[index];
	if (line === undefined || !line.includes("|")) return false;
	const next = lines[index + 1];
	return next !== undefined && next.includes("|") && isTableSeparator(next);
}

function startsBlock(lines: readonly string[], index: number): boolean {
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

function renderCode(lang: unknown, code: string): string {
	const language = clipText(String(lang ?? "").trim(), 24);
	const label = language === "" ? "代码" : language;
	return `<figure class="md-code" data-lang="${escapeAttr(language)}"><figcaption class="md-code-bar"><span class="md-code-lang mono">${escapeHtml(label)}</span><button class="${CODE_COPY_CLASS}" type="button" data-copy="code" aria-label="复制代码" title="复制代码">复制</button></figcaption><pre><code>${escapeHtml(code.replace(/\n$/, ""))}</code></pre></figure>`;
}

function alignClass(cell: string): string {
	if (/^:-+:$/.test(cell)) return "ta-c";
	if (/^:-+$/.test(cell)) return "";
	if (/^-+:$/.test(cell)) return "ta-r";
	return "";
}

function renderTable(headerLine: string, separatorLine: string, bodyLines: readonly string[]): string {
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

/** 一个块收完之后的产物：HTML + 下一行从哪开始。 */
type Block = { html: string; next: number };

function collectFence(lines: readonly string[], start: number): Block {
	const language = fenceInfo(lines[start] ?? "");
	const code: string[] = [];
	let index = start + 1;
	while (index < lines.length) {
		const line = lines[index];
		// `index < length` 已保证有值；`undefined` 分支只为收窄类型（越界即结束）。
		if (line === undefined || /^\s{0,3}```\s*$/.test(line)) break;
		code.push(line);
		index += 1;
	}
	if (index < lines.length) index += 1;
	return { html: renderCode(language, code.join("\n")), next: index };
}

function collectQuote(lines: readonly string[], start: number): Block {
	const inner: string[] = [];
	let index = start;
	while (index < lines.length) {
		const line = lines[index];
		if (line === undefined) break;
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

function collectTable(lines: readonly string[], start: number): Block {
	// 只会在 `isTableStart` 为真时调用，那已经保证这两行存在。
	const headerLine = lines[start] ?? "";
	const separatorLine = lines[start + 1] ?? "";
	const body: string[] = [];
	let index = start + 2;
	while (index < lines.length) {
		const line = lines[index];
		if (line === undefined) break;
		if (line.trim() === "" || !line.includes("|")) break;
		if (isTableSeparator(line)) break;
		body.push(line);
		index += 1;
	}
	return { html: renderTable(headerLine, separatorLine, body), next: index };
}

/** 收集一个列表块（含缩进续行），空行后若仍是列表则继续。 */
function collectList(lines: readonly string[], start: number): Block {
	const block: string[] = [];
	let index = start;
	while (index < lines.length) {
		const line = lines[index];
		if (line === undefined) break;
		if (line.trim() === "") {
			let next = index + 1;
			while (next < lines.length && (lines[next] ?? "").trim() === "") next += 1;
			if (next < lines.length && isListLine(lines[next] ?? "")) {
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

/** 解析后的一条列表项。`task` 三态：不是任务项 / 未勾 / 已勾。 */
type ListEntry = {
	indent: number;
	ordered: boolean;
	content: string;
	task: boolean | null;
	extra: string[];
};

function parseListEntries(lines: readonly string[]): ListEntry[] {
	const entries: ListEntry[] = [];
	for (const line of lines) {
		const match = /^([ \t]*)([-*+]|\d{1,9}[.)])\s+(.*)$/.exec(line);
		if (match !== null) {
			let content = match[3] ?? "";
			let task: boolean | null = null;
			const taskMatch = /^\[([ xX])\]\s+(.*)$/.exec(content);
			if (taskMatch !== null) {
				task = (taskMatch[1] ?? "").toLowerCase() === "x";
				content = taskMatch[2] ?? "";
			}
			entries.push({
				indent: indentOf(match[1] ?? ""),
				ordered: /\d/.test(match[2]?.[0] ?? ""),
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

/** 列表树的一个结点：`ol` 还是 `ul`，以及它下面直接挂的条目。 */
type ListItem = { content: string; task: boolean | null; extra: string[]; sublists: ListTreeNode[] };

/** 列表树：同一层同一个类型（ul / ol）的条目 + 每条的缩进子树。 */
type ListTreeNode = { ordered: boolean; items: ListItem[] };

/** 递归解析的产物：这一层的树 + 下一层从哪条开始。 */
type ParsedTree = { node: ListTreeNode; next: number };

function parseListTree(entries: readonly ListEntry[], start: number, indent: number): ParsedTree {
	const node: ListTreeNode = { ordered: entries[start]?.ordered === true, items: [] };
	let index = start;
	while (index < entries.length) {
		const entry = entries[index];
		if (entry === undefined) break;
		if (entry.indent < indent) break;
		// 同一层换列表类型（ul ↔ ol）就收尾，交给外层开新列表
		if (entry.indent === indent && node.items.length > 0 && entry.ordered !== node.ordered) break;
		const item: ListItem = { content: entry.content, task: entry.task, extra: entry.extra, sublists: [] };
		index += 1;
		while (index < entries.length) {
			const next = entries[index];
			// 缩进回落到当前层就结束这一条的子列表（原来的 `entries[index].indent > indent`）。
			if (next === undefined || next.indent <= indent) break;
			const childIndent = next.indent;
			const child = parseListTree(entries, index, childIndent);
			item.sublists.push(child.node);
			index = child.next;
		}
		node.items.push(item);
	}
	return { node, next: index };
}

function renderListTree(node: ListTreeNode): string {
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

function renderList(lines: readonly string[]): string {
	const entries = parseListEntries(lines);
	if (entries.length === 0) return "";
	const baseIndent = Math.min(...entries.map((entry) => entry.indent));
	const parts: string[] = [];
	let index = 0;
	while (index < entries.length) {
		const tree = parseListTree(entries, index, baseIndent);
		if (tree.next === index) break;
		parts.push(renderListTree(tree.node));
		index = tree.next;
	}
	return parts.join("");
}

function renderBlocks(lines: readonly string[]): string {
	const output: string[] = [];
	let index = 0;

	while (index < lines.length) {
		const line = lines[index];
		// 越界即结束：`undefined` 分支只为把下标访问收窄成 `string`。
		if (line === undefined) break;

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
			const level = match === null ? 3 : (match[1] ?? "").length;
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
		const paragraph: string[] = [];
		while (index < lines.length) {
			const line = lines[index];
			if (line === undefined || line.trim() === "" || startsBlock(lines, index)) break;
			paragraph.push(line);
			index += 1;
		}
		if (paragraph.length === 0) {
			// 兜底：不认识的块起始行，按普通段落消费，避免死循环
			const line = lines[index];
			if (line !== undefined) paragraph.push(line);
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
export function renderMarkdown(text: string): string {
	return renderBlocks(String(text ?? "").replace(/\r\n?/g, "\n").split("\n"));
}
