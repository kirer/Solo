/**
 * 一人公司 · 网页界面入口（单页面）。
 *
 * 一屏之内：顶栏（视图切换 / 设置）+ 组织图 / 频道 / 看板 + 设置抽屉。
 *
 * **右侧常驻对话面板已经去掉**（老板：「去掉右侧聊天面板」）。现在每个 agent
 * 的对话就在频道视图的私聊里——那是唯一的聊天入口，不再有第二套聊天 UI。
 * 于是这里只剩三件事：订阅组织快照、切视图、把状态分发给视图模块。
 */
import { escapeHtml, formatCost, formatTokens } from "./format.js";
import { initOrg } from "./org.js";
import { initSettings } from "./settings.js";
import { initChannels } from "./channels.js";
import { notify } from "./toast.js";

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

// 组织图点职员只做选中高亮（UX-1）：聊天入口统一在频道私聊里。
const orgView = initOrg({ onSelect: () => {} });
const settingsPanel = initSettings({ onToast: (text, tone) => notify(text, tone) });
// 频道视图（通信重构）：左侧频道列表 + 消息流 + 成员/任务。
// 它是**唯一的聊天入口**——右侧对话面板已删除。
const channels = initChannels({ onToast: (text, tone) => notify(text, tone), fetchProfile });

/**
 * 「打开某个频道」的单一入口。
 *
 * 来源可能是看板卡片、组织图节点、以后的通知或搜索——它们都不该自己切视图、
 * 找 DOM、再调 channels.open()。这里只做这两步，频道视图自己负责加载与渲染。
 *
 * 频道视图初始化失败时 channels.open 是空函数，不会抛错。
 */
function openChannelById(channelId) {
	applyView("channels");
	void channels.open(channelId);
}
window.addEventListener("aic:open-channel", (event) => {
	const channelId = event.detail?.channelId;
	if (typeof channelId !== "string" || channelId === "") return;
	openChannelById(channelId);
});

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
 * 设置抽屉的开关。
 *
 * 历史：这里原本是「对话 ↔ 设置」互斥视图切换。右侧对话面板删掉之后
 * （老板：「去掉右侧聊天面板」），只剩设置一个视图，逻辑随之塌成「开 / 关」。
 *
 * 唯一真相是 `body[data-settings="open|closed"]`：`settings.css` 据此控制槽位宽度
 * 与位移。不用 `display:none`，否则动画与「关掉时不该进 tab 序列」两件事会打架——
 * 后者交给 `inert`。
 */
function isSettingsOpen() {
	return document.body.dataset.settings === "open";
}

/**
 * 打开 / 关闭设置。
 *
 * @param {boolean} open 目标状态。
 * @param {{focus?: boolean}} [options] `focus:false` 用于初始化时不抢焦点。
 */
function setSettingsOpen(open, { focus = true } = {}) {
	const panel = $("settings");
	const toggle = $("settings-toggle");
	if (panel === null || toggle === null) {
		// 静默 return 会让「点设置没反应」变成不可诊断的哑失败（UX-2 就是这么藏了很久）。
		console.warn("[settings] #settings / #settings-toggle 缺失，设置不可用");
		return;
	}
	document.body.dataset.settings = open ? "open" : "closed";
	toggle.setAttribute("aria-expanded", open ? "true" : "false");
	toggle.setAttribute("aria-pressed", open ? "true" : "false");
	// 关掉时移出无障碍树与 tab 序列；开着时正常可交互。
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
}

function setupSettings() {
	const panel = $("settings");
	const toggle = $("settings-toggle");
	const close = $("settings-close");
	if (panel === null || toggle === null) return;
	applyTheme(themeMode, { persist: false });

	const closePanel = (options) => setSettingsOpen(false, options);
	const openPanel = (options) => setSettingsOpen(true, options);

	toggle.addEventListener("click", () => {
		if (isSettingsOpen()) closePanel();
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
		if (!isSettingsOpen()) return;
		// 设置里的确认条、@ 提及弹层、抽屉等各自处理 Esc；这里只在没人消费时退出。
		if (event.defaultPrevented) return;
		event.preventDefault();
		closePanel();
	});
	systemLight.addEventListener("change", () => {
		if (themeMode === "system") applyTheme("system", { persist: false });
	});

	// 初始态显式落一次（index.html 不带该属性时也能工作），且不抢焦点。
	setSettingsOpen(false, { focus: false });
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
	// #5：视图切换的入场动画。由这里挂 data-enter，motion.css 只负责关键帧。
	//
	// 为什么不用纯 CSS 的 @starting-style / display 离散过渡：实测不生效
	// （`body[data-view="org"] .org { opacity: 1 }` 会压过起始样式，首帧就是终态）。
	// 用动画则与 display 无关，切到哪个视图就播哪个。
	//
	// 动画结束由 animationend 摘掉属性：留着会让元素一直带着 animation 声明，
	// 后续的 transform/opacity 改动会被动画的 `both` 填充值盖住。
	const entering = view === "board" ? $("board") : view === "channels" ? channelsRoot : $("org");
	if (entering !== null && entering !== undefined) {
		entering.dataset.enter = "true";
		const clear = () => {
			delete entering.dataset.enter;
		};
		// `animationend` 会**冒泡**：视图里任何一个子元素（组织图卡片、消息气泡、
		// 看板卡）的入场动画一结束就会冒上来把 data-enter 提前摘掉，主视图的
		// 动画就只播了个开头。必须确认事件源就是视图本身（老板 #3「没有动画」）。
		entering.addEventListener(
			"animationend",
			(event) => {
				if (event.target === entering) clear();
			},
			{ once: true },
		);
		// 兜底：prefers-reduced-motion 下动画被关掉，animationend 不会来。
		window.setTimeout(clear, 320);
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

// ⌘K / Ctrl+K 切换主视图（组织图 → 频道 → 看板）
document.addEventListener("keydown", (event) => {
	if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
		event.preventDefault();
		toggleView();
	}
});

MOBILE_QUERY.addEventListener("change", () => orgView.refreshLayout());
window.addEventListener("resize", () => orgView.refreshLayout());

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
		org: orgView,
		channels,
		settings: settingsPanel,
		switchView(name) {
			applyView(name);
		},
	};
	import("./dev-fixtures.js").then((fixtures) => {
		window.__company.useMock = () => fixtures.useMock();
		window.__company.mockOrg = () => fixtures.mockOrg();
	});
}

// ── 启动 ──────────────────────────────────────────────────────────────────

setupSettings();
setupViewSwitch();
connectOrg();

// ── 自挂载模块（导入即初始化） ─────────────────────────────────────────────
// 看板：自己拉 /api/board、订阅 aic:org、按 body[data-view] 显隐。
import "./board.js";
// 星海：挂到 #stage-bg，手机 / 减少动效 / 无 WebGL 时自动降级。
//
// **必须延迟加载**：它 import 的是 `ui/vendor/three.module.js`（691 KB / br 158 KB）。
// 以前用静态 `import "./starfield.js"`，等于每个人都得在首屏付这 158 KB 的
// 下载与解析成本，只为了背景里 212 个点。现在推到首屏之后（空闲时），
// 背景本来就要淡入，晚 1 秒完全看不出来。
// 降级判断仍在 starfield.js 内部（手机 / reduced-motion / 无 WebGL 时它自己会退出），
// 这里只负责不让它拖慢首屏。
const loadStarfield = () => {
	import("./starfield.js").catch(() => {
		/* 星海是装饰，加载失败不影响任何功能，静默降级为静态渐变 */
	});
};
if (typeof window.requestIdleCallback === "function") {
	window.requestIdleCallback(loadStarfield, { timeout: 2500 });
} else {
	window.setTimeout(loadStarfield, 1200);
}
