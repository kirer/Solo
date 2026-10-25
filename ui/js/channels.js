/**
 * 频道视图：左侧频道列表 + 中间消息流 + 右侧成员/任务。
 *
 * 设计见 `docs/design/COMMS-REFACTOR.md` §7。四件事：
 *
 * 1. **频道列表**：公司群 / 领导层 / 项目群 / 私聊 / 个人记录，带未读徽章
 * 2. **消息流**：气泡 + @ 已读点（灰=未读，绿=已读）+ 任务卡片
 * 3. **输入框**：@ 选择器、附件、发送
 * 4. **右侧**：成员列表（含各自未读）、本频道任务
 *
 * 数据全部来自 `/api/channels*`。SSE 的 org 事件只是「该刷新了」的信号，
 * 不做增量合并——频道消息量远小于会话流，全量拉最不容易出错。
 */
import { escapeAttr, escapeHtml, relTime, clockTime } from "./format.js";
import { icon } from "./icons.js";
import { renderMarkdown } from "./markdown.js";

const $ = (id) => document.getElementById(id);

const state = {
	channels: [],
	activeId: null,
	view: null,
	/** @ 选择器里当前候选。 */
	mentionCandidates: [],
	mentionQuery: "",
	mentionStart: -1,
	loading: false,
	lastFetchAt: 0,
};

const el = {
	root: null,
	layout: null,
	list: null,
	title: null,
	sub: null,
	body: null,
	input: null,
	send: null,
	members: null,
	tasks: null,
	mention: null,
};

/** 频道类型 → 分组标题。 */
const GROUPS = [
	{ kind: "company", label: "公司" },
	{ kind: "leadership", label: "领导层" },
	{ kind: "project", label: "项目" },
	{ kind: "dm", label: "私聊" },
	{ kind: "log", label: "工作记录" },
];

// ── 数据 ──────────────────────────────────────────────────────────────────

async function fetchJson(path, options) {
	const response = await fetch(path, { headers: { accept: "application/json" }, ...options });
	if (!response.ok) throw new Error(`HTTP ${response.status}`);
	const contentType = response.headers.get("content-type") ?? "";
	if (!contentType.includes("application/json")) throw new Error("接口未就绪");
	return response.json();
}

async function loadChannels() {
	try {
		const data = await fetchJson("/api/channels");
		state.channels = Array.isArray(data.channels) ? data.channels : [];
		state.lastFetchAt = Date.now();
		renderList(data.unread);
		// 没有选中频道时自动选第一个（有 @ 的优先）。
		// 手机上是两屏布局：先给列表，别把用户直接推进某个会话。
		const narrow = window.matchMedia("(max-width: 860px)").matches;
		if (state.activeId === null && state.channels.length > 0 && !narrow) {
			await openChannel(state.channels[0].id);
		} else if (state.activeId !== null) {
			// 保持当前选中；只更新列表徽章
			updateActiveRow();
		}
	} catch (error) {
		renderListError(error instanceof Error ? error.message : "未知错误");
	}
}

async function openChannel(id) {
	if (state.loading) return;
	state.loading = true;
	state.activeId = id;
	// 手机上是「列表页 → 会话页」两屏，进会话就切到 main
	if (el.layout !== null) el.layout.dataset.pane = "main";
	updateActiveRow();
	try {
		const view = await fetchJson(`/api/channels/${encodeURIComponent(id)}?limit=60`);
		state.view = view;
		renderHeader();
		renderMessages();
		renderMembers();
		renderTasks();
		scrollToBottom();
		// 打开即已读：服务端已在 GET 时推了读位置，这里同步列表徽章
		const row = state.channels.find((channel) => channel.id === id);
		if (row !== undefined) {
			row.unread = 0;
			row.mentions = 0;
			renderList();
		}
	} catch (error) {
		renderBodyError(error instanceof Error ? error.message : "加载失败");
	} finally {
		state.loading = false;
	}
}

async function sendMessage(text) {
	const channelId = state.activeId;
	if (channelId === null || text.trim() === "") return;
	const mentions = extractMentions(text);
	try {
		el.send?.setAttribute("disabled", "");
		await fetchJson(`/api/channels/${encodeURIComponent(channelId)}/messages`, {
			method: "POST",
			headers: { "content-type": "application/json", accept: "application/json" },
			body: JSON.stringify({ text, mentions }),
		});
		if (el.input !== null) {
			el.input.value = "";
			autoSize();
		}
		await openChannel(channelId);
		await loadChannels();
	} catch (error) {
		notify(error instanceof Error ? error.message : "发送失败", "error");
	} finally {
		el.send?.removeAttribute("disabled");
	}
}

/** 从正文里抽出 @ 到的人（按名字匹配候选表）。 */
function extractMentions(text) {
	const ids = new Set();
	for (const candidate of state.mentionCandidates) {
		if (text.includes(`@${candidate.label}`)) ids.add(candidate.id);
	}
	return [...ids];
}

// ── 渲染：频道列表 ─────────────────────────────────────────────────────────

/**
 * 头像：走服务端 `/api/avatar/:name`。
 *
 * 为什么不用首字母：中文名的第一个字区分度极低（「林越」「林墨」都是「林」），
 * 而头像的作用是扫视时快速认人。服务端按名字稳定生成同一张脸，重启不变。
 */
function avatar(label, size = 32, extraClass = "") {
	const src = `/api/avatar/${encodeURIComponent(label)}?size=${size * 2}`;
	return `<img class="ch-av ${extraClass}" src="${escapeAttr(src)}" alt="" width="${size}" height="${size}" loading="lazy" decoding="async">`;
}

/** 工作记录不是人，给它一个「文档」图标而不是人脸。 */
function logAvatar(size = 32) {
	return [
		`<span class="ch-av ch-av--icon" style="width:${size}px;height:${size}px" aria-hidden="true">`,
		`<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round">`,
		`<path d="M4 2.5h5.5L12 5v8.5H4z"/><path d="M9.5 2.5V5H12"/><path d="M6 8h4M6 10.5h3"/>`,
		`</svg>`,
		`</span>`,
	].join("");
}

function renderList(unread) {
	if (el.list === null) return;
	const grouped = new Map();
	for (const channel of state.channels) {
		const list = grouped.get(channel.kind) ?? [];
		list.push(channel);
		grouped.set(channel.kind, list);
	}

	const html = [`<div class="ch-list-head"><b>频道</b><span>${state.channels.length}</span></div>`];
	for (const group of GROUPS) {
		let items = grouped.get(group.kind) ?? [];
		if (items.length === 0) continue;
		// 工作记录太多（每个 agent 一个）：只列有内容的，其余折叠
		if (group.kind === "log") {
			const withContent = items.filter((channel) => channel.lastSeq > 0);
			const rest = items.length - withContent.length;
			items = rest > 0 ? [...withContent, { id: "__more-logs", title: `还有 ${rest} 个空的工作记录`, preview: "", kind: "log", lastAt: 0, unread: 0, mentions: 0, lastSeq: 0, memberCount: 0, openTasks: 0 }] : withContent;
			if (items.length === 0) continue;
		}
		html.push(`<div class="ch-group"><span>${escapeHtml(group.label)}</span></div>`);
		for (const channel of items) {
			const active = channel.id === state.activeId;
			const badge =
				channel.mentions > 0
					? `<b class="ch-badge ch-badge--mention">${channel.mentions}</b>`
					: channel.unread > 0
						? `<b class="ch-badge">${channel.unread}</b>`
						: "";
			if (channel.id === "__more-logs") {
				html.push(`<button class="ch-row ch-row--muted" type="button" disabled>${escapeHtml(channel.title)}</button>`);
				continue;
			}
			html.push(
				[
					`<button class="ch-row" type="button" data-id="${escapeAttr(channel.id)}"`,
					` data-active="${active ? "true" : "false"}"`,
					` data-mention="${channel.mentions > 0 ? "true" : "false"}">`,
					channel.kind === "log" ? logAvatar(32) : avatar(channel.title, 32),
					`<span class="ch-row-main">`,
					`<span class="ch-row-title">${escapeHtml(channel.title)}</span>`,
					channel.preview === "" ? "" : `<span class="ch-row-preview">${escapeHtml(channel.preview)}</span>`,
					`</span>`,
					`<span class="ch-row-side">`,
					channel.lastAt > 0 ? `<span class="ch-row-time">${escapeHtml(relTime(channel.lastAt))}</span>` : `<span class="ch-row-time">—</span>`,
					badge,
					`</span>`,
					`</button>`,
				].join(""),
			);
		}
	}
	el.list.innerHTML = html.join("") || `<div class="ch-empty">还没有频道</div>`;
	for (const button of el.list.querySelectorAll(".ch-row")) {
		if (button.dataset.id === undefined) continue;
		button.addEventListener("click", () => openChannel(button.dataset.id));
	}
	// 顶栏徽章
	const total = unread?.mentions ?? 0;
	const badge = $("ch-unread");
	if (badge !== null) {
		badge.textContent = total > 0 ? String(total) : "";
		badge.hidden = total === 0;
	}
}

function updateActiveRow() {
	if (el.list === null) return;
	for (const row of el.list.querySelectorAll(".ch-row")) {
		row.dataset.active = row.dataset.id === state.activeId ? "true" : "false";
	}
}

function renderListError(message) {
	if (el.list === null) return;
	el.list.innerHTML = `<div class="ch-empty">频道没拉到（${escapeHtml(message)}）</div>`;
}

// ── 渲染：头部 / 消息 / 成员 / 任务 ────────────────────────────────────────

function renderHeader() {
	const view = state.view;
	if (view === null || el.title === null) return;
	el.title.textContent = view.channel.title;
	const kindLabel = {
		company: "全员",
		leadership: "管理层",
		project: "项目群",
		dm: "私聊",
		log: "工作记录",
	}[view.channel.kind];
	// 公司群的标题就叫「公司大群」，别再重复一遍类型
	const parts = view.channel.kind === "company" ? [] : [kindLabel];
	parts.push(`${view.channel.memberCount} 人`);
	el.sub.textContent = parts.join(" · ");
}

function renderMessages() {
	const view = state.view;
	if (view === null || el.body === null) return;
	if (view.messages.length === 0) {
		el.body.innerHTML = `<div class="ch-empty">还没有消息。${view.channel.kind === "project" ? "在项目群里 @ 某人开始协作。" : ""}</div>`;
		return;
	}

	const html = [];
	let lastFrom = null;
	let lastAt = 0;
	let lastDay = "";
	for (const message of view.messages) {
		const grouped = message.from === lastFrom && message.at - lastAt < 5 * 60_000 && message.kind === "chat";
		lastFrom = message.from;
		lastAt = message.at;

		const day = dayKey(message.at);
		if (day !== lastDay) {
			html.push(`<div class="ch-day">${escapeHtml(dayLabel(message.at))}</div>`);
			lastDay = day;
		}

		if (message.kind === "system") {
			html.push(`<div class="ch-system">${escapeHtml(message.text)}</div>`);
			continue;
		}
		if (message.kind === "task" || message.kind === "report") {
			html.push(renderCard(message));
			continue;
		}

		html.push(
			[
				`<div class="ch-msg" data-from="${message.from}" data-grouped="${grouped ? "true" : "false"}">`,
				// 头像始终渲染（折叠时 CSS 隐藏）：留空会让 grid 把正文挤进 32px 列
				renderAvatar(message),
				`<div class="ch-msg-main">`,
				grouped ? "" : renderMsgHead(message),
				renderBubble(message.text),
				renderMentions(message),
				`</div>`,
				`</div>`,
			].join(""),
		);
	}
	el.body.innerHTML = html.join("");
	// 展开全文（事件委托：消息流每次全量重渲染，逐个绑定会漏）
	for (const button of el.body.querySelectorAll(".ch-expand")) {
		button.addEventListener("click", () => {
			const bubble = button.previousElementSibling;
			if (bubble === null) return;
			bubble.dataset.collapsed = "false";
			button.remove();
		});
	}
}

/**
 * 正文气泡。
 *
 * 长报告（agent 经常一次输出几百行）在聊天流里会把别的消息全挤出屏幕。
 * 超过 ~28 行就折叠，点「展开全文」再看——和飞书/Slack 的长消息处理一致。
 */
function renderBubble(text) {
	const html = renderMarkdown(text);
	const lines = (text.match(/\n/g) ?? []).length + 1;
	const long = lines > 28 || text.length > 1600;
	if (!long) return `<div class="ch-bubble">${html}</div>`;
	return [
		`<div class="ch-bubble" data-collapsed="true">${html}</div>`,
		`<button class="ch-expand" type="button">展开全文（${lines} 行）</button>`,
	].join("");
}

function renderAvatar(message) {
	return avatar(message.fromLabel, 32);
}

/** 日期键：用于插入「今天 / 昨天 / 8月3日」分隔线。 */
function dayKey(at) {
	const date = new Date(at);
	return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

function dayLabel(at) {
	const date = new Date(at);
	const today = new Date();
	const sameDay = (a, b) =>
		a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
	if (sameDay(date, today)) return "今天";
	const yesterday = new Date(today.getTime() - 86_400_000);
	if (sameDay(date, yesterday)) return "昨天";
	return `${date.getMonth() + 1} 月 ${date.getDate()} 日`;
}

function renderMsgHead(message) {
	return [
		`<div class="ch-msg-head">`,
		`<b>${escapeHtml(message.fromLabel)}</b>`,
		message.from === 0 ? `<span class="ch-tag ch-tag--owner">老板</span>` : "",
		`<span class="ch-time">${escapeHtml(clockTime(message.at))}</span>`,
		`</div>`,
	].join("");
}

/** @ 的已读点：灰 = 未读，绿 = 已读。 */
function renderMentions(message) {
	if (message.mentions.length === 0) return "";
	const dots = message.mentions
		.map(
			(mention) =>
				`<span class="ch-mention" title="${escapeAttr(mention.label)}：${mention.read ? "已读" : "未读"}">` +
				`<i data-read="${mention.read ? "true" : "false"}"></i>@${escapeHtml(mention.label)}</span>`,
		)
		.join("");
	return `<div class="ch-mentions">${dots}</div>`;
}

/** 任务 / 回报卡片。 */
function renderCard(message) {
	const taskId = message.refs?.taskId;
	const lines = message.text.split("\n");
	const title = lines[0] ?? "";
	const rest = lines.slice(1).join("\n");
	return [
		`<div class="ch-card" data-kind="${escapeAttr(message.kind)}">`,
		`<div class="ch-card-head">`,
		taskId === undefined ? "" : `<b class="ch-card-id">${escapeHtml(taskId)}</b>`,
		`<span class="ch-card-title">${escapeHtml(title.replace(/^【|】$/g, ""))}</span>`,
		`<span class="ch-time">${escapeHtml(clockTime(message.at))}</span>`,
		`</div>`,
		rest === "" ? "" : `<div class="ch-card-body">${renderMarkdown(rest)}</div>`,
		renderMentions(message),
		`</div>`,
	].join("");
}

function renderMembers() {
	const view = state.view;
	if (view === null || el.members === null) return;
	const html = view.members
		.map(
			(member) => [
				`<li class="ch-member" data-role="${escapeAttr(member.role)}">`,
				avatar(member.label, 22, "ch-av--sm"),
				`<span class="ch-member-main">`,
				`<b>${escapeHtml(member.label)}</b>`,
				`<span class="ch-member-role">${escapeHtml(roleLabel(member.role))}</span>`,
				`</span>`,
				member.unread > 0 ? `<b class="ch-badge">${member.unread}</b>` : "",
				`</li>`,
			].join(""),
		)
		.join("");
	el.members.innerHTML = html;
}

function renderTasks() {
	const view = state.view;
	if (view === null || el.tasks === null) return;
	if (view.tasks.length === 0) {
		el.tasks.innerHTML = `<li class="ch-empty ch-empty--inline">还没有任务</li>`;
		return;
	}
	const statusLabel = {
		todo: "待做",
		doing: "在做",
		blocked: "阻塞",
		review: "待验收",
		done: "已完成",
		cancelled: "已取消",
	};
	el.tasks.innerHTML = view.tasks
		.map(
			(task) => [
				`<li class="ch-task" data-status="${escapeAttr(task.status)}">`,
				`<span class="ch-task-id">${escapeHtml(task.id)}</span>`,
				`<span class="ch-task-title">${escapeHtml(task.title)}</span>`,
				`<span class="ch-task-status">${escapeHtml(statusLabel[task.status] ?? task.status)}</span>`,
				`</li>`,
			].join(""),
		)
		.join("");
}

function renderBodyError(message) {
	if (el.body === null) return;
	el.body.innerHTML = `<div class="ch-empty">${escapeHtml(message)}</div>`;
}

function scrollToBottom() {
	if (el.body !== null) el.body.scrollTop = el.body.scrollHeight;
}

function roleLabel(role) {
	return { owner: "老板", ceo: "CEO", management: "管理层", leader: "项目负责人", staff: "员工" }[role] ?? role;
}

// ── 输入框：@ 选择器 ──────────────────────────────────────────────────────

async function loadMentionCandidates() {
	if (state.activeId === null) return;
	try {
		const data = await fetchJson(`/api/channels/${encodeURIComponent(state.activeId)}/mentionable`);
		state.mentionCandidates = Array.isArray(data.candidates) ? data.candidates : [];
	} catch {
		state.mentionCandidates = [];
	}
}

function onInput() {
	autoSize();
	updateMentionPopup();
}

function autoSize() {
	if (el.input === null) return;
	el.input.style.height = "auto";
	el.input.style.height = `${Math.min(el.input.scrollHeight, 160)}px`;
}

/** 光标前是否正在输入 @。 */
function detectMention(value, caret) {
	const before = value.slice(0, caret);
	const at = before.lastIndexOf("@");
	if (at < 0) return null;
	// @ 后面不能有空格（否则已经不是在选人）
	const query = before.slice(at + 1);
	if (/\s/.test(query)) return null;
	return { start: at, query };
}

function updateMentionPopup() {
	if (el.input === null || el.mention === null) return;
	const detected = detectMention(el.input.value, el.input.selectionStart ?? 0);
	if (detected === null) {
		el.mention.hidden = true;
		state.mentionStart = -1;
		return;
	}
	state.mentionStart = detected.start;
	state.mentionQuery = detected.query;
	const query = detected.query.toLowerCase();
	const list = state.mentionCandidates.filter((candidate) => candidate.label.toLowerCase().includes(query));
	if (list.length === 0) {
		el.mention.hidden = true;
		return;
	}
	el.mention.hidden = false;
	el.mention.innerHTML = list
		.slice(0, 8)
		.map(
			(candidate) =>
				`<button type="button" class="ch-mention-item" data-label="${escapeAttr(candidate.label)}">` +
				avatar(candidate.label, 18, "ch-av--xs") +
				`<b>${escapeHtml(candidate.label)}</b>` +
				`<span>${escapeHtml(roleLabel(candidate.role))}</span>` +
				`</button>`,
		)
		.join("");
	for (const button of el.mention.querySelectorAll(".ch-mention-item")) {
		button.addEventListener("click", () => insertMention(button.dataset.label));
	}
}

function insertMention(label) {
	if (el.input === null) return;
	const value = el.input.value;
	const start = state.mentionStart >= 0 ? state.mentionStart : value.lastIndexOf("@");
	if (start < 0) return;
	const caret = el.input.selectionStart ?? value.length;
	const next = `${value.slice(0, start)}@${label} ${value.slice(caret)}`;
	el.input.value = next;
	const position = start + label.length + 2;
	el.input.setSelectionRange(position, position);
	el.input.focus();
	el.mention.hidden = true;
	autoSize();
}

// ── 交互 ──────────────────────────────────────────────────────────────────

function notify(text, tone = "info") {
	window.dispatchEvent(new CustomEvent("aic:toast", { detail: { text, tone } }));
}

/** 挂载到 #channels 容器（由 app.js 在切到频道视图时调用）。 */
export function initChannels({ onSend } = {}) {
	el.root = $("channels");
	if (el.root === null) return { refresh: () => {}, open: () => {} };
	el.layout = el.root.querySelector(".ch-layout");
	if (el.layout !== null) el.layout.dataset.pane = "list";
	el.list = $("ch-list");
	el.title = $("ch-title");
	el.sub = $("ch-sub");
	el.body = $("ch-body");
	el.input = $("ch-input");
	el.send = $("ch-send");
	el.members = $("ch-members");
	el.tasks = $("ch-tasks");
	el.mention = $("ch-mention-popup");

	$("ch-back")?.addEventListener("click", () => {
		if (el.layout !== null) el.layout.dataset.pane = "list";
	});

	el.send?.addEventListener("click", () => sendMessage(el.input?.value ?? ""));
	el.input?.addEventListener("input", onInput);
	el.input?.addEventListener("keydown", (event) => {
		if (event.key === "Enter" && !event.shiftKey) {
			event.preventDefault();
			if (el.mention !== null && !el.mention.hidden) return;
			sendMessage(el.input?.value ?? "");
		}
		if (event.key === "Escape") {
			if (el.mention !== null) el.mention.hidden = true;
		}
	});

	// 切到频道视图时才加载（避免启动就多两个请求）
	let loaded = false;
	const ensureLoaded = async () => {
		if (loaded) return;
		loaded = true;
		await loadChannels();
	};

	// org SSE 推送 → 刷新（节流）
	let pending = null;
	window.addEventListener("aic:org", () => {
		if (document.body.dataset.view !== "channels") return;
		if (pending !== null) return;
		pending = window.setTimeout(async () => {
			pending = null;
			await loadChannels();
			if (state.activeId !== null) await openChannel(state.activeId);
		}, 400);
	});

	return {
		async refresh() {
			await ensureLoaded();
			if (state.activeId !== null) {
				await loadMentionCandidates();
			}
		},
		open: openChannel,
		loadMentionCandidates,
	};
}
