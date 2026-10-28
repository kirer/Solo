/**
 * 四种行。这个文件就是「信息密度」的定义。
 *
 * 一张表定死能画什么：say / event / note / pending。未命中的 kind 一律 return null
 * —— 不画、不占高、不显示「不支持的消息类型」。宁可少一行，也不给界面添一种新卡片。
 *
 * 这里只产出 DOM 字符串/节点，不碰 fetch、不碰全局状态：事件全部交给 app.js 的委托。
 */

import { avatarSvg } from "./avatar.js";
import { clockTime, dayLabel, escapeHtml, sameDay } from "./format.js";
import { renderMarkdown } from "./markdown.js";

/**
 * 17 个工具 → 人话。这是产品语气的一部分：用户看到的是「他读了一个文件」，
 * 不是 `read_file({"path":"x"})`。未命中的工具名画「在做一件事」，绝不显示原名。
 */
export const TOOL_PHRASES = {
	say: "说了一句",
	read_channel: "翻了一遍频道",
	org: "看了一遍名册",
	hire: "拉了一个人进来",
	update_identity: "改了自己的档案",
	list_skills: "翻了一遍技能",
	read_skill: "读了一份技能",
	write_skill: "写了一份技能",
	list_projects: "翻了一遍项目",
	read_project: "读了一个项目",
	write_project: "写了一个项目",
	remember: "记了一笔",
	read_history: "翻了一遍历史",
	recall: "回想了一下",
	run: "跑了一条命令",
	write_file: "写了一个文件",
	read_file: "读了一个文件",
};

/** 说人类的 kind 走 say 行。其余（think/tool/work/note）各有归宿，剩下的不画。 */
const SAY_KINDS = new Set(["say", "chat", "report", "decision", "question"]);

/** 长文才折叠，追问和短报告不折。 */
const FOLD_KINDS = new Set(["chat", "report", "decision", "question", "say"]);
const FOLD_OVER = 1500;

/** 同一人 2 分钟内连发 → 后续行不画头像名字，只缩进对齐。 */
const GROUP_MS = 2 * 60 * 1000;

const ICONS = {
	copy: `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><rect x="5.5" y="5.5" width="7" height="7" rx="1.6"/><path d="M10.5 3.6A1.6 1.6 0 0 0 8.9 2.5H5A1.5 1.5 0 0 0 3.5 4v3.9c0 .7.5 1.3 1.1 1.5"/></svg>`,
	check: `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 8.5l3 3 6-6.5"/></svg>`,
	reply: `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M6.5 4.5 3 8l3.5 3.5"/><path d="M3 8h5a4.5 4.5 0 0 1 4.5 4.5v.5"/></svg>`,
	locate: `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 5.5v-3h3M13.5 5.5v-3h-3M2.5 10.5v3h3M13.5 10.5v3h-3"/></svg>`,
};

/** 一条消息是不是「需要你」。这是顶栏 N 件找你与左侧 2px 竖线的唯一来源。 */
export function isNeed(message) {
	if (!message) return false;
	if (message.kind === "pending" || message.status === "pending") return true;
	if (message.fromSlug === "owner") return false;
	// 提问，且点名了老板（owner 的 id 恒为 0）。
	if (message.kind === "question") {
		return Array.isArray(message.mentions) && message.mentions.some((m) => m.id === 0);
	}
	return false;
}

/* ── event 行的人话 ─────────────────────────────────────────────────── */

function firstQuote(text) {
	const match = /"([^"]{1,64})"/.exec(text ?? "");
	return match ? match[1] : "";
}

/** 路径太长就把前面截掉 —— 文件名比目录名有信息量。 */
function shortPath(path) {
	return path.length > 42 ? `…${path.slice(-40)}` : path;
}

/** 工具名：文本的第一个词。如 `run command="ls"` → `run`。 */
export function toolNameOf(message) {
	if (message.kind !== "tool") return "";
	return String(message.text ?? "")
		.trim()
		.split(/\s+/)[0]
		.replace(/[^\w-]/g, "");
}

/**
 * event 行要说的话。think 的秒数由 buildStream 合并计算，这里给的是不合并时的默认。
 */
export function eventPhrase(message) {
	const kind = message.kind;
	if (kind === "think") return "想了一会儿";
	if (kind === "tool") {
		const name = toolNameOf(message);
		// 读/写类工具带一个文件名，信息密度立刻高一档，且仍然只有一行。
		if (/^read_(file|skill|project)$/.test(name)) {
			const arg = firstQuote(message.text);
			return arg ? `读了 ${shortPath(arg)}` : "读了一个文件";
		}
		if (/^write_(file|skill|project)$/.test(name)) {
			const arg = firstQuote(message.text);
			return arg ? `写了 ${shortPath(arg)}` : "写了一个文件";
		}
		return TOOL_PHRASES[name] ?? "在做一件事";
	}
	if (kind === "work") {
		const text = String(message.text ?? "");
		if (text.startsWith("$")) return "跑了一条命令";
		if (text.startsWith("已写入") || text.startsWith("写入")) return "写了一个文件";
		if (text.startsWith("已读取") || text.startsWith("读取")) return "读了一个文件";
		return "在做一件事";
	}
	return "";
}

/** 活动行的一句话（不含人名）。 */
export function activityPhrase(message) {
	if (!message) return "";
	if (message.kind === "think") return "在想事情";
	return eventPhrase(message);
}

/* ── 小工具 ─────────────────────────────────────────────────────────── */

function toolsBar() {
	return `<div class="row-tools" role="toolbar" aria-label="消息操作"><button class="tool" type="button" data-act="copy" title="复制" aria-label="复制">${ICONS.copy}</button><button class="tool" type="button" data-act="reply" title="引用回复" aria-label="引用回复">${ICONS.reply}</button><button class="tool" type="button" data-act="locate" title="定位" aria-label="定位">${ICONS.locate}</button></div>`;
}

function quoteBlock(replyTo) {
	if (!replyTo) return "";
	const label = escapeHtml(replyTo.fromLabel ?? "");
	const excerpt = escapeHtml(String(replyTo.excerpt ?? "").slice(0, 80));
	return `<button class="row-quote" type="button" data-jump="${Number(replyTo.seq) || 0}"><b>${label}</b><span>${excerpt}</span></button>`;
}

/**
 * @名字 只换文字颜色、不加底色。做法是在已渲染的文本节点上包一层 span，
 * 而不是对 HTML 做正则替换 —— 后者会把标签属性里的字符也改掉。
 */
function paintMentions(root, mentions) {
	if (!Array.isArray(mentions) || mentions.length === 0) return;
	const labels = [...new Set(mentions.map((m) => m.label).filter(Boolean))].sort(
		(a, b) => b.length - a.length,
	);
	if (labels.length === 0) return;
	const pattern = new RegExp(`@(?:${labels.map((l) => l.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})`, "g");
	const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
	const targets = [];
	while (walker.nextNode()) {
		const node = walker.currentNode;
		const parent = node.parentElement;
		if (!parent) continue;
		if (parent.closest("pre, code, a, .mention-name")) continue;
		if (!pattern.test(node.nodeValue ?? "")) continue;
		pattern.lastIndex = 0;
		targets.push(node);
	}
	for (const node of targets) {
		const text = node.nodeValue ?? "";
		const frag = document.createDocumentFragment();
		let last = 0;
		for (const match of text.matchAll(pattern)) {
			const at = match.index ?? 0;
			if (at > last) frag.append(text.slice(last, at));
			const span = document.createElement("span");
			span.className = "mention-name";
			span.textContent = match[0];
			frag.append(span);
			last = at + match[0].length;
		}
		if (last < text.length) frag.append(text.slice(last));
		node.replaceWith(frag);
	}
}

function bodyHtml(message) {
	const raw = String(message.text ?? "");
	const html = renderMarkdown(raw);
	if (!FOLD_KINDS.has(message.kind ?? "say") || raw.length <= FOLD_OVER) return `<div class="md">${html}</div>`;
	return `<div class="md fold" data-folded="true">${html}</div><button class="text-btn fold-btn" type="button" data-fold-btn>展开全文（${raw.length} 字）</button>`;
}

/* ── say ────────────────────────────────────────────────────────────── */

function sayRow(message, ctx, grouped) {
	const isOwner = message.fromSlug === "owner";
	const person = ctx.bySlug.get(message.fromSlug);
	const role = [person?.title, person?.project].filter(Boolean).join(" · ");
	const need = (ctx.isNeed ?? isNeed)(message) && !isOwner;

	const av = grouped
		? ""
		: `<div class="row-av">${avatarSvg({
				slug: message.fromSlug,
				name: message.fromLabel,
				size: 40,
				state: ctx.stateOf?.(message.fromSlug) ?? "idle",
			})}</div>`;

	const head = grouped
		? ""
		: `<div class="row-head">${need ? '<span class="need-tag">需要你</span>' : ""}<span class="row-name">${escapeHtml(
				message.fromLabel ?? "",
			)}</span>${role ? `<span class="row-role">${escapeHtml(role)}</span>` : ""}<span class="row-time">${clockTime(
				message.at,
			)}</span></div>`;

	const wrap = document.createElement("div");
	wrap.className = "row row-say";
	wrap.dataset.seq = String(message.seq);
	wrap.dataset.grouped = grouped ? "true" : "false";
	if (isOwner) wrap.dataset.owner = "true";
	if (need) wrap.dataset.need = "true";
	wrap.innerHTML = `${av}<div class="row-body">${head}${quoteBlock(message.replyTo)}${bodyHtml(message)}${toolsBar()}</div>`;

	const md = wrap.querySelector(".md");
	if (md) paintMentions(md, message.mentions);
	return wrap;
}

/* ── note ───────────────────────────────────────────────────────────── */

function noteRow(message) {
	const note = document.createElement("div");
	note.className = "row row-note";
	note.dataset.seq = String(message.seq);
	note.innerHTML = `<div class="note-text">${renderMarkdown(String(message.text ?? ""))}</div>`;
	return note;
}

/* ── event（think / tool / work） ──────────────────────────────────── */

function eventNode(message, text) {
	const row = document.createElement("div");
	row.className = "row row-event";
	row.dataset.seq = String(message.seq);
	row.dataset.kind = message.kind;
	row.innerHTML = `<span class="ev"><b>${escapeHtml(message.fromLabel ?? "")}</b> ${escapeHtml(text)}</span>`;
	return row;
}

/* ── pending（待办拍板卡，结构见 pending.css 顶部注释） ─────────────── */

function parsePending(message) {
	const given = message.pending;
	if (given && Array.isArray(given.options) && given.options.length > 0) {
		return {
			question: given.question ?? message.text ?? "",
			asker: given.asker ?? message.fromLabel ?? "",
			reviewer: given.reviewer ?? "",
			options: given.options.map((opt, index) => ({
				n: opt.n ?? index + 1,
				text: opt.text ?? String(opt),
				recommended: Boolean(opt.recommended),
			})),
		};
	}
	// 没有结构化字段时从正文里拆：第一行是问题，编号行是选项。
	const lines = String(message.text ?? "")
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean);
	if (lines.length < 3) return null;
	const options = [];
	for (const line of lines.slice(1)) {
		const match = /^(\d+)[.、)]\s*(.+)$/.exec(line);
		if (!match) continue;
		options.push({ n: Number(match[1]), text: match[2].replace(/\s*（?推荐）?\s*$/, ""), recommended: /推荐/.test(line) });
	}
	if (options.length < 2) return null;
	return { question: lines[0], asker: message.fromLabel ?? "", reviewer: "", options };
}

function pendingRow(message, at, now) {
	const data = parsePending(message);
	if (!data) return null;
	const row = document.createElement("div");
	row.className = "row row-pending";
	row.dataset.seq = String(message.seq);
	row.dataset.need = "true";
	row.dataset.kind = "pending";

	const opts = data.options
		.map(
			(opt) =>
				`<button class="pending-opt" type="button" data-pending="answer" data-opt="${opt.n}"><span class="opt-n">${opt.n}</span><span class="opt-t">${escapeHtml(
					opt.text,
				)}</span>${opt.recommended ? '<span class="opt-rec">推荐</span>' : ""}</button>`,
		)
		.join("");

	const meta = [data.asker ? `${escapeHtml(data.asker)}问` : "", data.reviewer ? `${escapeHtml(data.reviewer)}已看过` : ""]
		.filter(Boolean)
		.join(" · ");

	row.innerHTML = `<article class="pending"><header class="pending-head"><span class="pending-kicker">需要你拍板</span><span class="pending-time" data-at="${at}">${clockTime(
		at,
	)}</span></header><h2 class="pending-q">${escapeHtml(data.question)}</h2>${meta ? `<p class="pending-meta">${meta}</p>` : ""}<div class="pending-opts">${opts}</div><form class="pending-foot"><input class="pending-input" type="text" placeholder="也可以直接写…" aria-label="说点别的"><button class="text-btn" type="button" data-pending="resolve">✓ 标记已解决</button><button class="text-btn" type="button" data-pending="reject">驳回</button></form></article>${toolsBar()}`;
	void now;
	return row;
}

/* ── 组装 ───────────────────────────────────────────────────────────── */

function timeSepNodes(message, prev) {
	const nodes = [];
	if (!prev) {
		if (!sameDay(message.at, Date.now())) nodes.push(sepNode(dayLabel(message.at)));
		return nodes;
	}
	if (!sameDay(prev.at, message.at)) {
		nodes.push(sepNode(dayLabel(message.at)));
	} else if (message.at - prev.at > 30 * 60 * 1000) {
		nodes.push(sepNode(clockTime(message.at)));
	}
	return nodes;
}

function sepNode(label) {
	const node = document.createElement("div");
	node.className = "time-sep";
	node.textContent = label;
	return node;
}

/**
 * @param {Array<object>} messages 已按时间正序
 * @param {{people?:Array<object>, now?:number, stateOf?:(slug:string)=>string}} ctx
 * @returns {DocumentFragment}
 */
export function buildStream(messages, ctx = {}) {
	const list = Array.isArray(messages) ? messages : [];
	const bySlug = new Map((ctx.people ?? []).map((person) => [person.slug, person]));
	const full = { bySlug, stateOf: ctx.stateOf, isNeed: ctx.isNeed ?? isNeed };
	const now = ctx.now ?? Date.now();
	const frag = document.createDocumentFragment();

	let prevSay = null; // 上一条 say（判断是否同人连发）
	let lastAt = 0; // 上一条被画出来的行的时间
	let thinkRun = null;

	for (const message of list) {
		if (!message) continue;

		// think 合并：连续同人、间隔 < 2 分钟 → 一行带秒数
		if (message.kind === "think") {
			if (thinkRun && thinkRun.slug === message.fromSlug && message.at - thinkRun.end <= GROUP_MS) {
				thinkRun.end = message.at;
				const seconds = Math.max(1, Math.round((thinkRun.end - thinkRun.start) / 1000));
				thinkRun.el.querySelector(".ev").innerHTML = `<b>${escapeHtml(
					message.fromLabel ?? "",
				)}</b> 想了 ${seconds}s`;
				continue;
			}
			const row = eventNode(message, "想了 1s");
			thinkRun = { slug: message.fromSlug, start: message.at, end: message.at, el: row };
			frag.append(row);
			lastAt = message.at;
			prevSay = null;
			continue;
		}
		thinkRun = null;

		if (message.kind === "tool" || message.kind === "work") {
			for (const sep of timeSepNodes(message, lastAt ? { at: lastAt } : null)) frag.append(sep);
			frag.append(eventNode(message, eventPhrase(message)));
			lastAt = message.at;
			prevSay = null;
			continue;
		}

		if (message.kind === "note") {
			frag.append(noteRow(message));
			lastAt = message.at;
			prevSay = null;
			continue;
		}

		if (message.kind === "pending" || message.status === "pending") {
			const row = pendingRow(message, message.at, now);
			if (!row) continue;
			for (const sep of timeSepNodes(message, lastAt ? { at: lastAt } : null)) frag.append(sep);
			frag.append(row);
			lastAt = message.at;
			prevSay = null;
			continue;
		}

		// 未登记的 kind：不画。
		if (message.kind != null && !SAY_KINDS.has(message.kind)) continue;

		const grouped =
			prevSay !== null &&
			prevSay.fromSlug === message.fromSlug &&
			message.at - prevSay.at < GROUP_MS &&
			message.at - prevSay.at >= 0;

		if (!grouped) {
			for (const sep of timeSepNodes(message, lastAt ? { at: lastAt } : null)) frag.append(sep);
		}

		frag.append(sayRow(message, full, grouped));
		prevSay = message;
		lastAt = message.at;
	}

	return frag;
}

/** 单条重画：SSE 推来一条新消息时用，避免整列重建。 */
export function buildOne(message, ctx = {}) {
	return buildStream([message], ctx);
}
