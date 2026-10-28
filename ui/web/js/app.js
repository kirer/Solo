/**
 * 世代 2 频道页。一个文件，没有框架，没有状态库。
 *
 * 与旧前端（`ui/js/channels.js` 1952 行）的差别只有一条原则：
 * **界面只显示后端真的有的东西。** 旧页面为了填满布局，画了「谁读了」「待办卡」
 * 「任务区」「展开成员」「查看提示词」这些新核心根本没有的块，于是要么恒空、
 * 要么显示错数。这里没有的就不画。
 *
 * 结构：`state` 是唯一真相 → 任何改动都走 `render*()` 重画对应区域。
 * 三个区域各自整体替换（列表 / 消息流 / 顶栏），不做增量 patch —— 一个频道
 * 几百条消息时 `replaceChildren` 比 diff 更快，也更难写错。
 */
import { getJSON, postJSON, streamOrg } from "./api.js";
import {
	copyText,
	dayLabel,
	escapeAttr,
	escapeHtml,
	clockTime,
	hueFor,
	initials,
	relTime,
	sameDay,
} from "./format.js";
import { renderMarkdown } from "./markdown.js";

/** 一页多少条。后端上限 200，这里取 40：一屏多一点，翻页不明显。 */
const PAGE = 40;
/** 列表里的相对时间每隔这么久重算一次（「3 分钟前」→「4 分钟前」）。 */
const TICK_MS = 30_000;

const state = {
	/** @type {{id:string,kind:string,title:string,project?:string,unread:number,mentions:number,preview:string,lastAt:number,lastSeq:number,memberCount:number}[]} */
	channels: [],
	mentionTotal: 0,
	/** 当前打开的频道 id。 */
	current: "",
	/** @type {{channel:object,members:object[],messages:object[],hasMore:boolean,serverNow:number}|null} */
	detail: null,
	/** 引用中的消息（`{seq,fromLabel,excerpt}`）。 */
	reply: null,
	/** 浮在消息上的操作条对应的 seq；`0` 表示没有。 */
	actionsFor: 0,
	/** @ 候选：`{items,index,start,end}`，`start` 是 `@` 在输入框里的位置。 */
	mention: null,
	/** 已读上报节流用。 */
	readSeqs: new Map(),
	/** 组织快照（`/api/org` 整帧）。`null` = 还没拿到。 */
	org: null,
	/** 编制表（团队视图）是否打开。 */
	teamOpen: false,
	/** 各频道消息流滚动位置记忆（T-012）。值=scrollTop 数值；-1 表示上次在底部。 */
	scrollPos: new Map(),
	/** T-016：当前频道的 SSE 连接（按频道推消息增量）；切频道/离开时关闭。 */
	stream: null,
};

const el = {
	meta: document.querySelector("#company-meta"),
	refresh: document.querySelector("#refresh"),
	/** 顶栏那个「N 件需要你」。元素 id 还叫 unread-total（index.html 不改），语义已收窄到点名。 */
	unreadTotal: document.querySelector("#unread-total"),
	rows: document.querySelector("#rows"),
	paneTitle: document.querySelector("#pane-title"),
	paneSub: document.querySelector("#pane-sub"),
	back: document.querySelector("#back"),
	flow: document.querySelector("#flow"),
	flowInner: document.querySelector("#flow-inner"),
	composer: document.querySelector("#composer"),
	input: document.querySelector("#input"),
	send: document.querySelector("#send"),
	replyBar: document.querySelector("#reply-bar"),
	replyText: document.querySelector("#reply-text"),
	replyCancel: document.querySelector("#reply-cancel"),
	mentionPop: document.querySelector("#mention-pop"),
	toastRoot: document.querySelector("#toast-root"),
	teamBtn: document.querySelector("#team-btn"),
	team: document.querySelector("#team"),
	teamPanel: document.querySelector("#team-panel"),
	teamList: document.querySelector("#team-list"),
	teamCount: document.querySelector("#team-count"),
	teamClose: document.querySelector("#team-close"),
};

// ── 提示 ────────────────────────────────────────────────────────────────

let toastTimer;

function toast(text, tone = "info") {
	if (el.toastRoot === null) return;
	el.toastRoot.replaceChildren();
	const node = document.createElement("div");
	node.className = "toast";
	node.dataset.tone = tone;
	node.textContent = text;
	el.toastRoot.append(node);
	clearTimeout(toastTimer);
	toastTimer = setTimeout(() => node.remove(), 3_600);
}

// ── 频道列表 ────────────────────────────────────────────────────────────

/** 左侧的三个分组。分组靠频道 id 前缀决定。 */
const GROUPS = [
	{ key: "company", label: "公司", match: (channel) => channel.kind === "company" || channel.kind === "leadership" },
	{ key: "project", label: "项目", match: (channel) => channel.kind === "project" },
	// 个人分组仍然排最后、dm 仍然归在这里，但不画「个人」这行字：
	// 人名本身就说明这是个人频道（T-20261028-007 老板追加要求）。顺序不变。
	{ key: "personal", label: "个人", hideTitle: true, match: (channel) => channel.kind === "dm" },
];

// ── 组织信息（谁是哪个项目的、什么职位） ─────────────────────────────────

/** 项目 slug → 显示名。没登记的 slug 直接显示，不编名字。 */
const PROJECT_LABELS = { platform: "平台", dino: "小恐龙" };

/**
 * 项目色：颜色本身写在 CSS 的 `:root` 里，这里只给变量名 —— 和页面其他地方
 * 「颜色只从变量取」是同一条规矩。没登记的项目按 slug 算一个稳定色相，
 * 以后新开项目不改代码也不会掉成灰色。
 */
const PROJECT_TONES = { platform: "var(--tone-platform)", dino: "var(--tone-dino)" };

function projectName(project) {
	return PROJECT_LABELS[project] ?? project;
}

function projectTone(project) {
	// 没有项目 = 人像那种石墨灰（`--tone-person`），不再另设一个色；
	// 没登记的新项目按 slug 算一个稳定色相，不用改代码。
	if (project === undefined || project === "") return "var(--tone-person)";
	return PROJECT_TONES[project] ?? `hsl(${hueFor(project)} 30% 58%)`;
}

function personBySlug(slug) {
	return state.org?.people.find((person) => person.slug === slug);
}

/** 个人频道的频道名就是人名（`dm:<x>` 的 title），所以这里按显示名找。 */
function personByName(label) {
	return state.org?.people.find((person) => person.label === label);
}

/** 「职位 · 项目」一句，个人频道第二行、消息头、顶栏副标题共用。 */
function roleLine(person) {
	if (person === undefined) return "";
	return [person.title, person.project === undefined ? "" : projectName(person.project)].filter(Boolean).join(" · ");
}

/**
 * 头像：**形状承担语义，颜色只是加强**（T-20261028-008）。
 *
 * - 圆 = 人：个人频道行、消息、团队视图。不再按名字哈希色相 —— 人不是标签，
 *   一个名字一个颜色只会让「谁是房间」更难看出来；统一退成石墨灰。
 * - 圆角方 = 房间：公司 / 项目频道。项目房用项目色（与左侧色条同源），
 *   公司房用一个中性专色 `--tone-company`（不跟任何项目色撞）。
 *
 * 灰度下形状仍然成立：圆的半径是 50%，房间是 6px 圆角，22px 上一眼就能分开。
 */
function avatarHtml(label, options = {}) {
	const { size, shape = "person", tone } = options;
	const attrs = [
		shape === "room" ? ' data-shape="room"' : "",
		size === "lg" ? ' data-size="lg"' : "",
		tone === undefined ? "" : ` style="--tone-room:${tone}"`,
	].join("");
	return `<span class="avatar"${attrs} aria-hidden="true">${escapeHtml(initials(label))}</span>`;
}

/** 房间头像的底色：项目房取项目色，其余（公司 / 管理层）取中性专色。 */
function roomTone(channel) {
	return channel.kind === "project" ? projectTone(channel.project) : "var(--tone-company)";
}

/**
 * 列表第二行：先说是谁（职位 / 项目 / 负责人），再说最后一句。
 *
 * 旧版只有「负责人 X」这一种写法，于是个人频道（`dm:人名`）那一行只剩名字和
 * 一个「个人」小标 —— 老板看不出这个人属于哪个项目、什么职位，这正是
 * T-20261028-005 要解决的问题。项目频道与消息本身保持原样。
 */
function previewHtml(channel) {
	const tail = escapeHtml(channel.preview === "" ? "" : channel.preview);
	if (channel.kind === "dm") {
		const person = personByName(channel.title);
		if (person !== undefined) {
			const role = roleLine(person) || "公司";
			return `<span class="row-role" style="--crew:${projectTone(person.project)}">${escapeHtml(role)}</span>${
				tail === "" ? "" : " · " + tail
			}`;
		}
	}
	if (channel.ownerLabel !== undefined) {
		return `<span class="row-owner">负责人 ${escapeHtml(channel.ownerLabel)}</span>${tail === "" ? "" : " · " + tail}`;
	}
	return tail === "" ? "还没有消息" : tail;
}

/**
 * 侧栏徽标只有两种（T-20261028-009，老板定口径 A）：
 * - 有人 @ 你 → **红色数字**，数字就是 `mentions`（宁多勿漏由后端字段保证）；
 * - 只是有新内容 → **灰色小点**，不带数字。
 *
 * 「有新内容」不等于「需要你」：员工在个人频道里的过程汇报不应该持续叫老板。
 * 两种互斥，靠 `data-kind` 区分，别用一个 badge 改样式来表达语义。
 */
function badgeHtml(channel) {
	if (channel.mentions > 0) {
		return `<span class="badge" data-kind="mention" role="img" aria-label="${channel.mentions} 件需要你">${channel.mentions}</span>`;
	}
	if (channel.unread > 0) {
		return `<span class="badge" data-kind="quiet" role="img" aria-label="${channel.unread} 条未读"></span>`;
	}
	return "";
}

function rowHtml(channel) {
	const badge = badgeHtml(channel);
	return `<button class="row" type="button" data-channel="${escapeAttr(channel.id)}"${
		channel.id === state.current ? ' aria-current="true"' : ""
	}>
		${avatarHtml(channel.title, {
			// 侧栏会话行按 Figma 用 48；消息与团队视图的默认尺寸是 40。
			size: "lg",
			...(channel.kind === "dm" ? {} : { shape: "room", tone: roomTone(channel) }),
		})}
		<span class="row-main">
			<span class="row-title"><span>${escapeHtml(channel.title)}</span></span>
			<span class="row-preview">${previewHtml(channel)}</span>
		</span>
		<span class="row-meta">
			<span>${escapeHtml(relTime(channel.lastAt))}</span>
			${badge}
		</span>
	</button>`;
}

function renderList() {
	const parts = [];
	for (const group of GROUPS) {
		const rows = state.channels.filter(group.match);
		if (rows.length === 0) continue;
		if (group.hideTitle !== true) parts.push(`<div class="group-title">${group.label}</div>`);
		parts.push(rows.map(rowHtml).join(""));
	}
	el.rows.innerHTML = parts.join("") || `<div class="empty">还没有频道</div>`;
	// 顶栏只数「点名叫你」的未读（= 后端 `unread.mentions`）。灰点不进这个数，
	// 否则老板又会看到「一直在响」（T-20261028-009）。0 的时候整块留空。
	el.unreadTotal.textContent = state.mentionTotal > 0 ? `${state.mentionTotal} 件需要你` : "";
}

// ── 消息流 ──────────────────────────────────────────────────────────────

function quoteHtml(message) {
	if (message.replyTo === undefined) return "";
	return `<div class="msg-quote" role="button" tabindex="0" data-jump="${message.replyTo.seq}">
		<b>${escapeHtml(message.replyTo.fromLabel)}</b>：${escapeHtml(message.replyTo.excerpt || "（一条消息）")}
	</div>`;
}

function kindHtml(message) {
	if (message.kind === "chat" || message.kind === "note" || message.kind === "" || message.kind === "say") return "";
	const label = { decision: "拍板", report: "汇报", task: "任务", think: "思考", tool: "调用" }[message.kind] ?? message.kind;
	return `<span class="msg-kind" data-kind="${escapeAttr(message.kind)}">${escapeHtml(label)}</span>`;
}

/**
 * `work` 消息正文里的操作类型标签。
 *
 * 正文格式是 `logWork` 约定的：`$ <命令>` 开头是执行命令；`已写入 <路径>` / `已读取 <路径>`
 * 是写/读文件（写文件工具自己写回的文本）。从这里读「做了什么操作」，而不是在正文里
 * 再塞一行标签 —— 正文保持纯记录，界面只做投影。
 */
function workOp(text) {
	const head = (text ?? "").split("\n")[0] ?? "";
	if (head.startsWith("$ ")) return "执行命令";
	if (head.startsWith("已写入")) return "写文件";
	if (head.startsWith("已读取") || head.startsWith("文件不存在")) return "读文件";
	if (head.startsWith("(后台运行")) return "后台运行";
	return "工作记录";
}

/** 每种操作类型对应的图标与「已做什么」措辞（仿 ChatGPT 的过程行）。 */
function opMeta(op) {
	const map = {
		"执行命令": { icon: "▸", label: "已运行" },
		"写文件": { icon: "✎", label: "已写入文件" },
		"读文件": { icon: "▣", label: "已读取文件" },
		"后台运行": { icon: "▷", label: "已后台运行" },
	};
	return map[op] ?? { icon: "▸", label: "已工作" };
}

/** `work`/`tool` 行的短摘要：命令取到路径为止，文件取文件名，一行放得下。 */
function opSummary(text, op) {
	const head = (text ?? "").split("\n")[0] ?? "";
	if (op === "执行命令") {
		const raw = head.replace(/^\$ /, "");
		// `cd /x && echo ... && cat y` → 只留最后一段有信息量的。
		const parts = raw.split("&&").map((s) => s.trim()).filter(Boolean);
		return parts[parts.length - 1] ?? raw;
	}
	if (op === "写文件") return head.replace(/^已写入\s*/, "");
	if (op === "读文件") return head.replace(/^(已读取|文件不存在：?)\s*/, "");
	return head;
}

function messageHtml(message, previous, beforeUnreadFrom) {
	// 同一个人连续发言：只第一行显示头像和名字，后面缩进对齐（时间是唯一的隔断）。
	const grouped = previous !== undefined && previous.fromSlug === message.fromSlug && !beforeUnreadFrom;
	const quotes = quoteHtml(message);
	const kind = kindHtml(message);
	// 头像上已经写着名字了，这里补一句「他是谁」——只在轮到显示名字的那一行出现。
	const role = grouped ? "" : roleLine(personBySlug(message.fromSlug));

	// work = 执行命令的记录：折叠成等宽字体块，默认收起。
	// note = 系统留痕：灰色淡显。
	if (message.kind === "work") {
		const op = workOp(message.text);
		const meta = opMeta(op);
		const summary = opSummary(message.text, op);
		return `<div class="msg msg-work" data-seq="${message.seq}">
			<div class="msg-gutter">${grouped ? "" : avatarHtml(message.fromLabel)}</div>
			<div class="msg-main">
				<details><summary><span class="op-icon">${meta.icon}</span><span class="op-verb">${escapeHtml(meta.label)}</span><code>${escapeHtml(summary)}</code><span class="op-chevron">⌄</span></summary>
				<div class="msg-text msg-text-mono">${escapeHtml(message.text)}</div></details>
			</div>
		</div>`;
	}

	// think = 思考过程：仿 ChatGPT，默认收起（点开才展开），不喧宾夺主。
	if (message.kind === "think") {
		return `<div class="msg msg-think" data-seq="${message.seq}">
			<div class="msg-gutter">${grouped ? "" : avatarHtml(message.fromLabel)}</div>
			<div class="msg-main">
				<details><summary><span class="think-label">思考</span><span class="op-chevron">⌄</span></summary>
				<div class="msg-text msg-text-think">${renderMarkdown(message.text)}</div></details>
			</div>
		</div>`;
	}

	// tool = 工具调用：一行紧凑卡，「已调用 + 名字 + 参数摘要」，可折叠。
	if (message.kind === "tool") {
		// 完整首行交给 CSS 省略号：一眼能多看到参数，悬停 summary 有 title 全量。
		const firstLine = message.text.split("\n")[0] ?? "";
		return `<div class="msg msg-tool" data-seq="${message.seq}">
			<div class="msg-gutter">${grouped ? "" : avatarHtml(message.fromLabel)}</div>
			<div class="msg-main">
				<details title="${escapeAttr(message.text)}"><summary><span class="op-icon">⚙</span><span class="op-verb">已调用</span><code>${escapeHtml(firstLine)}</code><span class="op-chevron">⌄</span></summary>
				<div class="msg-text msg-text-mono">${escapeHtml(message.text)}</div></details>
			</div>
		</div>`;
	}

	if (message.kind === "note") {
		return `<div class="msg msg-note" data-seq="${message.seq}">
			<div class="msg-gutter"></div>
			<div class="msg-main"><div class="msg-text msg-text-dim">${escapeHtml(message.text)}</div></div>
		</div>`;
	}

	const heading = grouped
		? ""
		: `<div class="msg-head"><span class="msg-from">${escapeHtml(message.fromLabel)}</span>${
				role === "" ? "" : `<span class="msg-role">${escapeHtml(role)}</span>`
			}<span class="msg-time">${clockTime(message.at)}</span>${kind}</div>`;
	// T-016：占位状态渲染。pending 且空文本 = loading 光标（CSS ::after）；error 且空 = 兜底灰字。
	const pending = message.status === "pending" && (message.text ?? "").trim() === "";
	const errPending = message.status === "error" && (message.text ?? "").trim() === "";
	const body = errPending
		? `<div class="msg-text" data-error>处理中，稍候刷新</div>`
		: pending
			? `<div class="msg-text" data-placeholder></div>`
			: `${quotes}<div class="msg-text">${renderMarkdown(message.text)}</div>`;
	const statusAttr = message.status === undefined ? "" : ` data-status="${message.status}"`;
	return `<div class="msg" data-seq="${message.seq}" data-owner="${message.fromSlug === "owner"}"${statusAttr}${
		grouped ? ' data-grouped="true"' : ""
	}>
		<div class="msg-gutter">${grouped ? "" : avatarHtml(message.fromLabel)}</div>
		<div class="msg-main">${heading}${body}</div>
	</div>`;
}

/**
 * Markdown 里没有 @ 高亮（`renderMarkdown` 是纯函数，不认人）。
 * 所以正文先走 markdown，再把渲染结果里**文本节点**中的 `@名字` 包成 `.mention`。
 * 用 DOMParser 而不是正则改 HTML 字符串：后者会命中 `<a href="@x">` 这类属性值。
 */
function decorateMentions(root, mentions) {
	if (mentions.length === 0) return;
	const known = new Set(mentions.map((item) => item.label));
	const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
	const targets = [];
	while (walker.nextNode()) {
		const node = walker.currentNode;
		if (node.nodeValue?.includes("@") !== true) continue;
		// 代码块里的 @ 不是提及。
		if (node.parentElement?.closest("pre, code, a") !== null) continue;
		targets.push(node);
	}
	for (const node of targets) {
		const text = node.nodeValue ?? "";
		const fragment = document.createDocumentFragment();
		let index = 0;
		for (const match of text.matchAll(/@([\p{L}\p{N}_-]+)/gu)) {
			if (!known.has(match[1])) continue;
			if (match.index > index) fragment.append(text.slice(index, match.index));
			const span = document.createElement("span");
			span.className = "mention";
			span.textContent = match[0];
			fragment.append(span);
			index = match.index + match[0].length;
		}
		if (index === 0) continue;
		if (index < text.length) fragment.append(text.slice(index));
		node.replaceWith(fragment);
	}
}

/** 给当前 DOM 里的每条消息做 @ 高亮。渲染完以后统一跑一遍。 */
function decorateAll() {
	const detail = state.detail;
	if (detail === null) return;
	const bySeq = new Map(detail.messages.map((message) => [message.seq, message]));
	for (const item of el.flowInner.querySelectorAll(".msg")) {
		const message = bySeq.get(Number(item.dataset.seq));
		const target = item.querySelector(".msg-text");
		if (message === undefined || target === null) continue;
		decorateMentions(target, message.mentions);
	}
}

function dividerHtml(label) {
	return `<div class="divider">${escapeHtml(label)}</div>`;
}

function renderFlow(options = {}) {
	const detail = state.detail;
	if (detail === null) {
		el.flowInner.innerHTML = `<div class="empty">左边选一个频道开始</div>`;
		return;
	}

	const fragment = document.createDocumentFragment();
	// T-015：不再渲染「加载更早」按钮，改为滚动到顶自动加载（见 loadEarlier + flow 的 scroll 监听）。

	// 已读位置：后端给的是「读到这条为止」，这里找第一条未读，画一条分界线。
	// 「新消息」只标别人发来的未读：老板自己刚发的消息当然也「未读」，但它不是新消息。
	const firstUnread = detail.messages.find((message) => !message.read && message.fromSlug !== "owner");

	if (detail.messages.length === 0) {
		fragment.append(node(`<div class="empty">这里还没有消息，说点什么</div>`));
	}

	let previous;
	let lastDay = 0;
	for (const message of detail.messages) {
		if (lastDay === 0 || !sameDay(lastDay, message.at)) {
			fragment.append(node(dividerHtml(sameDay(message.at, Date.now()) ? `今天 ${clockTime(message.at)}` : dayLabel(message.at))));
			previous = undefined;
		} else if (message.at - lastDay > 5 * 60_000) {
			fragment.append(node(dividerHtml(clockTime(message.at))));
		}
		lastDay = message.at;

		const isFirstUnread = message === firstUnread;
		if (isFirstUnread) fragment.append(node(`<div class="unread-line">新消息</div>`));
		fragment.append(node(messageHtml(message, previous, isFirstUnread)));
		previous = message;
	}

	el.flowInner.replaceChildren(fragment);
	// 换频道才播一次入场：同频道刷新（发完消息重取）不该整段重新淡入。
	if (options.fresh === true) {
		el.flowInner.dataset.fresh = "true";
		el.flowInner.addEventListener("animationend", () => delete el.flowInner.dataset.fresh, { once: true });
	}
	decorateAll();

	if (options.toBottom === true) el.flow.scrollTop = el.flow.scrollHeight;
}

/** HTML 字符串 → 节点。`template` 是唯一不引入解析器又能信任的方式（内容都经过转义）。 */
function node(html) {
	const template = document.createElement("template");
	template.innerHTML = html.trim();
	return template.content.firstElementChild ?? document.createTextNode("");
}

// T-015：上滑到顶自动加载更早消息（替代原「加载更早」按钮）。复用 openChannel 的 before 分支，带防重入。
let loadingEarlier = false;
async function loadEarlier() {
	if (loadingEarlier) return;
	const detail = state.detail;
	if (detail === null || detail.messages.length === 0 || !detail.hasMore) return;
	loadingEarlier = true;
	try {
		const before = detail.messages[0].seq;
		await openChannel(detail.channel.id, { before });
	} finally {
		loadingEarlier = false;
	}
}

// T-016：占位气泡 + 增量 upsert。SSE 推来的 `create`（含 connect 时全量补齐、以及 A 填充占位后的 done 全文）
// 按 seq 幂等落地：已存在则整节点重建（文本/状态覆盖），不存在则按 seq 顺序插入。
function upsertMessage(view) {
	const detail = state.detail;
	if (detail === null) return;
	const idx = detail.messages.findIndex((m) => m.seq === view.seq);
	if (idx >= 0) detail.messages[idx] = { ...detail.messages[idx], ...view };
	else {
		detail.messages.push(view);
		detail.messages.sort((a, b) => a.seq - b.seq);
	}
	const fresh = node(messageHtml(view, undefined, false));
	const existing = el.flowInner.querySelector(`.msg[data-seq="${view.seq}"]`);
	if (existing === null) {
		const after = [...el.flowInner.querySelectorAll(".msg")].find((m) => Number(m.dataset.seq) > view.seq);
		if (after === null) el.flowInner.append(fresh);
		else el.flowInner.insertBefore(fresh, after);
	} else {
		existing.replaceWith(fresh);
	}
	decorateMentions(fresh.querySelector(".msg-text"), view.mentions ?? []);
	// 靠近底部才自动贴底，避免用户在看历史时被拽下去（T-012 的浏览位置保护）。
	const nearBottom = el.flow.scrollTop >= el.flow.scrollHeight - el.flow.clientHeight - 80;
	if (nearBottom) el.flow.scrollTop = el.flow.scrollHeight;
}

// T-016：订阅某频道的按频道 SSE。切频道/重取时调用，内部先关闭旧连接。
function connectStream(id) {
	if (state.stream !== null) {
		state.stream.close();
		state.stream = null;
	}
	const es = new EventSource(`/api/channels/${encodeURIComponent(id)}/stream`);
	state.stream = es;
	// create 事件带完整消息视图（含 status/text），幂等 upsert —— 占位 pending 与填充后 done 都走它。
	es.addEventListener("create", (event) => {
		try {
			upsertMessage(JSON.parse((event).data));
		} catch {
			/* 忽略坏帧 */
		}
	});
	// v1 不依赖逐字（token/done 增量）：create 已含 done 全文，幂等覆盖即可。预留监听避免静默报错。
	es.addEventListener("token", () => {});
	es.addEventListener("done", (event) => {
		try {
			upsertMessage(JSON.parse((event).data));
		} catch {
			/* 忽略坏帧 */
		}
	});
	es.addEventListener("error", () => {});
}

// ── 顶栏 / 输入区 ───────────────────────────────────────────────────────

function renderHead() {
	const detail = state.detail;
	if (detail === null) {
		el.paneTitle.textContent = "选择一个频道";
		el.paneSub.textContent = "";
		el.composer.hidden = true;
		return;
	}
	el.paneTitle.textContent = detail.channel.title;
	const channel = detail.channel;
	// 副标题只说「这个房间意味着什么」，不重复标题里已有的人名。
	const bits = [];
	if (channel.ownerLabel !== undefined) bits.push(`负责人 ${channel.ownerLabel}`);
	if (channel.project !== undefined) bits.push(`项目 ${projectName(channel.project)}`);
	if (channel.kind === "dm") {
		// 个人频道标题就是人名，所以这里直接把这个人的职位与项目补上。
		const person = personByName(channel.title);
		if (person?.title !== undefined) bits.push(person.title);
		if (person?.project !== undefined) bits.push(`项目 ${projectName(person.project)}`);
		bits.push("个人频道");
	}
	if (bits.length === 0) bits.push(`${detail.members.filter((member) => member.slug !== "owner").length} 人`);
	el.paneSub.textContent = bits.join(" · ");
	el.composer.hidden = false;
}

function renderReply() {
	const reply = state.reply;
	el.replyBar.hidden = reply === null;
	if (reply === null) return;
	el.replyText.textContent = `回复 ${reply.fromLabel}：${reply.excerpt}`;
}

// ── 数据 ────────────────────────────────────────────────────────────────

async function loadChannels() {
	const data = await getJSON("/api/channels");
	state.channels = data.channels ?? [];
	state.mentionTotal = data.unread?.mentions ?? 0;
	renderList();
}

async function openChannel(id, options = {}) {
	// T-012：是否「真的换了频道」。列表点击/初始进入 = 换频道；同频道内发消息重取 = 不换。
	const changed = state.current !== id;
	// 离开当前频道前，先记下它的滚动位置（贴近底部记 -1，回来时回到底部）。
	if (changed && state.current !== "") {
		const atBottom = el.flow.scrollTop >= el.flow.scrollHeight - el.flow.clientHeight - 2;
		state.scrollPos.set(state.current, atBottom ? -1 : el.flow.scrollTop);
	}
	const playFresh = changed && options.fresh === true;
	if (state.current !== id) state.detail = null;
	state.current = id;
	state.actionsFor = 0;
	state.reply = null;
	renderReply();
	renderList();
	document.body.dataset.pane = "chat";

	const limit = options.limit ?? PAGE;
	const before = options.before;
	const query = `?limit=${limit}${before === undefined ? "" : `&before=${before}`}`;
	const detail = await getJSON(`/api/channels/${encodeURIComponent(id)}${query}`);
	state.detail = detail;

	if (before === undefined) {
		renderHead();
		renderFlow({ toBottom: true, fresh: playFresh });
		// T-012：换频道回来时恢复到上次浏览位置；同频道重取（changed=false）始终保持底部。
		if (changed) {
			const saved = state.scrollPos.get(id);
			if (saved !== undefined && saved !== -1) el.flow.scrollTop = saved;
		}
		// T-016：建立/重建该频道的 SSE 连接（切频道时 connectStream 内部会先关闭旧连接）。
		connectStream(id);
	} else {
		// 上滑加载：把新拿到的一段**插到前面**，并把视口按新内容高度下移，
		// 否则正在看的那条会被推走（旧前端「滚动条乱跳」就是这里没补偿）。
		const heightBefore = el.flow.scrollHeight;
		const fragment = document.createDocumentFragment();
		for (const message of detail.messages) fragment.append(node(messageHtml(message, undefined, false)));
		// T-015：移除「加载更早」按钮，改为上滑自动加载（见 loadEarlier + flow 的 scroll 监听）。
		const existing = el.flowInner.querySelector(".more");
		existing?.remove();
		el.flowInner.prepend(fragment);
		el.flow.scrollTop += el.flow.scrollHeight - heightBefore;
		decorateAll();
	}
	await markRead();
}

/** 上报已读：只报「看到的最新一条」，后端只前进不后退。 */
async function markRead() {
	const detail = state.detail;
	if (detail === null || detail.messages.length === 0) return;
	const seq = detail.messages[detail.messages.length - 1].seq;
	if (state.readSeqs.get(detail.channel.id) === seq) return;
	state.readSeqs.set(detail.channel.id, seq);
	try {
		await postJSON(`/api/channels/${encodeURIComponent(detail.channel.id)}/read`, { seq });
		// 本地先落账，避免列表红点等到下一次 SSE 才消失。
		for (const message of detail.messages) message.read = true;
		const row = state.channels.find((channel) => channel.id === detail.channel.id);
		if (row !== undefined) {
			// 只减点名数：未读总数已经不显示，留着它就是没人读的状态。
			state.mentionTotal = Math.max(0, state.mentionTotal - row.mentions);
			row.unread = 0;
			row.mentions = 0;
			renderList();
		}
	} catch (error) {
		state.readSeqs.delete(detail.channel.id);
		toast(error.message, "error");
	}
}

async function send() {
	const text = el.input.value.trim();
	if (text === "" || state.detail === null) return;
	const reply = state.reply;
	el.send.disabled = true;
	try {
		await postJSON(`/api/channels/${encodeURIComponent(state.detail.channel.id)}/messages`, {
			text,
			...(reply === null ? {} : { replyTo: reply.seq }),
		});
		el.input.value = "";
		state.reply = null;
		renderReply();
		resizeInput();
		// 不等 SSE：立刻把这一段重取一遍，否则要等推送才有自己的消息。
		await openChannel(state.detail.channel.id);
	} catch (error) {
		toast(error.message, "error");
	} finally {
		el.send.disabled = false;
		el.input.focus();
	}
}

// ── @ 候选 ──────────────────────────────────────────────────────────────

let mentionTimer;

function hideMention() {
	state.mention = null;
	el.mentionPop.hidden = true;
}

function renderMention() {
	const mention = state.mention;
	if (mention === null || mention.items.length === 0) {
		el.mentionPop.hidden = true;
		return;
	}
	el.mentionPop.innerHTML = mention.items
		.map(
			(item, index) =>
				`<button class="mention-item" type="button" data-index="${index}"${
					index === mention.index ? ' aria-selected="true"' : ""
				}><span class="mention-name">${escapeHtml(item.label)}</span><small class="mention-title">${escapeHtml(item.title ?? "")}</small><small class="mention-slug">@${escapeHtml(item.slug)}</small></button>`,
		)
		.join("");
	const rect = el.input.getBoundingClientRect();
	el.mentionPop.style.left = `${rect.left + 8}px`;
	el.mentionPop.style.bottom = `${window.innerHeight - rect.top + 6}px`;
	el.mentionPop.hidden = false;
}

async function refreshMention() {
	const input = el.input;
	const caret = input.selectionStart ?? 0;
	const before = input.value.slice(0, caret);
	const match = /(^|[\s（(])@([\p{L}\p{N}_-]*)$/u.exec(before);
	if (match === null) {
		hideMention();
		return;
	}
	const keyword = match[2] ?? "";
	const start = caret - keyword.length - 1;
	if (state.detail === null) {
		hideMention();
		return;
	}
	const data = await getJSON(`/api/channels/${encodeURIComponent(state.detail.channel.id)}/mentionable`);
	const items = (data.candidates ?? []).filter(
		(item) => keyword === "" || item.label.includes(keyword) || item.slug.includes(keyword),
	);
	if (items.length === 0) {
		hideMention();
		return;
	}
	state.mention = { items: items.slice(0, 8), index: 0, start, end: caret };
	renderMention();
}

function acceptMention(index) {
	const mention = state.mention;
	if (mention === null) return;
	const item = mention.items[index];
	if (item === undefined) return;
	const value = el.input.value;
	const label = item.label;
	el.input.value = `${value.slice(0, mention.start)}@${label} ${value.slice(mention.end)}`;
	const caret = mention.start + label.length + 2;
	el.input.setSelectionRange(caret, caret);
	hideMention();
	el.input.focus();
}

// ── 消息浮窗（复制 / 引用） ─────────────────────────────────────────────

function showActions(seq, container) {
	document.querySelector(".msg-actions")?.remove();
	state.actionsFor = seq;
	const message = state.detail?.messages.find((entry) => entry.seq === seq);
	if (message === undefined) return;
	const bar = document.createElement("div");
	bar.className = "msg-actions";
	bar.dataset.for = String(seq);
	bar.innerHTML = `<button type="button" data-act="copy">复制</button><button type="button" data-act="reply">引用</button>`;
	container.append(bar);
}

function clearActions() {
	document.querySelector(".msg-actions")?.remove();
	state.actionsFor = 0;
}

// ── 编制表（团队视图） ──────────────────────────────────────────────────

/**
 * 「谁是哪个项目的、什么职位」—— 老板提的需求（T-20261028-005）。
 *
 * 数据一直在 `/api/org` 里（`streamOrg` 每帧都是完整快照），旧前端只把它当成
 * 「该刷新频道列表了」的信号，一次都没画出来。这里把同一份快照投影成一张表：
 * 不新开接口、不额外轮询，组织一变表就变。
 *
 * 为什么不塞进左侧频道列表：频道列表回答「去哪儿说话」，编制表回答「他是谁」。
 * 两个问题挤在一列里，两边都会变难读（那正是老板说「太混乱」的原因）。
 */
function renderTeam() {
	const people = state.org?.people ?? [];
	el.teamCount.textContent = people.length === 0 ? "" : `${people.length} 人`;
	if (people.length === 0) {
		el.teamList.innerHTML = `<div class="empty">还没拿到组织数据，稍等一下或点刷新</div>`;
		return;
	}
	el.teamList.innerHTML = people.map(crewHtml).join("");
}

/** 一行一人：左色条（项目）+ 头像 + 姓名 + 职位 + 项目 + 向谁汇报。 */
function crewHtml(person) {
	const tone = projectTone(person.project);
	// `orgView` 约定：manager 为空 = 直接向老板汇报。
	const to = person.manager === undefined ? "老板" : (person.managerLabel ?? person.manager);
	const project =
		person.project === undefined
			? `<span class="crew-proj" data-kind="none">公司</span>`
			: `<span class="crew-proj">${escapeHtml(projectName(person.project))}</span>`;
	return `<div class="crew" style="--crew:${tone}" data-slug="${escapeAttr(person.slug)}">
		<span class="crew-strip" aria-hidden="true"></span>
		${avatarHtml(person.label)}
		<span class="crew-name">${escapeHtml(person.label)}</span>
		<span class="crew-title">${escapeHtml(person.title || "职位待填")}</span>
		${project}
		<span class="crew-report">向 <b>${escapeHtml(to)}</b> 汇报</span>
	</div>`;
}

// 浮层打开时，背景内容对屏幕阅读器/键盘不可达（无障碍语义）；关闭时恢复。
function setBackgroundInert(inert) {
	for (const node of document.body.children) {
		node.inert = node === el.team ? false : inert;
	}
}

async function openTeam() {
	state.teamOpen = true;
	el.team.hidden = false;
	el.teamBtn.setAttribute("aria-expanded", "true");
	setBackgroundInert(true);
	renderTeam();
	el.teamPanel.focus();
	// SSE 还没推过第一帧时自己拉一次；失败就留空态，等人点刷新 —— 不吞错。
	if (state.org === null) {
		try {
			const snapshot = await getJSON("/api/org");
			state.org = snapshot;
			if (state.teamOpen) renderTeam();
			renderList();
			renderHead();
		} catch (error) {
			toast(error.message, "error");
		}
	}
}

function closeTeam() {
	state.teamOpen = false;
	el.team.hidden = true;
	setBackgroundInert(false);
	el.teamBtn.setAttribute("aria-expanded", "false");
	el.teamBtn.focus();
}

// ── 事件 ────────────────────────────────────────────────────────────────

function resizeInput() {
	el.input.style.height = "auto";
	el.input.style.height = `${Math.min(el.input.scrollHeight, 200)}px`;
}

function setupEvents() {
	// 列表：一个委托监听，频道行整体重画不影响。
	el.rows.addEventListener("click", (event) => {
		const row = event.target.closest("[data-channel]");
		if (row === null) return;
		void openChannel(row.dataset.channel, { fresh: true }).catch((error) => toast(error.message, "error"));
	});

	// 消息流：加载更早 / 点引用跳过去 / 点消息浮窗。
	el.flow.addEventListener("click", (event) => {
		const jump = event.target.closest("[data-jump]");
		if (jump !== null) {
			const target = el.flowInner.querySelector(`[data-seq="${jump.dataset.jump}"]`);
			if (target === null) {
				toast("那条消息已经不在这一页里了", "error");
				return;
			}
			target.scrollIntoView({ block: "center", behavior: "smooth" });
			target.animate?.([{ background: "color-mix(in srgb, var(--accent) 22%, transparent)" }, { background: "transparent" }], {
				duration: 900,
			});
			return;
		}
		const act = event.target.closest("[data-act]");
		if (act !== null) {
			const seq = Number(act.closest(".msg-actions")?.dataset.for);
			const message = state.detail?.messages.find((entry) => entry.seq === seq);
			if (message === undefined) return;
			if (act.dataset.act === "copy") {
				void copyText(message.text).then((ok) => toast(ok ? "已复制" : "复制失败，请手动选择", ok ? "info" : "error"));
			} else {
				const first = message.text.split("\n").find((line) => line.trim() !== "") ?? "";
				state.reply = {
					seq: message.seq,
					fromLabel: message.fromLabel,
					excerpt: first.length > 60 ? `${first.slice(0, 60)}…` : first,
				};
				renderReply();
				el.input.focus();
			}
			clearActions();
			return;
		}
		const bubble = event.target.closest(".msg");
		if (bubble === null) {
			clearActions();
			return;
		}
		const seq = Number(bubble.dataset.seq);
		if (state.actionsFor === seq) {
			clearActions();
			return;
		}
		// 浮窗贴着这条消息的右上角，而不是跟着鼠标 —— 后者滚动时会漂。
		showActions(seq, bubble);
	});

	// 滚动时收浮窗：绝对定位的元素跟着滚动会很怪。
	el.flow.addEventListener("scroll", () => {
		if (state.actionsFor !== 0) clearActions();
		// T-015：距顶小于阈值时自动加载更早消息（loadEarlier 内部会判 hasMore 与防重入）。
		if (el.flow.scrollTop < 80 && (state.detail?.hasMore ?? false)) void loadEarlier();
	}, { passive: true });

	el.refresh.addEventListener("click", () => {
		void loadChannels().catch((error) => toast(error.message, "error"));
		if (state.current !== "") void openChannel(state.current).catch((error) => toast(error.message, "error"));
	});

	el.back.addEventListener("click", () => {
		document.body.dataset.pane = "list";
	});

	el.replyCancel.addEventListener("click", () => {
		state.reply = null;
		renderReply();
	});

	el.composer.addEventListener("submit", (event) => {
		event.preventDefault();
		void send();
	});

	el.input.addEventListener("input", () => {
		resizeInput();
		clearTimeout(mentionTimer);
		mentionTimer = setTimeout(() => void refreshMention(), 120);
	});

	el.input.addEventListener("keydown", (event) => {
		const mention = state.mention;
		if (mention !== null) {
			if (event.key === "ArrowDown" || event.key === "ArrowUp") {
				event.preventDefault();
				const step = event.key === "ArrowDown" ? 1 : -1;
				mention.index = (mention.index + step + mention.items.length) % mention.items.length;
				renderMention();
				return;
			}
			if (event.key === "Enter" || event.key === "Tab") {
				event.preventDefault();
				acceptMention(mention.index);
				return;
			}
			if (event.key === "Escape") {
				hideMention();
				return;
			}
		}
		// 输入法组字期间的 Enter 是选词，不是发送。`keyCode === 229` 兼容 Safari。
		if (event.key === "Enter" && !event.shiftKey && !event.isComposing && event.keyCode !== 229) {
			event.preventDefault();
			void send();
		}
	});

	el.mentionPop.addEventListener("mousedown", (event) => {
		const item = event.target.closest("[data-index]");
		if (item === null) return;
		event.preventDefault();
		acceptMention(Number(item.dataset.index));
	});

	document.addEventListener("click", (event) => {
		if (el.mentionPop.contains(event.target)) return;
		if (event.target === el.input) return;
		hideMention();
	});

	// 团队视图：入口开/关，点浮层外关，Esc 关（键盘可达要求见工单）。
	el.teamBtn.addEventListener("click", () => {
		if (state.teamOpen) closeTeam();
		else void openTeam();
	});
	el.teamClose.addEventListener("click", () => closeTeam());
	el.team.addEventListener("click", (event) => {
		if (event.target === el.team) closeTeam();
	});
	// 面板里只有一个可聚焦的控件（关闭按钮）。Tab 不许跑到背后的页面上：
	// 背后是浮层，看得见但点不到，焦点落在那里等于键盘用户迷路。
	el.team.addEventListener("keydown", (event) => {
		if (event.key !== "Tab") return;
		event.preventDefault();
		el.teamClose.focus();
	});
	document.addEventListener("keydown", (event) => {
		if (event.key === "Escape" && state.teamOpen) {
			event.preventDefault();
			closeTeam();
		}
	});
}

// ── 启动 ────────────────────────────────────────────────────────────────

/**
 * 组织快照变了（首帧、有人入职、有人改了 identity.md）。
 *
 * SSE 每帧都是完整快照，所以整份替换即可。除了刷新频道列表，还要重画编制表：
 * 老板在别处改了一个人的职位/项目，开着的团队视图必须自己跟着变，不用刷新页面。
 */
function onOrg(snapshot) {
	if (Array.isArray(snapshot?.people)) {
		state.org = snapshot;
		if (state.teamOpen) renderTeam();
		renderList();
		renderHead();
	}
	void loadChannels().catch(() => {});
}

async function main() {
	setupEvents();
	resizeInput();
	try {
		await loadChannels();
	} catch (error) {
		toast(error.message, "error");
	}
	streamOrg(onOrg, () => {});
	// SSE 的第一帧可能要等一个心跳；先自己拉一份，个人频道行与消息头立刻就有
	// 职位可显示，而不是先空一小会儿再跳出来。
	if (state.org === null) {
		void getJSON("/api/org")
			.then((snapshot) => onOrg(snapshot))
			.catch(() => {});
	}
	setInterval(() => {
		renderList();
	}, TICK_MS);

	// 深链：`#/c/<频道 id>` 直接开那个频道（看板与外部链接都靠它）。
	const fromHash = /^#\/c\/(.+)$/u.exec(window.location.hash);
	const first = fromHash?.[1] ?? (window.innerWidth > 760 ? state.channels[0]?.id : undefined);
	if (first !== undefined) {
		void openChannel(decodeURIComponent(first), { fresh: true }).catch((error) => toast(error.message, "error"));
	}
}

void main();
