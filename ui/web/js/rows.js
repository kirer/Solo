/**
 * 四种行。这个文件就是「信息密度」的定义。
 *
 * 一张表定死能画什么：say / event / note / pending。未命中的 kind 一律 return null
 * —— 不画、不占高、不显示「不支持的消息类型」。宁可少一行，也不给界面添一种新卡片。
 *
 * 这里只产出 DOM 字符串/节点，不碰 fetch、不碰全局状态：事件全部交给 app.js 的委托。
 */

import { attachmentsHtml } from "./attach.js";
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
	run: "执行了命令",
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
// 半分钟内连着说的几句算「一段」：气泡角连起来、时间戳只留第一个。
// 这和后端 `STEP_MERGE_MS` 是同一个数 —— 后端把过程话并进上一条，前端把漏过来的相邻几句
// 在视觉上并成一块，否则同一件事在屏幕上被切开成三块，读起来像三个人在抢话。
const CONT_MS = 30 * 1000;

const ICONS = {
	copy: `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><rect x="5.5" y="5.5" width="7" height="7" rx="1.6"/><path d="M10.5 3.6A1.6 1.6 0 0 0 8.9 2.5H5A1.5 1.5 0 0 0 3.5 4v3.9c0 .7.5 1.3 1.1 1.5"/></svg>`,
	check: `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 8.5l3 3 6-6.5"/></svg>`,
	reply: `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M6.5 4.5 3 8l3.5 3.5"/><path d="M3 8h5a4.5 4.5 0 0 1 4.5 4.5v.5"/></svg>`,
};

/** 一条消息是不是「需要你」。这是顶栏 N 件找你与左侧 2px 竖线的唯一来源。 */
export function isNeed(message) {
	if (!message) return false;
	// 「开始处理…」占位的 status 也是 pending，但它不是待办、不是要老板拍板的东西。
	if (message.processing === true) return false;
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
/**
 * 「过程行」：他在想什么、跑了什么。这些行没有头像，缩进对齐在正文左缘，
 * 归属是**紧随其后的那句话**（见 `app.js` 里 `state.tailEvents` 的搬移）。
 */
export function isEventKind(kind) {
	return kind === "think" || kind === "tool" || kind === "work";
}

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
		if (text.startsWith("$")) return "执行了命令";
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
	return `<div class="row-tools" role="toolbar" aria-label="消息操作"><button class="tool" type="button" data-act="copy" title="复制" aria-label="复制">${ICONS.copy}</button><button class="tool" type="button" data-act="reply" title="引用回复" aria-label="引用回复">${ICONS.reply}</button></div>`;
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
	// 附件画在正文**之前**：图片是这个人的第一句话，正文是补充说明。
	// 放在 `.md` 外面，因为 `.md` 是排版正文的（段落间距、列表标记），不是排图片的。
	// 纯附件消息的正文是服务端写的占位（文件名），读起来像一句正常的话，不用特判。
	const attachments = attachmentsHtml(message.attachments);
	// 纯附件消息的正文是服务端写的占位（「[图片] 宽图.png」）。图片已经画在图里、
	// 文件名已经在文件卡里，再把占位当正文排一遍就是同一件事说两次。
	const placeholderOnly = Boolean(message.attachments?.length) && /^\[(图片|文件)\]\s/.test(raw.trim());
	const text = renderMarkdown(raw);
	const body =
		placeholderOnly
			? ""
			: !FOLD_KINDS.has(message.kind ?? "say") || raw.length <= FOLD_OVER
			? `<div class="md">${text}</div>`
			: `<div class="md fold" data-folded="true">${text}</div><button class="text-btn fold-btn" type="button" data-fold-btn>展开全文（${raw.length} 字）</button>`;
	return `${attachments}${body}`;
}

/* ── say ────────────────────────────────────────────────────────────── */

function sayRow(message, ctx, grouped, cont = false) {
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
		: `<div class="row-head"><span class="row-name">${escapeHtml(
				message.fromLabel ?? "",
			)}</span>${role ? `<span class="row-role">${escapeHtml(role)}</span>` : ""}${
				// 「需要你」放在名字和角色**之后**：一行的读法应该是「谁 · 什么角色 · 要我做什么」，
				// 先喊「需要你」再说谁在说话，读起来像系统的报错。
				need ? '<span class="need-tag">需要你</span>' : ""
			}<span class="row-time">${clockTime(message.at)}</span></div>`;

	const wrap = document.createElement("div");
	wrap.className = "row row-say";
	wrap.dataset.seq = String(message.seq);
	wrap.dataset.grouped = grouped ? "true" : "false";
	if (cont) wrap.dataset.cont = "true";
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

const CHEVRON = `<svg class="ev-chevron" width="10" height="10" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><path d="M4.5 2.5 8 6l-3.5 3.5"/></svg>`;

/**
 * 过程行（想了多久 / 跑了什么命令 / 做了什么）。
 *
 * 一整行都是一句话：句子后面挂细节。所以它是个按钮 —— 点开看原文。
 * 以前这些细节根本看不到：界面上只剩「想了一会儿」，而模型真正在想什么、
 * 那条命令到底跑了什么、输出了多少，全在 `message.text` 里躺着没人给出口。
 *
 * 细节用 `textContent` 写进 `<pre>`，不走 innerHTML：那是原始文本（可能带尖括号），
 * 不是 Markdown，也不该被当成 HTML。
 */
function eventNode(message, text) {
	const row = document.createElement("div");
	row.className = "row row-event";
	row.dataset.seq = String(message.seq);
	row.dataset.kind = message.kind;
	// 静态工具消息只展示「做了什么」（如「执行了命令」），不暴露是谁执行的 —— 匿名化。
	const detail = String(message.text ?? "").trim();
	if (detail === "") {
		row.innerHTML = `<span class="ev"><span class="ev-what">${escapeHtml(text)}</span></span>`;
		return row;
	}
	row.innerHTML = `<button class="ev" type="button" data-act="expand" aria-expanded="false" title="展开看原文"><span class="ev-what">${escapeHtml(
		text,
	)}</span>${CHEVRON}</button><div class="ev-body" hidden><pre></pre></div>`;
	row.querySelector("pre").textContent = detail;
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

/**
 * 处理中指示：某人收到 @他 / 直接发给他的消息后，在他所在频道出现的「开始处理…」**气泡**。
 *
 * 它就是一条普通聊天消息 —— 同一个头像、同一个气泡样式，只是文案是「开始处理…」、
 * 末尾多三个跳动的点，气泡整体极轻微呼吸。被该人真实回复原地覆盖（processing 标记消失、
 * status=done）后，同一个 seq 就地变成普通气泡，不是一条孤立的闪烁条（#92）。
 */
function processingRow(message, ctx, grouped, cont) {
	const row = sayRow(message, ctx, grouped, cont);
	row.classList.add("row-processing");
	row.dataset.kind = "processing";
	const dots = document.createElement("span");
	dots.className = "proc-dots";
	dots.innerHTML = "<i></i><i></i><i></i>";
	// 点跟着文案走：正文最后一段的句尾，不是另起一行。
	const md = row.querySelector(".md");
	const tail = md?.lastElementChild;
	if (tail && tail.tagName === "P") tail.append(dots);
	else if (md) md.append(dots);
	else row.querySelector(".row-body")?.append(dots);
	return row;
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

/** 过程行的短标签，用来做「15 步过程 · 想 3 · 命令 8」这行摘要。 */
export function eventLabel(message) {
	if (message.kind === "think") return "想";
	if (message.kind === "work") return "命令";
	const tool = toolNameOf(message);
	// `run` 的 stdout 会另存一条 `work`（同一次命令），两条都数就会变成「跑 6 · run 6」。
	if (tool === "run" || tool === "bash") return "命令";
	return tool ?? "用工具";
}

/**
 * 把一串过程行收成一个可展开的组。
 *
 * 一个人干一件事能留下十几条 think/tool。全都平铺出来，一屏全是「想了 1s」，
 * 把他真正说的那句话埋掉了 —— 老板的原话是「沟通内容太多了，根本不像正常人之间沟通」。
 * 收成一行，想看细节再点开。
 */
export function wrapEvents(slug, name, nodes, labels = []) {
	const rows = nodes.filter((node) => node.classList?.contains("row-event"));
	if (rows.length <= 1) return nodes;
	const counts = new Map();
	for (const label of labels) counts.set(label, (counts.get(label) ?? 0) + 1);
	const mix = [...counts]
		.sort((left, right) => right[1] - left[1])
		.slice(0, 3)
		.map(([label, count]) => `${escapeHtml(label)} ${count}`)
		.join(" · ");
	const wrap = document.createElement("div");
	wrap.className = "row row-events";
	wrap.dataset.slug = slug ?? "";
	const button = document.createElement("button");
	button.className = "evs";
	button.type = "button";
	button.dataset.act = "expand";
	button.setAttribute("aria-expanded", "false");
	button.innerHTML = `<b>${escapeHtml(name ?? "")}</b> <span class="evs-what">${rows.length} 步过程</span>${
		mix ? ` <span class="evs-mix">${mix}</span>` : ""
	}<svg class="ev-chevron" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg>`;
	const body = document.createElement("div");
	body.className = "evs-body";
	body.hidden = true;
	const inner = document.createElement("div");
	inner.className = "evs-list";
	for (const node of nodes) {
		// 组里的时间分隔线没有意义（本来就在一段连续干活里），只留过程行本身
		if (node.classList?.contains("row-time-divider")) continue;
		inner.append(node);
	}
	body.append(inner);
	wrap.append(button, body);
	return [wrap];
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

	let prevSay = ctx.prev ?? null; // 上一条 say（判断是否同人连发）
	let lastAt = ctx.prev?.at ?? 0; // 上一条被画出来的行的时间
	let thinkRun = null;
	// 过程行先攒着，等「它产出的那句话」出现再一起放。
	//
	// 不攒的话：agent 先想、先执行命令、最后才说，于是「沈舟 想了 1s」出现在沈舟的**头像上方**
	// —— 读起来像是上一句的尾巴，也确实让人认错发言人。攒到他开口之后再放，
	// 三行过程就落在他那句话底下、和正文左缘对齐。
	const pendingEvents = [];
	const queueEvent = (slug, nodes, label) => pendingEvents.push({ slug, nodes, label });
	// 把「连续的同一个人的过程行」收成一组再放。注意要按**整段连续**收，不能逐条收：
	// agent 干一段活会留下十几条独立消息，逐条 wrap 就是十几行「想了 1s」平铺。
	const emitRun = (entries) => {
		if (entries.length === 0) return;
		const slug = entries[0].slug;
		const nodes = [];
		const labels = [];
		for (const entry of entries) {
			nodes.push(...entry.nodes);
			if (entry.label) labels.push(entry.label);
		}
		for (const node of wrapEvents(slug, bySlug.get(slug)?.label ?? slug, nodes, labels)) frag.append(node);
	};
	const flushEvents = (keepSlug) => {
		if (pendingEvents.length === 0) return;
		// 相邻的同一个人的过程行合成一段，段之间保持原来的先后顺序。
		const runs = [];
		const kept = [];
		for (const entry of pendingEvents) {
			if (keepSlug !== undefined && entry.slug === keepSlug) {
				kept.push(entry);
				continue;
			}
			const last = runs[runs.length - 1];
			if (last !== undefined && last.slug === entry.slug) last.entries.push(entry);
			else runs.push({ slug: entry.slug, entries: [entry] });
		}
		for (const run of runs) emitRun(run.entries);
		pendingEvents.length = 0;
		pendingEvents.push(...kept);
	};
	const takeEvents = (slug) => {
		const taken = [];
		const labels = [];
		for (let i = pendingEvents.length - 1; i >= 0; i -= 1) {
			if (pendingEvents[i].slug !== slug) continue;
			taken.unshift(...pendingEvents[i].nodes);
			if (pendingEvents[i].label) labels.unshift(pendingEvents[i].label);
			pendingEvents.splice(i, 1);
		}
		// 一次性收成一组：一段连续干活十几条过程行，展开的时候才看。
		return wrapEvents(slug, bySlug.get(slug)?.label ?? slug, taken, labels);
	};

	for (const message of list) {
		if (!message) continue;

		// think 合并：连续同人、间隔 < 2 分钟 → 一行带秒数
		if (message.kind === "think") {
			if (thinkRun && thinkRun.slug === message.fromSlug && message.at - thinkRun.end <= GROUP_MS) {
				thinkRun.end = message.at;
				const seconds = Math.max(1, Math.round((thinkRun.end - thinkRun.start) / 1000));
				const what = thinkRun.el.querySelector(".ev-what");
				if (what) what.textContent = `想了 ${seconds}s`;
				continue;
			}
			const row = eventNode(message, "想了 1s");
			thinkRun = { slug: message.fromSlug, start: message.at, end: message.at, el: row };
			queueEvent(message.fromSlug, [row], eventLabel(message));
			lastAt = message.at;
			prevSay = null;
			continue;
		}
		thinkRun = null;

		if (message.kind === "tool" || message.kind === "work") {
			const nodes = [...timeSepNodes(message, lastAt ? { at: lastAt } : null), eventNode(message, eventPhrase(message))];
			queueEvent(message.fromSlug, nodes, eventLabel(message));
			lastAt = message.at;
			prevSay = null;
			continue;
		}

		if (message.kind === "note") {
			flushEvents();
			frag.append(noteRow(message));
			lastAt = message.at;
			prevSay = null;
			continue;
		}

		// B（处理中指示）：processing 占位按一条普通聊天消息画（头像 + 气泡，见 processingRow）。
		// 必须在 pending 分支之前拦：占位的 status 也是 pending，不拦就会被画成拍板卡。
		if (message.processing === true) {
			const gap = prevSay === null ? Number.POSITIVE_INFINITY : message.at - prevSay.at;
			const grouped = prevSay !== null && prevSay.fromSlug === message.fromSlug && gap < GROUP_MS && gap >= 0;
			const cont = grouped && gap <= CONT_MS;
			flushEvents(message.fromSlug);
			if (!grouped) {
				for (const sep of timeSepNodes(message, lastAt ? { at: lastAt } : null)) frag.append(sep);
			}
			frag.append(processingRow(message, full, grouped, cont));
			for (const node of takeEvents(message.fromSlug)) frag.append(node);
			flushEvents();
			prevSay = message;
			lastAt = message.at;
			continue;
		}

		if (message.kind === "pending" || message.status === "pending") {
			const row = pendingRow(message, message.at, now);
			if (!row) continue;
			flushEvents();
			for (const sep of timeSepNodes(message, lastAt ? { at: lastAt } : null)) frag.append(sep);
			frag.append(row);
			lastAt = message.at;
			prevSay = null;
			continue;
		}

		// 未登记的 kind：不画。
		if (message.kind != null && !SAY_KINDS.has(message.kind)) continue;

		const gap = prevSay === null ? Number.POSITIVE_INFINITY : message.at - prevSay.at;
		const grouped =
			prevSay !== null &&
			prevSay.fromSlug === message.fromSlug &&
			gap < GROUP_MS &&
			gap >= 0;
		// 比「同一人连发」更紧的一档：半分钟内。再远就不是一段话，是两次说话了。
		const cont = grouped && gap <= CONT_MS;

		flushEvents(message.fromSlug);
		if (!grouped) {
			for (const sep of timeSepNodes(message, lastAt ? { at: lastAt } : null)) frag.append(sep);
		}

		frag.append(sayRow(message, full, grouped, cont));
		// 他自己的过程行跟在他这句话下面（见上面 `pendingEvents` 的注释）。
		for (const node of takeEvents(message.fromSlug)) frag.append(node);
		flushEvents();
		prevSay = message;
		lastAt = message.at;
	}

	flushEvents();
	return frag;
}

/**
 * 只画一条（SSE 推来新消息时用）。
 *
 * `prev` 是这条之前最后一条消息：连发合并、30 分钟时间分隔都靠它判断，
 * 不传的话每条新消息都会重新画一次头像和名字。
 */
export function buildOne(message, ctx = {}, prev = null) {
	return buildStream([message], { ...ctx, prev });
}
