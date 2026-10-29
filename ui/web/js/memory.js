/**
 * 一个人的记忆面板：老板能看见、能删掉、能手动加一条。
 *
 * 为什么要有这个界面：记忆是**不可信的模型**写的，而且它会先进提示词、再进正文。
 * 老板看不见记忆，就等于把「这个人以后会怎么做事」交给了一个没人审的 Markdown。
 * 所以这里必须能读、能删（删要二次确认）、能加，且**分层要看得见**：
 *
 *   1. `digest` —— 真正拼进提示词的目录（有条数 + 字数预算）。
 *   2. `entries` —— 文件里的小节，只有被 recall 到才会进上下文。
 *
 * 两条必须守住的：
 *   - 所有来自记忆文件的文字都过 `escapeHtml` 注入 —— 记忆里有反引号、引号、`<`，
 *     一个 `<img onerror>` 就能拿到整页的控制权。
 *   - 增删都不「整页重刷」：先就地改 DOM，再用服务端那份真相静默对齐。
 *
 * 模块自带挂载：`openMemory` 自己建 DOM 并 append 到 body，不依赖页面上任何预置元素。
 * 样式也自己挂（`ensureCss`），这样接线代码只需要一行。
 */

import { editPersonMemory, personMemory } from "./api.js";
import { clipText } from "./format.js";
import { avatarSvg } from "./avatar.js";
import { withLinger } from "./motion.js";

/* ── 常量 ───────────────────────────────────────────────────────────── */

/** 和后端 `MEMORY_LIMITS.entry` 对齐：一条记忆 300 字。 */
export const MAX_ADD = 300;

/** 超过 4 行先折叠。单行太长（一行顶四行）也折，否则行数判断不到它。 */
const FOLD_LINES = 4;
const FOLD_CHARS = 180;

/** 浮层退出：和 pop-out 同一套手感（motion.css 里退场统一 160–200ms）。 */
const LEAVE_MS = 200;

const CLOSE_ICON = `<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true" focusable="false"><path d="M4 4l8 8M12 4l-8 8"/></svg>`;

/* ── 纯函数（可以被 node 里的单测直接 import） ──────────────────────── */

/**
 * HTML 转义。五个字符全转：这个字符串既要进元素内容也要进属性值。
 * 反引号故意不转 —— 它在 HTML 里没有特殊含义，转了反而让复制出来的正文变形。
 */
export function escapeHtml(text) {
	return String(text ?? "")
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
}

/**
 * 从整份 markdown 里切出小节（和后端 `sectionsOf` 同一条规矩）：
 * `## ` 开头算一条，第一个 `## ` 之前是导语，不算条目。
 */
export function parseEntries(raw) {
	const source = String(raw ?? "");
	const out = [];
	let heading;
	let buffer = [];
	const flush = () => {
		if (heading === undefined) return;
		out.push({ heading, body: buffer.join("\n").trim() });
	};
	for (const line of source.split("\n")) {
		if (line.startsWith("## ")) {
			flush();
			heading = line.slice(3).trim();
			buffer = [];
			continue;
		}
		if (heading !== undefined) buffer.push(line);
	}
	flush();
	return out;
}

/**
 * 本地筛：不区分大小写的子串匹配，标题和正文都算。
 * 空查询返回**副本**（调用方拿到的东西永远不改到原数组）。
 */
export function entryFilter(entries, query) {
	const list = Array.isArray(entries) ? entries : [];
	const needle = String(query ?? "").trim().toLowerCase();
	if (needle === "") return list.slice();
	return list.filter((entry) => `${entry.heading ?? ""}\n${entry.body ?? ""}`.toLowerCase().includes(needle));
}

/** 要不要折叠。行数或长度任一超标就折 —— 长单行没有换行，行数看不出来。 */
export function isLongEntry(body) {
	const text = String(body ?? "");
	return text.split("\n").length > FOLD_LINES || text.length > FOLD_CHARS;
}

/** 提交前夹一次：textarea 的 maxlength 挡得住键盘，挡不住脚本与粘贴绕路。 */
export function clampAdd(text, max = MAX_ADD) {
	// 按字素切：粘贴进来的 emoji 不能被切掉半个（孤立代理会显示成 �）。
	return clipText(String(text ?? "").trim(), max);
}

/**
 * 今天的日期小节标题。
 *
 * 用 **UTC** 而不是本地时区：后端 `appendMemory` 用的是
 * `at.toISOString().slice(0, 10)`，本地时区在跨零点那几小时会切出两个不同的小节。
 */
export function todayHeading(at = new Date()) {
	const date = at instanceof Date ? at : new Date(at);
	if (Number.isNaN(date.getTime())) return "";
	return date.toISOString().slice(0, 10);
}

/**
 * 一个小节里有几条。
 *
 * 「条」在界面上永远是**行数**，不是小节数：后端按 `## 日期` 切段，同一天记的
 * 五件事挤在一个小节里。按小节数显示会告诉老板「记了 10 条」，而实际是 19 条 ——
 * 更糟的是点一次「删掉」会删掉一天里的好几行（这个数字也是删除确认文案的依据）。
 */
export function lineCount(body) {
	return String(body ?? "")
		.split("\n")
		.filter((line) => line.trim() !== "").length;
}

/** 若干小节加起来几行。 */
export function linesOf(entries) {
	const list = Array.isArray(entries) ? entries : [];
	return list.reduce((sum, entry) => sum + Math.max(1, lineCount(entry?.body)), 0);
}

/** 头部那行：「记了 N 条 · 最近 2026-10-28」。条目顺序是文件顺序（最新的在最后）。 */
export function memoryMeta(data) {
	const entries = Array.isArray(data?.entries) ? data.entries : [];
	if (entries.length === 0) return "还没记过东西";
	const total = linesOf(entries);
	const latest = entries[entries.length - 1]?.heading ?? "";
	return latest === "" ? `记了 ${total} 条` : `记了 ${total} 条 · 最近 ${latest}`;
}

/** 计数：没筛时只说总数，筛过要说「总共几条里的几条」。 */
export function countLabel(shown, total) {
	const all = Number(total) || 0;
	const visible = Number(shown) || 0;
	return all === visible ? `${all} 条` : `${all} 条中的 ${visible} 条`;
}

/**
 * 删除确认文案。
 *
 * 后端是按**小节标题**删的，同一天的多条并在一个 `## 日期` 小节里 —— 所以删一条
 * 可能等于删掉那一天的几条。文案必须说实话，不能让人以为只掉了一行。
 */
export function forgetPrompt(heading, entries) {
	const list = Array.isArray(entries) ? entries : [];
	const shared = linesOf(list.filter((entry) => entry.heading === heading));
	return shared > 1 ? `确定删掉「${heading}」这 ${shared} 条？` : "确定删掉这条？";
}

/** 接口/网络错误 → 一句能看懂的中文。api.js 已经把后端的 `{error}` 翻好了。 */
export function errorText(error) {
	const raw = error instanceof Error ? error.message : String(error ?? "");
	const text = raw.trim();
	if (text === "" || /failed to fetch|networkerror|load failed|fetch failed/i.test(text)) {
		return "连不上服务，检查一下它是否还在跑。";
	}
	return text;
}

/* ── 模块状态 ───────────────────────────────────────────────────────── */

let mountRoot = null;
let ui = null;
let state = null;
let opener = null;
let inerted = [];
let cssHooked = false;

/* ── 样式自带 ───────────────────────────────────────────────────────── */

function ensureCss() {
	if (cssHooked || typeof document === "undefined") return;
	const href = new URL("../css/memory.css", import.meta.url).href;
	const already = Array.from(document.querySelectorAll('link[rel="stylesheet"]')).some(
		(link) => link.href === href || (link.getAttribute("href") ?? "").endsWith("css/memory.css"),
	);
	if (!already) {
		const link = document.createElement("link");
		link.rel = "stylesheet";
		link.href = href;
		document.head.append(link);
	}
	cssHooked = true;
}

/* ── 挂载 / 开关 ────────────────────────────────────────────────────── */

/**
 * 可选初始化。`root` 默认 `document.body`。
 * 返回一个收尾函数（组件卸载时调一次，会立刻关掉并摘掉面板）。
 */
export function mountMemory(root) {
	ensureCss();
	if (typeof Element !== "undefined" && root instanceof Element) mountRoot = root;
	return () => closeMemory({ immediate: true });
}

/**
 * 打开某人的记忆面板。自己 fetch，自己建 DOM。
 * @param {{slug:string,label?:string,onClose?:() => void}} spec
 */
export function openMemory(spec = {}) {
	const slug = String(spec.slug ?? "").trim();
	if (slug === "" || typeof document === "undefined") return;
	if (state !== null && ui !== null) {
		if (state.slug === slug) {
			ui.panel.focus();
			return;
		}
		closeMemory({ immediate: true });
	}
	ensureCss();

	opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
	ui = build();
	state = {
		slug,
		label: String(spec.label ?? slug),
		onClose: typeof spec.onClose === "function" ? spec.onClose : null,
		data: null,
		filter: "",
		busy: false,
	};
	ui.name.textContent = state.label;
	ui.av.innerHTML = avatarSvg({ slug, name: state.label, size: 40, state: "idle" });
	ui.hint.textContent = `会记到 ## ${todayHeading()}`;
	(mountRoot ?? document.body).append(ui.root);
	maskBackground(true);
	bind();
	renderSkeleton();
	ui.panel.focus();
	void load({ quiet: false });
}

/** 关掉。`immediate` 只给「换一个人」和卸载用。 */
export function closeMemory(options = {}) {
	const current = state;
	const panel = ui;
	if (current === null || panel === null) return;
	state = null;
	ui = null;
	document.removeEventListener("keydown", onKeydown, true);
	maskBackground(false);

	const done = () => {
		panel.root.remove();
		if (current.onClose !== null) {
			try {
				current.onClose();
			} catch {
				/* 关闭回调不该自己炸掉关闭流程 */
			}
		}
	};
	if (options.immediate === true) done();
	else withLinger(panel.root, LEAVE_MS, done);

	if (opener !== null && opener.isConnected) opener.focus();
	opener = null;
}

/**
 * 打开时把面板之外的 body 子节点全设为 inert：Tab 出不去，读屏也走不进去。
 * 记下是谁被我们改过，关的时候只还原自己动过的那些。
 */
function maskBackground(active) {
	if (typeof document === "undefined" || ui === null) return;
	if (active) {
		for (const child of document.body.children) {
			if (child === ui.root || !(child instanceof HTMLElement)) continue;
			if (child.inert) continue;
			child.inert = true;
			inerted.push(child);
		}
		return;
	}
	for (const child of inerted) child.inert = false;
	inerted = [];
}

/* ── DOM 骨架 ───────────────────────────────────────────────────────── */

function build() {
	const root = document.createElement("div");
	root.className = "mem";
	root.innerHTML = `<div class="mem-scrim" data-act="scrim"></div><aside class="mem-panel" role="dialog" aria-modal="true" aria-labelledby="mem-title" tabindex="-1"><header class="mem-head"><span class="mem-av"></span><span class="mem-who"><h2 class="mem-name" id="mem-title"></h2><span class="mem-meta"></span></span><button class="icon-btn mem-close" type="button" data-act="close" aria-label="关掉" title="关掉（Esc）">${CLOSE_ICON}</button></header><div class="mem-body"><section class="mem-sec"><p class="mem-cap">这一份会进他的提示词（有长度预算），下面的条目不一定进。</p><pre class="mem-digest"></pre></section><section class="mem-sec"><div class="mem-list-head"><input class="mem-filter" type="search" placeholder="按内容筛…" aria-label="按内容筛记忆"><span class="mem-count num"></span></div><div class="mem-list"></div></section></div><form class="mem-add"><div class="mem-add-head"><label class="mem-add-label" for="mem-add-text">手动记一条</label><span class="mem-counter num">0 / ${MAX_ADD}</span></div><textarea class="mem-textarea" id="mem-add-text" rows="2" maxlength="${MAX_ADD}" placeholder="他该记住什么？一句话最好用。"></textarea><p class="mem-add-err" role="alert" hidden></p><div class="mem-add-foot"><span class="mem-add-hint"></span><button class="mem-save" type="submit" disabled>记下</button></div></form></aside>`;

	const refs = {
		root,
		panel: root.querySelector(".mem-panel"),
		av: root.querySelector(".mem-av"),
		name: root.querySelector(".mem-name"),
		meta: root.querySelector(".mem-meta"),
		body: root.querySelector(".mem-body"),
		digest: root.querySelector(".mem-digest"),
		filter: root.querySelector(".mem-filter"),
		count: root.querySelector(".mem-count"),
		list: root.querySelector(".mem-list"),
		form: root.querySelector(".mem-add"),
		text: root.querySelector(".mem-textarea"),
		counter: root.querySelector(".mem-counter"),
		hint: root.querySelector(".mem-add-hint"),
		save: root.querySelector(".mem-save"),
		addErr: root.querySelector(".mem-add-err"),
	};
	return refs;
}

/* ── 事件 ───────────────────────────────────────────────────────────── */

function bind() {
	ui.root.addEventListener("click", onClick);
	ui.filter.addEventListener("input", () => {
		if (state === null) return;
		state.filter = ui.filter.value;
		renderList();
	});
	ui.digest.addEventListener("scroll", markDigestScroll, { passive: true });
	ui.form.addEventListener("submit", (event) => {
		event.preventDefault();
		void addEntry();
	});
	ui.text.addEventListener("input", () => {
		updateCounter();
		hideAddError();
	});
	ui.text.addEventListener("keydown", (event) => {
		// Ctrl/Cmd + Enter 提交；裸 Enter 是换行（正文本来就是多行的）。
		if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
			event.preventDefault();
			void addEntry();
		}
	});
	document.addEventListener("keydown", onKeydown, true);
}

function onClick(event) {
	const target = event.target instanceof Element ? event.target.closest("[data-act]") : null;
	if (target === null || state === null || ui === null) return;
	const act = target.dataset.act;
	if (act === "close" || act === "scrim") {
		closeMemory();
		return;
	}
	if (act === "retry") {
		void load({ quiet: false });
		return;
	}
	if (act === "clear-filter") {
		ui.filter.value = "";
		state.filter = "";
		renderList();
		ui.filter.focus();
		return;
	}
	const row = target.closest(".mem-row");
	if (row === null) return;
	if (act === "fold") {
		const text = row.querySelector(".mem-text");
		if (text === null) return;
		const folded = text.dataset.folded !== "false";
		text.dataset.folded = folded ? "false" : "true";
		target.textContent = folded ? "收起" : "展开";
		return;
	}
	if (act === "forget") {
		const tools = row.querySelector(".mem-tools");
		if (tools === null) return;
		tools.innerHTML = `<span class="mem-ask">${escapeHtml(
			forgetPrompt(row.dataset.heading ?? "", state.data?.entries),
		)}</span><button class="mem-danger" type="button" data-act="confirm">确定</button><button class="text-btn mem-undo" type="button" data-act="cancel">取消</button>`;
		tools.querySelector('[data-act="confirm"]')?.focus();
		return;
	}
	if (act === "cancel") {
		restoreTools(row);
		return;
	}
	if (act === "confirm") {
		void forget(row);
	}
}

function restoreTools(row) {
	const tools = row.querySelector(".mem-tools");
	if (tools === null) return;
	tools.innerHTML = `<button class="mem-del" type="button" data-act="forget">删掉</button>`;
}

function onKeydown(event) {
	if (state === null || ui === null) return;
	if (event.key === "Escape") {
		event.preventDefault();
		event.stopPropagation();
		// 先收掉打开着的确认，再退一步才关面板 —— 一次 Esc 不该同时取消两种状态。
		const confirming = Array.from(ui.root.querySelectorAll(".mem-tools")).filter(
			(tools) => tools.querySelector('[data-act="cancel"]') !== null,
		);
		if (confirming.length > 0) {
			for (const tools of confirming) {
				const row = tools.closest(".mem-row");
				if (row !== null) restoreTools(row);
			}
			return;
		}
		closeMemory();
		return;
	}
	if (event.key !== "Tab") return;
	trapFocus(event);
}

function trapFocus(event) {
	const nodes = Array.from(
		ui.panel.querySelectorAll('button, [href], input, textarea, select, [tabindex]:not([tabindex="-1"])'),
	).filter((node) => !node.disabled && node.offsetParent !== null);
	if (nodes.length === 0) {
		event.preventDefault();
		return;
	}
	const first = nodes[0];
	const last = nodes[nodes.length - 1];
	const active = document.activeElement;
	if (event.shiftKey && (active === first || active === ui.panel)) {
		event.preventDefault();
		last.focus();
	} else if (!event.shiftKey && active === last) {
		event.preventDefault();
		first.focus();
	}
}

/* ── 读 / 画 ────────────────────────────────────────────────────────── */

async function load({ quiet }) {
	const slug = state?.slug;
	if (slug === undefined) return;
	if (!quiet) {
		state.data = null;
		renderSkeleton();
	}
	try {
		const data = await personMemory(slug);
		if (state === null || state.slug !== slug) return;
		const before = state.data;
		state.data = data;
		renderMeta();
		renderDigest();
		if (quiet && before !== null && sameEntries(before.entries, data.entries)) renderCount();
		else renderList();
	} catch (error) {
		if (state === null || state.slug !== slug) return;
		renderError(errorText(error));
	}
}

function sameEntries(left, right) {
	if (!Array.isArray(left) || !Array.isArray(right)) return false;
	if (left.length !== right.length) return false;
	return left.every(
		(entry, index) => entry.heading === right[index].heading && entry.body === right[index].body,
	);
}

function renderSkeleton() {
	ui.meta.textContent = "读他的记忆…";
	ui.digest.dataset.skeleton = "true";
	delete ui.digest.dataset.empty;
	ui.digest.innerHTML = `<span class="mem-sk" style="width:76%"></span><span class="mem-sk" style="width:92%"></span><span class="mem-sk" style="width:48%"></span>`;
	ui.count.textContent = "";
	ui.list.innerHTML = [0, 1, 2]
		.map(
			() =>
				`<div class="mem-row mem-skel"><span class="mem-sk" style="width:64px"></span><span class="mem-sk" style="width:100%"></span><span class="mem-sk" style="width:84%"></span></div>`,
		)
		.join("");
}

function renderMeta() {
	ui.meta.textContent = memoryMeta(state.data);
}

function renderDigest() {
	delete ui.digest.dataset.skeleton;
	const digest = state.data?.digest;
	if (typeof digest !== "string" || digest.trim() === "") {
		ui.digest.dataset.empty = "true";
		ui.digest.textContent = "（还没有目录）";
		return;
	}
	delete ui.digest.dataset.empty;
	// 原样显示：目录里带序号和缩进，重新排版会看不出「哪几条真的在提示词里」。
	ui.digest.textContent = digest;
	markDigestScroll();
}

/**
 * 目录超出高度时，在底部加一层渐隐，告诉人「下面还有」。
 *
 * 为什么不是直接给滚动条：macOS 的滚动条是浮层，不动鼠标不显示 ——
 * 于是「被切了一半的一行字」看起来就是排版坏了，而不是「可以往下滚」。
 * 渐隐是常显的提示，且不占宽度。
 */
function markDigestScroll() {
	const box = ui?.digest;
	if (box === null || box === undefined) return;
	const overflow = box.scrollHeight - box.clientHeight;
	box.dataset.scroll = overflow > 2 ? "true" : "false";
	box.dataset.atEnd = box.scrollTop >= overflow - 2 ? "true" : "false";
}

function renderCount() {
	const all = Array.isArray(state.data?.entries) ? state.data.entries : [];
	const shown = entryFilter(all, state.filter);
	ui.count.textContent = countLabel(shown.length, all.length);
}

function renderError(message) {
	ui.meta.textContent = "没读到";
	delete ui.digest.dataset.skeleton;
	ui.digest.dataset.empty = "true";
	ui.digest.textContent = "（没读到他的记忆）";
	ui.count.textContent = "";
	ui.list.innerHTML = `<div class="mem-err" role="alert"><span>没读到他的记忆：${escapeHtml(
		message,
	)}</span><button class="mem-retry" type="button" data-act="retry">重试</button></div>`;
}

/**
 * 条目列表。显示顺序是**新的在上**（文件里是追加的，最新的在末尾）。
 * 全部重建成字符串而不是逐条 diff：只有几十条，重建比 diff 便宜，也不会留旧节点。
 */
function renderList() {
	if (state === null || ui === null) return;
	const all = Array.isArray(state.data?.entries) ? state.data.entries : [];
	const ordered = all.slice().reverse();
	const shown = entryFilter(ordered, state.filter);
	ui.count.textContent = countLabel(linesOf(shown), linesOf(all));
	// 静默对齐时会整列重建：滚动位置是老板的，别替他归零。
	const scrollTop = ui.body.scrollTop;

	if (all.length === 0) {
		ui.list.innerHTML = `<div class="mem-empty"><p class="mem-empty-main">他还没记下任何东西。</p><p class="mem-empty-sub">任务做完会被自动整理一次，也可以在这里手动加一条。</p></div>`;
		return;
	}
	if (shown.length === 0) {
		ui.list.innerHTML = `<div class="mem-empty"><p class="mem-empty-main">没有匹配「${escapeHtml(
			state.filter,
		)}」的条目。</p><button class="text-btn mem-clear" type="button" data-act="clear-filter">清掉筛选</button></div>`;
		return;
	}
	ui.list.innerHTML = shown.map(rowHtml).join("");
	ui.body.scrollTop = scrollTop;
}

function rowHtml(entry) {
	const heading = String(entry.heading ?? "");
	const body = String(entry.body ?? "");
	const long = isLongEntry(body);
	const lines = lineCount(body);
	return `<article class="mem-row" data-heading="${escapeHtml(heading)}"><header class="mem-row-head"><span class="mem-date num">${
		heading === "" ? "（没写日期）" : escapeHtml(heading)
	}</span>${lines > 1 ? `<span class="mem-lines num">${lines} 条</span>` : ""}<span class="mem-tools"><button class="mem-del" type="button" data-act="forget">删掉</button></span></header><p class="mem-text" data-folded="${
		long ? "true" : "false"
	}">${body === "" ? `<span class="mem-void">（这一条是空的）</span>` : escapeHtml(body)}</p>${
		long ? `<button class="text-btn mem-fold" type="button" data-act="fold">展开</button>` : ""
	}</article>`;
}

/* ── 写 ─────────────────────────────────────────────────────────────── */

function updateCounter() {
	const length = ui.text.value.length;
	ui.counter.textContent = `${length} / ${MAX_ADD}`;
	ui.counter.dataset.over = length >= MAX_ADD ? "true" : "false";
	ui.save.disabled = clampAdd(ui.text.value) === "";
}

function showAddError(message) {
	ui.addErr.textContent = message;
	ui.addErr.hidden = false;
}

function hideAddError() {
	ui.addErr.hidden = true;
	ui.addErr.textContent = "";
}

async function addEntry() {
	if (state === null || ui === null || state.busy) return;
	const text = clampAdd(ui.text.value);
	if (text === "") {
		showAddError("先写点什么再记。");
		return;
	}
	state.busy = true;
	hideAddError();
	setSaveBusy(true);

	// 就地插一条占位：POST 是本地的，但这个面板也可能连着远处的服务。
	const stub = document.createElement("article");
	stub.className = "mem-row mem-row-new";
	stub.innerHTML = `<header class="mem-row-head"><span class="mem-date num">${escapeHtml(
		todayHeading(),
	)}</span><span class="mem-tools"><span class="mem-ask">记下…</span></span></header><p class="mem-text">${escapeHtml(
		text,
	)}</p>`;
	const empty = ui.list.querySelector(".mem-empty");
	if (empty !== null) empty.setAttribute("hidden", "true");
	ui.list.prepend(stub);

	try {
		await editPersonMemory(state.slug, { op: "add", text });
		if (state === null) return;
		ui.text.value = "";
		updateCounter();
		stub.remove();
		// 用服务端那份真相静默对齐（可能并进了当天小节，也可能被去重拒了）。
		await load({ quiet: true });
	} catch (error) {
		if (state === null) return;
		stub.remove();
		renderList();
		showAddError(`没记下：${errorText(error)}`);
	} finally {
		if (state !== null && ui !== null) {
			state.busy = false;
			setSaveBusy(false);
		}
	}
}

function setSaveBusy(busy) {
	ui.save.textContent = busy ? "记…" : "记下";
	ui.save.disabled = busy || clampAdd(ui.text.value) === "";
}

async function forget(row) {
	if (state === null || ui === null || state.busy) return;
	const heading = row.dataset.heading ?? "";
	const tools = row.querySelector(".mem-tools");
	if (tools === null) return;
	state.busy = true;
	row.dataset.busy = "true";
	tools.innerHTML = `<span class="mem-ask">删…</span>`;
	try {
		await editPersonMemory(state.slug, { op: "forget", heading });
		if (state === null) return;
		row.remove();
		await load({ quiet: true });
	} catch (error) {
		if (state === null) return;
		delete row.dataset.busy;
		const current = row.querySelector(".mem-tools");
		if (current !== null) {
			current.innerHTML = `<span class="mem-ask mem-bad">没删掉：${escapeHtml(
				errorText(error),
			)}</span><button class="text-btn" type="button" data-act="forget">再来</button>`;
		}
	} finally {
		if (state !== null) state.busy = false;
	}
}
