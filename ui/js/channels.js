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
	/** @ 候选当前高亮项（上下键移动，回车/Tab 选中）。 */
	mentionActive: 0,
	/** 当前候选列表（与 DOM 顺序一致）。 */
	mentionItems: [],
	loading: false,
	lastFetchAt: 0,
	/** 请求令牌：只让「最后一次点击的那个频道」的响应落地。 */
	reqToken: 0,
	/** 发送锁：连按两次 Enter 不会发两条。 */
	sending: false,
	/** 翻页锁：连点「加载更早」不会重复请求同一页。 */
	loadingEarlier: false,
	/** 已展开全文的消息（按 seq）。轮询全量重渲染后要靠它恢复，否则一点就白点。 */
	expanded: new Set(),
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
	if (!response.ok) {
		// 服务端的错误体是中文可读的（"频道不存在"），丢掉它前端就只剩 "HTTP 404"。
		let detail = "";
		try {
			const body = await response.json();
			if (typeof body?.error === "string") detail = body.error;
		} catch {
			/* 非 JSON 错误体：退回状态码 */
		}
		throw new Error(detail === "" ? `HTTP ${response.status}` : detail);
	}
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

/**
 * 打开（或刷新）一个频道。
 *
 * 三个必须守住的约束，都是踩过的坑：
 *
 * 1. **请求令牌**：以前用 `if (state.loading) return;` 直接丢弃并发请求——用户在
 *    加载中点另一个频道，那一下点击就静默消失了。现在用 reqToken：只有最后
 *    一次点击的响应能落地，早到的直接丢。
 * 2. **不抢用户的屏**：手机上是「列表页 / 会话页」两屏。只有用户**主动点频道**
 *    才切到 main；轮询刷新不能把人从列表页踢进会话页。
 * 3. **保住滚动位置与展开状态**：轮询会全量重渲染消息流，无条件
 *    `scrollToBottom()` 会把正在翻历史的用户拽回底部。
 */
async function openChannel(id, { userInitiated = true } = {}) {
	const token = ++state.reqToken;
	state.activeId = id;
	// 切频道必须重拉 @ 候选：候选是「本频道成员」，否则会 @ 到不在群里的人
	if (userInitiated) void loadMentionCandidates();
	// 手机上是「列表页 → 会话页」两屏，用户主动进会话才切到 main
	if (userInitiated && el.layout !== null) el.layout.dataset.pane = "main";
	updateActiveRow();
	const keepScroll = userInitiated ? null : captureScroll();
	try {
		const view = await fetchJson(`/api/channels/${encodeURIComponent(id)}?limit=60`);
		if (token !== state.reqToken) return; // 用户已经切到别的频道了
		// 轮询刷新时，如果用户已经往前翻过页，把更早的那些消息保住——
		// 否则每 4 秒一次刷新就把翻页结果冲掉，用户永远读不到历史。
		if (!userInitiated && state.view !== null && state.view.channel.id === id) {
			const firstFetched = view.messages[0]?.seq ?? Number.POSITIVE_INFINITY;
			const older = state.view.messages.filter((message) => message.seq < firstFetched);
			if (older.length > 0) {
				state.view = { ...view, messages: [...older, ...view.messages] };
			} else {
				state.view = view;
			}
		} else {
			state.view = view;
		}
		renderHeader();
		renderMessages();
		renderMembers();
		renderTasks();
		if (keepScroll === null) scrollToBottom();
		else restoreScroll(keepScroll);
		// 已读要前端**显式**上报：GET 不再有副作用（否则轮询/手机列表页也会清未读）。
		// 只报到真正渲染出来的最后一条，中间的未读不会被吞。
		const lastSeq = view.messages.at(-1)?.seq;
		if (lastSeq !== undefined) {
			void fetchJson(`/api/channels/${encodeURIComponent(id)}/read`, {
				method: "POST",
				headers: { "content-type": "application/json", accept: "application/json" },
				body: JSON.stringify({ seq: lastSeq }),
			}).catch(() => {
				/* 已读上报失败不打扰用户：下一轮会再报 */
			});
		}
		// 同步列表徽章
		const row = state.channels.find((channel) => channel.id === id);
		if (row !== undefined) {
			row.unread = 0;
			row.mentions = 0;
			renderList();
		}
	} catch (error) {
		if (token !== state.reqToken) return;
		renderBodyError(error instanceof Error ? error.message : "加载失败");
	}
}

/**
 * 往前翻一页。
 *
 * 只把结果**插到前面**（`state.view.messages` 合并），不整段重拉——否则用户
 * 翻到第 5 页时一次轮询又回到最近 60 条。滚动位置按「新增高度」补偿，
 * 视觉上停在原来看的那条上。
 */
async function loadEarlier(before) {
	const channelId = state.activeId;
	if (channelId === null || !Number.isFinite(before) || before <= 0) return;
	if (state.loadingEarlier) return;
	state.loadingEarlier = true;
	const heightBefore = el.body?.scrollHeight ?? 0;
	const topBefore = el.body?.scrollTop ?? 0;
	try {
		const page = await fetchJson(`/api/channels/${encodeURIComponent(channelId)}?limit=60&before=${before}`);
		if (state.activeId !== channelId || state.view === null) return;
		const known = new Set(state.view.messages.map((message) => message.seq));
		const older = page.messages.filter((message) => !known.has(message.seq));
		state.view = {
			...state.view,
			messages: [...older, ...state.view.messages],
			hasMore: page.hasMore,
		};
		renderMessages();
		if (el.body !== null) {
			// 内容变高了，补偿差值让视口停在原来的位置
			el.body.scrollTop = topBefore + (el.body.scrollHeight - heightBefore);
		}
	} catch (error) {
		notify(error instanceof Error ? error.message : "加载更早的消息失败", "error");
	} finally {
		state.loadingEarlier = false;
	}
}

/** 记下消息区的滚动位置（是否贴底 + 距底距离）。 */
function captureScroll() {
	if (el.body === null) return null;
	const distance = el.body.scrollHeight - el.body.scrollTop - el.body.clientHeight;
	return { distance, atBottom: distance < 48 };
}

function restoreScroll(saved) {
	if (el.body === null || saved === null) return;
	if (saved.atBottom) {
		el.body.scrollTop = el.body.scrollHeight;
		return;
	}
	// 内容可能变高了（新消息进来），按「距底距离」还原比按绝对 scrollTop 稳
	el.body.scrollTop = el.body.scrollHeight - el.body.clientHeight - saved.distance;
}

async function sendMessage(text) {
	const channelId = state.activeId;
	if (channelId === null || text.trim() === "") return;
	// 连按两次 Enter 不该发两条
	if (state.sending) return;
	state.sending = true;
	const sentText = text;
	const mentions = extractMentions(text);
	try {
		el.send?.setAttribute("disabled", "");
		await fetchJson(`/api/channels/${encodeURIComponent(channelId)}/messages`, {
			method: "POST",
			headers: { "content-type": "application/json", accept: "application/json" },
			body: JSON.stringify({ text: sentText, mentions }),
		});
		// 只有输入框里还是刚发出去的那段文字才清空。
		// 曾经无条件 `el.input.value = ""`：发送途中用户切频道并开始打新草稿，
		// 草稿被这条旧响应抹掉。
		if (el.input !== null && el.input.value === sentText) {
			el.input.value = "";
			autoSize();
		}
		// 同理：发送途中用户已经切走，就不要把人拽回旧频道
		if (state.activeId === channelId) await openChannel(channelId, { userInitiated: false });
		await loadChannels();
	} catch (error) {
		notify(error instanceof Error ? error.message : "发送失败", "error");
	} finally {
		state.sending = false;
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
	// onerror 兜底：头像接口挂了（或离线）时显示首字，而不是一个破图标
	const initial = escapeAttr(label.slice(0, 1));
	return (
		`<img class="ch-av ${extraClass}" src="${escapeAttr(src)}" alt="" width="${size}" height="${size}" loading="lazy" decoding="async"` +
		` onerror="this.replaceWith(Object.assign(document.createElement('span'),{className:'ch-av ch-av--fallback ${extraClass}',textContent:'${initial}'}))">`
	);
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
	// 顶栏徽章：**从 state.channels 自己算**。
	// 以前用 `unread?.mentions ?? 0`——renderList() 无参调用时 unread 是 undefined，
	// 顶栏 @ 徽章就被清空了（openChannel / 展开全文 后都会调一次）。
	const total =
		unread?.mentions ??
		state.channels.reduce((sum, channel) => sum + (channel.mentions ?? 0), 0);
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
	// 更早的消息：服务端有 before 游标（每频道保留 800 条），前端以前硬编码
	// `?limit=60` 且从不翻页，用户只能看到最近 60 条，更早的等于不存在。
	if (view.hasMore) {
		const firstSeq = view.messages[0]?.seq ?? 0;
		html.push(`<button class="ch-load-more" type="button" data-before="${firstSeq}">加载更早的消息</button>`);
	}
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
				renderBubble(message.text, message.seq),
				renderMentions(message),
				`</div>`,
				`</div>`,
			].join(""),
		);
	}
	el.body.innerHTML = html.join("");
	for (const button of el.body.querySelectorAll(".ch-load-more")) {
		button.addEventListener("click", () => loadEarlier(Number(button.dataset.before)));
	}
	// 展开全文（事件委托：消息流每次全量重渲染，逐个绑定会漏）
	for (const button of el.body.querySelectorAll(".ch-expand")) {
		button.addEventListener("click", () => {
			const seq = Number(button.dataset.seq);
			if (Number.isFinite(seq)) state.expanded.add(seq);
			const bubble = button.previousElementSibling;
			if (bubble !== null) bubble.dataset.collapsed = "false";
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
function renderBubble(text, seq) {
	const html = renderMarkdown(text);
	const lines = (text.match(/\n/g) ?? []).length + 1;
	const long = lines > 28 || text.length > 1600;
	if (!long) return `<div class="ch-bubble">${html}</div>`;
	// 展开状态存在 state 里而不是 DOM 上：消息流每次轮询全量重渲染，
	// 只改 DOM 的 dataset 等于「点了展开，下一轮又收回去」。
	const open = state.expanded.has(seq);
	return [
		`<div class="ch-bubble" data-collapsed="${open ? "false" : "true"}">${html}</div>`,
		open ? "" : `<button class="ch-expand" type="button" data-seq="${seq}">展开全文（${lines} 行）</button>`,
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
			// 成员可点：点一下直接进和 TA 的私聊频道（dm:<id>）。
			// 以前是纯文本，看到「林越」想问一句却没法开私聊。
			(member) => [
				`<li class="ch-member" data-role="${escapeAttr(member.role)}">`,
				`<button class="ch-member-btn" type="button" data-dm="${member.id}" title="和 ${escapeAttr(member.label)} 私聊">`,
				avatar(member.label, 22, "ch-av--sm"),
				`<span class="ch-member-main">`,
				`<b>${escapeHtml(member.label)}</b>`,
				`<span class="ch-member-role">${escapeHtml(roleLabel(member.role))}</span>`,
				`</span>`,
				member.unread > 0 ? `<b class="ch-badge">${member.unread}</b>` : "",
				`</button>`,
				`</li>`,
			].join(""),
		)
		.join("");
	el.members.innerHTML = html;
	for (const button of el.members.querySelectorAll(".ch-member-btn")) {
		button.addEventListener("click", () => {
			const id = Number(button.dataset.dm);
			if (!Number.isFinite(id)) return;
			// 私聊频道由 ensureAllChannels 建好，命名固定 `dm:<conversationId>`
			const dmId = `dm:${id}`;
			const exists = state.channels.some((channel) => channel.id === dmId);
			if (!exists) {
				notify("还没有和这个人的私聊频道", "error");
				return;
			}
			state.expanded.clear();
			openChannel(dmId);
		});
	}
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
	// `@` 前一个字符必须是空白或行首：否则 `a@b.com`、`foo@bar` 也会弹候选
	if (at > 0 && !/[\s(（【\[]/.test(before[at - 1])) return null;
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
		state.mentionItems = [];
		return;
	}
	state.mentionStart = detected.start;
	state.mentionQuery = detected.query;
	const query = detected.query.toLowerCase();
	const list = state.mentionCandidates.filter((candidate) => candidate.label.toLowerCase().includes(query));
	if (list.length === 0) {
		el.mention.hidden = true;
		state.mentionItems = [];
		return;
	}
	const items = list.slice(0, 8);
	state.mentionItems = items;
	// 高亮项越界就夹回来（用户打字把候选从 8 个筛到 2 个时）
	if (state.mentionActive >= items.length) state.mentionActive = 0;
	el.mention.hidden = false;
	el.mention.innerHTML = items
		.map(
			(candidate, index) =>
				`<button type="button" class="ch-mention-item" data-label="${escapeAttr(candidate.label)}"` +
				` data-active="${index === state.mentionActive ? "true" : "false"}">` +
				avatar(candidate.label, 18, "ch-av--xs") +
				`<b>${escapeHtml(candidate.label)}</b>` +
				`<span>${escapeHtml(roleLabel(candidate.role))}</span>` +
				`</button>`,
		)
		.join("");
	for (const button of el.mention.querySelectorAll(".ch-mention-item")) {
		// mousedown 里 preventDefault：否则 input 先 blur，弹层被关掉，click 永远到不了
		button.addEventListener("mousedown", (event) => {
			event.preventDefault();
			insertMention(button.dataset.label);
		});
	}
	el.mention.querySelectorAll(".ch-mention-item").forEach((button, index) => {
		button.addEventListener("mousemove", () => {
			if (state.mentionActive === index) return;
			state.mentionActive = index;
			el.mention.querySelectorAll(".ch-mention-item").forEach((other, otherIndex) => {
				other.dataset.active = otherIndex === index ? "true" : "false";
			});
		});
	});
}

/** 上下键移动高亮（不重渲染整段：只改 data-active，避免闪烁与丢焦点）。 */
function moveMentionActive(step) {
	const count = state.mentionItems.length;
	if (count === 0) return;
	state.mentionActive = (state.mentionActive + step + count) % count;
	if (el.mention === null) return;
	const buttons = el.mention.querySelectorAll(".ch-mention-item");
	buttons.forEach((button, index) => {
		button.dataset.active = index === state.mentionActive ? "true" : "false";
	});
	buttons[state.mentionActive]?.scrollIntoView({ block: "nearest" });
}

/** 选中当前高亮的候选。 */
function pickMentionActive() {
	const item = state.mentionItems[state.mentionActive];
	if (item === undefined) return false;
	insertMention(item.label);
	return true;
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

/**
 * 提示。
 *
 * 曾经只 dispatch 一个 `aic:toast` CustomEvent —— 全前端**零监听器**，
 * 所以「发送失败」是彻底静默的。现在由 app.js 注入真正的 toast。
 */
let toast = null;
function notify(text, tone = "info") {
	if (toast !== null) toast(text, tone);
	else if (tone === "error") console.error("[频道]", text);
}

/** 挂载到 #channels 容器（由 app.js 在切到频道视图时调用）。 */
export function initChannels({ onToast } = {}) {
	toast = typeof onToast === "function" ? onToast : null;
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
		// **中文输入法**：选候选词时按 Enter 也会触发 keydown，key 同样是 "Enter"。
		// 不挡住就会把拼音/半截中文直接发出去（chat.js 早就有这个判断，频道漏了）。
		if (event.isComposing || event.keyCode === 229) return;

		const popupOpen = el.mention !== null && !el.mention.hidden;
		if (popupOpen) {
			if (event.key === "ArrowDown" || event.key === "ArrowUp") {
				event.preventDefault();
				moveMentionActive(event.key === "ArrowDown" ? 1 : -1);
				return;
			}
			if ((event.key === "Enter" || event.key === "Tab") && !event.shiftKey) {
				event.preventDefault();
				if (pickMentionActive()) return;
			}
			if (event.key === "Escape") {
				event.preventDefault();
				el.mention.hidden = true;
				state.mentionItems = [];
				return;
			}
		}

		if (event.key === "Enter" && !event.shiftKey) {
			event.preventDefault();
			sendMessage(el.input?.value ?? "");
		}
	});

	// 切到频道视图时才加载（避免启动就多两个请求）
	let loaded = false;
	const ensureLoaded = async () => {
		if (loaded) return;
		loaded = true;
		try {
			await loadChannels();
		} catch {
			// 失败要允许重试：以前 loaded 在 await 前就置 true，一次失败就永久空白
			loaded = false;
		}
	};

	// org SSE 推送 → 刷新（节流）
	let pending = null;
	window.addEventListener("aic:org", () => {
		if (document.body.dataset.view !== "channels") return;
		if (pending !== null) return;
		pending = window.setTimeout(async () => {
			pending = null;
			await loadChannels();
			// 手机停在列表页时不要自动进会话（会把人踢离列表并顺手标已读）
			const onListPane = el.layout === null || el.layout.dataset.pane !== "main";
			const narrow = window.matchMedia("(max-width: 860px)").matches;
			if (state.activeId !== null && !(narrow && onListPane)) {
				await openChannel(state.activeId, { userInitiated: false });
			}
		}, 400);
	});

	return {
		async refresh() {
			await ensureLoaded();
			if (state.activeId !== null) {
				await loadMentionCandidates();
			}
		},
		/** 切换频道后必须重拉候选：@ 列表是「本频道成员」，不然会 @ 到不在群里的人。 */
		reloadCandidates: loadMentionCandidates,
		open: openChannel,
		loadMentionCandidates,
	};
}
