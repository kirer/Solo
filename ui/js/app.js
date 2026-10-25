/**
 * 一人公司 · 网页界面入口（单页面）。
 *
 * 一屏之内：顶栏（设置 / 待办 / 对话开关）+ 组织图 + 常驻对话。
 * 只做四件事：订阅数据、切换会话、发消息、把状态分发给视图模块。
 */
import { escapeHtml, formatCost, formatTokens } from "./format.js";
import { initOrg } from "./org.js";
import { initChat } from "./chat.js";
import { initSettings } from "./settings.js";
import { initChannels } from "./channels.js";

const $ = (id) => document.getElementById(id);
const MOBILE_QUERY = window.matchMedia("(max-width: 860px)");

const state = {
	org: null,
	openId: null,
	orgSource: null,
	feedSource: null,
	/** 开发钩子：冻结 SSE，用于注入假数据做视觉验收。 */
	freeze: false,
	connected: true,
	/** 当前主视图：org（组织图）/ board（任务看板）。 */
	view: "org",
	autoSelected: false,
	chromeSignature: "",
	actorSignature: "",
	lastFeedNoticeAt: 0,
};

const orgView = initOrg({ onSelect: (id) => selectConversation(id) });
// 待办不再是「面板顶部的一块区域」：它随 feed 进聊天流，交互也归聊天面板。
// 这里只把「怎么提交答复」注入进去（ADR-026 的面板与流内卡片从此只有一套渲染）。
const chat = initChat({ onSend: sendMessage, uploadFile, fetchProfile, onAnswer: submitAnswer });
const settingsPanel = initSettings({ onToast: (text, tone) => chat.notify?.(text, tone) });
// 频道视图（通信重构）：左侧频道列表 + 消息流 + 成员/任务
const channels = initChannels({ onToast: (text, tone) => chat.notify?.(text, tone) });

/**
 * 取一位职工的角色档案（角色预制提示词 / 技能清单）。
 *
 * 档案是「点开才看」的次要信息，所以失败一律返回 null，
 * 由 chat 面板降级成「暂无档案」，不弹错误、不阻塞对话。
 */
async function fetchProfile(conversationId) {
	const id = Number(conversationId);
	if (!Number.isFinite(id)) return null;
	try {
		const response = await fetch(`/api/profile/${id}`);
		if (!response.ok) return null;
		const data = await response.json();
		if (data === null || typeof data !== "object" || data.error !== undefined) return null;
		return data;
	} catch {
		return null;
	}
}

// ── 组织快照 ──────────────────────────────────────────────────────────────

function findActor(org, conversationId) {
	if (org === null) return null;
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

function applyOrg(next) {
	state.org = next;
	// 看板等模块独立挂载，只订阅这一份组织快照（不直接依赖 app.js 内部状态）。
	window.dispatchEvent(new CustomEvent("aic:org", { detail: next }));
	renderChrome(next);
	orgView.update(next);

	const actor = state.openId === null ? null : findActor(next, state.openId);
	if (actor !== null) {
		const signature = `${actor.conversationId}:${actor.status}:${actor.tokens}:${actor.activity}:${actor.awaitingYou}:${actor.label}`;
		if (signature !== state.actorSignature) {
			state.actorSignature = signature;
			chat.updateOrg(next);
		}
	} else if (state.openId !== null) {
		state.openId = null;
		closeFeed();
		chat.clear();
	}

	if (!state.autoSelected) {
		state.autoSelected = true;
		const target = conversationFromHash() ?? next.ceo?.conversationId;
		if (target !== undefined && findActor(next, target) !== null) {
			selectConversation(target, { openSheet: false, focus: false });
		}
	}
}

function renderChrome(org) {
	const companyName = $("company-name");
	if (companyName !== null) companyName.textContent = org.company?.name || "一人公司";
	// 设置面板读到 /api/settings 后接管这一行（显示配置的默认模型而不是运行时快照）。
	const modelLabel = $("company-model");
	if (modelLabel !== null && modelLabel.dataset.settingsOwner !== "1") {
		modelLabel.textContent = org.company?.model ?? "—";
		modelLabel.title = org.company?.model ?? "";
	}

	const forYou = (org.pending ?? []).filter((item) => item.forYou);

	const actors = allActors(org);
	const busy = actors.filter((actor) => actor.status === "busy").length;
	const activeProjects = (org.projects ?? []).filter((project) => project.status !== "terminated");
	const staffCount = (org.projects ?? []).reduce(
		(total, project) => total + (project.staff ?? []).filter((person) => !person.archived).length,
		0,
	);

	const signature = `${activeProjects.length}:${staffCount}:${forYou.length}:${busy}`;
	if (signature !== state.chromeSignature) {
		state.chromeSignature = signature;
		const parts = [
			`${activeProjects.length} 个项目`,
			`${staffCount} 名员工`,
			busy > 0 ? `${busy} 人在跑` : null,
		].filter((part) => part !== null);
		$("stage-sub").innerHTML = parts.join(" · ");
	}

	const tokens = formatTokens(org.costs?.totalTokens ?? 0);
	const cost = formatCost(org.costs?.totalCostUsd ?? 0);
	$("settings-cost").textContent = `${tokens} tokens · ${cost}`;

	document.title = forYou.length > 0 ? `(${forYou.length}) 一人公司` : "一人公司";
}

function allActors(org) {
	const list = [];
	if (org.ceo !== undefined) list.push(org.ceo);
	for (const role of org.roles ?? []) list.push(role);
	for (const project of org.projects ?? []) {
		if (project.lead !== undefined) list.push(project.lead);
		for (const person of project.staff ?? []) list.push(person);
	}
	return list;
}

// ── 会话切换 ──────────────────────────────────────────────────────────────

function selectConversation(conversationId, options = {}) {
	const id = Number(conversationId);
	if (!Number.isFinite(id)) return;
	const actor = findActor(state.org, id);
	if (actor === null) return;

	const mobile = MOBILE_QUERY.matches;
	const openSheet = options.openSheet ?? true;

	if (state.openId === id) {
		chat.setActor(actor);
		if (mobile && openSheet) openMobileSheet();
		else chat.expand?.();
		return;
	}

	state.openId = id;
	state.actorSignature = `${actor.conversationId}:${actor.status}:${actor.tokens}:${actor.activity}:${actor.awaitingYou}:${actor.label}`;
	orgView.setSelected(id);
	chat.setActor(actor);
	chat.setLoading();
	if (!mobile) chat.expand?.();
	openFeed(id);

	if (mobile && openSheet) openMobileSheet();
	if (options.focus !== false && !mobile) $("input")?.focus();

	try {
		history.replaceState(null, "", `#/c/${id}`);
	} catch {
		/* file:// 下 replaceState 可能被拒 */
	}
}

function openFeed(conversationId) {
	closeFeed();
	// 开发钩子灌假数据时不要连真实会话流：假会话在库里不存在，会一直重连。
	if (state.freeze) return;
	const source = new EventSource(`/api/stream/feed/${conversationId}`);
	source.addEventListener("open", () => setConnected(true));
	source.addEventListener("feed", (event) => {
		setConnected(true);
		if (state.freeze) return;
		let feed;
		try {
			feed = JSON.parse(event.data);
		} catch {
			return;
		}
		chat.setFeed(feed);
	});
	source.onerror = () => {
		const now = Date.now();
		if (now - state.lastFeedNoticeAt > 12_000) {
			state.lastFeedNoticeAt = now;
			chat.notify?.("连接有点慢，正在重连…", "warn");
		}
	};
	state.feedSource = source;
}

function closeFeed() {
	state.feedSource?.close();
	state.feedSource = null;
}

function conversationFromHash() {
	const match = /^#\/c\/(\d+)/.exec(location.hash);
	return match === null ? null : Number(match[1]);
}

// ── 手机抽屉 / 对话开关 ───────────────────────────────────────────────────

function openMobileSheet() {
	// 设置是全屏视图：从这里打开对话说明用户要离开设置，先回到 chat 视图。
	showAsideView("chat", { focus: false });
	document.body.dataset.chat = "open";
	document.body.dataset.sheet = "open";
	chat.openSheet?.();
	syncChatButton();
}

function closeMobileSheet() {
	document.body.dataset.sheet = "closed";
	chat.closeSheet?.();
	syncChatButton();
}

function toggleChat() {
	if (MOBILE_QUERY.matches) {
		if (document.body.dataset.sheet === "open") {
			closeMobileSheet();
			return;
		}
		if (state.openId !== null) {
			openMobileSheet();
			return;
		}
		if (state.org?.ceo !== undefined) {
			selectConversation(state.org.ceo.conversationId, { openSheet: true });
		}
		return;
	}
	// 桌面：设置占着槽位时，“打开对话”= 切回对话视图，而不是把被隐藏的对话展开。
	if (document.body.dataset.viewAside === "settings") {
		showAsideView("chat");
		return;
	}
	chat.toggle();
	syncChatButton();
}

function syncChatButton() {
	const mobile = MOBILE_QUERY.matches;
	const open = mobile
		? document.body.dataset.sheet === "open"
		: document.body.dataset.chat === "open";
	const button = $("chat-toggle");
	if (button !== null) button.setAttribute("aria-pressed", open ? "true" : "false");
}

// ── 设置 ──────────────────────────────────────────────────────────────────

const THEME_KEY = "ai-company.theme";
const THEME_LABEL = { dark: "深色", light: "浅色", system: "跟随系统" };
const THEME_BG = { dark: "#0b0c0e", light: "#f5f5f2" };
const systemLight = window.matchMedia("(prefers-color-scheme: light)");
let themeMode = document.documentElement.dataset.theme || "system";

function resolvedTheme(mode) {
	if (mode === "system") return systemLight.matches ? "light" : "dark";
	return mode === "light" ? "light" : "dark";
}

function applyTheme(mode, { persist = true } = {}) {
	themeMode = THEME_LABEL[mode] === undefined ? "system" : mode;
	const resolved = resolvedTheme(themeMode);
	document.documentElement.dataset.theme = themeMode;
	document.documentElement.dataset.resolved = resolved;
	if (persist) {
		try {
			localStorage.setItem(THEME_KEY, themeMode);
		} catch {
			/* 隐私模式下 localStorage 可能不可写 */
		}
	}
	const meta = document.querySelector('meta[name="theme-color"]');
	if (meta !== null) meta.setAttribute("content", THEME_BG[resolved]);

	for (const option of document.querySelectorAll("[data-theme-option]")) {
		const checked = option.dataset.themeOption === themeMode;
		option.setAttribute("aria-checked", checked ? "true" : "false");
		option.classList.toggle("is-active", checked);
	}
}

/**
 * 对话 ↔ 设置：互斥视图切换（设置不是浮层）。
 *
 * 形态：`#chat` 与 `#settings` 在 `.workspace` 里共用同一块并排槽位，
 * `body[data-view-aside]` 决定谁在前、谁可交互（位移/透明度全交给 settings.css）。
 *
 * 三条硬约束（老板验收口径）：
 *   1. 不销毁聊天 DOM —— 只切属性，滚动位置与输入框草稿天然留在原位；
 *   2. 过渡是普通 CSS transition（transform + opacity），没有 animationend 回调，
 *      连续快速切换由下一次状态自然接管：可中断、可反向；
 *   3. 焦点进场 / 归还，Esc 与返回按钮都能退出。
 */
const ASIDE_VIEW = { chat: "chat", settings: "settings" };

/** 「设置是否打开」的唯一真相：body[data-view-aside]，不看元素显隐。 */
function asideView() {
	return document.body.dataset.viewAside === ASIDE_VIEW.settings ? ASIDE_VIEW.settings : ASIDE_VIEW.chat;
}

/**
 * 切到设置 / 切回对话（模块级：桌面「打开对话」按钮也要能调用）。
 *
 * 先落同一个 body 属性，过渡交给 CSS：中断/反向都不需要额外收拾状态。
 * 被替换的视图用 inert 退出无障碍树与 tab 序列（不用 display:none，
 * 否则 .chat 的滚动容器高度归零，scrollTop 会被浏览器抹掉）。
 */
function showAsideView(view, { focus = true } = {}) {
	const next = view === ASIDE_VIEW.settings ? ASIDE_VIEW.settings : ASIDE_VIEW.chat;
	if (asideView() === next) return next;
	const panel = $("settings");
	const toggle = $("settings-toggle");
	const chatEl = $("chat");
	if (panel === null || toggle === null) return next;

	document.body.dataset.viewAside = next;
	const open = next === ASIDE_VIEW.settings;
	panel.setAttribute("aria-hidden", open ? "false" : "true");
	toggle.setAttribute("aria-expanded", open ? "true" : "false");
	toggle.setAttribute("aria-pressed", open ? "true" : "false");
	if (chatEl !== null) chatEl.inert = open;
	panel.inert = !open;
	if (open) {
		// 打开时刷新一次：设置可能在别的标签页/终端里改过。
		settingsPanel.refresh?.();
		if (focus) {
			const target = panel.querySelector('[aria-checked="true"]') ?? panel.querySelector(".settings-head b");
			target?.focus?.({ preventScroll: true });
		}
	} else if (focus) {
		toggle.focus({ preventScroll: true });
	}
	return next;
}

function setupSettings() {
	const panel = $("settings");
	const toggle = $("settings-toggle");
	const close = $("settings-close");
	if (panel === null || toggle === null) return;
	applyTheme(themeMode, { persist: false });

	const closePanel = (options) => showAsideView(ASIDE_VIEW.chat, options);
	const openPanel = (options) => showAsideView(ASIDE_VIEW.settings, options);

	toggle.addEventListener("click", () => {
		if (asideView() === ASIDE_VIEW.settings) closePanel();
		else openPanel();
	});
	close?.addEventListener("click", () => closePanel());

	const themeOptions = [...panel.querySelectorAll("[data-theme-option]")];
	for (const option of themeOptions) {
		option.addEventListener("click", () => applyTheme(option.dataset.themeOption));
	}
	// APG radiogroup：方向键切换并移动焦点
	panel.querySelector(".settings-theme")?.addEventListener("keydown", (event) => {
		const steps = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 };
		const step = steps[event.key];
		if (step === undefined) return;
		const index = themeOptions.indexOf(document.activeElement);
		if (index === -1) return;
		event.preventDefault();
		const next = themeOptions[(index + step + themeOptions.length) % themeOptions.length];
		next.focus();
		applyTheme(next.dataset.themeOption);
	});
	// 旧的「点外面关闭」随浮层一起删掉了：设置现在是整块视图，没有「外面」可点。
	document.addEventListener("keydown", (event) => {
		if (event.key !== "Escape") return;
		if (asideView() !== ASIDE_VIEW.settings) return;
		// 设置里的确认条、@ 提及弹层、抽屉等各自处理 Esc；这里只在没人消费时退出。
		if (event.defaultPrevented) return;
		event.preventDefault();
		closePanel();
	});
	systemLight.addEventListener("change", () => {
		if (themeMode === "system") applyTheme("system", { persist: false });
	});

	// 初始态显式落一次（index.html 不带该属性时也能工作），且不抢焦点。
	showAsideView(ASIDE_VIEW.chat, { focus: false });
}

// ── 主视图切换（组织图 / 看板） ────────────────────────────────────────────

const VIEW_KEY = "ai-company.view";

/**
 * 切换主视图：org（组织图）或 board（任务看板）。
 *
 * 只做三件事：body[data-view] 给 CSS、#board.hidden 控制占位、按钮 aria-selected。
 * 看板内容由 board.js 自己渲染，这里不碰。
 */
function applyView(name, { persist = true } = {}) {
	const view = name === "board" ? "board" : name === "channels" ? "channels" : "org";
	state.view = view;
	document.body.dataset.view = view;
	const board = $("board");
	if (board !== null) board.hidden = view !== "board";
	const channelsRoot = $("channels");
	if (channelsRoot !== null) channelsRoot.hidden = view !== "channels";
	for (const button of document.querySelectorAll(".view-switch-btn")) {
		button.setAttribute("aria-selected", button.id === `view-${view}` ? "true" : "false");
	}
	// 切到频道视图时才拉数据（省掉启动时的两个请求）
	if (view === "channels") void channels.refresh();
	// 通知各模块「当前是哪个视图」：看板据此起停轮询，别再后台白烧请求
	window.dispatchEvent(new CustomEvent("aic:view", { detail: { view } }));
	if (persist) {
		try {
			localStorage.setItem(VIEW_KEY, view);
		} catch {
			/* 隐私模式可能不可写 */
		}
	}
}

/** 三个视图轮转：组织 → 看板 → 频道 → 组织。 */
function toggleView() {
	const next = state.view === "org" ? "board" : state.view === "board" ? "channels" : "org";
	applyView(next);
}

function setupViewSwitch() {
	$("view-channels")?.addEventListener("click", () => applyView("channels"));
	$("view-org")?.addEventListener("click", () => applyView("org"));
	$("view-board")?.addEventListener("click", () => applyView("board"));
	let stored = "org";
	try {
		stored = localStorage.getItem(VIEW_KEY) ?? "org";
	} catch {
		stored = "org";
	}
	applyView(stored, { persist: false });
}

// ── 动作 ──────────────────────────────────────────────────────────────────

/** 附件上限与后端一致：超过就别浪费一次上传。 */
const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;

/**
 * 上传一个文件，返回 /api/upload 的响应对象（{id,name,size,mime,url}）。
 *
 * chat.js 负责托盘展示与失败 toast：这里抛出的 Error 消息要能直接给人看。
 * 文件名走 x-file-name，必须 encodeURIComponent（HTTP 头不能放非 ASCII 字符）。
 */
async function uploadFile(file) {
	if (!(file instanceof File)) throw new Error("没有可上传的文件。");
	if (file.size > MAX_UPLOAD_BYTES) {
		throw new Error(`文件「${file.name || "未命名"}」超过 20 MiB，请压缩后再试。`);
	}
	let response;
	try {
		response = await fetch("/api/upload", {
			method: "POST",
			headers: {
				"Content-Type": file.type || "application/octet-stream",
				"x-file-name": encodeURIComponent(file.name || "file"),
			},
			body: file,
		});
	} catch {
		throw new Error("上传失败：连不上服务，检查 ai-company 是否还在运行。");
	}
	let data = null;
	try {
		data = await response.json();
	} catch {
		data = null;
	}
	if (!response.ok) {
		const message = typeof data?.error === "string" && data.error.trim() !== "" ? data.error.trim() : "";
		throw new Error(message !== "" ? message : `上传失败（HTTP ${response.status}）。`);
	}
	if (data === null || typeof data !== "object" || data.id === undefined) {
		throw new Error("上传失败：服务返回的数据不完整。");
	}
	return data;
}

async function sendMessage(text, attachments = []) {
	const conversationId = state.openId;
	if (conversationId === null) return false;
	const files = (Array.isArray(attachments) ? attachments : []).filter(
		(item) => item !== null && typeof item === "object",
	);
	const message = String(text ?? "").trim();
	if (message === "" && files.length === 0) return false;
	chat.addLocalQueued(message !== "" ? message : files.map((item) => item.name).join("、"));
	const payload = { conversationId, text: message };
	if (files.length > 0) {
		payload.attachments = files.map((item) => ({
			id: item.id,
			name: item.name,
			mime: item.mime,
			size: item.size,
		}));
	}
	try {
		const response = await fetch("/api/message", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(payload),
		});
		if (!response.ok) {
			let detail = "";
			try {
				const data = await response.json();
				detail = typeof data?.error === "string" ? data.error : "";
			} catch {
				detail = "";
			}
			throw new Error(detail !== "" ? detail : `HTTP ${response.status}`);
		}
		return true;
	} catch (error) {
		const reason = error instanceof Error && error.message !== "" ? error.message : "";
		chat.notify?.(
			reason === "" || reason.startsWith("HTTP")
				? "消息没发出去，检查服务是否还在运行。"
				: `消息没发出去：${reason}`,
			"error",
		);
		return false;
	}
}

async function submitAnswer(key, text) {
	const value = String(text ?? "").trim();
	if (value === "") return false;
	try {
		const response = await fetch("/api/answer", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ key, text: value }),
		});
		if (!response.ok) throw new Error(`HTTP ${response.status}`);
		return true;
	} catch {
		return false;
	}
}

// ── 连接 ──────────────────────────────────────────────────────────────────

function connectOrg() {
	const source = new EventSource("/api/stream/org");
	source.addEventListener("open", () => setConnected(true));
	source.addEventListener("org", (event) => {
		setConnected(true);
		if (state.freeze) return;
		let org;
		try {
			org = JSON.parse(event.data);
		} catch {
			return;
		}
		if (org?.error !== undefined) {
			showFatal(String(org.error));
			return;
		}
		applyOrg(org);
	});
	source.onerror = () => setConnected(false);
	state.orgSource = source;

	setTimeout(() => {
		if (state.org === null && !state.freeze) {
			showFatal("连不上服务。检查终端里 npm start 是否还在运行。");
		}
	}, 8000);
}

function setConnected(on) {
	state.connected = on;
	const conn = $("conn");
	if (conn === null) return;
	conn.dataset.state = on ? "on" : "off";
	conn.hidden = on;
	conn.title = on ? "实时连接正常" : "连接断开，正在自动重连";
}

function showFatal(message) {
	$("graph").innerHTML = `<div class="graph-loading">${escapeHtml(message)}</div>`;
	$("stage-sub").textContent = "服务未连接";
}

// ── 交互绑定 ──────────────────────────────────────────────────────────────

$("chat-toggle").addEventListener("click", toggleChat);

$("scrim").addEventListener("click", () => {
	if (state.openId !== null) closeMobileSheet();
});

document.addEventListener("keydown", (event) => {
	if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "j") {
		event.preventDefault();
		toggleChat();
	}
});

// ⌘K / Ctrl+K 切换主视图（组织图 → 看板 → 频道）
document.addEventListener("keydown", (event) => {
	if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
		event.preventDefault();
		toggleView();
	}
});

MOBILE_QUERY.addEventListener("change", () => {
	if (MOBILE_QUERY.matches) {
		document.body.dataset.sheet = "closed";
	} else {
		document.body.dataset.sheet = "closed";
		chat.closeSheet?.();
	}
	syncChatButton();
	orgView.refreshLayout();
});

// 对话面板自己的收起/展开（按钮点击、拖宽）也会改变按钮状态
if (typeof MutationObserver === "function") {
	const observer = new MutationObserver(syncChatButton);
	observer.observe(document.body, { attributes: true, attributeFilter: ["data-chat", "data-sheet"] });
}

window.addEventListener("resize", () => orgView.refreshLayout());
window.addEventListener("hashchange", () => {
	const id = conversationFromHash();
	if (id !== null && id !== state.openId) selectConversation(id);
});

// ── 开发钩子（仅 ?dev）：注入假数据做视觉验收 ─────────────────────────────

if (new URLSearchParams(location.search).has("dev")) {
	window.__company = {
		state,
		findActor,
		get freeze() {
			return state.freeze;
		},
		set freeze(value) {
			state.freeze = Boolean(value);
		},
		setOrg(next) {
			state.freeze = true;
			applyOrg(next);
		},
		setFeed(feed) {
			chat.setFeed(feed);
		},
		select(conversationId, options) {
			selectConversation(conversationId, options);
		},
		org: orgView,
		chat,
		settings: settingsPanel,
		switchView(name) {
			applyView(name);
		},
	};
	import("./dev-fixtures.js").then((fixtures) => {
		window.__company.useMock = () => fixtures.useMock();
		window.__company.mockOrg = () => fixtures.mockOrg();
		window.__company.mockFeed = (conversationId) => fixtures.mockFeed(conversationId);
	});
}

// ── 启动 ──────────────────────────────────────────────────────────────────

$("scrim").hidden = false;
chat.clear();
setupSettings();
setupViewSwitch();
syncChatButton();
connectOrg();

// ── 自挂载模块（导入即初始化） ─────────────────────────────────────────────
// 看板：自己拉 /api/board、订阅 aic:org、按 body[data-view] 显隐。
// 星海：挂到 #stage-bg，手机 / 减少动效 / 无 WebGL 时自动降级。
import "./board.js";
import "./starfield.js";
