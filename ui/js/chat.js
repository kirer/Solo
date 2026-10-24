/**
 * 对话面板。
 *
 * 只负责渲染与交互：数据由 app.js 通过 setActor / setFeed 推下来，
 * 发送与打断回调交回 app.js。消息流按 item 键做前缀比较，只追加新条目，
 * 已展开的 <details>、滚动位置和选中状态不会被整块重绘冲掉。
 */
import {
	clamp,
	clockTime,
	escapeAttr,
	escapeHtml,
	formatTokens,
	initials,
	parseJsonish,
	relTime,
	statusLabel,
	statusOf,
	toolMeta,
} from "./format.js";
import { icon } from "./icons.js";
import { renderMarkdown } from "./markdown.js";

/**
 * 面板宽度变化后，组织图要重算连线。app.js 没有把 org 句柄传进来，
 * 只能等它自己挂到 window.__company.org 上（只在 ?dev 下存在，其余场景靠 resize 事件）。
 */
function refreshOrgLayout() {
	try {
		window.__company?.org?.refreshLayout?.();
	} catch {
		/* 开发钩子不在时忽略 */
	}
}

const $ = (id) => document.getElementById(id);
const MOBILE_QUERY = window.matchMedia("(max-width: 860px)");
const STORAGE_KEY = "ai-company.chat-width";
const WIDTH_DEFAULT = 480;
const WIDTH_MIN = 360;
const WIDTH_MAX = 760;
const NEAR_BOTTOM = 90;
/** 流式 Markdown 重绘间隔：契约要求 ≤80ms。 */
const STREAM_INTERVAL = 70;
const TOAST_MS = 3500;

/* ── 纯函数 ─────────────────────────────────────────────────────────────── */

const plainText = (value) => escapeHtml(String(value ?? "")).replace(/\n/g, "<br>");

const avatarHtml = (label, extraClass = "") =>
	`<span class="avatar ${extraClass}" aria-hidden="true">${escapeHtml(initials(label))}</span>`;

const copyButtonHtml = (label) =>
	`<button class="copy-btn" type="button" data-copy="pane" aria-label="${label}" title="${label}"><span>复制</span></button>`;

const timeOf = (at) => relTime(at) || clockTime(at);

function kindLabel(kind) {
	if (kind === "owner") return "老板通道";
	if (kind === "role") return "高管";
	if (kind === "project") return "项目负责人";
	if (kind === "staff") return "员工";
	return "";
}

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

function elFromHtml(html) {
	const template = document.createElement("template");
	template.innerHTML = html.trim();
	return template.content.firstElementChild;
}

function signatureOf(item) {
	switch (item.kind) {
		case "tool":
			return `tool|${item.name}|${item.args}|${item.output}|${item.state}`;
		case "user":
		case "assistant":
		case "thinking":
		case "note":
		case "alert":
			return `${item.kind}|${item.text}`;
		default:
			return `${item.kind}`;
	}
}

/* ── 面板 ───────────────────────────────────────────────────────────────── */

export function initChat({ onSend, onInterrupt } = {}) {
	const els = {
		chat: $("chat"),
		body: $("chat-body"),
		title: $("chat-title"),
		role: $("chat-role"),
		avatar: $("chat-avatar"),
		pill: $("chat-status"),
		statusText: $("chat-status-text"),
		tokens: $("chat-tokens"),
		fold: $("chat-fold"),
		collapse: $("chat-collapse"),
		close: $("chat-close"),
		input: $("input"),
		send: $("send"),
		form: $("composer"),
		resizer: $("chat-resizer"),
	};
	if (els.chat === null || els.body === null) return {};

	// 抽屉把手、浮层（新消息 / 轻提示）都由聊天自己补，不改外壳 DOM。
	const grab = elFromHtml('<div class="chat-grab" aria-hidden="true"><span></span></div>');
	els.chat.prepend(grab);

	const dock = elFromHtml('<div class="chat-dock"></div>');
	const jump = document.createElement("button");
	jump.type = "button";
	jump.className = "chat-jump";
	jump.hidden = true;
	const toasts = document.createElement("div");
	toasts.className = "chat-toasts";
	toasts.setAttribute("aria-live", "polite");
	dock.append(jump, toasts);
	els.chat.append(dock);

	const stream = document.createElement("div");
	stream.className = "chat-stream";
	els.body.innerHTML = "";
	els.body.append(stream);

	const foot = els.chat.querySelector(".chat-foot");
	if (foot !== null && "ResizeObserver" in window) {
		const observer = new ResizeObserver(() => {
			els.chat.style.setProperty("--foot-h", `${foot.offsetHeight}px`);
		});
		observer.observe(foot);
		els.chat.style.setProperty("--foot-h", `${foot.offsetHeight}px`);
	}

	/* ── 状态 ── */
	let actor = null;
	let feed = null;
	let loading = false;
	let mode = "empty"; // empty | loading | rows
	let rendered = []; // { key, sig, el }
	const openStates = new Map();
	let localQueue = [];
	let localSeq = 0;
	let storedOrg = null;
	let sending = false;
	let newCount = 0;

	// 流式重绘
	let streamTimer = 0;
	let streamPending = null;
	let lastStreamAt = 0;

	/* ── 宽度 ── */
	const maxWidth = () =>
		Math.max(WIDTH_MIN, Math.min(WIDTH_MAX, Math.round(window.innerWidth * 0.6)));

	function readStoredWidth() {
		try {
			const raw = window.localStorage.getItem(STORAGE_KEY);
			if (raw === null) return null;
			const value = Number(raw);
			return Number.isFinite(value) ? value : null;
		} catch {
			return null;
		}
	}

	function storeWidth(value) {
		try {
			window.localStorage.setItem(STORAGE_KEY, String(Math.round(value)));
		} catch {
			/* 隐私模式写不了，忽略 */
		}
	}

	let resizeFrame = 0;
	function announceResize() {
		if (resizeFrame !== 0) return;
		resizeFrame = window.requestAnimationFrame(() => {
			resizeFrame = 0;
			window.dispatchEvent(new Event("resize"));
		});
	}

	function applyWidth(px, persist = false) {
		const value = clamp(Math.round(Number(px) || WIDTH_DEFAULT), WIDTH_MIN, maxWidth());
		document.documentElement.style.setProperty("--chat-w", `${value}px`);
		els.resizer.setAttribute("aria-valuenow", String(value));
		els.resizer.setAttribute("aria-valuemin", String(WIDTH_MIN));
		els.resizer.setAttribute("aria-valuemax", String(maxWidth()));
		if (persist) storeWidth(value);
		announceResize();
		return value;
	}

	function currentWidth() {
		const inline = document.documentElement.style.getPropertyValue("--chat-w");
		if (inline !== "") {
			const value = Number.parseFloat(inline);
			if (Number.isFinite(value)) return value;
		}
		const measured = els.chat.offsetWidth;
		if (measured > 0) return measured;
		return readStoredWidth() ?? WIDTH_DEFAULT;
	}

	function setupResizer() {
		const stored = readStoredWidth();
		if (stored !== null) applyWidth(stored, false);
		else {
			els.resizer.setAttribute("aria-valuemin", String(WIDTH_MIN));
			els.resizer.setAttribute("aria-valuemax", String(maxWidth()));
			window.requestAnimationFrame(() => {
				const width = els.chat.offsetWidth;
				els.resizer.setAttribute("aria-valuenow", String(Math.round(width > 0 ? width : WIDTH_DEFAULT)));
			});
		}

		let drag = null;
		els.resizer.addEventListener("pointerdown", (event) => {
			if (event.button !== 0) return;
			event.preventDefault();
			const startWidth = els.chat.offsetWidth > 0 ? els.chat.offsetWidth : currentWidth();
			drag = { pointerId: event.pointerId, startX: event.clientX, startWidth };
			els.resizer.setPointerCapture(event.pointerId);
			document.body.classList.add("resizing");
		});
		els.resizer.addEventListener("pointermove", (event) => {
			if (drag === null || event.pointerId !== drag.pointerId) return;
			applyWidth(drag.startWidth + (drag.startX - event.clientX), false);
		});
		const finish = (event) => {
			if (drag === null) return;
			if (event !== undefined && event.pointerId !== undefined && event.pointerId !== drag.pointerId) return;
			drag = null;
			document.body.classList.remove("resizing");
			storeWidth(currentWidth());
		};
		els.resizer.addEventListener("pointerup", finish);
		els.resizer.addEventListener("pointercancel", finish);
		els.resizer.addEventListener("lostpointercapture", finish);
		els.resizer.addEventListener("dblclick", () => applyWidth(WIDTH_DEFAULT, true));

		els.resizer.addEventListener("keydown", (event) => {
			const step = event.shiftKey ? 80 : 20;
			let next = currentWidth();
			if (event.key === "ArrowLeft") next += step;
			else if (event.key === "ArrowRight") next -= step;
			else if (event.key === "Home") next = WIDTH_MIN;
			else if (event.key === "End") next = maxWidth();
			else return;
			event.preventDefault();
			applyWidth(next, true);
		});
	}

	window.addEventListener("resize", () => {
		if (isMobile()) return;
		const limit = maxWidth();
		els.resizer.setAttribute("aria-valuemax", String(limit));
		const width = els.chat.offsetWidth;
		if (width > limit) applyWidth(limit, true);
	});

	/* ── 手机抽屉下拉 ── */
	let sheetDrag = null;
	grab.addEventListener("pointerdown", (event) => {
		if (!MOBILE_QUERY.matches || event.button !== 0) return;
		sheetDrag = { pointerId: event.pointerId, startY: event.clientY, dy: 0 };
		grab.setPointerCapture(event.pointerId);
		els.chat.style.transition = "none";
		els.chat.classList.add("is-grabbing");
	});
	grab.addEventListener("pointermove", (event) => {
		if (sheetDrag === null || event.pointerId !== sheetDrag.pointerId) return;
		const dy = Math.max(0, event.clientY - sheetDrag.startY);
		sheetDrag.dy = dy;
		els.chat.style.transform = `translateY(${dy}px)`;
	});
	function endSheetDrag(event) {
		if (sheetDrag === null) return;
		if (event !== undefined && event.pointerId !== undefined && event.pointerId !== sheetDrag.pointerId) return;
		const dy = sheetDrag.dy;
		sheetDrag = null;
		els.chat.classList.remove("is-grabbing");
		const close = dy > Math.min(140, els.chat.offsetHeight * 0.18);
		els.chat.style.transition = "transform 220ms cubic-bezier(0.22, 1, 0.36, 1)";
		els.chat.style.transform = close ? "translateY(100%)" : "translateY(0)";
		window.setTimeout(() => {
			els.chat.style.transition = "";
			els.chat.style.transform = "";
			if (close) closeSheet();
		}, 230);
	}
	grab.addEventListener("pointerup", endSheetDrag);
	grab.addEventListener("pointercancel", endSheetDrag);
	grab.addEventListener("lostpointercapture", endSheetDrag);

	/* ── 头部 ── */
	function actorState() {
		if (feed !== null) {
			if (feed.busy) return "busy";
			if (feed.awaitingOwner) return "waiting";
		}
		if (actor === null) return "idle";
		return statusOf(actor);
	}

	function syncHeader() {
		if (actor === null) {
			els.title.textContent = "选择一位同事";
			els.role.textContent = "组织图里点任意卡片，对话就在这里";
			els.avatar.textContent = "·";
			els.pill.dataset.state = "idle";
			els.statusText.textContent = "空闲";
			els.tokens.textContent = "";
			els.tokens.title = "";
			els.input.placeholder = "说点什么…";
			els.input.disabled = true;
			updateSendState();
			return;
		}

		els.title.textContent = actor.label;
		const parts = [actor.subtitle, actor.projectName].filter(
			(part) => typeof part === "string" && part.trim() !== "",
		);
		els.role.textContent = parts.join(" · ") || kindLabel(actor.kind);
		els.avatar.textContent = initials(actor.label);

		const state = actorState();
		els.pill.dataset.state = state;
		els.statusText.textContent = state === "waiting" ? "待你拍板" : statusLabel(state);

		const total = Number(feed?.tokens ?? actor.tokens ?? 0);
		els.tokens.textContent = `${formatTokens(total)} tokens`;
		els.tokens.title = `${total} tokens`;

		els.input.placeholder = `对 ${actor.label} 说点什么…`;
		els.input.disabled = false;
		updateSendState();
	}

	function updateSendState() {
		els.send.disabled = actor === null || els.input.value.trim() === "";
	}

	/* ── 工作过程折叠 ── */
	function updateFold() {
		const details = [...stream.querySelectorAll("details")];
		const visible = actor !== null && details.length > 0;
		els.fold.hidden = !visible;
		if (!visible) {
			els.fold.dataset.state = "closed";
			els.fold.setAttribute("aria-expanded", "false");
			return;
		}
		const allOpen = details.every((element) => element.open);
		els.fold.dataset.state = allOpen ? "open" : "closed";
		els.fold.setAttribute("aria-expanded", String(allOpen));
		els.fold.title = allOpen ? "收起全部工作过程" : "展开全部工作过程";
		els.fold.setAttribute("aria-label", els.fold.title);
	}

	els.fold.addEventListener("click", () => {
		const details = [...stream.querySelectorAll("details")];
		if (details.length === 0) return;
		const open = !details.every((element) => element.open);
		for (const element of details) {
			element.open = open;
			if (element.dataset.key !== undefined) openStates.set(element.dataset.key, open);
		}
		updateFold();
		if (isNearBottom()) scrollToBottom();
	});

	/* ── 新消息 / 轻提示 ── */
	function isNearBottom() {
		return els.body.scrollHeight - els.body.scrollTop - els.body.clientHeight < NEAR_BOTTOM;
	}

	function scrollToBottom(behavior = "auto") {
		const smooth = behavior === "smooth" && !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
		window.requestAnimationFrame(() => {
			els.body.scrollTo({ top: els.body.scrollHeight, behavior: smooth ? "smooth" : "auto" });
		});
	}

	function hideJump() {
		newCount = 0;
		jump.hidden = true;
		jump.innerHTML = "";
	}

	function showJump() {
		if (newCount <= 0) return;
		jump.innerHTML = `${icon("arrowDown", 12)}<span>${newCount} 条新消息</span>`;
		jump.hidden = false;
	}

	jump.addEventListener("click", () => {
		hideJump();
		scrollToBottom("smooth");
	});

	els.body.addEventListener(
		"scroll",
		() => {
			if (newCount > 0 && isNearBottom()) hideJump();
		},
		{ passive: true },
	);

	function notify(text, tone = "info") {
		const value = String(text ?? "").trim();
		if (value === "") return;
		const toast = document.createElement("div");
		toast.className = "chat-toast";
		toast.dataset.tone = tone === "warn" || tone === "error" ? tone : "info";
		toast.textContent = value;
		toasts.append(toast);
		while (toasts.children.length > 3) toasts.firstElementChild.remove();
		window.setTimeout(() => {
			toast.classList.add("is-out");
			window.setTimeout(() => toast.remove(), 200);
		}, TOAST_MS);
	}

	/* ── 行生成 ── */
	function buildRows() {
		const rows = [];
		if (actor === null) return rows;

		if (feed !== null) {
			feed.items.forEach((item, index) => {
				rows.push({ key: `it:${index}:${item.kind}`, kind: item.kind, sig: signatureOf(item), item });
			});
			if (feed.thinking) {
				const item = { kind: "thinking", live: true, text: feed.thinking };
				rows.push({ key: "live:thinking", kind: "thinking", sig: `live|${feed.thinking}`, item });
			}
			for (const [index, tool] of (feed.running ?? []).entries()) {
				const item = {
					kind: "tool",
					live: true,
					name: tool.name,
					args: tool.args,
					output: "",
					state: "running",
					collapsible: false,
				};
				rows.push({
					key: `live:tool:${index}`,
					kind: "tool",
					sig: `live|${tool.name}|${tool.args}`,
					item,
				});
			}
			if (feed.streaming) {
				const item = { kind: "assistant", live: true, text: feed.streaming };
				rows.push({ key: "live:streaming", kind: "assistant", sig: `stream|${feed.streaming}`, item });
			}
			for (const queued of feed.queued ?? []) {
				const item = { kind: "queued", ...queued };
				rows.push({
					key: `queued:${queued.id}`,
					kind: "queued",
					sig: `queued|${queued.text}|${queued.mode}`,
					item,
				});
			}
		}

		for (const local of localQueue) {
			const item = { kind: "localqueued", ...local };
			rows.push({
				key: `local:${local.seq}`,
				kind: "localqueued",
				sig: `local|${local.text}`,
				item,
			});
		}
		return rows;
	}

	function createRow(row) {
		const item = row.item;
		let el;
		switch (item.kind) {
			case "user":
				el = elFromHtml(
					`<div class="msg msg--user"><div class="bubble" title="${escapeAttr(timeOf(item.at))}">${plainText(item.text)}</div></div>`,
				);
				break;
			case "assistant":
				el = renderAssistant(item);
				break;
			case "thinking":
				el = renderThinking(item);
				break;
			case "tool":
				el = renderTool(item);
				break;
			case "note":
				el = elFromHtml(`<div class="note"><span class="note-text">${plainText(item.text)}</span></div>`);
				break;
			case "alert":
				el = elFromHtml(
					`<div class="alert" role="note">${icon("alert", 13)}<span class="alert-text">${plainText(item.text)}</span></div>`,
				);
				break;
			case "queued":
			case "localqueued":
				el = renderQueued(item);
				break;
			default:
				el = elFromHtml(`<div class="note"><span class="note-text">${plainText(item.text ?? "")}</span></div>`);
		}

		el.dataset.key = row.key;
		if (el.tagName === "DETAILS") {
			if (openStates.has(row.key)) el.open = openStates.get(row.key);
			else if (row.kind === "thinking" && item.live === true) el.open = true;
		}
		return el;
	}

	function renderAssistant(item) {
		const live = item.live === true;
		const who = actor?.label ?? "助手";
		const el = elFromHtml(`
			<div class="msg msg--assistant${live ? " is-streaming" : ""}">
				<div class="msg-head">
					${avatarHtml(who, "avatar--sm")}
					<span class="msg-who">${escapeHtml(who)}</span>
					<span class="msg-time mono" title="${escapeAttr(clockTime(item.at))}">${escapeHtml(live ? "刚刚" : timeOf(item.at))}</span>
					${live ? '<span class="msg-live"><i></i>正在输出</span>' : ""}
					<button class="msg-copy" type="button" data-copy="message" aria-label="复制回答" title="复制回答"><span>复制</span></button>
				</div>
				<div class="md">${renderMarkdown(item.text)}</div>
			</div>`);
		el.dataset.raw = String(item.text ?? "");
		return el;
	}

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

	function renderQueued(item) {
		const local = item.kind === "localqueued";
		// 别的 agent 派来的任务不是老板的消息：不能显示成「插话/追加」，
		// 也不能给「立即处理」——那会把别人的任务当成老板的话重投一遍。
		const delegated = item.origin === "agent";
		const mode = delegated ? "" : item.mode === "steer" ? "插话" : item.mode === "followUp" ? "追加" : "";
		const head = local
			? "已发出，等待进入对话"
			: delegated
				? `由 ${item.from ?? "协作方"} 派来`
				: "排队中";
		const actions = delegated
			? '<span class="queued-hint">当前这轮结束后自动处理</span>'
			: '<button class="queued-act" type="button" data-interrupt>立即处理</button>';
		const el = elFromHtml(`
			<div class="queued${local ? " queued--local" : ""}${delegated ? " queued--agent" : ""}">
				<div class="queued-head">
					<i></i><span>${head}</span>
					${mode === "" ? "" : `<span class="queued-mode">${mode}</span>`}
				</div>
				<div class="queued-text">${plainText(item.text)}</div>
				<div class="queued-actions">${actions}</div>
			</div>`);
		el.dataset.text = String(item.text ?? "");
		el.dataset.origin = delegated ? "agent" : "owner";
		return el;
	}

	/* ── 增量更新 ── */
	function patchRow(record, row) {
		const el = record.el;
		const item = row.item;
		switch (row.kind) {
			case "assistant":
				patchAssistant(el, item);
				break;
			case "thinking":
				patchThinking(el, item);
				break;
			case "tool":
				patchTool(el, item);
				break;
			case "user": {
				const bubble = el.querySelector(".bubble");
				if (bubble !== null) bubble.innerHTML = plainText(item.text);
				break;
			}
			case "note": {
				const target = el.querySelector(".note-text");
				if (target !== null) target.innerHTML = plainText(item.text);
				break;
			}
			case "alert": {
				const target = el.querySelector(".alert-text");
				if (target !== null) target.innerHTML = plainText(item.text);
				break;
			}
			case "queued":
			case "localqueued": {
				el.dataset.text = String(item.text ?? "");
				const target = el.querySelector(".queued-text");
				if (target !== null) target.innerHTML = plainText(item.text);
				const mode = item.mode === "steer" ? "插话" : item.mode === "followUp" ? "追加" : "";
				const modeEl = el.querySelector(".queued-mode");
				if (modeEl !== null) modeEl.textContent = mode;
				break;
			}
			default:
				break;
		}
	}

	function patchAssistant(el, item) {
		const live = item.live === true;
		el.classList.toggle("is-streaming", live);
		el.dataset.raw = String(item.text ?? "");
		const md = el.querySelector(".md");
		const head = el.querySelector(".msg-head");
		const time = el.querySelector(".msg-time");
		if (time !== null) time.textContent = live ? "刚刚" : timeOf(item.at);
		let marker = el.querySelector(".msg-live");
		if (live && marker === null) {
			marker = elFromHtml('<span class="msg-live"><i></i>正在输出</span>');
			const copy = head?.querySelector(".msg-copy") ?? null;
			head?.insertBefore(marker, copy);
		} else if (!live && marker !== null) {
			marker.remove();
		}
		if (md !== null) {
			if (live) scheduleStream(md, item.text);
			else md.innerHTML = renderMarkdown(item.text);
		}
	}

	function patchThinking(el, item) {
		const live = item.live === true;
		if (live) el.setAttribute("data-live", "true");
		else el.removeAttribute("data-live");
		const kicker = el.querySelector(".think-kicker");
		const meta = el.querySelector(".think-meta");
		const body = el.querySelector(".think-body");
		if (kicker !== null) kicker.textContent = live ? "正在思考" : "思考";
		if (meta !== null) meta.textContent = `· ${item.text.length} 字`;
		if (body !== null) body.innerHTML = plainText(item.text);
	}

	function patchTool(el, item) {
		const meta = toolMeta(item.name, item.args);
		const state = toolStateOf(item);
		el.dataset.state = state;
		const iconBox = el.querySelector(".tool-icon");
		const label = el.querySelector(".tool-label");
		const detail = el.querySelector(".tool-detail");
		const stateEl = el.querySelector(".tool-state");
		const summary = argsSummary(item);
		if (iconBox !== null) iconBox.innerHTML = icon(meta.icon, 13);
		if (label !== null) label.textContent = meta.label;
		if (detail !== null) {
			detail.textContent = summary;
			detail.title = summary;
		}
		if (stateEl !== null) {
			stateEl.dataset.state = state;
			stateEl.textContent = stateTextOf(state);
		}
		fillToolPanes(el, item);
	}

	function scheduleStream(md, text) {
		streamPending = { md, text };
		if (streamTimer !== 0) return;
		const wait = Math.max(16, STREAM_INTERVAL - (Date.now() - lastStreamAt));
		streamTimer = window.setTimeout(flushStream, wait);
	}

	function flushStream() {
		streamTimer = 0;
		lastStreamAt = Date.now();
		if (streamPending === null) return;
		const { md, text } = streamPending;
		streamPending = null;
		if (!md.isConnected) return;
		md.innerHTML = renderMarkdown(text);
		if (isNearBottom()) scrollToBottom();
	}

	function resetStream() {
		if (streamTimer !== 0) window.clearTimeout(streamTimer);
		streamTimer = 0;
		streamPending = null;
	}

	function updateRows() {
		const rows = buildRows();

		if (rows.length === 0) {
			rendered = [];
			showPlaceholder();
			syncHeader();
			updateFold();
			return;
		}

		if (mode !== "rows") {
			stream.innerHTML = "";
			rendered = [];
			mode = "rows";
		}

		const near = isNearBottom();
		const hadRows = rendered.length > 0;

		let common = 0;
		while (
			common < rendered.length &&
			common < rows.length &&
			rendered[common].key === rows[common].key
		) {
			common += 1;
		}

		for (let index = rendered.length - 1; index >= common; index -= 1) {
			const record = rendered[index];
			if (record.key === "live:streaming") resetStream();
			record.el.remove();
		}
		rendered.length = common;

		for (let index = 0; index < common; index += 1) {
			const record = rendered[index];
			const row = rows[index];
			if (record.sig === row.sig) continue;
			patchRow(record, row);
			record.sig = row.sig;
		}

		let appendedMessages = 0;
		for (let index = common; index < rows.length; index += 1) {
			const row = rows[index];
			const el = createRow(row);
			stream.append(el);
			rendered.push({ key: row.key, sig: row.sig, el });
			const isMessage = row.kind === "user" || row.kind === "note" || row.kind === "alert";
			const isCommittedAssistant = row.kind === "assistant" && row.item.live !== true;
			if (hadRows && (isMessage || isCommittedAssistant)) appendedMessages += 1;
		}

		if (!hadRows || near) scrollToBottom();
		else if (appendedMessages > 0) {
			newCount += appendedMessages;
			showJump();
		}

		syncHeader();
		updateFold();
	}

	/* ── 空状态 / 加载 ── */
	function showPlaceholder() {
		if (actor === null) {
			mode = "empty";
			stream.innerHTML = `
				<div class="chat-empty chat-empty--idle">
					<b>选一个人，开始对话</b>
					<p>组织图里点任意卡片，这里的对话会跟着切换。</p>

				</div>`;
			return;
		}
		if (loading || feed === null) {
			mode = "loading";
			stream.innerHTML = `
				<div class="chat-loading" role="status" aria-live="polite">
					<div class="chat-loading-head">
						<span class="chat-spinner" aria-hidden="true"></span>
						<span class="chat-loading-text">正在同步对话…</span>
					</div>
					<div class="chat-loading-rows" aria-hidden="true">
						<span class="sk sk--1"></span>
						<span class="sk sk--2"></span>
						<span class="sk sk--3"></span>
						<span class="sk sk--4"></span>
					</div>
				</div>`;
			return;
		}
		mode = "empty";
		stream.innerHTML = `
			<div class="chat-empty">
				<b>还没有对话</b>
				<p>有什么要交给 ${escapeHtml(actor.label)} 的，直接说。</p>

			</div>`;
	}

	/* ── 会话状态 ── */
	function resetConversation() {
		resetStream();
		feed = null;
		loading = false;
		rendered = [];
		openStates.clear();
		localQueue = [];
		mode = "none";
		stream.innerHTML = "";
		hideJump();
		els.body.scrollTop = 0;
		if (actor === null) showPlaceholder();
	}

	function setActor(next) {
		const value = next ?? null;
		const changed =
			actor === null ||
			value === null ||
			actor.conversationId !== value.conversationId ||
			actor.kind !== value.kind;
		actor = value;
		if (changed) {
			resetConversation();
			if (actor !== null) showPlaceholder();
		}
		syncHeader();
		updateFold();
	}

	function setLoading() {
		loading = true;
		feed = null;
		resetStream();
		rendered = [];
		openStates.clear();
		localQueue = [];
		mode = "none";
		stream.innerHTML = "";
		hideJump();
		els.body.scrollTop = 0;
		showPlaceholder();
		syncHeader();
		updateFold();
	}

	function setFeed(next) {
		if (next === null || typeof next !== "object") return;
		if (actor === null) return;
		if (Number(next.conversationId) !== Number(actor.conversationId)) return;
		feed = next;
		loading = false;
		reconcileLocalQueue(next);
		updateRows();
	}

	function clear() {
		actor = null;
		feed = null;
		loading = false;
		rendered = [];
		openStates.clear();
		localQueue = [];
		mode = "none";
		resetStream();
		stream.innerHTML = "";
		hideJump();
		els.body.scrollTop = 0;
		showPlaceholder();
		syncHeader();
		updateFold();
	}

	function reconcileLocalQueue(source) {
		if (localQueue.length === 0) return;
		const texts = new Set();
		for (const item of source.items ?? []) {
			if (item.kind === "user") texts.add(String(item.text ?? "").trim());
		}
		for (const queued of source.queued ?? []) texts.add(String(queued.text ?? "").trim());
		if (texts.size === 0) return;
		localQueue = localQueue.filter((entry) => !texts.has(entry.text.trim()));
	}

	function addLocalQueued(text) {
		const value = String(text ?? "").trim();
		if (value === "") return;
		const entry = { seq: (localSeq += 1), text: value, at: Date.now() };
		localQueue.push(entry);
		updateRows();
		scrollToBottom();
		window.setTimeout(() => removeLocalQueued(entry.seq), 30_000);
	}

	function removeLocalQueued(seq) {
		const before = localQueue.length;
		localQueue = localQueue.filter((entry) => entry.seq !== seq);
		if (localQueue.length !== before) updateRows();
	}

	function removeLocalQueuedByText(text) {
		const value = String(text ?? "").trim();
		for (let index = localQueue.length - 1; index >= 0; index -= 1) {
			if (localQueue[index].text.trim() === value) {
				removeLocalQueued(localQueue[index].seq);
				return;
			}
		}
	}

	function findActorIn(org, conversationId) {
		if (org === null || org === undefined) return null;
		if (org.ceo?.conversationId === conversationId) return org.ceo;
		for (const role of org.roles ?? []) {
			if (role.conversationId === conversationId) return role;
		}
		for (const project of org.projects ?? []) {
			if (project.lead?.conversationId === conversationId) {
				return { ...project.lead, projectName: project.name };
			}
			for (const person of project.staff ?? []) {
				if (person.conversationId === conversationId) {
					return { ...person, projectName: project.name };
				}
			}
		}
		return null;
	}

	function updateOrg(org) {
		storedOrg = org ?? null;
		if (actor === null || storedOrg === null) return;
		const next = findActorIn(storedOrg, actor.conversationId);
		if (next !== null) setActor(next);
	}

	/* ── 面板开合 ── */
	function isMobile() {
		return MOBILE_QUERY.matches;
	}

	function setChatOpen(open) {
		document.body.dataset.chat = open ? "open" : "closed";
		announceResize();
		window.setTimeout(announceResize, 300);
	}

	function collapseDesktop() {
		setChatOpen(false);
		const rail = document.querySelector('[data-rail="chat"]');
		window.setTimeout(() => {
			if (document.body.dataset.chat === "closed" && rail instanceof HTMLElement) {
				rail.focus({ preventScroll: true });
			}
		}, 300);
	}

	function expand() {
		if (isMobile()) {
			openSheet();
			return;
		}
		setChatOpen(true);
	}

	function openSheet() {
		els.chat.style.transition = "";
		els.chat.style.transform = "";
		document.body.dataset.sheet = "open";
	}

	function closeSheet() {
		els.chat.style.transition = "";
		els.chat.style.transform = "";
		document.body.dataset.sheet = "closed";
	}

	function toggle() {
		if (isMobile()) {
			if (document.body.dataset.sheet === "open") closeSheet();
			else openSheet();
			return;
		}
		if (document.body.dataset.chat === "closed") expand();
		else collapseDesktop();
	}

	els.collapse.addEventListener("click", collapseDesktop);
	els.close.addEventListener("click", closeSheet);
	document.addEventListener("keydown", (event) => {
		if (event.key !== "Escape" || !isMobile()) return;
		if (document.body.dataset.sheet === "open") {
			event.preventDefault();
			closeSheet();
		}
	});

	/* ── 复制 / 立即处理 ── */
	async function copyText(text) {
		try {
			if (navigator.clipboard?.writeText !== undefined) {
				await navigator.clipboard.writeText(text);
				return true;
			}
		} catch {
			/* 落到 execCommand */
		}
		try {
			const helper = document.createElement("textarea");
			helper.className = "copy-helper";
			helper.value = text;
			helper.setAttribute("readonly", "");
			document.body.append(helper);
			helper.select();
			const ok = document.execCommand("copy");
			helper.remove();
			return ok;
		} catch {
			return false;
		}
	}

	function flashCopied(button) {
		const label = button.querySelector("span");
		const original = label?.textContent ?? button.textContent;
		button.classList.add("is-copied");
		if (label !== null && label !== undefined) label.textContent = "已复制";
		else button.textContent = "已复制";
		if (button._copyTimer !== undefined) window.clearTimeout(button._copyTimer);
		button._copyTimer = window.setTimeout(() => {
			button.classList.remove("is-copied");
			if (label !== null && label !== undefined) label.textContent = "复制";
			else button.textContent = original;
		}, 1400);
	}

	async function handleCopy(button) {
		const modeOf = button.dataset.copy;
		let text = "";
		if (modeOf === "code") {
			text = button.closest(".md-code")?.querySelector("pre code")?.textContent ?? "";
		} else if (modeOf === "message") {
			text = button.closest(".msg--assistant")?.dataset.raw ?? "";
		} else if (modeOf === "pane") {
			text = button.closest(".tool-pane")?.querySelector("pre")?.textContent ?? "";
		}
		if (text === "") return;
		const ok = await copyText(text);
		if (!ok) {
			notify("复制失败，请手动选择文本。", "error");
			return;
		}
		flashCopied(button);
	}

	async function handleInterrupt(button) {
		const row = button.closest(".queued");
		if (row === null || actor === null) return;
		// 只处理老板自己的排队消息；agent 派来的任务不能当成老板的话重投
		if (row.dataset.origin === "agent") return;
		const text = row.dataset.text ?? row.querySelector(".queued-text")?.textContent ?? "";
		if (text.trim() === "") return;
		button.disabled = true;
		button.textContent = "处理中…";
		let ok = false;
		try {
			if (typeof onInterrupt === "function") {
				ok = (await onInterrupt(actor.conversationId, text)) === true;
			}
		} catch {
			ok = false;
		}
		if (ok) {
			notify("已插话，等它收尾就处理这条。", "info");
			if (row.classList.contains("queued--local")) removeLocalQueuedByText(text);
		} else {
			button.disabled = false;
			button.textContent = "立即处理";
		}
	}

	els.body.addEventListener("click", (event) => {
		const button = event.target.closest("button");
		if (button === null) return;
		if (button.hasAttribute("data-interrupt")) {
			void handleInterrupt(button);
			return;
		}
		if (button.hasAttribute("data-copy")) void handleCopy(button);
	});

	// 记住手动展开/收起的 details（toggle 不冒泡，用捕获阶段监听）
	els.body.addEventListener(
		"toggle",
		(event) => {
			const target = event.target;
			if (target instanceof HTMLElement && target.tagName === "DETAILS" && target.dataset.key !== undefined) {
				openStates.set(target.dataset.key, target.open);
				updateFold();
			}
		},
		true,
	);

	/* ── 输入区 ── */
	function autoGrow() {
		els.input.style.height = "auto";
		const height = clamp(els.input.scrollHeight, 38, 160);
		els.input.style.height = `${height}px`;
	}

	async function submit() {
		if (sending || actor === null) return;
		const raw = els.input.value;
		const text = raw.trim();
		if (text === "") return;
		sending = true;
		els.input.value = "";
		autoGrow();
		updateSendState();
		let ok = false;
		try {
			if (typeof onSend === "function") ok = (await onSend(text)) === true;
		} catch {
			ok = false;
		} finally {
			sending = false;
		}
		if (!ok) {
			// app.js 会先乐观排队；失败时把本地留痕和输入还原，别让用户以为发出去了
			removeLocalQueuedByText(text);
			if (els.input.value.trim() === "") {
				els.input.value = raw;
				autoGrow();
				updateSendState();
			}
		} else {
			scrollToBottom();
		}
	}

	els.form.addEventListener("submit", (event) => {
		event.preventDefault();
		void submit();
	});

	els.input.addEventListener("keydown", (event) => {
		if (event.key !== "Enter" || event.shiftKey) return;
		if (event.isComposing || event.keyCode === 229) return;
		event.preventDefault();
		void submit();
	});

	els.input.addEventListener("input", () => {
		autoGrow();
		updateSendState();
	});

	/* ── 启动 ── */
	setupResizer();
	autoGrow();
	syncHeader();
	showPlaceholder();
	updateFold();

	return {
		setActor,
		setFeed,
		setLoading,
		clear,
		addLocalQueued,
		notify,
		toggle,
		openSheet,
		closeSheet,
		expand,
		updateOrg,
	};
}
