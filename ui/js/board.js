/**
 * 任务看板：进行中 / 待办 / 最近完成。
 *
 * 导入即自挂载（读 #board-inner）。只做四件事：
 *   1. 拉 GET /api/board，按契约归一化；后端未就绪时降级为契约 mock（界面上明确标注）。
 *   2. 三列渲染：列头计数、项目 chip、负责人、状态点、空状态、骨架。
 *   3. 刷新：9s 轮询 + window "aic:org" 事件触发；页面隐藏时暂停。
 *   4. 点卡片跳到频道视图里那个人的私聊（`dm:<conversationId>`）。
 *      历史：以前点卡片走 `#/c/<conversationId>` hash 路由打开对话面板；右侧面板
 *      删掉之后那条路由没有任何消费者了（app.js 不再监听 hash），所以改成直接
 *      调频道视图的 open()——看板是老板的入口之一，点了必须真的到得了地方。
 *
 * 视图显隐不在这里做：body[data-view="board"] 的 CSS 归 shell.css。
 */
import { escapeHtml, relTime, initials } from "./format.js";
import { icon } from "./icons.js";

const POLL_MS = 9_000;
/** aic:org 可能很密集：两次刷新之间至少隔 1.2s。 */
const MIN_REFRESH_GAP_MS = 1_200;
const COLUMNS = [
	{ id: "doing", title: "进行中", empty: "没有在跑的条目", hint: "有会话开始干活时会出现在这里", icon: "play" },
	{ id: "todo", title: "待办", empty: "待办清空了", hint: "等你拍板或排队中的任务会落在这里", icon: "filter" },
	{ id: "done", title: "最近完成", empty: "还没有完成记录", hint: "跑完的会话会在这里留一条", icon: "check" },
];
const STATUS_LABEL = {
	busy: "在跑",
	waiting: "待你",
	queued: "排队",
	idle: "空闲",
	done: "完成",
};

const boardInner = document.getElementById("board-inner");

/** 只更新一次的静态节点。 */
const el = {
	inner: boardInner,
	meta: null,
	live: null,
	source: null,
	refresh: null,
	cols: null,
	offline: null,
};

let lastColumnsSignature = "";
/** 已经入过场的条目 id：只有新 id 才播放入场动效。 */
const seen = new Set();
const scrollTopByColumn = new Map();
let lastBoard = null;
let lastFetchAt = 0;
let timer = null;
let pendingAicOrg = null;
let inFlight = false;
let destroyed = false;

// ── 归一化 ────────────────────────────────────────────────────────────────

function asText(value) {
	return value === undefined || value === null ? "" : String(value);
}

/**
 * 看板标题来自会话文本，可能带 Markdown 记号（**加粗**、`代码`、# 标题）。
 * 卡片是一行两行的短文本，剥掉记号比原样显示更好读；正文不动。
 */
function plainTitle(text) {
	return asText(text)
		.replace(/```[\s\S]*?```/g, " ")
		.replace(/[*_`]+/g, "")
		.replace(/^\s*#{1,6}\s*/gm, "")
		.replace(/^\s*[-—]\s+/gm, "")
		.replace(/\s+/g, " ")
		.trim();
}

function normalizeItem(raw) {
	if (raw === null || typeof raw !== "object") return null;
	const title = plainTitle(raw.title);
	if (title === "") return null;
	const status = Object.hasOwn(STATUS_LABEL, raw.status) ? raw.status : "idle";
	const conversationId = Number(raw.conversationId);
	const id = asText(raw.id) || `${conversationId}:${title}`;
	return {
		id,
		title,
		project: asText(raw.project),
		projectName: asText(raw.projectName) || asText(raw.project),
		owner: asText(raw.owner),
		ownerLabel: asText(raw.ownerLabel) || asText(raw.owner),
		status,
		conversationId: Number.isFinite(conversationId) && conversationId > 0 ? conversationId : null,
		at: Number(raw.at) > 0 ? Number(raw.at) : null,
	};
}

function normalizeBoard(raw) {
	if (raw === null || typeof raw !== "object" || !Array.isArray(raw.columns)) return null;
	const byId = new Map();
	for (const column of raw.columns) {
		if (column === null || typeof column !== "object") continue;
		const id = asText(column.id);
		if (!COLUMNS.some((item) => item.id === id)) continue;
		const items = Array.isArray(column.items) ? column.items.map(normalizeItem).filter(Boolean) : [];
		byId.set(id, { title: asText(column.title), items });
	}
	const columns = COLUMNS.map((meta) => {
		const found = byId.get(meta.id);
		return {
			id: meta.id,
			title: found?.title || meta.title,
			items: found?.items ?? [],
		};
	});
	return {
		generatedAt: Number(raw.generatedAt) > 0 ? Number(raw.generatedAt) : null,
		columns,
		mocked: false,
	};
}

// ── 契约 mock（backend 未就绪时用；界面上标注「示例数据」） ─────────────────

function mockBoard() {
	const now = Date.now();
	return {
		generatedAt: now,
		mocked: true,
		columns: [
			{
				id: "doing",
				title: "进行中",
				items: [
					{
						id: "mock-doing-1",
						title: "把任务看板接进单页面视图",
						project: "web-board",
						projectName: "界面重构",
						owner: "mk",
						ownerLabel: "前端 · mk",
						status: "busy",
						conversationId: 101,
						at: now - 2 * 60_000,
					},
					{
						id: "mock-doing-2",
						title: "校对 ADR-026 决策路由的边界条件",
						project: "runtime",
						projectName: "运行时内核",
						owner: "lin",
						ownerLabel: "后端 · lin",
						status: "waiting",
						conversationId: 102,
						at: now - 6 * 60_000,
					},
				],
			},
			{
				id: "todo",
				title: "待办",
				items: [
					{
						id: "mock-todo-1",
						title: "写外部桥接入说明（微信 / 企微）",
						project: "settings",
						projectName: "设置与接入",
						owner: "yu",
						ownerLabel: "文档 · yu",
						status: "queued",
						conversationId: 103,
						at: now - 11 * 60_000,
					},
					{
						id: "mock-todo-2",
						title: "终止项目的收尾卡片设计",
						project: "legacy",
						projectName: "旧项目 · 已终止",
						owner: "qi",
						ownerLabel: "设计 · qi",
						status: "idle",
						conversationId: 104,
					},
				],
			},
			{
				id: "done",
				title: "最近完成",
				items: [
					{
						id: "mock-done-1",
						title: "附件上传联调（≤20MiB，粘贴图片）",
						project: "settings",
						projectName: "设置与接入",
						owner: "han",
						ownerLabel: "后端 · han",
						status: "done",
						conversationId: 105,
						at: now - 24 * 60_000,
					},
					{
						id: "mock-done-2",
						title: "组织图卡片 3D 悬浮与星海降级",
						project: "graph",
						projectName: "组织图",
						owner: "sen",
						ownerLabel: "图形 · sen",
						status: "done",
						conversationId: 106,
						at: now - 52 * 60_000,
					},
				],
			},
		],
	};
}

// ── 渲染 ──────────────────────────────────────────────────────────────────

function renderShell() {
	el.inner.innerHTML = `
		<div class="board-bar">
			<div class="board-bar-main">
				<b class="board-title">${icon("columns", 14)}任务看板</b>
				<span class="board-meta" id="board-meta">正在读取…</span>
				<span class="board-source" id="board-source" hidden></span>
			</div>
			<div class="board-bar-actions">
				<span class="board-live" id="board-live" data-state="ok"><i></i><span>实时</span></span>
				<button class="board-refresh" id="board-refresh" type="button" aria-label="刷新看板" title="刷新（每 9 秒自动刷新）">
					${icon("refresh", 15)}
				</button>
			</div>
		</div>
		<div class="board-offline" id="board-offline" hidden></div>
		<div class="board-cols" id="board-cols"></div>
	`;

	el.offline = el.inner.querySelector("#board-offline");
	el.meta = el.inner.querySelector("#board-meta");
	el.source = el.inner.querySelector("#board-source");
	el.live = el.inner.querySelector("#board-live");
	el.refresh = el.inner.querySelector("#board-refresh");
	el.cols = el.inner.querySelector("#board-cols");

	el.refresh.addEventListener("click", (event) => {
		event.preventDefault();
		el.refresh.setAttribute("aria-busy", "true");
		refresh({ manual: true }).finally(() => el.refresh.removeAttribute("aria-busy"));
	});

	// 点卡片 = 「去那个人的私聊」。看板不认识频道视图，只发事件；
	// app.js 负责切视图并把频道打开（单一入口，避免两处各写一份切换逻辑）。
	el.cols.addEventListener("click", (event) => {
		const card = event.target instanceof Element ? event.target.closest(".board-card") : null;
		if (card === null || card.disabled) return;
		const conversationId = Number(card.dataset.conversation);
		if (!Number.isFinite(conversationId) || conversationId <= 0) return;
		window.dispatchEvent(
			new CustomEvent("aic:open-channel", { detail: { channelId: `dm:${conversationId}` } }),
		);
	});
}

function renderSkeleton() {
	el.meta.textContent = "正在读取…";
	el.live.dataset.state = "stale";
	el.live.querySelector("span").textContent = "连接中";
	el.cols.innerHTML = COLUMNS.map(
		(meta) => `
		<section class="board-col" data-col="${meta.id}" aria-label="${escapeHtml(meta.title)}">
			<header class="board-col-head">
				<i></i><span class="board-col-title">${escapeHtml(meta.title)}</span>
				<span class="board-col-count">—</span>
			</header>
			<div class="board-col-body">
				<div class="board-skeleton">
					${[1, 2, 3]
						.map(
							() => `
						<div class="board-skeleton-card">
							<div class="board-skeleton-line is-chip skeleton"></div>
							<div class="board-skeleton-line is-title skeleton"></div>
							<div class="board-skeleton-line is-short skeleton"></div>
						</div>`,
						)
						.join("")}
				</div>
			</div>
		</section>`,
	).join("");
}

function statusLabel(status) {
	return STATUS_LABEL[status] ?? "空闲";
}

function cardHtml(item, index) {
	const entering = !seen.has(item.id);
	if (entering) seen.add(item.id);
	const status = item.status;
	/* 入场动效挂在 li 上，不挂在卡片上：
	   带 fill-mode: both 的 animation 会锁死 transform，卡片自己的 hover 抬升就失效了。 */
	const liClass = entering ? ` class="is-enter"` : "";
	const liStyle = entering ? ` style="--i:${Math.min(index, 8)}"` : "";
	const badge = initials(item.ownerLabel || item.owner);
	const time = item.at === null ? "" : relTime(item.at);
	const statusHtml = `
		<span class="board-status" data-status="${escapeHtml(status)}">
			<i class="${status === "busy" ? "pulse-dot" : ""}"></i>${escapeHtml(statusLabel(status))}
		</span>`;
	const inner = `
		<span class="board-card-top">
			${
				item.projectName === ""
					? ""
					: `<span class="project-chip" title="${escapeHtml(item.projectName)}">${escapeHtml(item.projectName)}</span>`
			}
			${statusHtml}
		</span>
		<span class="board-card-title">${escapeHtml(item.title)}</span>
		${
			item.ownerLabel === ""
				? ""
				: `<span class="board-card-foot">
						<span class="board-owner">
							<span class="board-owner-badge">${escapeHtml(badge)}</span>
							<span class="board-owner-label" title="${escapeHtml(item.ownerLabel)}">${escapeHtml(item.ownerLabel)}</span>
						</span>
						${time === "" ? "" : `<span class="board-time">${escapeHtml(time)}</span>`}
					</span>`
		}`;

	// 卡片一律是 button：点它是「切到频道视图 + 打开那个人」，不是导航到某个 URL。
	// 用 button 而不是 <a href> 是为了拿回键盘/无障碍语义（Enter/Space 直接触发），
	// 又不留下一条已经没人消费的 hash 路由。
	const attrs =
		item.conversationId === null
			? ` type="button" disabled aria-disabled="true"`
			: ` type="button" data-conversation="${item.conversationId}"`;
	return `<li${liClass}${liStyle}><button class="board-card"${attrs}>${inner}</button></li>`;
}

function emptyHtml(meta) {
	return `
		<div class="board-empty">
			${icon(meta.icon, 15)}
			<b>${escapeHtml(meta.empty)}</b>
			<span>${escapeHtml(meta.hint)}</span>
		</div>`;
}

function captureScroll() {
	if (el.cols === null) return;
	for (const body of el.cols.querySelectorAll(".board-col-body")) {
		const id = body.closest(".board-col")?.dataset.col;
		if (id !== undefined) scrollTopByColumn.set(id, body.scrollTop);
	}
}

function restoreScroll() {
	if (el.cols === null) return;
	for (const body of el.cols.querySelectorAll(".board-col-body")) {
		const id = body.closest(".board-col")?.dataset.col;
		const top = id === undefined ? 0 : scrollTopByColumn.get(id) ?? 0;
		if (top > 0) body.scrollTop = top;
	}
}

function renderColumns(board) {
	captureScroll();
	el.cols.innerHTML = board.columns
		.map((column) => {
			const meta = COLUMNS.find((item) => item.id === column.id) ?? COLUMNS[0];
			const count = column.items.length;
			return `
			<section class="board-col" data-col="${column.id}" aria-label="${escapeHtml(column.title)}（${count}）">
				<header class="board-col-head">
					<i></i><span class="board-col-title">${escapeHtml(column.title)}</span>
					<span class="board-col-count">${count}</span>
				</header>
				<div class="board-col-body">
					${
						count === 0
							? emptyHtml(meta)
							: `<ul class="board-list">${column.items.map(cardHtml).join("")}</ul>`
					}
				</div>
			</section>`;
		})
		.join("");
	restoreScroll();
	syncCurrent();
}

/**
 * 高亮「当前正开着的那个频道」对应的卡片。
 *
 * 以前读 `location.hash`（`#/c/<id>`），但那条路由是对话面板时代的产物，
 * 面板删掉后没人再写 hash。现在真相在频道视图里（`.ch-row[data-active="true"]`
 * 的 `dm:<id>`），这里只做一次只读映射——看板不持有频道状态，不去抢那份数据。
 */
function syncCurrent() {
	if (el.cols === null) return;
	const active = document.querySelector('.ch-row[data-active="true"]')?.dataset.id ?? "";
	const match = /^dm:(\d+)$/.exec(active);
	const id = match === null ? null : match[1];
	for (const card of el.cols.querySelectorAll(".board-card")) {
		const isCurrent = id !== null && card.dataset.conversation === id;
		if (isCurrent) card.setAttribute("aria-current", "true");
		else card.removeAttribute("aria-current");
	}
}

function renderMeta(board) {
	const at = board.generatedAt ?? Date.now();
	const date = new Date(at);
	const pad = (value) => String(value).padStart(2, "0");
	el.meta.textContent = `更新于 ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
	el.source.hidden = !board.mocked;
	el.source.dataset.mock = board.mocked ? "true" : "false";
	el.source.textContent = board.mocked ? "示例数据" : "";
	el.source.title = board.mocked ? "GET /api/board 暂不可用，当前展示契约 mock" : "来自 GET /api/board";
	el.live.dataset.state = board.mocked ? "mock" : "ok";
	el.live.querySelector("span").textContent = board.mocked ? "示例" : "实时";
}

function applyBoard(board) {
	lastBoard = board;
	renderMeta(board);
	clearError();
	const signature = JSON.stringify(board.columns);
	if (signature !== lastColumnsSignature) {
		lastColumnsSignature = signature;
		renderColumns(board);
	}
}

/**
 * 拉取失败时不打散已有列表：顶部压一条离线提示 + 重试按钮，
 * 列里保留上一次成功的数据（mock 兜底只在完全没数据时出现）。
 */
function showError(message) {
	const live = el.live?.querySelector("span");
	if (live !== null && live !== undefined) {
		live.textContent = "离线";
		el.live.dataset.state = "stale";
		el.live.title = message;
	}
	if (el.meta !== null) el.meta.title = message;
	if (el.offline === null) return;
	if (el.offline.dataset.message === message) return;
	el.offline.dataset.message = message;
	el.offline.innerHTML = `${icon("alert", 13)}<span>${escapeHtml(message)}</span><button type="button">重试</button>`;
	el.offline.hidden = false;
	el.offline.querySelector("button")?.addEventListener("click", () => refresh({ manual: true }));
}

function clearError() {
	if (el.offline === null || el.offline.hidden) return;
	el.offline.hidden = true;
	el.offline.dataset.message = "";
	el.offline.innerHTML = "";
}

// ── 数据 ──────────────────────────────────────────────────────────────────

async function refresh({ manual = false } = {}) {
	if (destroyed || inFlight) return;
	if (!manual && document.hidden) return;
	inFlight = true;
	try {
		const response = await fetch("/api/board", { headers: { accept: "application/json" } });
		if (!response.ok) throw new Error(`HTTP ${response.status}`);
		// 后端未注册路由时可能回落到 index.html（200 + text/html），这里按契约拒收。
		const contentType = response.headers.get("content-type") ?? "";
		if (!contentType.includes("application/json")) throw new Error("接口未就绪");
		const raw = await response.json();
		const board = normalizeBoard(raw);
		if (board === null) throw new Error("接口返回格式不符");
		lastFetchAt = Date.now();
		applyBoard(board);
	} catch (error) {
		const message = error instanceof Error ? error.message : "未知错误";
		if (lastBoard === null) {
			// 后端未就绪（路由未注册 / 连接失败 / 契约不符）→ 契约 mock，并明确标注「示例数据」。
			applyBoard(mockBoard());
			showError(`/api/board 暂不可用（${message}），下面是契约示例数据`);
		} else {
			showError(`看板没拉到（${message}），保持上一次的数据`);
		}
	} finally {
		inFlight = false;
	}
}

function scheduleRefresh() {
	if (pendingAicOrg !== null) return;
	pendingAicOrg = window.setTimeout(
		() => {
			pendingAicOrg = null;
			if (Date.now() - lastFetchAt < MIN_REFRESH_GAP_MS) return;
			refresh();
		},
		Math.max(0, MIN_REFRESH_GAP_MS - (Date.now() - lastFetchAt)),
	);
}

function startPolling() {
	if (timer !== null) return;
	timer = window.setInterval(() => {
		if (document.hidden) return;
		refresh();
	}, POLL_MS);
}

function stopPolling() {
	if (timer === null) return;
	window.clearInterval(timer);
	timer = null;
}

// ── 启动 ──────────────────────────────────────────────────────────────────

function mount() {
	if (boardInner === null) return;

	// 不碰 #board.hidden：显隐归 app.js 切 dataset + shell.css 的 body[data-view] 规则，
	// 这里只负责往里画内容，避免两个模块抢同一个属性。
	renderShell();
	renderSkeleton();
	// 只在看板视图里轮询：切到组织图/频道后还每 9s 打一次 /api/board 是白烧。
	// app.js 的 applyView 会派发 aic:view，这里据此起停。
	if (document.body.dataset.view === "board") {
		startPolling();
		refresh();
	}
}

window.addEventListener("aic:org", scheduleRefresh);
window.addEventListener("aic:view", (event) => {
	const view = event.detail?.view;
	if (view === "board") {
		startPolling();
		refresh();
		// 从频道切过来时要立刻反映「现在开着哪个私聊」，不能等下一次刷新。
		syncCurrent();
	} else {
		stopPolling();
	}
});
window.addEventListener("aic:channel", syncCurrent);
document.addEventListener("visibilitychange", () => {
	if (document.hidden) {
		stopPolling();
		return;
	}
	// 回到前台时**只在看板视图里**恢复轮询：以前无条件 startPolling()，
	// 于是在组织图/频道视图里切一次标签页回来，看板又开始每 9 秒打
	// 一次 /api/board（白烧），而它自己明明已经在 aic:view 里停过了。
	if (document.body.dataset.view !== "board") return;
	startPolling();
	refresh();
});

// 页面被卸载前收掉定时器（单页面里极少触发，防御性写一下）。
window.addEventListener("pagehide", () => {
	destroyed = true;
	stopPolling();
});

mount();
