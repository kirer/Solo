/**
 * 装配：状态、取数、事件、渲染调度。
 *
 * 分工是硬的：
 *   avatar.js 画人，rows.js 决定「一行长什么样」，motion.js 管曲线，
 *   这里只管「什么时候要画什么」以及所有 fetch。
 *
 * 所有 DOM 事件都走委托（挂在 #feed / #rows / #people / #composer 上），
 * 因为消息流每次都是整体重建的 —— 逐条 bind 会在重建时泄漏。
 */

import { attention, getJSON, personProfile, postJSON, streamOrg, workspaceFiles } from "./api.js";
import { mountFiles } from "./files.js";
import { MAX_PER_MESSAGE, filesOf, kindOfFile, queueItemHtml, uploadOne } from "./attach.js";
import { openMemory } from "./memory.js";
import { avatarSvg, groupAvatar } from "./avatar.js";
import { channelDetailHtml, personDetailHtml } from "./detail.js";
import { clipText, copyText, escapeHtml, headParts, relTime, sortChannels, unreadLabel } from "./format.js";
import { glide, installMotionTokens, prefersReducedMotion, withLinger } from "./motion.js";
import {
	activityRun,
	buildEventRow,
	buildOne,
	buildStream,
	groupStatus,
	advanceSeconds,
	isEventKind,
	PLACEHOLDER_TTL_MS,
	markGroupDone,
	shouldShowActivity,
	mergeDoneGroups,
	runStartAt,
	isNeed as isNeedRow,
	wrapEvents,
} from "./rows.js";
import {
	channelCursor,
	enqueueMessage,
	insertLocalMessage,
	localEcho,
	mergeMessage,
	mergeMessages,
	previousOf,
} from "./messages.js";
import { installJankMonitor, mark } from "./jank.js";

/* ── 常量 ───────────────────────────────────────────────────────────── */

const PAGE = 40;
const TICK_MS = 30_000;
const LAYOUT_KEY = "ai-company.layout";
const HL_MS = 1200; // 定位高亮

const STATUS_LABEL = { thinking: "在想", working: "在做", idle: "待命", asleep: "睡了" };

/* ── 状态 ───────────────────────────────────────────────────────────── */

const state = {
	channels: [],
	unread: { total: 0, mentions: 0 },
	attention: { items: [], unread: 0 },
	org: null,
	people: [],
	currentId: null,
	detail: null,
	error: null,
	loading: false,
	loadingEarlier: false,
	layout: readLayout(),
	replyTo: null,
	presence: new Map(),
	lastSeen: new Map(),
	scrollPos: new Map(), // channelId → scrollTop（-1 = 钉在底部）
	readMark: new Map(),
	needIndex: -1,
	mention: { open: false, items: [], index: 0, start: 0 },
	/** 待发送的附件队列。每项 { id?, name, kind, bytes, preview?, state }。 */
	attach: [],
	attentionBroken: false,
	conn: "open",
	lastOk: 0,
	closeChannelStream: null,
	/** 当前列上最后画出来的那条消息的 seq。SSE 只追加比它大的。 */
	lastRendered: 0,
	// 这一轮已经落地、还没等到那句 `say` 的过程行。见 merge()。
	refreshTimer: 0,
	/** 侧栏展开态："open" | "rail"。见 applySide()。 */
	side: "open",
};

const SIDE_KEY = "ai-company.side";

function readSide() {
	try {
		return localStorage.getItem(SIDE_KEY) === "rail" ? "rail" : "open";
	} catch {
		// 隐私模式读不到盘：默认展开。收起是省地方的手段，不该变成默认状态。
		return "open";
	}
}

function readLayout() {
	try {
		return localStorage.getItem(LAYOUT_KEY) === "bubble" ? "bubble" : "flat";
	} catch {
		return "flat";
	}
}

/* ── 元素 ───────────────────────────────────────────────────────────── */

const $ = (id) => document.getElementById(id);

const el = {
	companyMeta: $("company-meta"),
	conn: $("conn"),
	unreadTotal: $("unread-total"),
	needMenu: $("need-menu"),
	plusBtn: $("plus-btn"),
	settings: $("settings"),
	settingsBtn: $("settings-btn"),
	settingsClose: $("settings-close"),
	layoutOptions: $("layout-options"),
	themeOptions: $("theme-options"),
	plusMenu: $("plus-menu"),
	rows: $("rows"),
	sidebar: $("sidebar"),
	sideToggle: $("side-toggle"),
	frame: document.querySelector(".frame"),
	sheet: $("sheet"),
	paneTitle: $("pane-title"),
	barTitle: $("bar-title"),
	paneSub: $("pane-sub"),
	back: $("back"),
	flow: $("flow"),
	flowInner: $("flow-inner"),
	flowTop: $("flow-top"),
	toBottom: $("to-bottom"),
	feed: $("feed"),
	skel: $("skel"),
	act: $("act"),
	actAv: document.querySelector("#act .act-av"),
	actText: document.querySelector("#act .act-text"),
	actTime: document.querySelector("#act .act-time"),
	actLive: document.querySelector("#act .act-live"),
	replyBar: $("reply-bar"),
	replyText: $("reply-text"),
	replyCancel: $("reply-cancel"),
	composer: $("composer"),
	input: $("input"),
	send: $("send"),
	fileInput: $("file-input"),
	tray: $("attach-tray"),
	mentionPop: $("mention-pop"),
	mentionList: $("mention-list"),
	mentionThumb: $("mention-thumb"),
	toastRoot: $("toast-root"),
	teamBtn: $("team-btn"),
	detailBtn: $("detail-btn"),
	detailClose: $("detail-close"),
	filesBody: $("files-body"),
	detailBack: $("detail-back"),
	detail: $("detail"),
	detailPanel: $("detail-panel"),
	detailBody: $("detail-body"),
	team: $("team"),
	teamPanel: $("team-panel"),
	teamList: $("team-list"),
	teamCount: $("team-count"),
	teamClose: $("team-close"),
	lightbox: $("lightbox"),
	lightboxImg: $("lightbox-img"),
	frame: document.querySelector(".frame"),
};

/* ── 小工具 ─────────────────────────────────────────────────────────── */

function kindOf(channel) {
	if (channel?.kind) return channel.kind;
	const id = channel?.id ?? "";
	if (id.startsWith("dm:")) return "dm";
	if (id.startsWith("proj:")) return "project";
	if (id.startsWith("lead:")) return "leadership";
	return "company";
}

function isGroupChannel(channel) {
	const kind = kindOf(channel);
	return kind === "company" || kind === "leadership";
}

function channelAvatar(channel, size) {
	if (isGroupChannel(channel)) {
		const people = state.people.slice(0, 4);
		return groupAvatar({ people, size });
	}
	// 项目频道用自己的 slug 画（同一个负责人手下的两个项目不该长得一样）；
	// 个人频道退到人。
	const slug = channel.project ?? channel.owner ?? channel.id;
	const name = channel.ownerLabel ?? channel.title;
	return avatarSvg({ slug, name, size });
}

/** slug → 名册里那个人（身份正文、岗位、项目）。名册是 `/api/org` 给的唯一事实。 */
function personOf(slug) {
	if (!slug) return undefined;
	return state.people.find((person) => person.slug === slug);
}

function presenceOf(slug) {
	const now = Date.now();
	const live = state.presence.get(slug);
	if (live && now - live.at < 5 * 60 * 1000) return live.state;
	const seen = state.lastSeen.get(slug);
	if (seen && now - seen > 6 * 60 * 60 * 1000) return "asleep";
	return "idle";
}

function notePresence(message) {
	if (!message || message.fromSlug === "owner") return;
	state.lastSeen.set(message.fromSlug, message.at);
	let next = "idle";
	if (message.kind === "think") next = "thinking";
	else if (message.kind === "tool" || message.kind === "work") next = "working";
	const current = state.presence.get(message.fromSlug);
	if (next === "idle" && current) return; // 一句话不把「在做」熄灭
	state.presence.set(message.fromSlug, { state: next, at: message.at });
}

function toast(text, tone = "info") {
	const node = document.createElement("div");
	node.className = "toast";
	node.dataset.tone = tone;
	node.textContent = text;
	el.toastRoot.append(node);
	window.setTimeout(() => withLinger(node, 180, () => node.remove()), 3600);
}

/* ── 顶栏 ───────────────────────────────────────────────────────────── */

/* 需要你的事：优先用 /api/attention（跨频道、带精确 seq）；
 * 这个接口不在时退回「各频道未读提及之和」，仍然是真的数，不造假。 */
function needItems() {
	// 没理的排前面：点一下要跳到「下一条要你处理的」，跳到一条已经理过的不算帮忙。
	if (state.attention.items.length > 0) {
		return [...state.attention.items].sort((a, b) => Number(a.read) - Number(b.read));
	}
	return state.channels
		.filter((channel) => (channel.mentions ?? 0) > 0)
		.map((channel) => ({ channelId: channel.id, channelTitle: channel.title, seq: 0, mentions: channel.mentions }));
}

/* 跳到某条消息：同频道直接高亮，跨频道切过去再高亮（行是异步渲染的，highlightSeq 自己重试）。 */
function jumpTo(channelId, seq) {
	if (channelId !== state.currentId) {
		openChannel(channelId).then(() => {
			if (seq) window.setTimeout(() => highlightSeq(seq), 120);
		});
	} else if (seq) highlightSeq(seq);
}

/* 「找你」清单里的一行：频道名 · 谁 · 80 字摘要 · 相对时间。已理过的淡化。 */
function renderNeedMenu() {
	const items = needItems();
	if (items.length === 0) {
		el.needMenu.innerHTML = `<p class="need-empty">现在没有要你拍板的事。</p>`;
		return;
	}
	const rows = items.slice(0, 12).map((item) => {
		const who = item.fromLabel ?? item.fromSlug ?? "";
		const excerpt = clipText(String(item.excerpt ?? "").replace(/\s+/g, " ").trim(), 80);
		const time = item.at ? relTime(item.at) : "";
		return `<button class="need-item" type="button" role="menuitem" data-need="${escapeHtml(
			item.channelId
		)}|${item.seq ?? 0}" data-read="${item.read ? "true" : "false"}"><span class="need-where">${escapeHtml(
			item.channelTitle ?? ""
		)}${who ? ` · ${escapeHtml(who)}` : ""}</span><span class="need-text">${escapeHtml(
			excerpt
		)}</span><span class="need-time num">${escapeHtml(time)}</span></button>`;
	});
	const more = items.length > 12 ? `<p class="need-more">还有 ${items.length - 12} 条，先处理这些。</p>` : "";
	el.needMenu.innerHTML = rows.join("") + more;
}

function needCount() {
	// 顶栏显示的是**还没理**的条数，不是全部：`/api/attention` 把已读的也返回（老板要能
	// 回头看「哪些我还没理」），直接拿 length 会把 7 天里理过的都算进来 —— 实测一上来
	// 就是「60 件找你」，那个 60 是接口上限，不是真事。
	if (state.attention.items.length > 0) return state.attention.unread;
	return state.channels.reduce((sum, channel) => sum + (channel.mentions ?? 0), 0);
}

function renderTop() {
	// 顶栏左边展示公司名；产品名已固定在别处，这里不再重复，改为展示真实规模（人数 · 频道数）。
	const people = state.org?.people?.length ?? 0;
	const channels = state.channels.length;
	el.companyMeta.textContent = `${people} 人 · ${channels} 个频道`;
	const count = needCount();
	el.unreadTotal.textContent = `${count} 件找你`;
	el.unreadTotal.dataset.zero = count === 0 ? "true" : "false";
	el.unreadTotal.title = count === 0 ? "现在没有需要你拍板的事" : "跳到下一条需要你的事";

	if (state.conn === "closed") {
		const at = state.lastOk ? new Date(state.lastOk) : null;
		el.conn.textContent = at
			? `连不上，${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")} 最后一次成功`
			: "连不上";
		el.conn.hidden = false;
	} else {
		el.conn.hidden = true;
	}
}

/* ── 人栏 ───────────────────────────────────────────────────────────── */

/** 群频道里显示人，私聊频道里显示那个人。两者都要能取到状态。 */
function slugOfChannel(channel) {
	if (kindOf(channel) !== "dm") return undefined;
	const id = String(channel.id ?? "");
	const dash = id.lastIndexOf("-");
	return dash < 0 ? undefined : id.slice(dash + 1);
}

/**
 * 左侧会话列表：**一列平铺，不分纮**。
 *
 * 以前分「成员 / 群组 / 私聊」三段，同一个人在「成员」和「私聊」各出现一次，
 * 两边状态还得自己对上；而群、项目、私聊本来就是同一件事（一个能说话的地方），
 * 拆成两个列表只是把选择变多。现在按最后说话时间排，谁刚找过你在最上面。
 *
 * 每行只给三件事：脸、名字（后面跟状态）、时间（有未读就给点）。
 * 预览、职位、项目、人数全不放 —— 那些扫一眼看不出来，只会把名字挤小。
 */
function renderSidebar() {
	const endMark = mark("render:sidebar");
	// 知言（slug=知言）的私聊恒排第一，其余按最后说话时间 —— 重启后重新拉取也走这里。
	const channels = sortChannels(state.channels);
	if (channels.length === 0) {
		el.rows.innerHTML = `<div class="empty"><span>还没有频道。</span></div>`;
		endMark();
		return;
	}
	const out = channels.map((channel) => {
		const current = channel.id === state.currentId;
		const slug = slugOfChannel(channel);
		// 未读从「一个点」改成数字：点只能说明「有」，说不出「积了多少」。
		// 文案交给 format.unreadLabel（99+ 也在那里截断），这里只管画。
		const unread = unreadLabel(channel.unread);
		const badge =
			unread === ""
				? ""
				: `<span class="ch-badge"${channel.mentions > 0 ? ' data-kind="mention"' : ""}>${unread}</span>`;
		// 状态只对人显示：频道没在「想」这一回事。
		const presence = slug ? presenceOf(slug) : null;
		const state_tag = presence
			? `<span class="ch-state" data-state="${presence}">${STATUS_LABEL[presence] ?? ""}</span>`
			: "";
		// 两行：上面名字 + 状态，下面最后一句。一列平铺是为了「一眼扫完谁在等你」，
		// 但只剩名字的话分不清哪个频道有新内容 —— 预览那一行是这份列表的主要信息。
		const preview = channel.preview ?? "";
		return `<button class="ch" type="button" data-channel="${escapeHtml(channel.id)}"${
			current ? ' aria-current="true"' : ""
		}><span class="ch-av">${channelAvatar(channel, 24)}</span><span class="ch-main"><span class="ch-top"><span class="ch-title">${escapeHtml(
			channel.title ?? "",
		)}</span>${state_tag}</span><span class="ch-sub">${escapeHtml(preview)}</span></span><span class="ch-meta"><span class="ch-time">${relTime(
			channel.lastAt ?? 0,
		)}</span>${badge}</span></button>`;
	});
	el.rows.innerHTML = out.join("");
	// 收起态下每行的名字要写进 title（重建之后旧的 title 跟着节点一起没了）。
	if (state.side === "rail") applySide("rail");
	endMark();
}

/**
 * 只改「哪一行是当前的」。
 *
 * 切频道时以前是整列重建两次（打开前一次、标已读一次）—— 15 行 × 两张 SVG 头像，
 * 连点几下就能看出卡。现在只改属性。
 */
function markCurrent() {
	for (const button of el.rows.querySelectorAll("[data-channel]")) {
		const current = button.dataset.channel === state.currentId;
		if (current) button.setAttribute("aria-current", "true");
		else button.removeAttribute("aria-current");
	}
}


/* ── 消息流 ─────────────────────────────────────────────────────────── */

function isPinned() {
	const flow = el.flow;
	return flow.scrollHeight - flow.scrollTop - flow.clientHeight < 48;
}

function scrollToBottom() {
	el.flow.scrollTop = el.flow.scrollHeight;
	syncToBottom();
}

/* 「回到最新」：钉在底部时藏起来，离开底部时露出。
   刻意不报「N 条新消息」——增量推送、补历史、重放都会让前端自己数出来的条数失真，
   一个会算错的数字比没有数字更糟。要数字看顶栏的「N 件找你」。 */
function syncToBottom() {
	if (!el.toBottom) return;
	const pinned = isPinned();
	if (el.toBottom.hidden === pinned) return; // hidden=true 且 pinned=true / hidden=false 且 pinned=false
	el.toBottom.hidden = pinned;
}

function streamCtx() {
	const need = needSeqs();
	return {
		people: state.people,
		// 频道类型要带下去：私聊里最后一段正在跑的过程组默认展开（老板要看得见过程），
		// 项目/公司频道全折叠。
		channelKind: kindOf(currentChannel()),
		// 两个来源取并集：后端判定的 attention，以及前端按「提问 + 点名老板」算的。
		isNeed: (message) => message.processing !== true && ((message.status === "pending") || need.has(message.seq) || isNeedRow(message)),
	};
}

/**
 * 增量路径下的过程组。
 *
 * 整列重建（buildStream）和这里必须长出同一套东西：一个连续干活段 = 一个组头，
 * 新的过程行往**已有**的组里追加，不许再开第二个头 —— 以前 SSE 每来一条过程就
 * 独立画一行，结果连着两行「14 步过程 命令 14」。
 */
function openGroupOf(slug) {
	const last = el.feed.lastElementChild;
	if (!last || !last.classList?.contains("row-events")) return null;
	if (last.dataset.state !== "running" || last.dataset.slug !== String(slug ?? "")) return null;
	return last;
}

/** 一条过程行到了：并进正在跑的组，没有就开一个（组头照例只说「查看过程」）。 */
function appendEventRow(message, node) {
	const group = openGroupOf(message.fromSlug);
	if (group) {
		group.querySelector(".evs-list")?.append(node);
		group.dataset.end = String(message.at ?? 0);
		return group;
	}
	// 换人了：先把上一个人的 running 组定格到**它自己最后一条过程行**，
	// 不然没人来收口，它会一直跳到 5 分钟超时才停 —— 屏幕上就是别人的活
	// 明明干完了还挂着在跑的状态（活动行也是按它算的）。
	closeOpenGroups(undefined, undefined);
	// 相邻同名的已完成组能并就并：上一段刚收口、这一段又接着干，屏幕上只留一个箭头。
	const prev = el.feed.lastElementChild;
	const rows = [node];
	if (prev?.classList?.contains("row-events") && prev.dataset.state === "done" && prev.dataset.slug === String(message.fromSlug ?? "")) {
		for (const row of [...prev.querySelectorAll(".evs-list > .row-event")]) rows.unshift(row);
		prev.remove();
	}
	const [wrap] = wrapEvents(message.fromSlug, personOf(message.fromSlug)?.label ?? message.fromSlug, rows, {
		// 过程行本身不带 startedAt（它是处理中占位记的「触发时刻」），所以和组头、
		// 活动行走同一个函数：往前找到这一轮的 runStartAt，别从首条投影起算。
		startAt: runStartAt(state.detail?.messages ?? [], [message]),
		endAt: message.at,
		now: Date.now(),
		running: true,
		// 私聊里刚开跑的这一组默认展开：刷新/增量都应该看得见过程。
		defaultOpen: kindOf(currentChannel()) === "dm",
	});
	el.feed.append(wrap);
	return wrap;
}

/**
 * 收口：把跑着的组标成已完成（组头文字不变，都是「查看过程」；用时写进 aria 与 dataset）。
 *
 * 只收 `slug` 这个人的组 —— 别人还在跑，不能因为有人说话就把他的表停掉。
 * `afterNode` 给的时候把组挪到那句话下面：读起来才是「先干活、再开口」。
 */
function closeOpenGroups(endAt, slug, afterNode = null) {
	for (const group of el.feed.querySelectorAll('.row-events[data-state="running"]')) {
		if (slug !== undefined && group.dataset.slug !== String(slug)) continue;
		markGroupDone(group, endAt);
		if (afterNode) afterNode.after(group);
	}
}

/**
 * 清掉同一个人残留的处理中占位。
 *
 * 服务端的占位填充不保证覆盖成功：实测有占位留在库里、真人回复另起一条，
 * 于是屏幕上一条「开始处理」永远转圈。他说了话，这个人的旧占位就该消失。
 */
function dropStalePlaceholders(slug) {
	for (const row of el.feed.querySelectorAll(".row-processing")) {
		if (row.dataset.slug === String(slug ?? "")) row.remove();
	}
}

/**
 * 清掉超时的处理中占位。
 *
 * 只靠「本人后来有没有说话」不够：叫了一个没有会话的同事，那条占位永远不会有人接。
 * 超过 TTL（10 分钟）就当它不存在，别在屏幕上永远转圈。
 */
function sweepExpiredPlaceholders(now = Date.now()) {
	for (const row of el.feed.querySelectorAll(".row-processing")) {
		const at = Number(row.dataset.at ?? 0);
		if (at > 0 && now - at > PLACEHOLDER_TTL_MS) row.remove();
	}
}

/** 跑着的组每秒刷新一次秒数；只改文字，不重建 DOM（重建会吃掉展开状态）。 */
function tickRunningGroups() {
	const now = Date.now();
	for (const group of el.feed.querySelectorAll('.row-events[data-state="running"]')) {
		const startAt = Number(group.dataset.start ?? 0);
		if (!startAt) continue;
		// 五分钟没来新过程行就当这一轮结束了：否则一条历史上的尾巴会永远在跳秒，
		// 变成「看起来一直在跑」的假象。真在跑的话，新过程行会不断刷新 data-end。
		const lastAt = Number(group.dataset.end ?? 0);
		if (lastAt && now - lastAt > 5 * 60 * 1000) {
			closeOpenGroups(lastAt, group.dataset.slug ?? undefined);
			continue;
		}
		// 秒数只许变大：系统时钟被拨回时也不能让老板看到「67s 变成 55s」。
		// 比较用 dataset 里的数值，不从文案里抠 —— 文案改了也不会静默失效。
		// 组头本身不再显示计时（老板的口径：组头只说「查看过程」），这里只维护数值，
		// 供 aria-label 和收口时定格用。
		group.dataset.seconds = String(advanceSeconds(group.dataset.seconds, startAt, now));
	}
}

function needSeqs() {
	const set = new Set();
	for (const item of state.attention.items) {
		if (item.channelId === state.currentId) set.add(item.seq);
	}
	return set;
}
function renderFlow({ veil = false, restore = true } = {}) {
	const detail = state.detail;
	el.skel.hidden = true;

	if (!detail) {
		el.feed.replaceChildren();
		if (state.error) el.feed.append(errorBlock(state.error, "重新加载", () => openChannel(state.currentId)));
		else el.feed.append(emptyBlock(state.currentId ? "这个频道还没有消息。" : "从左边挑一个频道。", null));
		return;
	}

	const messages = detail.messages ?? [];
	// restore=true 时参考「上次离开这个频道时的位置」；restore=false（SSE 增量、加载更早）
	// 只看**此刻**是否钉在底部 —— 以前这里写死 true，等于每条新消息都把正在上翻看历史的人
	// 拽回底部（实测：滚到顶后发一条消息，scrollTop 从 0 跳到 1522）。
	const pinned = restore ? state.scrollPos.get(state.currentId) === -1 || isPinned() : isPinned();
	const previousTop = el.flow.scrollTop;

	el.feed.replaceChildren();
	if (messages.length === 0) {
		// 空频道不是「出错」，是「还没开始」。与其只说一句「还没有消息」，不如把
		// 可以点的人放在这里 —— 老板下一步总是「找个人说话」，不该让他自己敲 @。
		el.feed.append(emptyBlock("这个频道还没有消息。", null, startHints()));
	} else {
		el.feed.append(buildStream(messages, streamCtx()));
	}
	state.lastRendered = messages.length > 0 ? Number(messages[messages.length - 1].seq ?? 0) : 0;
	if (state.error) el.feed.prepend(errorBlock(state.error, "重试", () => openChannel(state.currentId)));

	if (veil) {
		el.flowInner.classList.remove("veil");
		void el.flowInner.offsetWidth;
		el.flowInner.classList.add("veil");
	}

	if (pinned) scrollToBottom();
	else el.flow.scrollTop = previousTop;
}

/* 空频道里可以「从谁开始」：点一下把人 @ 进输入框。用的是真实名册，不是示例数据。 */
function startHints() {
	// 知言恒排第一（pin to top）：空频道「从谁开始」与 @ 候选都先看到助理。
	const people = [...state.people].sort((left, right) =>
		left.slug === PINNED_SLUG ? -1 : right.slug === PINNED_SLUG ? 1 : 0,
	);
	return people.slice(0, 4).map((person) => ({
		label: person.label,
		slug: person.slug,
	}));
}

function emptyBlock(text, actionLabel, hints) {
	const node = document.createElement("div");
	node.className = "empty";
	node.innerHTML = `<b>还没有内容</b><span>${escapeHtml(text)}</span>${actionLabel ? `<button type="button">${escapeHtml(actionLabel)}</button>` : ""}`;
	if (actionLabel) node.querySelector("button")?.addEventListener("click", onAction);
	if (Array.isArray(hints) && hints.length > 0) {
		const row = document.createElement("div");
		row.className = "empty-hints";
		row.innerHTML = `<span class="empty-hints-cap">从谁开始</span>${hints
			.map(
				(person) =>
					`<button class="empty-hint" type="button" data-hint="${escapeHtml(person.slug)}"><span class="empty-hint-av">${avatarSvg({ slug: person.slug, name: person.label, size: 20 })}</span>${escapeHtml(person.label)}</button>`
			)
			.join("")}`;
		row.addEventListener("click", (event) => {
			const chip = event.target.closest("[data-hint]");
			if (!chip) return;
			const person = state.people.find((item) => item.slug === chip.dataset.hint);
			if (!person) return;
			el.input.value = `${el.input.value}@${person.label} `.trimStart();
			el.input.focus();
			autosize();
			el.input.setSelectionRange(el.input.value.length, el.input.value.length);
		});
		node.append(row);
	}
	return node;
}

function errorBlock(message, retryLabel, onRetry) {
	const node = document.createElement("div");
	node.className = "err";
	node.innerHTML = `<span>${escapeHtml(message)}</span><button type="button">${escapeHtml(retryLabel)}</button>`;
	node.querySelector("button")?.addEventListener("click", onRetry);
	return node;
}

/* ── 活动行 ─────────────────────────────────────────────────────────── */

const act = { slug: "", running: null, startAt: 0, endAt: 0 };

/**
 * 底部活动行：和过程组头同一套文案与计时。
 *
 * 活跃状态只在这一条上显示：名字 + 正在执行 · 67s + 三个动点（过程组头不写这些，
 * 不然屏幕上会有好几条「正在执行」）。他开口后这一行直接收掉。
 * 起点用这一段活的组起点（`startedAt ?? 第一条过程行 at`），新过程行不会把表清零。
 */
function renderActivity() {
	const run = activityRun(state.detail?.messages ?? [], Date.now());
	// 过程组头只说「查看过程」，活跃状态只由这一条活动行负责 —— 有活跃轮次就显示。
	if (!shouldShowActivity(run)) {
		hideActivity();
		return;
	}
	const name = personOf(run.slug)?.label ?? run.slug;
	if (el.act.hidden) {
		el.act.hidden = false;
		el.act.dataset.leaving = "";
		act.slug = "";
	}
	if (act.slug !== run.slug) {
		act.slug = run.slug;
		el.actAv.innerHTML = avatarSvg({ slug: run.slug, name, size: 22, state: "working" });
	}
	act.running = true;
	act.startAt = run.startAt;
	act.endAt = run.endAt;
	el.act.dataset.state = "running";
	el.actText.textContent = name;
	el.actTime.textContent = groupStatus({ running: true, startAt: run.startAt, endAt: run.endAt, now: Date.now() });
	if (el.actLive) el.actLive.hidden = false;
}

/** 跑着时每秒重算一次秒数（只改文字）。 */
function tickActivity() {
	if (el.act.hidden || act.running !== true) return;
	el.actTime.textContent = groupStatus({ running: true, startAt: act.startAt, endAt: Date.now(), now: Date.now() });
}

function hideActivity() {
	if (el.act.hidden) return;
	const pinned = isPinned();
	const delta = el.act.offsetHeight;
	// 钉在底部时，这一行消失会让内容整体上移 delta —— 用 WAAPI 补一段，别让它跳。
	if (pinned && !prefersReducedMotion()) {
		el.feed.animate([{ transform: `translateY(${delta}px)` }, { transform: "none" }], {
			duration: 140,
			easing: "cubic-bezier(0.23, 1, 0.32, 1)",
		});
	}
	withLinger(el.act, 140, () => {
		el.act.hidden = true;
		if (pinned) scrollToBottom();
	});
	act.slug = "";
	act.running = null;
}

/* ── 标题 / 引用 / 输入 ─────────────────────────────────────────────── */

function renderHead() {
	const channel =
		state.detail?.channel ?? state.channels.find((candidate) => candidate.id === state.currentId) ?? null;
	el.paneTitle.textContent = channel?.title ?? "频道";
	// 侧栏那个 h1 是产品名，恒定不变（页面上唯一的一级标题）。
	// 手机列表态的字号由 shell.css 的媒体查询管，不靠改文案。
	// 标题下面那一行只放「不能从标题猜到的」信息。
	//
	// 私聊不写「2 人」：私聊本来就是两个人，写出来是废话，还占掉一行副标题的位置。
	// 私聊写的是这个人在干什么（和左侧列表一致），这才是老板打开私聊想知道的第一件事。
	if (!channel) {
		el.paneSub.textContent = "";
		el.composer.hidden = !state.currentId;
		document.body.dataset.pane = state.currentId ? "chat" : "list";
		return;
	}
	const kind = kindOf(channel);
	if (kind === "dm") {
		// 私聊的副标题是**这个人是谁**：岗位、项目，最后是状态（带边框的标签）。
		// 只写「睡了」等于什么都没说 —— 老板打开私聊想知道的是他能干什么。
		const slug = slugOfChannel(channel);
		const person = slug === null ? undefined : personOf(slug);
		const before = [person?.title, person?.project].filter(Boolean).map((text) => escapeHtml(String(text)));
		const status = slug === null ? "" : STATUS_LABEL[presenceOf(slug)] ?? "";
		// 前半段自己一个可省略的盒子：不然「岗位 · 项目」太长时会把右边的状态标签一起切掉
		// （实测过：`前端开发（小恐龙）·di` 后面直接没字了）。
		el.paneSub.innerHTML = `<span class="pane-text">${before.join('<span class="pane-dot">·</span>')}</span>${
			status === "" ? "" : `<span class="pane-state">${escapeHtml(status)}</span>`
		}`;
	} else {
		// 项目频道第一段是这个项目现在在干什么（后端 doing），后面才是项目名 / 负责人 / 人数。
		// 没有 doing 时 parts 和以前一模一样。
		el.paneSub.textContent = headParts(kind === "project" ? channel : { ...channel, doing: undefined }).join(" · ");
	}
	el.composer.hidden = !state.currentId;
	document.body.dataset.pane = state.currentId ? "chat" : "list";
}

function renderReply() {
	if (!state.replyTo) {
		el.replyBar.hidden = true;
		el.replyText.textContent = "";
		return;
	}
	el.replyBar.hidden = false;
	el.replyText.innerHTML = `<b>${escapeHtml(state.replyTo.fromLabel ?? "")}</b> ${escapeHtml(
		clipText(state.replyTo.excerpt, 60),
	)}`;
}

function autosize() {
	el.input.style.height = "auto";
	const next = Math.min(160, Math.max(30, el.input.scrollHeight));
	el.input.style.height = `${next}px`;
	const card = el.composer.querySelector(".composer-card");
	if (card) card.dataset.multi = next > 36 ? "true" : "false";
	const empty = el.input.value.trim() === "" && state.attach.length === 0;
	el.send.disabled = empty || !state.currentId || state.attach.some((item) => item.state === "uploading");
}

/* ── 附件 ───────────────────────────────────────────────────────────── */

/** 队列重画。很小的列表（≤10），整体重建比 diff 便宜。 */
function renderAttach() {
	el.tray.hidden = state.attach.length === 0;
	el.tray.innerHTML = state.attach.map(queueItemHtml).join("");
	autosize();
}

/**
 * 把选中的文件放进队列并上传。
 *
 * 一进来就插入队列（`state: "uploading"`）再异步上传，而不是「先传完再显示」：
 * 传一个 20MB 的图要几秒，这几秒里界面必须已经变过样子，否则用户会再点一次。
 */
async function addFiles(files) {
	const room = MAX_PER_MESSAGE - state.attach.length;
	if (room <= 0) {
		toast(`一条消息最多 ${MAX_PER_MESSAGE} 个附件`, "error");
		return;
	}
	const accepted = [...files].slice(0, room);
	if (files.length > room) toast(`只加了前 ${room} 个（上限 ${MAX_PER_MESSAGE}）`, "error");

	for (const file of accepted) {
		const kind = kindOfFile(file);
		const item = {
			name: file.name || "附件",
			kind,
			bytes: file.size,
			// 图片先给一个本地预览（不等上传）：`URL.createObjectURL` 是同步的，画面立刻有反应。
			preview: kind === "image" ? URL.createObjectURL(file) : undefined,
			state: "uploading",
		};
		state.attach.push(item);
		renderAttach();
		try {
			const saved = await uploadOne(file);
			item.id = saved.id;
			item.name = saved.name ?? item.name;
			item.kind = saved.kind ?? item.kind;
			item.bytes = saved.bytes ?? item.bytes;
			item.state = "done";
		} catch (error) {
			item.state = "error";
			toast(error.message, "error");
		}
		renderAttach();
	}
}

function dropAttachment(index) {
	const [item] = state.attach.splice(index, 1);
	if (item?.preview) URL.revokeObjectURL(item.preview);
	renderAttach();
}

/** 发送完之后清空队列，并释放本地预览（不释放会一直占着内存）。 */
function clearAttach() {
	for (const item of state.attach) if (item.preview) URL.revokeObjectURL(item.preview);
	state.attach = [];
	renderAttach();
}

function renderAll({ veil = false } = {}) {
	renderTop();
	renderSidebar();
	renderHead();
	renderReply();
	renderFlow({ veil });
	renderActivity();
	autosize();
}

/* ── 侧栏收起 ───────────────────────────────────────────────────────── */

/**
 * 收起态只改一个属性：`.frame[data-side]`。宽度、隐藏哪些列、行变成 36×36 的方块，
 * 全部由 shell.css 从这一个属性派生 —— JS 不碰任何尺寸。
 *
 * 收起之后名字看不见了，所以把「名字 · 状态」写进每行的 title：鼠标停一下能读到，
 * 读屏也读得到（title 会进无障碍名字）。
 */
function applySide(side = readSide()) {
	state.side = side;
	const rail = side === "rail";
	el.frame.dataset.side = side;
	if (el.sideToggle) {
		el.sideToggle.setAttribute("aria-expanded", rail ? "false" : "true");
		const label = rail ? "展开侧边栏" : "收起侧边栏";
		el.sideToggle.title = label;
		el.sideToggle.setAttribute("aria-label", label);
	}
	for (const row of el.rows.querySelectorAll("[data-channel]")) {
		if (rail) {
			const title = row.querySelector(".ch-title")?.textContent ?? "";
			const sub = row.querySelector(".ch-sub")?.textContent ?? "";
			row.title = sub === "" ? title : `${title} · ${sub}`;
		} else if (row.title !== "") {
			row.removeAttribute("title");
		}
	}
}

function toggleSide() {
	const next = state.side === "rail" ? "open" : "rail";
	try {
		localStorage.setItem(SIDE_KEY, next);
	} catch {
		// 存不下就只在这次会话里生效。
	}
	applySide(next);
}

/* ── 取数 ───────────────────────────────────────────────────────────── */

async function loadOrg() {
	try {
		const org = await getJSON("/api/org");
		state.org = org;
		state.people = org.people ?? [];
		state.lastOk = Date.now();
		renderSidebar();
		renderTop();
		if (!el.team.hidden) renderTeam();
	} catch (error) {
		toast(error.message, "error");
	}
}

async function loadChannels() {
	try {
		const payload = await getJSON("/api/channels");
		state.channels = payload.channels ?? [];
		state.unread = payload.unread ?? { total: 0, mentions: 0 };
		state.lastOk = Date.now();
		renderSidebar();
		renderTop();
	} catch (error) {
		state.error = error.message;
		renderFlow();
	}
}

async function loadAttention() {
	if (state.attentionBroken) return;
	try {
		const payload = await attention();
		state.attention = { items: payload.items ?? [], unread: payload.unread ?? 0 };
		renderTop();
	} catch {
		// 接口不存在也不影响主流程：退回「未读提及之和」，标记仍靠 isNeed 在前端算。
		// 只尝试一次，别每次推送都刷一条 404。
		state.attentionBroken = true;
		state.attention = { items: [], unread: 0 };
		renderTop();
	}
}

async function openChannel(id, { push = true } = {}) {
	if (!id) return;
	if (state.currentId && state.currentId !== id) {
		state.scrollPos.set(state.currentId, isPinned() ? -1 : el.flow.scrollTop);
	}
	closeChannelStream();
	state.currentId = id;
	state.detail = null;
	state.error = null;
	state.loading = true;
	state.replyTo = null;
	if (el.toBottom) el.toBottom.hidden = true;
	el.skel.hidden = false;
	renderHead();
	markCurrent();
	renderReply();
	renderFlow({ veil: true });
	if (push && location.hash !== `#/c/${id}`) history.replaceState(null, "", `#/c/${id}`);

	try {
		const detail = await getJSON(`/api/channels/${encodeURIComponent(id)}?limit=${PAGE}`);
		if (state.currentId !== id) return;
		state.detail = detail;
		for (const message of detail.messages ?? []) notePresence(message);
		// 注意顺序：先把游标标成已读，再画 —— 否则第一条新消息会先闪一下未读点。
		await markRead(detail);
		renderAll();
		scrollToBottom();
		openChannelStream(id);
	} catch (error) {
		if (state.currentId !== id) return;
		state.error = error.message;
		state.loading = false;
		renderFlow({ veil: true });
	}
}

async function markRead(detail) {
	const channel = detail?.channel;
	if (!channel) return;
	const lastSeq = channel.lastSeq ?? 0;
	if (!lastSeq) return;
	const key = `${state.currentId}:${lastSeq}`;
	if (state.readMark.get(key)) return;
	state.readMark.set(key, true);
	try {
		await postJSON(`/api/channels/${encodeURIComponent(state.currentId)}/read`, { seq: lastSeq });
		const row = state.channels.find((candidate) => candidate.id === state.currentId);
		if (row) {
			row.unread = 0;
			row.mentions = 0;
			const button = el.rows.querySelector(`[data-channel="${CSS.escape(row.id)}"]`);
			button?.querySelector(".ch-badge")?.remove();
		}
	} catch {
		state.readMark.delete(key);
	}
}

async function loadEarlier() {
	if (state.loadingEarlier || !state.detail?.hasMore || !state.currentId) return;
	const first = state.detail.messages?.[0]?.seq;
	if (!first) return;
	state.loadingEarlier = true;
	// 补的是**上面**的历史，所以只把新的行插到最前面，**不重建整列**。
	// 插在上面会让 scrollHeight 正好增加插入的高度，把 scrollTop 加回去，
	// 屏幕上正在看的那一条就一点不动 —— 这是唯一不会抖的做法。
	// （整列重建每次都要重新算位置，实测补两轮后视野跳 900 多像素。）
	// 记下最上面那条已有消息的 seq 和它的屏幕位置：补完历史后把它按回原处。
	// 不看 scrollHeight 差多少 —— 插入的行里可能有图片、附件、代码块，它们的最终高度
	// 只有布局稳定后才知道，用高度差会差出几百像素（实测差 300px，整屏内容往上跳了 10 行）。
	const boundary = topRowOfViewport();
	try {
		const earlier = await getJSON(
			`/api/channels/${encodeURIComponent(state.currentId)}?limit=${PAGE}&before=${first}`,
		);
		if (state.currentId !== earlier.channel.id || !state.detail) return;
		const older = (earlier.messages ?? []).filter(
			(message) => !(state.detail.messages ?? []).some((known) => known.seq === message.seq),
		);
		state.detail = {
			...state.detail,
			messages: mergeMessages(earlier.messages, state.detail.messages),
			hasMore: earlier.hasMore,
		};
		if (older.length > 0) {
			el.feed.insertBefore(buildStream(older, streamCtx()), el.feed.firstChild);
			if (boundary) {
				const node = el.feed.querySelector(`.row[data-seq="${boundary.seq}"]`);
				if (node) el.flow.scrollTop += node.getBoundingClientRect().top - boundary.top;
			}
		}
	} catch (error) {
		toast(error.message, "error");
	} finally {
		state.loadingEarlier = false;
	}
}

/* 视口里最上面那条**消息行**的 seq 和屏幕位置。用它当锚点，补历史前后唯一可比。 */
function topRowOfViewport() {
	const box = el.flow.getBoundingClientRect();
	for (const row of el.feed.querySelectorAll(".row")) {
		const rect = row.getBoundingClientRect();
		if (rect.bottom > box.top + 4) return { seq: row.dataset.seq, top: rect.top };
	}
	return null;
}

async function reload() {
	await Promise.all([loadOrg(), loadChannels(), loadAttention()]);
	if (state.currentId) await openChannel(state.currentId, { push: false });
}

/* ── SSE ────────────────────────────────────────────────────────────── */

/**
 * 一条消息「画出来会变吗」的指纹。
 *
 * 服务端每次提交都会把最近几条重推一遍（占位填充要能原地覆盖），绝大多数和上一次一模一样。
 * 比较指纹比重新渲染便宜三个数量级：字符串拼接 vs 一张 SVG 头像 + 一遍 Markdown。
 */
function messageSignature(message) {
	if (!message) return "";
	const attachments = Array.isArray(message.attachments)
		? message.attachments.map((item) => item?.id ?? "").join(",")
		: "";
	const mentions = Array.isArray(message.mentions) ? message.mentions.join(",") : "";
	return [
		message.seq,
		message.kind ?? "",
		message.status ?? "",
		message.at ?? "",
		message.fromSlug ?? message.from ?? "",
		message.replyTo?.seq ?? "",
		mentions,
		attachments,
		message.needsYou ? "1" : "",
		message.text ?? "",
	].join("\u0001");
}

function openChannelStream(id) {
	if (typeof EventSource === "undefined") return;
	// `since` = 已经拿到的最后一条。带上它，服务端只补增量，
	// 不会把 60 条历史再推一遍（推过来的旧消息会插到列表末尾，一刷新就乱序）。
	const lastSeq = state.detail?.channel?.lastSeq ?? state.detail?.messages?.at(-1)?.seq ?? 0;
	const source = new EventSource(
		`/api/channels/${encodeURIComponent(id)}/stream${lastSeq > 0 ? `?since=${lastSeq}` : ""}`,
	);
	/**
	 * 把一条 SSE 消息应用到列表（不含滚动、活动行、埋点 —— 那些按**批**做）。
	 *
	 * 为什么拆开：服务端一次补历史会连着推几十条，逐条 scrollToBottom 会读一次
	 * scrollHeight（强制布局）再写 scrollTop，几十条就是几十次同步重排；主线程
	 * 就这么被一条一条啃掉了。现在一批只做一次。
	 */
	const applyMessage = (message) => {
		if (state.currentId !== id || !state.detail) return false;
		if (!message || typeof message.seq !== "number") return false;
		const messages = state.detail.messages ?? [];
		const index = messages.findIndex((candidate) => candidate.seq === message.seq);
		const isAppend = index < 0 && message.seq > (state.lastRendered ?? 0);
		// 追加看最后一条；原地替换看 index - 1（占位填充时被替换的就是最后一条，
		// 拿它自己当「上一条」会把头像和名字吃掉，见 messages.previousOf）。
		const previous = previousOf(messages, index, isAppend);
		if (index >= 0) {
			// 合并抽到 messages.mergeMessage：新消息没带 `processing` 时要显式清掉旧值，
			// 否则占位填充完还按处理中画（老板看到的那条一直在转圈）。
			const merged = mergeMessage(messages[index], message);
			// 一个字都没变的消息不是「新消息」。
			//
			// 服务端按提交推送，一次运行里同一批消息会被反复带上（提示性重推，为了占位填充）。
			// 以前这里不管变没变都走 `renderFlow()` —— 实测一次运行 15 秒里整列重建 1616 次，
			// 加了 5 万个节点又删掉，最长一次卡了 2.7 秒。重推不是变化，直接扔掉。
			if (messageSignature(merged) === messageSignature(messages[index])) return false;
			messages[index] = merged;
		} else if (messages.length > 0 && message.seq < messages[messages.length - 1].seq) {
			// 比已加载窗口还早的消息不该追加到末尾（会变成「最新的在上面、更早的在最下面」）。
			// 正常不会走到这里 —— 客户端带 `since` 连流之后服务端只补增量；
			// 万一走了，也宁可整列按 seq 重排，不要乱序。
			messages.push(message);
			messages.sort((left, right) => left.seq - right.seq);
			return "rebuild";
		} else messages.push(message);
		notePresence(message);
		// 只画新来的那一条。
		//
		// 以前这里是无条件 `renderFlow()` —— 整个频道（100+ 行、每行一张 SVG 头像、
		// 正文还要过一遍 Markdown）在**每条消息**到达时重建一次。两个 agent 同时说话、
		// 加上 think/tool 过程投影，一秒能来好几条，主线程一直占着，点哪儿都像卡住。
		// 重建会把正在就地改的那一行（占位填充、编辑）一起换掉，正在写的正文就找不到落点了。
		if (isAppend) {
			if (isEventKind(message.kind)) {
				// 过程行交给 appendEventRow：并进正在跑的组，或者开一个新组。
				// 它拿到的必须是「这一行」这个元素（fragment 判断不了类名），
				// 而且要在挂到 feed 之前判，否则 lastElementChild 就是它自己。
				appendEventRow(message, buildEventRow(message));
			} else {
				el.feed.append(buildOne(message, streamCtx(), previous));
				// 他开口了：这一轮的组头挪到他这句话后面（`after` 是移动，不复制），计时定格。
				closeOpenGroups(message.at, message.fromSlug, el.feed.lastElementChild);
				// 他真说话了：这个人的旧占位（没被覆盖成功的那种）一起收掉。
				if (message.processing !== true) dropStalePlaceholders(message.fromSlug);
			}
			state.lastRendered = message.seq;
		} else if (index >= 0) {
			// 就地改一行（占位填充、编辑）。整列重画会把别的行也一起换掉，
			// 正在写的那一行就丢了落点。
			const row = el.feed.querySelector(`.row[data-seq="${message.seq}"]`);
			if (row === null) return "rebuild";
			row.replaceWith(buildOne(messages[index], streamCtx(), previous));
			// 占位被真实回复覆盖之后，这个人其它的残留占位也一并收掉。
			if (message.processing !== true) dropStalePlaceholders(message.fromSlug);
		} else {
			return "rebuild";
		}
		return true;
	};

	/**
	 * 一批消息一起落。
	 *
	 * 服务端补历史时会连着推几十条：逐条处理意味着几十次强制布局（滚动）、几次
	 * 整列重建的判断。这里攒到下一帧统一处理 —— 和浏览器的渲染节奏对齐，
	 * 主线程不再被一条一条啃。一批超过阈值就直接整列重建一次，别做几十次增量。
	 */
	const BATCH_REBUILD_OVER = 12;
	let pending = [];
	let scheduled = false;
	const flush = () => {
		scheduled = false;
		const batch = pending;
		pending = [];
		if (batch.length === 0) return;
		const endMark = mark("sse:batch");
		const pinned = isPinned();
		let rebuild = batch.length > BATCH_REBUILD_OVER;
		for (const message of rebuild ? [] : batch) {
			if (applyMessage(message) === "rebuild") {
				rebuild = true;
				break;
			}
		}
		if (rebuild) renderFlow({ restore: false });
		if (pinned) scrollToBottom();
		else syncToBottom();
		renderActivity();
		endMark();
	};
	const enqueue = (payload) => {
		const message = payload?.message ?? payload;
		if (!message || typeof message.seq !== "number") return;
		// 同一批里同一个 seq 只留最后一条（服务端重推很常见）。
		pending = enqueueMessage(pending, message);
		if (scheduled) return;
		scheduled = true;
		requestAnimationFrame(flush);
	};
	source.addEventListener("create", (event) => {
		try {
			enqueue(JSON.parse(event.data));
		} catch {
			/* 半条 JSON 不该让整列错误 */
		}
	});
	source.addEventListener("done", (event) => {
		try {
			enqueue(JSON.parse(event.data));
		} catch {
			/* 同上 */
		}
	});
	// 只有 create / done 两种事件：服务端已经没有假流式的 `token` 了（P1-3 删掉了），
	// 留着监听等于一段永远不跑的「纯文本 append 进 Markdown 容器」死代码。
	source.addEventListener("error", () => {
		/* EventSource 自己重连，这里只标记一次断线 */
	});
	state.closeChannelStream = () => source.close();
}

function closeChannelStream() {
	if (state.closeChannelStream) {
		state.closeChannelStream();
		state.closeChannelStream = null;
	}
}

/* ── 待办拍板 ───────────────────────────────────────────────────────── */

async function submitPending(row, action, option) {
	const seq = Number(row.dataset.seq);
	const article = row.querySelector(".pending");
	if (!article || !seq) return;
	const feedback = (text, ok) => {
		let node = article.querySelector(".pending-msg");
		if (!node) {
			node = document.createElement("p");
			node.className = "pending-msg";
			article.append(node);
		}
		node.textContent = text;
		if (!ok) node.dataset.tone = "error";
	};
	try {
		if (action === "answer") {
			await postJSON("/api/answer", { channelId: state.currentId, seq, choice: option });
			const button = article.querySelector(`.pending-opt[data-opt="${option}"]`);
			if (button) {
				button.dataset.done = "true";
				button.setAttribute("aria-pressed", "true");
				window.setTimeout(() => {
					feedback("已记录", true);
				}, 1500);
			}
			feedback("已记录", true);
		} else {
			await postJSON("/api/pending/dispose", { channelId: state.currentId, seq, action });
			feedback(action === "resolve" ? "已标记解决" : "已驳回", true);
			article.querySelectorAll(".pending-opt").forEach((node) => node.setAttribute("disabled", ""));
		}
	} catch (error) {
		feedback(`没提交上去：${error.message}`, false);
	}
}

/* ── 详情浮层（右上角那个 ⓘ） ──────────────────────────────────────── */

/**
 * 私聊看这个人，群看这个群。
 *
 * 人的档案走 `GET /api/people/:slug`（身份、技能、记忆概况、所在频道都在那一个响应里）；
 * 群的档案直接用手上已有的东西（频道元信息 + 成员），不再发一次请求。
 */
let detailReturn = null;

function currentChannel() {
	return state.detail?.channel ?? state.channels.find((candidate) => candidate.id === state.currentId) ?? null;
}

/**
 * 展开右侧栏。`tab` 是 `"detail"` 或 `"files"`。
 *
 * 打开分两帧：先把元素放出来（`hidden=false`），下一帧才把 `data-right` 改成 opens，
 * 这样 CSS 才有「从 0 过渡到 360」的起点 —— 同一帧改两样，浏览器会直接跳到终态。
 */
function openRight(tab) {
	detailReturn ??= document.activeElement;
	if (el.detail.hidden) {
		el.detail.hidden = false;
		requestAnimationFrame(() => {
			el.frame.dataset.right = "open";
		});
	} else {
		el.frame.dataset.right = "open";
	}
	selectRightTab(tab);
}

function selectRightTab(tab) {
	el.detail.dataset.tab = tab;
	for (const button of el.detail.querySelectorAll("[data-right-tab]")) {
		button.setAttribute("aria-selected", String(button.dataset.rightTab === tab));
	}
	el.detailBody.hidden = tab !== "detail";
	el.filesBody.hidden = tab !== "files";
	if (tab === "files") files?.reload();
}

let files = null;

/**
 * 右栏往下钻的路径。栈底永远是「当前频道」，每进一个人压一层。
 *
 * 为什么要有它：从项目详情点进某个成员，是同一个面板换了内容 —— 没有这一层，
 * 老板点完就回不到项目了（只能收起再点一次详情）。
 */
let rightTrail = [];

function pushRight(entry) {
	if (entry.kind === "channel") rightTrail = [entry];
	else rightTrail.push(entry);
	renderRightBack();
}

function renderRightBack() {
	el.detailBack.hidden = rightTrail.length < 2;
}

/** 返回上一层：人 → 人，或人 → 群。退到底就没了（栈底不画返回）。 */
function backRight() {
	if (rightTrail.length < 2) return;
	rightTrail.pop();
	const previous = rightTrail[rightTrail.length - 1];
	renderRightBack();
	if (previous === undefined) return;
	if (previous.kind === "person") void openPersonDetail(previous.slug, { push: false });
	else void openDetail({ push: false });
}

async function openDetail({ push = true } = {}) {
	const channel = currentChannel();
	if (!channel) return;
	openRight("detail");
	if (push) pushRight({ kind: "channel" });
	// 不设 `el.frame.inert`：这是从右边**展开**的一列，不是模态框。
	// 老板可以一边看档案一边点频道。
	el.detailPanel.focus();
	const kind = kindOf(channel);
	if (kind === "dm") {
		const slug = slugOfChannel(channel);
		el.detailBody.innerHTML = `<p class="detail-loading">正在读档案…</p>`;
		try {
			const person = await personProfile(slug);
			el.detailBody.innerHTML = personDetailHtml(person, {
				presence: presenceOf(slug),
				statusLabel: STATUS_LABEL[presenceOf(slug)] ?? "",
			});
		} catch (error) {
			el.detailBody.innerHTML = `<p class="detail-loading">读不到档案：${escapeHtml(
				error instanceof Error ? error.message : String(error),
			)}</p>`;
		}
		return;
	}
	// 知言（slug=知言）固定排第一（pin to top）：频道成员列表恒在首位。
	const members = [...(state.detail?.members ?? [])]
		.sort((left, right) => (left.slug === "知言" ? -1 : right.slug === "知言" ? 1 : 0))
		.map((member) => ({
			slug: member.slug,
			label: member.label,
			title: personOf(member.slug)?.title ?? "",
			presence: presenceOf(member.slug),
		}));
	el.detailBody.innerHTML = channelDetailHtml(channel, {
		kind,
		members,
		avatarHtml: channelAvatar(channel, 56),
		// 详情里「最近」显示的是**最后一句人话**：过程投影（think/tool/work）和系统留痕
		// （note）都不算，否则这里会显示「$ date」这种没人要看的东西。
		preview: recentLineOf(),
		lastAt: channel.lastAt ?? 0,
	});
}

/** 当前频道最后一句「人话」，没有就给空串（详情里那一段会自己收起来）。 */
function recentLineOf() {
	const list = state.detail?.messages ?? [];
	const quiet = new Set(["note", "think", "tool", "work"]);
	for (let index = list.length - 1; index >= 0; index -= 1) {
		const message = list[index];
		if (quiet.has(message.kind)) continue;
		const text = (message.text ?? "").replace(/\s+/g, " ").trim();
		if (text === "") continue;
		return `${message.fromLabel ?? message.from}：${clipText(text, 90)}`;
	}
	return "";
}

/** 从群详情里点一个人：换成那个人的档案（不关面板）。 */
async function openPersonDetail(slug, { push = true } = {}) {
	const before = el.detailBody.innerHTML;
	el.detailBody.innerHTML = `<p class="detail-loading">正在读档案…</p>`;
	try {
		const person = await personProfile(slug);
		el.detailBody.innerHTML = personDetailHtml(person, {
			presence: presenceOf(slug),
			statusLabel: STATUS_LABEL[presenceOf(slug)] ?? "",
		});
		if (push) pushRight({ kind: "person", slug });
	} catch (error) {
		// 读不到就**退回原样**再说一声：把整块内容换成一行错误，等于老板点错一下
		// 就把刚才那个项目详情弄丢了（他得重新收起、再点一遍）。
		el.detailBody.innerHTML = before;
		toast(`读不到这个人的档案：${error instanceof Error ? error.message : String(error)}`, "error");
	}
}

function closeDetail() {
	if (el.detail.hidden) return;
	// 先让列宽滑回 0（300ms），滑完了再 `hidden` 掉：
	// 直接 hidden 等于把动画剪掉，右边会「啪」地弹一下。
	el.frame.dataset.right = "closed";
	const wait = prefersReducedMotion() ? 0 : 300;
	window.setTimeout(() => {
		if (el.frame.dataset.right !== "closed") return;
		el.detail.hidden = true;
		rightTrail = [];
		renderRightBack();
		if (detailReturn instanceof HTMLElement) detailReturn.focus();
		detailReturn = null;
	}, wait);
}

/* ── 团队浮层 ───────────────────────────────────────────────────────── */

let teamReturn = null;

// 知言（slug=知言）固定排第一：助理位，任何列表恒在首位（pin to top）。
const PINNED_SLUG = "知言";

function renderTeam() {
	const people = state.org?.people ?? [];
	el.teamCount.textContent = `${people.length} 人`;
	const sorted = [...people].sort((left, right) => {
		if (left.slug === PINNED_SLUG) return -1;
		if (right.slug === PINNED_SLUG) return 1;
		const depth = (person) => (person.manager ? (person.managerLabel ? 1 : 1) : 0);
		return depth(left) - depth(right) || (left.label ?? "").localeCompare(right.label ?? "");
	});
	el.teamList.innerHTML =
		sorted
			.map((person) => {
				// 「记忆」放在团队表里而不是人栏：人栏那一列是**去说话**的地方，
				// 每行再塞两个按钮就分不清点哪儿会说话了。团队表是「看这个人」的地方。
				return `<div class="crew" data-slug="${escapeHtml(person.slug)}"><span>${avatarSvg({
					slug: person.slug,
					name: person.label,
					size: 24,
					state: presenceOf(person.slug),
				})}</span><span><span class="crew-name">${escapeHtml(person.label ?? "")}</span><span class="crew-line">${escapeHtml(
					[person.title, person.project].filter(Boolean).join(" · ") || "—",
				)}</span></span><span class="crew-report">${person.managerLabel ? `向 ${escapeHtml(person.managerLabel)}` : "直接向老板"}</span><button class="crew-mem" type="button" data-memory="${escapeHtml(
					person.slug,
				)}" title="看他记住了什么">记忆</button></div>`;
			})
			.join("") || `<div class="empty"><span>名册是空的。</span></div>`;
}

function openTeam() {
	teamReturn = document.activeElement;
	renderTeam();
	el.team.hidden = false;
	el.teamBtn.setAttribute("aria-expanded", "true");
	el.frame.inert = true;
	el.teamPanel.focus();
}

function closeTeam() {
	if (el.team.hidden) return;
	withLinger(el.team, 160, () => {
		el.team.hidden = true;
		if (teamReturn instanceof HTMLElement) teamReturn.focus();
	});
	el.teamBtn.setAttribute("aria-expanded", "false");
	el.frame.inert = false;
}

function trapTeamFocus(event) {
	if (event.key !== "Tab") return;
	const focusables = el.teamPanel.querySelectorAll(
		'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
	);
	if (focusables.length === 0) return;
	const first = focusables[0];
	const last = focusables[focusables.length - 1];
	if (event.shiftKey && document.activeElement === first) {
		event.preventDefault();
		last.focus();
	} else if (!event.shiftKey && document.activeElement === last) {
		event.preventDefault();
		first.focus();
	}
}

/* ── 菜单 ───────────────────────────────────────────────────────────── */

function placeMenu(menu, anchor, { align = "right", above = false } = {}) {
	const rect = anchor.getBoundingClientRect();
	menu.hidden = false;
	const width = menu.offsetWidth;
	const height = menu.offsetHeight;
	const left = align === "right" ? rect.right - width : rect.left;
	menu.style.left = `${Math.max(8, Math.min(window.innerWidth - width - 8, left))}px`;
	menu.style.top = `${above ? rect.top - height - 6 : rect.bottom + 6}px`;
	if (above) menu.style.transformOrigin = "6px 100%";
}

function toggleMenu(menu, anchor, options) {
	const willOpen = menu.hidden;
	for (const other of [el.plusMenu, el.needMenu]) {
		if (other !== menu && !other.hidden) withLinger(other, 120);
	}
	if (!willOpen) {
		withLinger(menu, 120);
		anchor?.setAttribute("aria-expanded", "false");
		return;
	}
	placeMenu(menu, anchor, options);
	anchor?.setAttribute("aria-expanded", "true");
}

function applyLayout() {
	document.body.dataset.layout = state.layout;
	for (const item of el.layoutOptions.querySelectorAll("[data-layout]")) {
		item.setAttribute("aria-checked", item.dataset.layout === state.layout ? "true" : "false");
	}
}

function setLayout(next) {
	state.layout = next;
	try {
		localStorage.setItem(LAYOUT_KEY, next);
	} catch {
		/* 隐私模式下写不进去就算了 */
	}
	applyLayout();
	renderFlow({ restore: false });
}

/* ── 设置弹窗（布局 + 主题） ─────────────────────────────────────────── */

let settingsReturn = null;

function syncThemeOptions() {
	const mode = currentThemeMode();
	for (const item of el.themeOptions.querySelectorAll("[data-theme-mode]")) {
		item.setAttribute("aria-checked", item.dataset.themeMode === mode ? "true" : "false");
	}
}

function openSettings() {
	settingsReturn = document.activeElement;
	applyLayout();
	syncThemeOptions();
	el.settings.hidden = false;
	el.settingsBtn.setAttribute("aria-expanded", "true");
	el.frame.inert = true;
	withLinger(el.settings, 0, () => el.settings.querySelector(".settings-panel")?.focus());
}

function closeSettings() {
	if (el.settings.hidden) return;
	withLinger(el.settings, 140, () => {
		el.settings.hidden = true;
		el.frame.inert = false;
		el.settingsBtn.setAttribute("aria-expanded", "false");
		if (settingsReturn instanceof HTMLElement) settingsReturn.focus();
	});
}

// 主题与设置面板的桥接：读取/写入由 theme.js 管理，这里只把它暴露给设置面板。
function currentThemeMode() {
	return window.__themeMode ?? "system";
}
function setThemeMode(mode) {
	if (typeof window.__setThemeMode === "function") window.__setThemeMode(mode);
	syncThemeOptions();
}

/* ── @ 提及 ─────────────────────────────────────────────────────────── */

let mentionCache = new Map();
let mentionTimer = 0;

function closeMention() {
	if (!state.mention.open) return;
	state.mention.open = false;
	el.mentionPop.hidden = true;
	el.mentionPop.dataset.active = "false";
}

function queryAtCaret() {
	const value = el.input.value;
	const caret = el.input.selectionStart ?? value.length;
	const before = value.slice(0, caret);
	const match = /(^|[\s（(])@([\p{L}\p{N}_-]*)$/u.exec(before);
	if (!match) return null;
	return { start: caret - match[2].length - 1, query: match[2].toLowerCase() };
}

async function refreshMention() {
	const hit = queryAtCaret();
	if (!hit || !state.currentId) return closeMention();
	window.clearTimeout(mentionTimer);
	const finish = (candidates) => {
		// 过滤后把知言（pin to top）提到最前，其余保持相关度顺序。
		const matched = candidates
			.filter((candidate) => {
				if (!hit.query) return true;
				return `${candidate.label} ${candidate.slug} ${candidate.title ?? ""}`
					.toLowerCase()
					.includes(hit.query);
			})
			.sort((left, right) =>
				left.slug === PINNED_SLUG ? -1 : right.slug === PINNED_SLUG ? 1 : 0,
			);
		const items = matched.slice(0, 8);
		if (items.length === 0) return closeMention();
		state.mention = { open: true, items, index: 0, start: hit.start };
		el.mentionList.innerHTML = items
			.map(
				(candidate) =>
					`<button class="mention-item" type="button" data-index="${items.indexOf(candidate)}" aria-selected="false"><span>${avatarSvg(
						{ slug: candidate.slug, name: candidate.label, size: 24 },
					)}</span><span class="mi-main"><span class="mi-name">${escapeHtml(
						candidate.label ?? "",
					)}</span><span class="mi-title">${escapeHtml(candidate.title || `@${candidate.slug ?? ""}`)}</span></span></button>`,
			)
			.join("");
		el.mentionPop.hidden = false;
		el.mentionPop.dataset.active = "true";
		positionMention();
		selectMention(0, { instant: true });
	};
	if (mentionCache.has(state.currentId)) {
		finish(mentionCache.get(state.currentId));
		return;
	}
	try {
		const payload = await getJSON(`/api/channels/${encodeURIComponent(state.currentId)}/mentionable`);
		const candidates = payload.candidates ?? [];
		mentionCache.set(state.currentId, candidates);
		finish(candidates);
	} catch {
		closeMention();
	}
}

function positionMention() {
	const card = el.composer.querySelector(".composer-card") ?? el.composer;
	const rect = card.getBoundingClientRect();
	const height = el.mentionPop.offsetHeight || 200;
	el.mentionPop.style.left = `${Math.max(8, Math.min(rect.left + 30, window.innerWidth - el.mentionPop.offsetWidth - 8))}px`;
	el.mentionPop.style.top = `${Math.max(8, rect.top - height - 6)}px`;
}

function selectMention(index, { instant = false } = {}) {
	const items = el.mentionList.querySelectorAll(".mention-item");
	if (items.length === 0) return;
	const next = (index + items.length) % items.length;
	state.mention.index = next;
	items.forEach((item, at) => item.setAttribute("aria-selected", at === next ? "true" : "false"));
	const target = items[next];
	const to = { x: target.offsetLeft, w: target.offsetWidth };
	if (instant) {
		el.mentionThumb.style.transform = `translateX(${to.x}px)`;
		el.mentionThumb.style.width = `${to.w}px`;
		return;
	}
	glide(el.mentionThumb, to);
	el.mentionThumb.style.height = `${target.offsetHeight}px`;
	el.mentionThumb.style.top = `${target.offsetTop}px`;
}

function acceptMention(index) {
	const candidate = state.mention.items[index];
	if (!candidate) return;
	const value = el.input.value;
	const caret = el.input.selectionStart ?? value.length;
	const head = value.slice(0, state.mention.start);
	const tail = value.slice(caret);
	const insert = `@${candidate.label ?? candidate.slug} `;
	el.input.value = `${head}${insert}${tail}`;
	const at = head.length + insert.length;
	el.input.setSelectionRange(at, at);
	closeMention();
	autosize();
	el.input.focus();
}

/* ── 行内动作 ───────────────────────────────────────────────────────── */

/**
 * 触屏上「点一下这条消息」= 把它的动作条叫出来。
 *
 * 为什么不在触屏上常驻：一排复制/回复/定位图标挂在每条消息下面，整屏都是按钮，
 * 正文被挤成碎片。点谁，才出谁的。
 */
function tapRow(row) {
	const already = row.dataset.tools === "true";
	clearTapRow();
	if (!already) row.dataset.tools = "true";
}

function clearTapRow() {
	for (const open of el.feed.querySelectorAll('[data-tools="true"]')) delete open.dataset.tools;
}

const isTouch = () => window.matchMedia("(hover: none)").matches;

function rowText(row) {
	return row.querySelector(".md")?.innerText ?? row.innerText ?? "";
}

async function copyRow(button, text) {
	const ok = await copyText(text);
	if (!ok) {
		toast("复制失败", "error");
		return;
	}
	const icon = button.innerHTML;
	button.dataset.done = "true";
	button.innerHTML = `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 8.5l3 3 6-6.5"/></svg>`;
	window.setTimeout(() => {
		button.dataset.done = "false";
		button.innerHTML = icon;
	}, HL_MS);
}

/**
 * 把某条消息滚到视野中央并闪一下。
 *
 * 要重试：切频道之后消息行是异步渲染出来的，`openChannel().then()` 返回时行可能还没进
 * DOM（实测点「N 件找你」跳过去什么都没高亮）。所以按帧重试几次，找不到就放弃 ——
 * 那条消息可能已经滚出「最近 60 条」的窗口，这种情况下放弃是对的。
 */
function highlightSeq(seq, attempt = 0) {
	const row = el.feed.querySelector(`.row[data-seq="${seq}"]`);
	if (!row) {
		if (attempt < 6) window.setTimeout(() => highlightSeq(seq, attempt + 1), 120);
		return;
	}
	row.scrollIntoView({ block: "center", behavior: prefersReducedMotion() ? "auto" : "smooth" });
	row.dataset.hl = "true";
	window.setTimeout(() => delete row.dataset.hl, HL_MS + 100);
}

/**
 * 展开/收起过程行（想了多久、跑了什么命令）。
 *
 * 用 `hidden` 而不是 class：隐藏的元素不参与布局也不被读屏念，语义就是这个意思。
 * `aria-expanded` 同步，键盘用户听得到状态。
 */
function expandEvent(button) {
	// 单条过程行是 `.row-event`，一组过程行是 `.row-events` —— 两种都能展开。
	const row = button.closest(".row-event, .row-events");
	const body = row?.querySelector(".ev-body, .evs-body");
	if (!body) return;
	const open = body.hidden;
	body.hidden = !open;
	button.setAttribute("aria-expanded", open ? "true" : "false");
	row.dataset.open = open ? "true" : "false";
}

function replyToRow(row) {
	const seq = Number(row.dataset.seq);
	if (!seq) return;
	state.replyTo = { seq, fromLabel: row.querySelector(".row-name")?.textContent ?? "消息", excerpt: clipText(rowText(row), 80) };
	renderReply();
	el.input.focus();
}

/* ── 事件绑定 ───────────────────────────────────────────────────────── */

function bind() {
	el.sideToggle?.addEventListener("click", toggleSide);

	// 「N 件找你」点开是一张清单，不是盲跳：老板的原话是「消息太多，真正需要我的
	// 信息没有 @ 我，能够让我直接定位」。盲跳只能一条一条试，清单能一眼扫完。
	el.unreadTotal.addEventListener("click", (event) => {
		event.stopPropagation();
		renderNeedMenu();
		toggleMenu(el.needMenu, el.unreadTotal);
	});

	el.needMenu.addEventListener("click", (event) => {
		const row = event.target.closest("[data-need]");
		if (!row) return;
		const [channelId, seq] = row.dataset.need.split("|");
		withLinger(el.needMenu, 120);
		el.unreadTotal.setAttribute("aria-expanded", "false");
		jumpTo(channelId, Number(seq) || 0);
	});

	// 设置：右上角唯一的「设置」按钮，弹窗内含布局与主题。
	el.settingsBtn.addEventListener("click", (event) => {
		event.stopPropagation();
		openSettings();
	});
	el.settingsClose.addEventListener("click", () => closeSettings());
	el.settings.addEventListener("click", (event) => {
		if (event.target === el.settings) closeSettings();
	});
	el.layoutOptions.addEventListener("click", (event) => {
		const item = event.target.closest("[data-layout]");
		if (!item) return;
		setLayout(item.dataset.layout);
	});
	el.themeOptions.addEventListener("click", (event) => {
		const item = event.target.closest("[data-theme-mode]");
		if (!item) return;
		setThemeMode(item.dataset.themeMode);
	});

	el.plusBtn.addEventListener("click", (event) => {
		event.stopPropagation();
		toggleMenu(el.plusMenu, el.plusBtn, { align: "left", above: true });
	});

	el.plusMenu.addEventListener("click", (event) => {
		const item = event.target.closest("[data-plus]");
		if (!item) return;
		withLinger(el.plusMenu, 120);
		el.plusBtn.setAttribute("aria-expanded", "false");
		if (item.dataset.plus === "quote") {
			const last = [...el.feed.querySelectorAll('.row[data-seq]')].pop();
			if (last) replyToRow(last);
			else toast("这个频道还没有可以引用的消息");
			return;
		}
		// 发图片 / 发文件：同一个 input，只是 `accept` 不同。
		// 分开的理由不是技术，是**默认行为**：发图片时系统相册只列图，省掉翻找；
		// 发文件时列全部，因为「我要发个压缩包」不该被 accept 挡住。
		if (item.dataset.plus === "image" || item.dataset.plus === "file") {
			el.fileInput.accept = item.dataset.plus === "image" ? "image/*" : "";
			el.fileInput.click();
			return;
		}
	});

	el.rows.addEventListener("click", (event) => {
		const button = event.target.closest("[data-channel]");
		if (!button) return;
		openChannel(button.dataset.channel);
	});

	el.back.addEventListener("click", () => {
		if (state.currentId) {
			state.scrollPos.set(state.currentId, isPinned() ? -1 : el.flow.scrollTop);
		}
		state.currentId = null;
		state.detail = null;
		state.replyTo = null;
		closeChannelStream();
		history.replaceState(null, "", "#/");
		renderAll();
	});

	/* 消息流：所有行内动作都在这里，委托一次到底。 */
	el.feed.addEventListener("click", (event) => {
		const target = event.target;
		const row = target.closest(".row");

		// 触屏：点一条消息把它的动作条叫出来。桌面上有 hover，不需要这一步。
		// 判断「点的是不是动作」必须放在最前面 —— 否则点「复制」也会先被当成选行。
		if (row && isTouch() && !target.closest("[data-act], [data-jump], [data-fold-btn], .md-code-copy, [data-pending], [data-lightbox], .md-img img, .md a")) {
			tapRow(row);
			return;
		}

		const tool = target.closest("[data-act]");
		if (tool && row) {
			if (tool.dataset.act === "copy") copyRow(tool, rowText(row));
			else if (tool.dataset.act === "reply") replyToRow(row);
			else if (tool.dataset.act === "expand") expandEvent(tool);
			return;
		}

		const jump = target.closest("[data-jump]");
		if (jump) {
			highlightSeq(Number(jump.dataset.jump));
			return;
		}

		const fold = target.closest("[data-fold-btn]");
		if (fold) {
			const body = fold.previousElementSibling;
			if (body?.classList.contains("fold")) {
				const folded = body.dataset.folded !== "false";
				body.dataset.folded = folded ? "false" : "true";
				fold.textContent = folded ? "收起" : `展开全文（${rowText(row).length} 字）`;
			}
			return;
		}

		const copyCode = target.closest(".md-code-copy");
		if (copyCode) {
			const pre = copyCode.closest(".md-code")?.querySelector("pre");
			if (!pre) return;
			copyText(pre.innerText).then((ok) => {
				if (!ok) return;
				const label = copyCode.textContent;
				copyCode.textContent = "已复制";
				window.setTimeout(() => {
					copyCode.textContent = label;
				}, HL_MS);
			});
			return;
		}

		const pending = target.closest("[data-pending]");
		if (pending && row) {
			const action = pending.dataset.pending;
			if (action === "answer") submitPending(row, "answer", Number(pending.dataset.opt));
			else submitPending(row, action);
			return;
		}

		const thumb = target.closest("[data-lightbox]");
		if (thumb) {
			el.lightboxImg.src = thumb.dataset.lightbox;
			el.lightbox.hidden = false;
			return;
		}

		const image = target.closest(".md-img img");
		if (image) {
			el.lightboxImg.src = image.currentSrc || image.src;
			el.lightbox.hidden = false;
			return;
		}

	});

	el.flow.addEventListener(
		"scroll",
		() => {
			if (state.currentId && !state.loading) state.scrollPos.set(state.currentId, isPinned() ? -1 : el.flow.scrollTop);
			syncToBottom();
		},
		{ passive: true },
	);

	el.toBottom?.addEventListener("click", () => {
		scrollToBottom();
		// 跳回去之后把这一屏标成已读：不然回来一圈未读数还挂着。
		if (state.detail) markRead(state.detail).then(markCurrent, () => {});
	});

	el.composer.addEventListener("submit", (event) => {
		event.preventDefault();
		sendMessage(el.input.value);
	});

	/* ── 附件 ─────────────────────────────────────────────────────────── */

	el.fileInput.addEventListener("change", () => {
		const files = [...(el.fileInput.files ?? [])];
		// 必须先清空：同一个文件选第二次不会触发 change，是浏览器里最经典的「点了没反应」。
		el.fileInput.value = "";
		addFiles(files);
	});

	// 队列里那一项的 ✕。用事件委托而不是每项挂监听：队列每次重画 innerHTML，
	// 挂上去的监听会随节点一起丢掉。
	el.tray.addEventListener("click", (event) => {
		const drop = event.target.closest("[data-drop]");
		if (!drop) return;
		dropAttachment(Number(drop.dataset.drop));
	});

	/**
	 * 拖拽。
	 *
	 * 只在 composer 自己身上算「目标」而不是整个窗口：把整页变成投放区会让人
	 * 拖文件经过时整页闪一下，且误投概率高。`dragleave` 会冒泡到子元素上（鼠标
	 * 划过一个字符就触发一次），所以用计数器而不是布尔值。
	 */
	let dragDepth = 0;
	const isFileDrag = (event) => [...(event.dataTransfer?.types ?? [])].includes("Files");

	el.composer.addEventListener("dragenter", (event) => {
		if (!isFileDrag(event)) return;
		event.preventDefault();
		dragDepth += 1;
		el.composer.dataset.drag = "true";
	});
	el.composer.addEventListener("dragover", (event) => {
		if (!isFileDrag(event)) return;
		// 不 preventDefault 的话浏览器会以「打开这个文件」收场，页面直接跳走。
		event.preventDefault();
		event.dataTransfer.dropEffect = "copy";
	});
	el.composer.addEventListener("dragleave", (event) => {
		if (!isFileDrag(event)) return;
		dragDepth = Math.max(0, dragDepth - 1);
		if (dragDepth === 0) delete el.composer.dataset.drag;
	});
	el.composer.addEventListener("drop", (event) => {
		if (!isFileDrag(event)) return;
		event.preventDefault();
		dragDepth = 0;
		delete el.composer.dataset.drag;
		addFiles(filesOf(event));
	});

	// 粘贴截图。（design skill：⌘V 一张图是最短的一条输入路径。）
	el.input.addEventListener("paste", (event) => {
		const files = filesOf(event);
		if (files.length === 0) return;
		event.preventDefault();
		addFiles(files);
	});

	el.input.addEventListener("input", () => {
		autosize();
		window.clearTimeout(mentionTimer);
		mentionTimer = window.setTimeout(refreshMention, 60);
	});

	el.input.addEventListener("blur", () => {
		window.setTimeout(closeMention, 120);
	});

	el.input.addEventListener("keydown", (event) => {
		if (event.key === "Escape") {
			if (state.mention.open) {
				event.preventDefault();
				closeMention();
				return;
			}
			if (state.replyTo) {
				event.preventDefault();
				state.replyTo = null;
				renderReply();
			}
			return;
		}
		if (state.mention.open) {
			if (event.key === "ArrowDown") {
				event.preventDefault();
				selectMention(state.mention.index + 1);
				return;
			}
			if (event.key === "ArrowUp") {
				event.preventDefault();
				selectMention(state.mention.index - 1);
				return;
			}
			if (event.key === "Enter" || event.key === "Tab") {
				if (!event.isComposing && event.keyCode !== 229) {
					event.preventDefault();
					acceptMention(state.mention.index);
					return;
				}
			}
		}
		// 输入法组字中 / Safari 的 229：回车是「上屏」，不是「发送」。
		if (event.key === "Enter" && !event.shiftKey) {
			if (event.isComposing || event.keyCode === 229) return;
			event.preventDefault();
			sendMessage(el.input.value);
		}
	});

	el.mentionList.addEventListener("mousedown", (event) => {
		const item = event.target.closest("[data-index]");
		if (!item) return;
		event.preventDefault();
		acceptMention(Number(item.dataset.index));
	});

	el.mentionList.addEventListener("mousemove", (event) => {
		const item = event.target.closest("[data-index]");
		if (!item) return;
		const index = Number(item.dataset.index);
		if (index !== state.mention.index) selectMention(index);
	});

	el.replyCancel.addEventListener("click", () => {
		state.replyTo = null;
		renderReply();
		el.input.focus();
	});

	el.teamBtn.addEventListener("click", openTeam);
	el.teamClose.addEventListener("click", closeTeam);
	el.detailBtn.addEventListener("click", openDetail);
	el.detailClose.addEventListener("click", closeDetail);
	el.detailBack.addEventListener("click", () => backRight());

	// 「文件」页只挂一次，切走再切回来只是 `reload()`（不重建 DOM，滚动位置还在）。
	files = mountFiles(el.filesBody, { load: workspaceFiles, onToast: toast });
	for (const button of el.detail.querySelectorAll("[data-right-tab]")) {
		button.addEventListener("click", () => selectRightTab(button.dataset.rightTab ?? "detail"));
	}

	// 详情面板里的点击：关、跳到某个频道、看某个人、开记忆。
	// 一律走委托 —— 面板内容每次是整块 innerHTML 换掉的。
	el.detailBody.addEventListener("click", (event) => {
		const target = event.target;
		if (!(target instanceof Element)) return;
		if (target.closest("[data-close-detail]")) {
			closeDetail();
			return;
		}
		const memory = target.closest("[data-open-memory]");
		if (memory) {
			const slug = memory.getAttribute("data-open-memory") ?? "";
			const person = personOf(slug);
			closeDetail();
			window.setTimeout(() => openMemory({ slug, label: person?.label ?? slug }), 180);
			return;
		}
		const goto = target.closest("[data-goto]");
		if (goto) {
			const id = goto.getAttribute("data-goto") ?? "";
			closeDetail();
			if (id !== state.currentId) void openChannel(id);
			return;
		}
		const person = target.closest("[data-open-person]");
		if (person) {
			const slug = person.getAttribute("data-open-person") ?? "";
			void openPersonDetail(slug);
			return;
		}
		if (target === el.detail) closeDetail();
	});

	// 换频道时详情面板自动收起：它讲的是上一个频道那个人。
	document.addEventListener("keydown", (event) => {
		if (event.key !== "Escape") return;
		if (!el.detail.hidden) {
			event.stopPropagation();
			closeDetail();
		}
	}, true);

	// 团队表里的「记忆」。先关团队浮层再开记忆面板 —— 两层浮层都抢 Esc 与 inert，
	// 叠在一起会变成「按 Esc 只关了下面那层」。
	el.teamList.addEventListener("click", (event) => {
		const button = event.target.closest("[data-memory]");
		if (!button) return;
		const slug = button.dataset.memory;
		const label = button.closest(".crew")?.querySelector(".crew-name")?.textContent ?? slug;
		closeTeam();
		window.setTimeout(() => openMemory({ slug, label }), 200);
	});

	// 列表右键：私聊那一行能看这个人的记忆。不放进常驻按钮 —— 每行只该有一个动作（去说话）。
	el.rows.addEventListener("contextmenu", (event) => {
		const row = event.target.closest("[data-channel]");
		const slug = row ? slugOfChannel({ id: row.dataset.channel, kind: "dm" }) : undefined;
		if (!slug) return;
		event.preventDefault();
		openMemory({ slug, label: row.querySelector(".ch-title")?.textContent ?? slug });
	});
	el.team.addEventListener("click", (event) => {
		if (event.target === el.team) closeTeam();
	});
	el.lightbox.addEventListener("click", () => {
		el.lightbox.hidden = true;
		el.lightboxImg.removeAttribute("src");
	});

	document.addEventListener("click", (event) => {
		if (!event.target.closest("#plus-menu, #plus-btn")) {
			if (!el.plusMenu.hidden) {
				withLinger(el.plusMenu, 120);
				el.plusBtn.setAttribute("aria-expanded", "false");
			}
		}
		if (!event.target.closest("#need-menu, #unread-total")) {
			if (!el.needMenu.hidden) {
				withLinger(el.needMenu, 120);
				el.unreadTotal.setAttribute("aria-expanded", "false");
			}
		}
	});

	// 触屏上点开的那条动作条：点别处就收起来。
	document.addEventListener("click", (event) => {
		if (!isTouch()) return;
		if (event.target.closest(".row[data-tools='true']")) return;
		clearTapRow();
	});

	document.addEventListener("keydown", (event) => {
		if (event.key === "Escape") {
			clearTapRow();
			if (!el.team.hidden) {
				event.preventDefault();
				closeTeam();
				return;
			}
			if (!el.lightbox.hidden) {
				event.preventDefault();
				el.lightbox.hidden = true;
				el.lightboxImg.removeAttribute("src");
				return;
			}
				if (!el.plusMenu.hidden) withLinger(el.plusMenu, 120);
			if (!el.settings.hidden) closeSettings();
		}
	});

	el.team.addEventListener("keydown", trapTeamFocus);

	window.addEventListener("resize", () => {
		if (!el.mentionPop.hidden) positionMention();

		if (!el.plusMenu.hidden) placeMenu(el.plusMenu, el.plusBtn, { align: "left", above: true });
	});

	window.addEventListener("hashchange", () => {
		const id = location.hash.startsWith("#/c/") ? decodeURIComponent(location.hash.slice(4)) : null;
		if (id && id !== state.currentId) openChannel(id, { push: false });
	});

	// 上滑加载更早：只盯 #flow-top，提前 600px 触发。
	const sentinel = new IntersectionObserver(
		(entries) => {
			for (const entry of entries) {
				if (entry.isIntersecting) loadEarlier();
			}
		},
		{ root: el.flow, rootMargin: "600px 0px 0px 0px", threshold: 0 },
	);
	sentinel.observe(el.flowTop);
}

async function sendMessage(raw) {
	const text = String(raw ?? "").trim();
	// 纯附件（正文空）也允许发 —— 老板拖一张图进来就想直接发，不该逼他打字。
	const attachments = state.attach.filter((item) => item.state === "done" && item.id);
	if ((text === "" && attachments.length === 0) || !state.currentId) return false;
	el.send.disabled = true;
	el.send.dataset.busy = "true";
	const replyTo = state.replyTo?.seq;
	const channelId = state.currentId;
	try {
		const result = await postJSON(`/api/channels/${encodeURIComponent(channelId)}/messages`, {
			text,
			...(replyTo ? { replyTo } : {}),
			...(attachments.length === 0
				? {}
				: { attachments: attachments.map((item) => ({ id: item.id, name: item.name, kind: item.kind, bytes: item.bytes })) }),
		});
		// 发送成功后本地先落一条：SSE 断线重连的那几秒里，消息不能看起来「没发出去」。
		// POST 返回里有 seq，SSE 到达时按同一个 seq 覆盖（merge 幂等），不会出现两条。
		if (typeof result?.seq === "number" && state.currentId === channelId && state.detail) {
			const messages = state.detail.messages ?? [];
			if (!messages.some((message) => message.seq === result.seq)) {
				state.detail.messages = insertLocalMessage(
					messages,
					localEcho({
						seq: result.seq,
						text,
						at: Date.now(),
						attachments: attachments.length === 0 ? undefined : attachments,
						replyTo,
					}),
				);
				state.lastRendered = Math.max(state.lastRendered ?? 0, result.seq);
				// 频道的「我拿到哪了」也要往前推：重连时 `since` 取的就是 lastSeq，
				// 不推的话重连会把这条再推一遍（更糟的是补历史窗口对不上，看起来像丢消息）。
				const cursor = channelCursor(state.detail.channel ?? null, result.seq);
				if (state.detail.channel) {
					state.detail.channel.lastSeq = cursor.lastSeq;
					state.detail.channel.lastAt = cursor.lastAt;
				}
				const row = state.channels.find((item) => item.id === channelId);
				if (row) {
					const next = channelCursor(row, result.seq);
					row.lastSeq = next.lastSeq;
					row.lastAt = next.lastAt;
				}
				renderFlow({ restore: false });
				renderSidebar();
			}
		}
		el.input.value = "";
		state.replyTo = null;
		renderReply();
		clearAttach();
		autosize();
		return true;
	} catch (error) {
		toast(error.message, "error");
		return false;
	} finally {
		delete el.send.dataset.busy;
		autosize();
	}
}

/* ── 启动 ───────────────────────────────────────────────────────────── */

function desktop() {
	return window.matchMedia("(min-width: 641px)").matches;
}

/** 第一屏打开哪个频道：先找有人点名老板的；没有就打开最近还在说话的那个（第一屏不能是一张白纸）。 */
function firstInterestingChannel() {
	const channels = state.channels.filter((channel) => channel.id);
	const need = channels.find((channel) => (channel.mentions ?? 0) > 0);
	if (need) return need;
	const recent = [...channels].sort((a, b) => (b.lastAt ?? 0) - (a.lastAt ?? 0));
	return (
		recent.find((channel) => kindOf(channel) !== "dm" && (channel.lastSeq ?? 0) > 0) ??
		recent.find((channel) => kindOf(channel) === "company") ??
		channels[0] ??
		null
	);
}

/* 焦点环只在键盘操作时出现：pointerdown 说明在用鼠标，把环关掉。
   没有这一行，点一下按钮就留一个 2px 蓝框，看起来像没点干净。 */
function installModality() {
	const root = document.documentElement;
	root.dataset.inputModality = "pointer";
	window.addEventListener(
		"pointerdown",
		() => {
			root.dataset.inputModality = "pointer";
		},
		true,
	);
	window.addEventListener(
		"keydown",
		() => {
			root.dataset.inputModality = "keyboard";
		},
		true,
	);
}

function boot() {
	installMotionTokens();
	installJankMonitor();
	installModality();
	applyLayout();
	applySide();
	bind();
	el.skel.hidden = false;

	const deep = location.hash.startsWith("#/c/") ? decodeURIComponent(location.hash.slice(4)) : null;
	if (deep) document.body.dataset.pane = "chat";

	Promise.all([loadOrg(), loadChannels(), loadAttention()]).then(() => {
		if (deep) return openChannel(deep, { push: false });
		// 桌面第一屏不能是一张白纸：自动打开一个有事的频道。手机上停在列表（一次只给一个区域）。
		const landing = desktop() ? firstInterestingChannel() : null;
		if (landing) return openChannel(landing.id, { push: false });
		renderAll();
	});

	streamOrg(
		() => {
			// org 推送会成串到达（一个动作常常连带几个文档变更）。以前每来一条都立刻
			// 重新拉频道列表 + 找你要的事，然后整条侧栏重建 —— 连续几下之后主线程就排满了。
			// 合并成一次：400ms 内的所有推送只取一次数据。
			window.clearTimeout(state.refreshTimer);
			state.refreshTimer = window.setTimeout(() => {
				loadChannels();
				loadAttention();
			}, 400);
		},
		(status) => {
			state.conn = status === "open" ? "open" : "closed";
			if (status === "open") state.lastOk = Date.now();
			renderTop();
		},
	);

	// 相对时间、活动行秒表、断线提示：每 30s 重算一次，不做逐秒 tick。
	window.setInterval(() => {
		if (state.currentId) {
			renderSidebar();
			renderActivity();
		}
	}, TICK_MS);

	// 过程组跑着时要逐秒跳：只改那一个 span 的文字，别顺手重画整列。
	window.setInterval(() => {
		tickRunningGroups();
		tickActivity();
		sweepExpiredPlaceholders();
	}, 1000);

	window.addEventListener("beforeunload", closeChannelStream);
}

boot();
