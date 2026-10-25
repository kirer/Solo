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
import { initProfile } from "./profile.js";
import { splitOptionsFromText } from "./ask.js";

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
/** 本地留痕的兜底寿命：超过它还没有真实 user 条目，就把「没收到推送」说清楚。 */
const LOCAL_ECHO_MS = 30_000;
/** 附件上限与后端保持一致（20 MiB）。 */
const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;

/* ── 纯函数 ─────────────────────────────────────────────────────────────── */

const plainText = (value) => escapeHtml(String(value ?? "")).replace(/\n/g, "<br>");

/**
 * 发言人：后端给 ActorRef（{ label, kind, conversationId }），没给就按契约降级。
 * 名字永远不空着——空字符串会让一条消息看起来没有主人。
 */
function actorRefOf(ref, fallbackLabel, fallbackKind = "system") {
	const label = String(ref?.label ?? "").trim();
	const kind = String(ref?.kind ?? "").trim();
	return {
		label: label === "" ? fallbackLabel : label,
		kind: kind === "" ? fallbackKind : kind,
	};
}

/** 名字 chip：整条消息唯一的边框标识，不再额外放头像方块。 */
const whoChipHtml = (who, time) => {
	const timeHtml = time === "" ? "" : `<span class="who-time mono">${escapeHtml(time)}</span>`;
	return `<span class="who-chip" data-kind="${escapeAttr(who.kind)}"><span class="who-name">${escapeHtml(
		who.label,
	)}</span>${timeHtml}</span>`;
};

/** 工作过程（思考 / 工具）里的发言人：纯文字，不再加第二个边框。 */
const workWhoHtml = (who) =>
	`<span class="work-who" title="发言人">${escapeHtml(who.label)}</span>`;

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

/** 文件大小：保持短，托盘里一行放得下。 */
function formatBytes(value) {
	const size = Number(value);
	if (!Number.isFinite(size) || size <= 0) return "";
	if (size < 1024) return `${size} B`;
	if (size < 1024 * 1024) return `${(size / 1024).toFixed(size < 10 * 1024 ? 1 : 0)} KB`;
	return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

/** 只读附件 chip（历史消息里回显）。 */
function attachmentChipsHtml(list) {
	if (!Array.isArray(list) || list.length === 0) return "";
	const chips = list
		.map((item) => {
			const name = String(item?.name ?? "附件");
			const size = formatBytes(item?.size);
			const image = typeof item?.mime === "string" && item.mime.startsWith("image/");
			const iconHtml =
				image && typeof item?.url === "string" && item.url !== ""
					? `<img class="attach-thumb" src="${escapeAttr(item.url)}" alt="">`
					: `<span class="attach-glyph">${icon("file", 14)}</span>`;
			return `<span class="attach-chip attach-chip--readonly" title="${escapeAttr(name)}">
				${iconHtml}
				<span class="attach-name">${escapeHtml(name)}</span>
				${size === "" ? "" : `<span class="attach-size mono">${escapeHtml(size)}</span>`}
			</span>`;
		})
		.join("");
	return `<div class="attach-list">${chips}</div>`;
}

function signatureOf(item) {
	switch (item.kind) {
		case "tool":
			return `tool|${item.name}|${item.args}|${item.output}|${item.state}`;
		case "user":
			return `user|${item.text}|${item.from?.label ?? ""}|${item.from?.kind ?? ""}|${attachmentsSigOf(
				item.attachments,
			)}`;
		case "note":
			return `note|${item.text}|${item.from?.label ?? ""}|${item.to?.label ?? ""}`;
		case "assistant":
		case "thinking":
			return `${item.kind}|${item.text}|${item.latest === true ? "latest" : ""}`;
		case "alert":
			return `alert|${item.text}|${item.from?.label ?? ""}`;
		default:
			return `${item.kind}`;
	}
}

/** 附件签名的稳定表示（只用于判断要不要 patch，不参与展示）。 */
function attachmentsSigOf(list) {
	if (!Array.isArray(list) || list.length === 0) return "";
	return list.map((item) => `${item?.id ?? ""}:${item?.name ?? ""}`).join(",");
}

/* ── 面板 ───────────────────────────────────────────────────────────────── */

// ADR-026 决策 7：界面不再提供二次点击确认（原 onInterrupt 已废，受理无条件）。
export function initChat({ onSend, uploadFile, fetchProfile } = {}) {
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
		dock: $("chat-dock"),
		tray: $("attach-tray"),
		attach: $("attach"),
		fileInput: $("file-input"),
		mention: $("mention-pop"),
	};
	if (els.chat === null || els.body === null) return {};

	// 抽屉把手、轻提示浮层都由聊天自己补，不改外壳 DOM。
	// 注意：档案 dock (#chat-dock) 归 index.html，这里的浮层是另一个容器。
	const grab = elFromHtml('<div class="chat-grab" aria-hidden="true"><span></span></div>');
	els.chat.prepend(grab);

	const float = elFromHtml('<div class="chat-float"></div>');
	const jump = document.createElement("button");
	jump.type = "button";
	jump.className = "chat-jump";
	jump.hidden = true;
	const toasts = document.createElement("div");
	toasts.className = "chat-toasts";
	toasts.setAttribute("aria-live", "polite");
	float.append(jump, toasts);
	els.chat.append(float);

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

	/** 待发送附件：{ key, status: "uploading"|"ready", id,name,size,mime,url,thumb,error } */
	let attachments = [];
	let attachSeq = 0;
	let uploading = 0;

	/** @ 提及弹层状态。 */
	const mention = { open: false, query: "", tokenStart: -1, items: [], active: 0 };

	/** 最近一次 feed 变化与本地留痕的发送时刻，用来发现「有回执没推送」。 */
	let feedPushAt = 0;
	let feedItemCount = 0;
	let feedHasAnswer = false;
	let answerWatch = 0;

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
			// ADR-026 决策 2：用结构化字段判断，不只看「是不是等老板」。
			// 待决人是谁也随之带上：该 CTO 拍的不能写成「待你（老板）拍板」。
			if (feed.awaitingDecision?.pending === true) return "waiting";
			// 兼容旧后端（尚未返回 awaitingDecision 时）
			if (feed.awaitingOwner) return "waiting";
		}
		if (actor === null) return "idle";
		return statusOf(actor);
	}

	/**
	 * 待决策状态的一句话（「待你拍板」/「待 CTO 拍板」）。
	 *
	 * ADR-026 决策 2 的界面推论：老板面板上不该把「等 CTO」显示成「等你」，
	 * 否则他会以为这件事卡在自己身上。决策人不是老板时，改用中性措辞。
	 */
	function awaitingText() {
		const decision = feed?.awaitingDecision;
		if (decision === undefined || decision.pending !== true) return "待你拍板";
		if (decision.decider === "owner") return "待你拍板";
		const who = typeof decision.label === "string" && decision.label !== "" ? decision.label : "该同事";
		return `待${who}拍板`;
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
		els.statusText.textContent = state === "waiting" ? awaitingText() : statusLabel(state);

		const total = Number(feed?.tokens ?? actor.tokens ?? 0);
		els.tokens.textContent = `${formatTokens(total)} tokens`;
		els.tokens.title = `${total} tokens`;

		els.input.placeholder = `对 ${actor.label} 说点什么…`;
		els.input.disabled = false;
		updateSendState();
	}

	function updateSendState() {
		els.send.disabled =
			actor === null || (els.input.value.trim() === "" && attachments.length === 0) || uploading > 0;
	}

	/* ── 头部按钮：角色档案（不再做「全部展开 / 收起」） ── */
	const profile = initProfile({
		fetchProfile: typeof fetchProfile === "function" ? fetchProfile : undefined,
		onToggle: (open) => {
			els.fold.dataset.state = open ? "open" : "closed";
			els.fold.setAttribute("aria-expanded", String(open));
		},
	});

	function updateFold() {
		const visible = actor !== null;
		els.fold.hidden = !visible;
		if (!visible) {
			els.fold.dataset.state = "closed";
			els.fold.setAttribute("aria-expanded", "false");
			els.fold.title = "角色档案";
			els.fold.setAttribute("aria-label", "角色档案");
			return;
		}
		const label = `查看 ${actor.label} 的角色档案`;
		els.fold.title = label;
		els.fold.setAttribute("aria-label", label);
		if (!profile.isOpen()) els.fold.dataset.state = "closed";
	}

	els.fold.addEventListener("click", () => {
		if (actor === null) return;
		if (profile.isOpen()) profile.close();
		else profile.open(actor.conversationId, actor);
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
			// 选项卡片只挂在「最后一条 assistant」上：历史消息里的编号清单不再出现
			// 可点的旧选项，避免把过期的选择发给模型。
			let lastAssistantIndex = -1;
			let lastUserAfterAssistant = -1;
			feed.items.forEach((item, index) => {
				if (item.kind === "assistant") lastAssistantIndex = index;
				else if (item.kind === "user") lastUserAfterAssistant = index;
			});
			const assistantIsLatest = lastAssistantIndex > lastUserAfterAssistant;
			feed.items.forEach((item, index) => {
				const withFlag =
					item.kind === "assistant" && assistantIsLatest && index === lastAssistantIndex
						? { ...item, latest: true }
						: item;
				rows.push({
					key: `it:${index}:${item.kind}`,
					kind: item.kind,
					sig: signatureOf(withFlag),
					item: withFlag,
				});
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
				el = renderUser(item);
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
				el = renderNote(item);
				break;
			case "alert": {
				const who =
					item.from === undefined || item.from === null ? null : actorRefOf(item.from, "系统", "system");
				el = elFromHtml(
					`<div class="alert" role="note">${icon("alert", 13)}<span class="alert-body">${
						who === null ? "" : `<span class="alert-who">${escapeHtml(who.label)}</span>`
					}<span class="alert-text">${plainText(item.text)}</span></span></div>`,
				);
				break;
			}
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

	/** 会话主人：assistant / thinking / tool 的发言人，优先用后端 Feed.actor。 */
	function speakerOf(feedValue) {
		return actorRefOf(feedValue?.actor, actor?.label ?? "助手", actor?.kind ?? "role");
	}

	function renderUser(item) {
		// user 条目的发言人：后端 item.from（老板 / 派活的 agent）；没有就降级成「老板」。
		const who = actorRefOf(item.from, "老板", "owner");
		const time = timeOf(item.at);
		const el = elFromHtml(`
			<div class="msg msg--user">
				<div class="msg-head msg-head--user">
					${whoChipHtml(who, time)}
				</div>
				${userBodyHtml(item)}
			</div>`);
		el.dataset.raw = String(item.text ?? "");
		return el;
	}

	/** 用户消息正文：气泡 + 只读附件 chip（历史消息里显示收到了什么）。 */
	function userBodyHtml(item) {
		const body = item.text === "" || item.text === undefined ? "" : `<div class="bubble">${plainText(item.text)}</div>`;
		return body + attachmentChipsHtml(item.attachments);
	}

	function renderNote(item) {
		const body = String(item.text ?? "");
		// ADR-026 决策 7.1 的受理回执：不经过模型，只是一条「收到了」的系统提示。
		// 它不该长得像一条聊天消息，更不该重复正文——压成一行极小的回执。
		if (item.from === undefined && body.startsWith("已收到")) {
			const el = elFromHtml(
				`<div class="receipt">${icon("check", 11)}<span>${escapeHtml(body)}</span></div>`,
			);
			el.dataset.raw = body;
			return el;
		}
		const from = item.from === undefined || item.from === null ? null : actorRefOf(item.from, "系统", "system");
		const to = item.to === undefined || item.to === null ? null : actorRefOf(item.to, "", "system");
		const who = from === null ? null : `<span class="note-who">${escapeHtml(from.label)}</span>`;
		const arrow = to === null ? "" : `<span class="note-arrow">→ ${escapeHtml(to.label)}</span>`;
		return elFromHtml(
			`<div class="note">${
				who === null ? "" : `<span class="note-from">${who}${arrow}</span>`
			}<span class="note-text">${plainText(item.text)}</span></div>`,
		);
	}

	function renderAssistant(item) {
		const live = item.live === true;
		const who = speakerOf(feed);
		const el = elFromHtml(`
			<div class="msg msg--assistant${live ? " is-streaming" : ""}">
				<div class="msg-head">
					${whoChipHtml(who, live ? "刚刚" : timeOf(item.at))}
					${live ? '<span class="msg-live"><i></i>正在输出</span>' : ""}
					<button class="msg-copy" type="button" data-copy="message" aria-label="复制回答" title="复制回答"><span>复制</span></button>
				</div>
				<div class="md"></div>
				<div class="msg-tail"></div>
			</div>`);
		el.dataset.raw = String(item.text ?? "");
		applyAssistantContent(el, item, live);
		return el;
	}

	/**
	 * 写入助手正文与选项卡片。
	 *
	 * 只有「最后一条 assistant」才解析编号选项：普通回复里的编号清单不能乱加卡片，
	 * 老消息里的选项也不能再点（会把过期选择发出去）。
	 */
	function applyAssistantContent(el, item, live) {
		const md = el.querySelector(".md");
		if (md !== null) md.innerHTML = renderMarkdown(item.text);
		const tail = el.querySelector(".msg-tail");
		if (tail === null) return;
		tail.innerHTML = "";
		if (live || item.latest !== true) return;
		const parsed = splitOptionsFromText(item.text);
		if (parsed === null) return;
		if (md !== null && parsed.body !== "") md.innerHTML = renderMarkdown(parsed.body);
		tail.innerHTML = optionGroupHtml(parsed.options);
	}

	/** 选项卡片：单选、最后一项固定「自定义输入」。 */
	function optionGroupHtml(options) {
		const cards = options
			.map(
				(option, index) => `<button class="msg-option" type="button" data-chat-option="${index}" data-label="${escapeAttr(
					option.label,
				)}" aria-pressed="false">
					<span class="msg-option-key mono">${index + 1}</span>
					<span class="msg-option-label">${escapeHtml(option.label)}</span>
				</button>`,
			)
			.join("");
		return `<div class="msg-options" role="group" aria-label="选择一项">
			${cards}
			<button class="msg-option msg-option--custom" type="button" data-chat-option="custom" aria-pressed="false">
				<span class="msg-option-key mono">${options.length + 1}</span>
				<span class="msg-option-label">自定义输入</span>
				<span class="msg-option-hint">${icon("edit", 12)}</span>
			</button>
			<span class="msg-options-hint">按 <kbd>1</kbd>–<kbd>${Math.min(
				options.length + 1,
				9,
			)}</kbd> 快速选择</span>
		</div>`;
	}

	function renderThinking(item) {
		const live = item.live === true;
		return elFromHtml(`
			<details class="think"${live ? ' data-live="true"' : ""}>
				<summary>
					${workWhoHtml(speakerOf(feed))}
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
					${workWhoHtml(speakerOf(feed))}
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

	/**
	 * 插入中的消息：按普通消息形态呈现，不描黄框、不做高亮。
	 *
	 * ADR-026 决策 7：老板的话到达即受理，界面不能再让它看起来像「待处理的队列」。
	 * 只保留一行极小的弱化标注（已受理 · 正在切换 / 由 X 派来）说明当前状态，
	 * 其余与一条普通消息一致。
	 */
	function renderQueued(item) {
		const local = item.kind === "localqueued";
		// 别的 agent 派来的任务不是老板的消息：不能显示成老板的插话，
		// 也不能给「立即处理」——那会把别人的任务当成老板的话重投一遍。
		const delegated = item.origin === "agent";
		const mode = delegated ? "" : item.mode === "steer" ? "插话" : item.mode === "followUp" ? "追加" : "";
		if (delegated) {
			return elFromHtml(`
				<div class="queued queued--agent" data-origin="agent">
					<div class="queued-head">
						<i></i><span>由 ${escapeHtml(item.from ?? "协作方")} 派来</span>
						<span class="queued-hint">本轮结束后处理</span>
					</div>
					<div class="queued-text">${plainText(item.text)}</div>
				</div>`);
		}

		const status = local ? "已发出 · 正在进入对话" : "已受理 · 正在切换";
		const el = elFromHtml(`
			<div class="queued queued--insert${local ? " queued--local" : ""}" data-origin="owner" data-mode="${escapeAttr(
				item.mode ?? "",
			)}">
				<div class="queued-insert-head">
					${whoChipHtml({ label: "老板", kind: "owner" }, "")}
					<span class="queued-status">${status}</span>
					${mode === "" ? "" : `<span class="queued-mode">${mode}</span>`}
				</div>
				<div class="bubble queued-text">${plainText(item.text)}</div>
			</div>`);
		el.dataset.text = String(item.text ?? "");
		el.dataset.origin = "owner";
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
				if (item.text === "" || item.text === undefined) {
					bubble?.remove();
				} else if (bubble !== null) {
					bubble.innerHTML = plainText(item.text);
				}
				const list = el.querySelector(".attach-list");
				if (list !== null) list.remove();
				const chips = attachmentChipsHtml(item.attachments);
				if (chips !== "") el.insertAdjacentHTML("beforeend", chips);
				el.dataset.raw = String(item.text ?? "");
				patchWhoChip(el, actorRefOf(item.from, "老板", "owner"), timeOf(item.at));
				break;
			}
			case "note": {
				const target = el.querySelector(".note-text");
				const receipt = el.querySelector(".receipt span");
				if (target !== null) target.innerHTML = plainText(item.text);
				else if (receipt !== null) receipt.textContent = String(item.text ?? "");
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

	/** 只改 chip 里的名字与时间，不动 chip 本身（避免每次 feed 都重建边框）。 */
	function patchWhoChip(el, who, time) {
		const chip = el.querySelector(".who-chip");
		if (chip === null) return;
		chip.dataset.kind = who.kind;
		const name = chip.querySelector(".who-name");
		if (name !== null) name.textContent = who.label;
		const timeEl = chip.querySelector(".who-time");
		if (timeEl !== null) timeEl.textContent = time;
	}

	/** 工作过程行的发言人（思考 / 工具）。 */
	function patchWorkWho(el) {
		const who = el.querySelector(".work-who");
		if (who !== null) who.textContent = speakerOf(feed).label;
	}

	function patchAssistant(el, item) {
		const live = item.live === true;
		el.classList.toggle("is-streaming", live);
		el.dataset.raw = String(item.text ?? "");
		const md = el.querySelector(".md");
		const head = el.querySelector(".msg-head");
		patchWhoChip(el, speakerOf(feed), live ? "刚刚" : timeOf(item.at));
		let marker = el.querySelector(".msg-live");
		if (live && marker === null) {
			marker = elFromHtml('<span class="msg-live"><i></i>正在输出</span>');
			const copy = head?.querySelector(".msg-copy") ?? null;
			head?.insertBefore(marker, copy);
		} else if (!live && marker !== null) {
			marker.remove();
		}
		if (md !== null) {
			if (live) {
				scheduleStream(md, item.text);
				const tail = el.querySelector(".msg-tail");
				if (tail !== null) tail.innerHTML = "";
			} else {
				applyAssistantContent(el, item, false);
			}
		}
	}

	function patchThinking(el, item) {
		const live = item.live === true;
		if (live) el.setAttribute("data-live", "true");
		else el.removeAttribute("data-live");
		const kicker = el.querySelector(".think-kicker");
		const meta = el.querySelector(".think-meta");
		const body = el.querySelector(".think-body");
		patchWorkWho(el);
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
		patchWorkWho(el);
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
			profile.close();
			// 附件属于「这条消息的草稿」：换人就不能留着，避免发错对象。
			clearAttachments();
			closeMention();
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
		feedPushAt = Date.now();
		feedItemCount = Array.isArray(next.items) ? next.items.length : 0;
		feedHasAnswer = Array.isArray(next.items)
			? next.items.some((item) => item.kind === "assistant" || item.kind === "alert")
			: feedHasAnswer;
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
		clearAttachments();
		closeMention();
		mode = "none";
		resetStream();
		profile.close();
		stream.innerHTML = "";
		hideJump();
		els.body.scrollTop = 0;
		showPlaceholder();
		syncHeader();
		updateFold();
	}

	/**
	 * 本地留痕只在「真的看到对应 user 条目（或 queued 条目）」后才消失。
	 *
	 * 不能只靠时间：服务端如果没把新消息推下来（历史上限、流断开），
	 * 到点就删会让人以为「发出去了但没人回」；所以还留一层 30s 兜底，
	 * 并在兜底时明确说明「服务没有推来新内容」。
	 */
	function reconcileLocalQueue(source) {
		if (localQueue.length === 0) return;
		const items = Array.isArray(source.items) ? source.items : [];
		const texts = new Set();
		let newestUserAt = 0;
		for (const item of items) {
			if (item.kind !== "user") continue;
			const value = String(item.text ?? "").trim();
			if (value !== "") texts.add(value);
			const at = Number(item.at) || 0;
			if (at > newestUserAt) newestUserAt = at;
		}
		const queuedTexts = new Set();
		for (const queued of source.queued ?? []) {
			const value = String(queued.text ?? "").trim();
			if (value !== "") queuedTexts.add(value);
		}
		localQueue = localQueue.filter((entry) => {
			const value = entry.text.trim();
			if (texts.has(value) || queuedTexts.has(value)) return false;
			// 带附件的消息：后端会往正文里追加 [附件] 引用，文本不再逐字相等。
			// 用「本地发出之后确实出现了新的 user 条目」兜底，避免留痕挂 30 秒。
			if (entry.hadAttachments === true && newestUserAt >= entry.at - 5_000) return false;
			return true;
		});
	}

	/** submit() 里在调用 onSend 前设置：app.js 会立即 addLocalQueued，用来标记这次带附件。 */
	let echoWillHaveAttachments = false;

	function addLocalQueued(text) {
		const value = String(text ?? "").trim();
		if (value === "") {
			echoWillHaveAttachments = false;
			return;
		}
		const entry = {
			seq: (localSeq += 1),
			text: value,
			at: Date.now(),
			hadAttachments: echoWillHaveAttachments,
		};
		echoWillHaveAttachments = false;
		localQueue.push(entry);
		updateRows();
		scrollToBottom();
		window.setTimeout(() => {
			if (!localQueue.some((item) => item.seq === entry.seq)) return;
			removeLocalQueued(entry.seq);
			// 只有「服务确实没推新内容」才这么说，避免正常慢回复时惊动用户。
			if (feedItemCount === 0 || feedPushAt < entry.at) {
				notify("消息已发出，但没收到服务端的新对话内容。刷新页面试试。", "warn");
			}
		}, LOCAL_ECHO_MS);
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

	/* ── 复制 ── */
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

	els.body.addEventListener("click", (event) => {
		const button = event.target.closest("button");
		if (button === null) return;
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

	/* ── 附件：选择 / 粘贴 / 拖入 / 托盘 ── */
	const readyAttachments = () => attachments.filter((entry) => entry.status === "ready");

	function trayChipHtml(entry) {
		const uploadingThis = entry.status === "uploading";
		const name = String(entry.name ?? "附件");
		const size = entry.size === undefined ? "" : formatBytes(entry.size);
		const image = typeof entry.mime === "string" && entry.mime.startsWith("image/");
		const thumbSrc = entry.thumb ?? (image && typeof entry.url === "string" ? entry.url : "");
		const glyph =
			thumbSrc === ""
				? `<span class="attach-glyph">${icon(image ? "image" : "file", 14)}</span>`
				: `<img class="attach-thumb" src="${escapeAttr(thumbSrc)}" alt="">`;
		return `<span class="attach-chip${uploadingThis ? " is-uploading" : ""}" data-attach="${escapeAttr(
			entry.key,
		)}" title="${escapeAttr(name)}">
			${glyph}
			<span class="attach-meta">
				<span class="attach-name">${escapeHtml(name)}</span>
				<span class="attach-size mono">${uploadingThis ? "上传中…" : escapeHtml(size)}</span>
			</span>
			<button class="attach-x" type="button" data-attach-remove="${escapeAttr(
				entry.key,
			)}" aria-label="移除附件 ${escapeAttr(name)}" title="移除">${icon("x", 12)}</button>
		</span>`;
	}

	function renderTray() {
		if (els.tray === null) return;
		els.tray.innerHTML = attachments.map(trayChipHtml).join("");
		els.tray.hidden = attachments.length === 0;
		els.form?.classList.toggle("has-attachments", attachments.length > 0);
		updateSendState();
	}

	function revokeThumb(entry) {
		if (entry?.thumbObject === true && typeof entry.thumb === "string") {
			try {
				URL.revokeObjectURL(entry.thumb);
			} catch {
				/* 已释放 */
			}
			entry.thumbObject = false;
		}
	}

	function removeAttachment(key) {
		const entry = attachments.find((item) => item.key === key);
		if (entry !== undefined) revokeThumb(entry);
		attachments = attachments.filter((item) => item.key !== key);
		renderTray();
	}

	function clearAttachments() {
		for (const entry of attachments) revokeThumb(entry);
		attachments = [];
		uploading = 0;
		renderTray();
	}

	/** 上传单个文件；失败把可读原因交给 toast，不在托盘里留一个坏 chip。 */
	async function uploadOne(file) {
		const key = `a${(attachSeq += 1)}`;
		const image = typeof file.type === "string" && file.type.startsWith("image/");
		let thumb = "";
		let thumbObject = false;
		if (image) {
			try {
				thumb = URL.createObjectURL(file);
				thumbObject = true;
			} catch {
				thumb = "";
			}
		}
		const entry = {
			key,
			status: "uploading",
			name: file.name || "附件",
			size: file.size,
			mime: file.type || "",
			url: "",
			thumb,
			thumbObject,
		};
		attachments.push(entry);
		uploading += 1;
		renderTray();

		try {
			if (typeof uploadFile !== "function") throw new Error("附件功能还没接通：app.js 没有注入 uploadFile。");
			if (file.size > MAX_UPLOAD_BYTES) {
				throw new Error(`「${entry.name}」超过 20 MiB，请压缩后再试。`);
			}
			const data = await uploadFile(file);
			if (data === null || typeof data !== "object" || data.id === undefined) {
				throw new Error(`「${entry.name}」上传失败：服务返回的数据不完整。`);
			}
			entry.id = data.id;
			entry.name = String(data.name ?? entry.name);
			entry.size = Number(data.size ?? entry.size);
			entry.mime = String(data.mime ?? entry.mime);
			entry.url = String(data.url ?? "");
			entry.status = "ready";
		} catch (error) {
			revokeThumb(entry);
			attachments = attachments.filter((item) => item.key !== key);
			const reason =
				error instanceof Error && String(error.message).trim() !== ""
					? String(error.message).trim()
					: "上传失败，稍后再试。";
			notify(reason, "error");
		} finally {
			uploading = Math.max(0, uploading - 1);
			renderTray();
		}
	}

	function addFiles(files) {
		const list = [...(files ?? [])].filter((file) => file instanceof File);
		if (list.length === 0) return;
		if (actor === null) {
			notify("先选一位同事，再添加附件。", "warn");
			return;
		}
		for (const file of list) void uploadOne(file);
	}

	els.attach?.addEventListener("click", () => els.fileInput?.click());
	els.fileInput?.addEventListener("change", () => {
		addFiles(els.fileInput.files);
		els.fileInput.value = "";
	});
	els.tray?.addEventListener("click", (event) => {
		const button = event.target.closest("[data-attach-remove]");
		if (button === null) return;
		removeAttachment(button.dataset.attachRemove);
	});

	// 拖入输入区
	if (els.form !== null) {
		let dragDepth = 0;
		els.form.addEventListener("dragenter", (event) => {
			if (!event.dataTransfer?.types?.includes("Files")) return;
			event.preventDefault();
			dragDepth += 1;
			els.form.classList.add("is-dropping");
		});
		els.form.addEventListener("dragover", (event) => {
			if (!event.dataTransfer?.types?.includes("Files")) return;
			event.preventDefault();
			event.dataTransfer.dropEffect = "copy";
		});
		els.form.addEventListener("dragleave", () => {
			dragDepth = Math.max(0, dragDepth - 1);
			if (dragDepth === 0) els.form.classList.remove("is-dropping");
		});
		els.form.addEventListener("drop", (event) => {
			if (!event.dataTransfer?.files || event.dataTransfer.files.length === 0) return;
			event.preventDefault();
			dragDepth = 0;
			els.form.classList.remove("is-dropping");
			addFiles(event.dataTransfer.files);
		});
	}

	// 粘贴图片
	els.input?.addEventListener("paste", (event) => {
		const files = [...(event.clipboardData?.files ?? [])];
		const images = files.filter((file) => file instanceof File && file.type.startsWith("image/"));
		if (images.length === 0) return;
		event.preventDefault();
		addFiles(images);
	});

	/* ── @ 提及 ── */
	function orgMembers() {
		const org = storedOrg;
		if (org === null || org === undefined) return [];
		const self = actor?.conversationId;
		const all = [];
		const push = (person, projectName) => {
			if (person === null || person === undefined) return;
			if (person.conversationId === self) return;
			all.push({
				conversationId: person.conversationId,
				label: String(person.label ?? "").trim(),
				subtitle: String(person.subtitle ?? "").trim(),
				kind: String(person.kind ?? "staff"),
				project: String(projectName ?? person.projectName ?? person.project ?? "").trim(),
			});
		};

		// 项目内成员（负责人 / 员工）只看到本项目的人；CEO 与管理层看全公司。
		const projectScoped = actor !== null && (actor.kind === "project" || actor.kind === "staff");
		if (projectScoped) {
			const project = (org.projects ?? []).find(
				(item) =>
					item.lead?.conversationId === self ||
					(item.staff ?? []).some((person) => person.conversationId === self),
			);
			if (project !== undefined) {
				push(project.lead, project.name);
				for (const person of project.staff ?? []) push(person, project.name);
			}
		} else {
			push(org.ceo, "");
			for (const role of org.roles ?? []) push(role, "");
			for (const project of org.projects ?? []) {
				push(project.lead, project.name);
				for (const person of project.staff ?? []) push(person, project.name);
			}
		}

		const seen = new Set();
		const members = [];
		for (const member of all) {
			if (member.label === "" || seen.has(member.conversationId)) continue;
			seen.add(member.conversationId);
			members.push(member);
		}
		return members;
	}

	/** 模糊匹配：前缀 < 包含 < 子序列；名字、岗位、项目名都参与。 */
	function fuzzyScore(haystack, query) {
		const value = String(haystack ?? "").toLowerCase();
		const needle = String(query ?? "").toLowerCase();
		if (needle === "") return 3;
		if (value === needle) return 0;
		if (value.startsWith(needle)) return 1;
		const index = value.indexOf(needle);
		if (index >= 0) return 2 + index / 100;
		// 子序列：@lys 也能命中「林越」的拼音首字母（如果 label 有的话）
		let cursor = 0;
		let gaps = 0;
		for (const char of value) {
			if (cursor < needle.length && char === needle[cursor]) cursor += 1;
			else if (cursor > 0) gaps += 1;
		}
		if (cursor === needle.length) return 4 + gaps / 100;
		return null;
	}

	function mentionMatches(query) {
		const scored = [];
		for (const member of orgMembers()) {
			const scores = [
				fuzzyScore(member.label, query),
				fuzzyScore(member.subtitle, query),
				fuzzyScore(member.project, query),
			].filter((value) => value !== null);
			if (scores.length === 0) continue;
			scored.push({ member, score: Math.min(...scores) });
		}
		scored.sort((a, b) => a.score - b.score || a.member.label.localeCompare(b.member.label, "zh-Hans-CN"));
		// 全公司成员可能十几个：弹层内部滚动，不截断成「看不全」。
		return scored.slice(0, 60).map((item) => item.member);
	}

	function mentionToken() {
		const value = els.input.value;
		const caret = els.input.selectionStart ?? value.length;
		const before = value.slice(0, caret);
		const match = /(^|[\s])@([^\s@]*)$/.exec(before);
		if (match === null) return null;
		const query = match[2];
		return { start: caret - query.length - 1, caret, query };
	}

	function renderMention() {
		if (els.mention === null) return;
		if (!mention.open) {
			els.mention.hidden = true;
			els.mention.innerHTML = "";
			return;
		}
		if (mention.items.length === 0) {
			els.mention.innerHTML = `<div class="mention-empty">没有匹配的成员${mention.query === "" ? "" : `：@${escapeHtml(mention.query)}`}</div>`;
			els.mention.hidden = false;
			return;
		}
		els.mention.innerHTML = mention.items
			.map(
				(member, index) => `<button class="mention-item" type="button" role="option"
					id="mention-${index}" aria-selected="${index === mention.active ? "true" : "false"}"
					data-mention="${index}">
					<span class="mention-name">@${escapeHtml(member.label)}</span>
					<span class="mention-sub">${escapeHtml(
						[member.subtitle, member.project].filter((part) => part !== "").join(" · ") || kindLabel(member.kind),
					)}</span>
				</button>`,
			)
			.join("");
		els.mention.hidden = false;
	}

	function updateMentionFromInput() {
		if (els.mention === null) return;
		const token = mentionToken();
		if (token === null) {
			closeMention();
			return;
		}
		const queryChanged = !mention.open || token.query !== mention.query;
		mention.open = true;
		mention.query = token.query;
		mention.tokenStart = token.start;
		mention.caret = token.caret;
		mention.items = mentionMatches(token.query);
		mention.active = queryChanged ? 0 : Math.min(mention.active, Math.max(0, mention.items.length - 1));
		renderMention();
	}

	function closeMention() {
		if (!mention.open) return;
		mention.open = false;
		mention.items = [];
		mention.active = 0;
		renderMention();
	}

	function insertMention(member) {
		if (member === undefined) return;
		const value = els.input.value;
		const start = mention.tokenStart >= 0 ? mention.tokenStart : value.length;
		const caret = Number.isFinite(mention.caret) ? mention.caret : value.length;
		const inserted = `@${member.label} `;
		els.input.value = value.slice(0, start) + inserted + value.slice(caret);
		const next = start + inserted.length;
		els.input.setSelectionRange(next, next);
		closeMention();
		autoGrow();
		updateSendState();
		els.input.focus();
	}

	els.input?.addEventListener("input", () => {
		autoGrow();
		updateSendState();
		updateMentionFromInput();
	});
	els.input?.addEventListener("click", () => updateMentionFromInput());
	els.input?.addEventListener("blur", () => {
		// 延迟关闭：让点击弹层里的成员先生效。
		window.setTimeout(() => {
			if (document.activeElement !== els.input && !els.mention?.contains(document.activeElement)) closeMention();
		}, 140);
	});
	els.input?.addEventListener("keydown", (event) => {
		if (mention.open) {
			if (event.key === "ArrowDown" || event.key === "ArrowUp") {
				event.preventDefault();
				if (mention.items.length > 0) {
					const step = event.key === "ArrowDown" ? 1 : -1;
					mention.active = (mention.active + step + mention.items.length) % mention.items.length;
					renderMention();
				}
				return;
			}
			if ((event.key === "Enter" || event.key === "Tab") && !event.shiftKey) {
				event.preventDefault();
				insertMention(mention.items[mention.active]);
				return;
			}
			if (event.key === "Escape") {
				event.preventDefault();
				closeMention();
				return;
			}
		}
		if (event.key !== "Enter" || event.shiftKey) return;
		if (event.isComposing || event.keyCode === 229) return;
		event.preventDefault();
		void submit();
	});
	els.mention?.addEventListener("mousedown", (event) => {
		// 防止 input 先 blur 导致点击丢失
		event.preventDefault();
		const button = event.target.closest("[data-mention]");
		if (button === null) return;
		insertMention(mention.items[Number(button.dataset.mention)]);
	});
	els.mention?.addEventListener("mousemove", (event) => {
		const button = event.target.closest("[data-mention]");
		if (button === null) return;
		const index = Number(button.dataset.mention);
		if (index === mention.active) return;
		mention.active = index;
		renderMention();
	});

	/* ── 选项卡片：点击 / 数字键 ── */
	function isEditableTarget(target) {
		return (
			target instanceof HTMLElement &&
			(target.tagName === "TEXTAREA" || target.tagName === "INPUT" || target.isContentEditable)
		);
	}

	async function sendOption(label) {
		const text = String(label ?? "").trim();
		if (text === "" || sending || actor === null) return;
		sending = true;
		updateSendState();
		echoWillHaveAttachments = false;
		let ok = false;
		try {
			if (typeof onSend === "function") ok = (await onSend(text, [])) === true;
		} catch {
			ok = false;
		} finally {
			sending = false;
			updateSendState();
		}
		if (!ok) {
			notify("这个选择没发出去，再点一次。", "error");
			return;
		}
		scrollToBottom();
		scheduleAnswerWatch();
	}

	els.body.addEventListener("click", (event) => {
		const option = event.target.closest("[data-chat-option]");
		if (option === null) return;
		if (option.dataset.chatOption === "custom") {
			els.input?.focus();
			return;
		}
		const group = option.closest(".msg-options");
		for (const button of group?.querySelectorAll("[data-chat-option]") ?? []) {
			button.classList.toggle("is-picked", button === option);
			button.setAttribute("aria-pressed", button === option ? "true" : "false");
		}
		void sendOption(option.dataset.label ?? "");
	});

	document.addEventListener("keydown", (event) => {
		if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
		if (!/^[1-9]$/.test(event.key)) return;
		if (isEditableTarget(event.target)) return;
		if (event.target instanceof HTMLElement && event.target.closest(".chat-pending") !== null) return;
		const groups = stream.querySelectorAll(".msg-options");
		const group = groups[groups.length - 1];
		const index = Number(event.key) - 1;
		if (group !== undefined) {
			const button = group.querySelectorAll("[data-chat-option]")[index];
			if (button === undefined) return;
			event.preventDefault();
			button.click();
			return;
		}
		// 没有聊天内选项时，数字键作用于顶部第一张带选项的待决卡片
		const askCard = document.querySelector("#ask-area .ask-options")?.closest(".ask");
		const askButton = askCard?.querySelectorAll(".ask-opt:not(.ask-opt--custom)")[index];
		if (askButton === undefined) return;
		event.preventDefault();
		askButton.click();
	});

	/* ── 发送与回复守望 ── */
	function scheduleAnswerWatch() {
		window.clearTimeout(answerWatch);
		const current = feed;
		if (current === null) return;
		const before = current.items.filter((item) => item.kind === "assistant" || item.kind === "alert").length;
		answerWatch = window.setTimeout(() => {
			answerWatch = 0;
			if (feed === null || feed.busy) return;
			const now = feed.items.filter((item) => item.kind === "assistant" || item.kind === "alert").length;
			if (now > before) return;
			notify("还没收到回复。如果一直这样，刷新页面或检查服务是否还在运行。", "warn");
		}, 20_000);
	}

	async function submit() {
		if (sending || actor === null) return;
		if (uploading > 0) {
			notify("附件还在上传，稍等一下再发。", "warn");
			return;
		}
		closeMention();
		const raw = els.input.value;
		const text = raw.trim();
		const files = readyAttachments().map((entry) => ({
			id: entry.id,
			name: entry.name,
			size: entry.size,
			mime: entry.mime,
			url: entry.url,
		}));
		if (text === "" && files.length === 0) return;
		if (typeof onSend !== "function") return;

		sending = true;
		els.input.value = "";
		autoGrow();
		updateSendState();
		echoWillHaveAttachments = files.length > 0;

		let ok = false;
		try {
			ok = (await onSend(text, files)) === true;
		} catch {
			ok = false;
		} finally {
			sending = false;
			echoWillHaveAttachments = false;
		}
		if (!ok) {
			// app.js 会先乐观排队；失败时把本地留痕和输入还原，附件留在托盘里。
			removeLocalQueuedByText(text);
			if (els.input.value.trim() === "") {
				els.input.value = raw;
				autoGrow();
			}
			updateSendState();
			return;
		}
		clearAttachments();
		updateSendState();
		scrollToBottom();
		scheduleAnswerWatch();
	}

	els.form?.addEventListener("submit", (event) => {
		event.preventDefault();
		void submit();
	});

	/* ── 启动 ── */
	setupResizer();
	autoGrow();
	renderTray();
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
		/** 开发/视觉验收专用：往托盘里放几条「已上传」的附件（不真正上传）。 */
		seedAttachments(list) {
			const demo = Array.isArray(list) ? list : [];
			for (const item of demo) {
				attachments.push({
					key: `seed${(attachSeq += 1)}`,
					status: "ready",
					id: item.id ?? `seed-${attachSeq}`,
					name: String(item.name ?? "附件"),
					size: Number(item.size ?? 0),
					mime: String(item.mime ?? ""),
					url: String(item.url ?? ""),
					thumb: String(item.thumb ?? item.url ?? ""),
					thumbObject: false,
				});
			}
			renderTray();
			return attachments.length;
		},
	};
}
