/**
 * 一人公司 · 网页界面入口。
 *
 * 只做四件事：订阅数据、切换会话、发消息、把状态分发给三个视图模块。
 * 视图不直接读 SSE，也不互相调用；所有跨模块动作都从这里走。
 */
import { escapeHtml, formatCost, formatTokens, relTime, statusOf } from "./format.js";
import { initAsk } from "./ask.js";
import { initOrg } from "./org.js";
import { initChat } from "./chat.js";

const $ = (id) => document.getElementById(id);
const MOBILE_QUERY = window.matchMedia("(max-width: 860px)");

const state = {
	org: null,
	/** 当前打开的会话标识。 */
	openId: null,
	orgSource: null,
	feedSource: null,
	/** 开发钩子：冻结 SSE，用于注入假数据做视觉验收。 */
	freeze: false,
	connected: true,
	/** 已经自动选过一次 CEO，避免每次组织更新都抢焦点。 */
	autoSelected: false,
};

const ask = initAsk({ onAnswer: submitAnswer });
const orgView = initOrg({ onSelect: (id) => selectConversation(id) });
const chat = initChat({ onSend: sendMessage, onInterrupt: interrupt });

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
	if (actor !== null) chat.setActor(actor);
	else if (state.openId !== null && actor === null) {
		// 会话所属的项目/员工没了（删项目）：清空对话，停在空状态
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
	$("company-name").textContent = org.company?.name || "一人公司";
	$("company-model").textContent = org.company?.model ?? "";
	$("company-model").title = org.company?.model ?? "";
	$("total-tokens").textContent = formatTokens(org.costs?.totalTokens ?? 0);
	$("total-tokens").title = `${org.costs?.totalTokens ?? 0} tokens`;

	const forYou = (org.pending ?? []).filter((item) => item.forYou);
	$("ask-count").textContent = String(forYou.length);
	$("topstat-ask").dataset.zero = forYou.length === 0 ? "1" : "0";
	const railAsk = $("rail-ask");
	railAsk.textContent = String(forYou.length);
	railAsk.hidden = forYou.length === 0;

	const actors = allActors(org);
	const busy = actors.filter((actor) => actor.status === "busy").length;
	const waiting = actors.filter((actor) => statusOf(actor) === "waiting").length;
	const idle = actors.length - busy - waiting;
	const activeProjects = (org.projects ?? []).filter((project) => project.status !== "terminated");
	const staffCount = (org.projects ?? []).reduce(
		(total, project) => total + (project.staff ?? []).filter((person) => !person.archived).length,
		0,
	);

	$("stage-sub").innerHTML = `${activeProjects.length} 个项目 · ${staffCount} 名员工 · ${
		forYou.length === 0
			? "没有待你拍板的事"
			: `<b>${forYou.length}</b> 件等你拍板`
	}`;

	$("legend").innerHTML = [
		["busy", "在跑", busy],
		["waiting", "待你", waiting],
		["idle", "空闲", idle],
	]
		.map(
			([status, label, count]) => `
			<span class="legend-item">
				<i class="legend-dot" data-status="${status}"></i>${label}
				<b>${count}</b>
			</span>`,
		)
		.join("");

	$("rail-running").textContent = String(busy);
	$("rail-running").dataset.busy = busy > 0 ? "1" : "0";
	$("rail-running").title = `${busy} 人正在工作`;

	const cost = formatCost(org.costs?.totalCostUsd ?? 0);
	$("stage-foot-cost").textContent = `全公司 ${formatTokens(org.costs?.totalTokens ?? 0)} tokens · ${cost}`;

	document.title =
		forYou.length > 0 ? `(${forYou.length}) 一人公司 · 指挥台` : "一人公司 · 指挥台";
	updateRail();
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
		// 再点同一个人：不重载，只把对话拉到眼前
		chat.setActor(actor);
		if (mobile && openSheet) openMobileSheet();
		else chat.expand?.();
		return;
	}

	state.openId = id;
	orgView.setSelected(id);
	chat.setActor(actor);
	chat.setLoading();
	openFeed(id);

	if (mobile && openSheet) openMobileSheet();
	if (options.focus !== false && !mobile) $("input")?.focus();

	try {
		history.replaceState(null, "", `#/c/${id}`);
	} catch {
		/* file:// 下 replaceState 可能被拒，不影响使用 */
	}
	updateRail();
}

function openFeed(conversationId) {
	closeFeed();
	const source = new EventSource(`/api/stream/feed/${conversationId}`);
	source.addEventListener("open", () => {
		setConnected(true);
	});
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
		// 不断开 EventSource：浏览器会自动重连。界面只提示一下，别让对话消失。
		chat.notify?.("连接有点慢，正在重连…", "warn");
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

// ── 手机抽屉 ──────────────────────────────────────────────────────────────

function openMobileSheet() {
	document.body.dataset.sheet = "open";
	chat.openSheet?.();
	updateRail();
}

function closeMobileSheet() {
	document.body.dataset.sheet = "closed";
	chat.closeSheet?.();
	updateRail();
}

function updateRail() {
	const mobile = MOBILE_QUERY.matches;
	const chatOpen = mobile && document.body.dataset.sheet === "open";
	for (const button of document.querySelectorAll(".rail-btn")) {
		const action = button.dataset.rail;
		const active = chatOpen ? action === "chat" : action === "top";
		button.classList.toggle("is-active", active);
	}
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

async function interrupt(conversationId, text) {
	try {
		const response = await fetch("/api/interrupt", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ conversationId, text }),
		});
		if (!response.ok) throw new Error(`HTTP ${response.status}`);
		return true;
	} catch {
		chat.notify?.("没打断成功，再试一次。", "error");
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

	// 兜底：连接一直没成功时给出人话，不留白屏
	setTimeout(() => {
		if (state.org === null && !state.freeze) {
			showFatal("连不上服务。检查终端里 npm start 是否还在运行。");
		}
	}, 8000);
}

function setConnected(on) {
	state.connected = on;
	$("conn").dataset.state = on ? "on" : "off";
	$("conn").title = on ? "实时连接正常" : "连接断开，正在自动重连";
	$("conn").querySelector(".conn-text").textContent = on ? "实时" : "重连中";
	$("rail-live").dataset.state = on ? "on" : "off";
}

function showFatal(message) {
	$("graph").innerHTML = `<div class="graph-loading">${escapeHtml(message)}</div>`;
	$("stage-sub").textContent = "服务未连接";
	$("legend").innerHTML = "";
}

// ── 交互绑定 ──────────────────────────────────────────────────────────────

document.querySelector(".rail").addEventListener("click", (event) => {
	const button = event.target.closest("[data-rail]");
	if (button === null) return;
	const action = button.dataset.rail;
	if (action === "top") {
		$("stage").scrollTo({ top: 0, behavior: "smooth" });
	} else if (action === "ask") {
		const card = document.querySelector(".ask");
		if (card !== null) card.scrollIntoView({ behavior: "smooth", block: "center" });
		else $("stage").scrollTo({ top: 0, behavior: "smooth" });
	} else if (action === "chat") {
		if (MOBILE_QUERY.matches) {
			if (document.body.dataset.sheet === "open") closeMobileSheet();
			else if (state.openId !== null) openMobileSheet();
			else if (state.org?.ceo !== undefined) {
				selectConversation(state.org.ceo.conversationId, { openSheet: true });
			}
		} else {
			chat.toggle();
		}
	}
});

$("scrim").addEventListener("click", () => {
	if (state.openId !== null) closeMobileSheet();
});

document.addEventListener("keydown", (event) => {
	if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "j") {
		event.preventDefault();
		if (MOBILE_QUERY.matches) {
			if (document.body.dataset.sheet === "open") closeMobileSheet();
			else if (state.openId !== null) openMobileSheet();
		} else {
			chat.toggle();
		}
	}
});

MOBILE_QUERY.addEventListener("change", () => {
	if (MOBILE_QUERY.matches) {
		if (document.body.dataset.chat === "closed") chat.expand?.();
	} else {
		document.body.dataset.sheet = "closed";
		chat.closeSheet?.();
	}
	updateRail();
	orgView.refreshLayout();
});

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
}

// ── 启动 ──────────────────────────────────────────────────────────────────

$("scrim").hidden = false;
chat.clear();
connectOrg();
void relTime;
