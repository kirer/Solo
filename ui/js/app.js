/**
 * 一人公司 · 网页界面入口（单页面）。
 *
 * 一屏之内：顶栏（设置 / 待办 / 对话开关）+ 组织图 + 常驻对话。
 * 只做四件事：订阅数据、切换会话、发消息、把状态分发给视图模块。
 */
import { escapeHtml, formatCost, formatTokens } from "./format.js";
import { initAsk } from "./ask.js";
import { initOrg } from "./org.js";
import { initChat } from "./chat.js";

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
	autoSelected: false,
	chromeSignature: "",
	actorSignature: "",
	lastFeedNoticeAt: 0,
};

const ask = initAsk({ onAnswer: submitAnswer });
const orgView = initOrg({ onSelect: (id) => selectConversation(id) });
const chat = initChat({ onSend: sendMessage, fetchProfile });

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
	renderChrome(next);
	ask.render((next.pending ?? []).filter((item) => item.forYou));
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
	$("company-model").textContent = org.company?.model ?? "—";
	$("company-model").title = org.company?.model ?? "";

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

function setupSettings() {
	const panel = $("settings");
	const toggle = $("settings-toggle");
	const close = $("settings-close");
	if (panel === null || toggle === null) return;
	applyTheme(themeMode, { persist: false });

	const closePanel = ({ focus = true } = {}) => {
		panel.hidden = true;
		toggle.setAttribute("aria-expanded", "false");
		if (focus) toggle.focus({ preventScroll: true });
	};
	const openPanel = () => {
		panel.hidden = false;
		toggle.setAttribute("aria-expanded", "true");
		panel.querySelector('[aria-checked="true"]')?.focus({ preventScroll: true });
	};

	toggle.addEventListener("click", (event) => {
		event.stopPropagation();
		if (panel.hidden) openPanel();
		else closePanel();
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
	document.addEventListener("click", (event) => {
		if (panel.hidden) return;
		if (panel.contains(event.target) || toggle.contains(event.target)) return;
		closePanel({ focus: false });
	});
	document.addEventListener("keydown", (event) => {
		if (event.key === "Escape" && !panel.hidden) {
			event.preventDefault();
			closePanel();
		}
	});
	systemLight.addEventListener("change", () => {
		if (themeMode === "system") applyTheme("system", { persist: false });
	});
}

// ── 动作 ──────────────────────────────────────────────────────────────────

async function sendMessage(text) {
	const conversationId = state.openId;
	if (conversationId === null) return false;
	chat.addLocalQueued(text);
	try {
		const response = await fetch("/api/message", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ conversationId, text }),
		});
		if (!response.ok) throw new Error(`HTTP ${response.status}`);
		return true;
	} catch {
		chat.notify?.("消息没发出去，检查服务是否还在运行。", "error");
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
syncChatButton();
connectOrg();
