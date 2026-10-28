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

import { attention, getJSON, postJSON, streamOrg } from "./api.js";
import { avatarSvg, groupAvatar } from "./avatar.js";
import { copyText, escapeHtml, relTime } from "./format.js";
import { glide, installMotionTokens, prefersReducedMotion, withLinger } from "./motion.js";
import { activityPhrase, buildStream, isNeed as isNeedRow } from "./rows.js";

/* ── 常量 ───────────────────────────────────────────────────────────── */

const PAGE = 40;
const TICK_MS = 30_000;
const LAYOUT_KEY = "ai-company.layout";
const HOLD_MS = 800; // 活动行每句话至少停 800ms
const HL_MS = 1200; // 定位高亮

const GROUPS = [
	{ key: "company", title: "公司", kinds: ["company", "leadership"] },
	{ key: "project", title: "项目", kinds: ["project"] },
	{ key: "dm", title: "", kinds: ["dm"] },
];

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
	attentionBroken: false,
	conn: "open",
	lastOk: 0,
	closeChannelStream: null,
};

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
	refresh: $("refresh"),
	conn: $("conn"),
	unreadTotal: $("unread-total"),
	menuBtn: $("menu-btn"),
	layoutMenu: $("layout-menu"),
	plusBtn: $("plus-btn"),
	plusMenu: $("plus-menu"),
	people: $("people"),
	rows: $("rows"),
	sidebar: $("sidebar"),
	sheet: $("sheet"),
	paneTitle: $("pane-title"),
	barTitle: $("bar-title"),
	paneSub: $("pane-sub"),
	back: $("back"),
	flow: $("flow"),
	flowInner: $("flow-inner"),
	flowTop: $("flow-top"),
	feed: $("feed"),
	skel: $("skel"),
	act: $("act"),
	actAv: document.querySelector("#act .act-av"),
	actText: document.querySelector("#act .act-text"),
	actTime: document.querySelector("#act .act-time"),
	replyBar: $("reply-bar"),
	replyText: $("reply-text"),
	replyCancel: $("reply-cancel"),
	composer: $("composer"),
	input: $("input"),
	send: $("send"),
	mentionPop: $("mention-pop"),
	mentionList: $("mention-list"),
	mentionThumb: $("mention-thumb"),
	toastRoot: $("toast-root"),
	teamBtn: $("team-btn"),
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

function needCount() {
	// 顶栏显示的是**还没理**的条数，不是全部：`/api/attention` 把已读的也返回（老板要能
	// 回头看「哪些我还没理」），直接拿 length 会把 7 天里理过的都算进来 —— 实测一上来
	// 就是「60 件找你」，那个 60 是接口上限，不是真事。
	if (state.attention.items.length > 0) return state.attention.unread;
	return state.channels.reduce((sum, channel) => sum + (channel.mentions ?? 0), 0);
}

function renderTop() {
	// 顶栏左边是公司名；名字叫「一人公司」时再写一遍只是重复，改成真实的规模。
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

function renderPeople() {
	const people = state.org?.people ?? [];
	if (people.length === 0) {
		el.people.replaceChildren();
		return;
	}
	el.people.innerHTML = people
		.map((person) => {
			const presence = presenceOf(person.slug);
			const active = person.project && state.channels.find((c) => kindOf(c) === "dm" && c.title === person.label);
			return `<button class="person" type="button" data-slug="${escapeHtml(person.slug)}"${
				active && active.id === state.currentId ? ' aria-current="true"' : ""
			}><span class="person-av">${avatarSvg({
				slug: person.slug,
				name: person.label,
				size: 24,
				state: presence,
			})}</span><span class="p-who"><span class="p-name">${escapeHtml(person.label ?? "")}</span><span class="p-status" data-state="${presence}"><span class="p-status-t">${
				STATUS_LABEL[presence]
			}${person.title ? ` · ${escapeHtml(person.title)}` : ""}</span></span></span></button>`;
		})
		.join("");
}

/* ── 频道栏 ─────────────────────────────────────────────────────────── */

function renderChannels() {
	if (state.channels.length === 0) {
		el.rows.innerHTML = `<div class="empty"><span>还没有频道。</span></div>`;
		return;
	}
	const out = [];
	for (const group of GROUPS) {
		const items = state.channels.filter((channel) => group.kinds.includes(kindOf(channel)));
		if (items.length === 0) continue;
		if (group.title) out.push(`<div class="chan-head"><b>${group.title}</b></div>`);
		for (const channel of items) {
			const current = channel.id === state.currentId;
			// 副标题只放人话：一句预览；没有预览才退到人数。项目 slug 不上屏。
			const preview = (channel.preview ?? "").trim();
			const sub = preview ? (preview.length > 48 ? `${preview.slice(0, 48)}…` : preview) : `${channel.memberCount ?? 0} 人`;
			const dot = channel.mentions > 0 ? '<span class="dot" data-kind="mention"></span>' : channel.unread > 0 ? '<span class="dot"></span>' : "";
			out.push(`<button class="ch" type="button" data-channel="${escapeHtml(channel.id)}"${
				current ? ' aria-current="true"' : ""
			}><span class="ch-av">${channelAvatar(channel, 24)}</span><span class="ch-main"><span class="ch-title">${escapeHtml(
				channel.title ?? "",
			)}</span><span class="ch-sub">${escapeHtml(sub)}</span></span><span class="ch-meta"><span class="ch-time">${relTime(
				channel.lastAt ?? 0,
			)}</span>${dot}</span></button>`);
		}
	}
	el.rows.innerHTML = out.join("");
}

/* ── 消息流 ─────────────────────────────────────────────────────────── */

function isPinned() {
	const flow = el.flow;
	return flow.scrollHeight - flow.scrollTop - flow.clientHeight < 48;
}

function scrollToBottom() {
	el.flow.scrollTop = el.flow.scrollHeight;
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
	const pinned = restore ? state.scrollPos.get(state.currentId) === -1 || isPinned() : true;
	const previousTop = el.flow.scrollTop;

	el.feed.replaceChildren();
	if (messages.length === 0) {
		el.feed.append(emptyBlock("这个频道还没有消息。", null));
	} else {
		const need = needSeqs();
		el.feed.append(
			buildStream(messages, {
				people: state.people,
				// 两个来源取并集：后端判定的 attention，以及前端按「提问 + 点名老板」算的。
				isNeed: (message) => message.status === "pending" || need.has(message.seq) || isNeedRow(message),
			}),
		);
	}
	if (state.error) el.feed.prepend(errorBlock(state.error, "重试", () => openChannel(state.currentId)));

	if (veil) {
		el.flowInner.classList.remove("veil");
		void el.flowInner.offsetWidth;
		el.flowInner.classList.add("veil");
	}

	if (pinned) scrollToBottom();
	else el.flow.scrollTop = previousTop;
}

function emptyBlock(text, actionLabel, onAction) {
	const node = document.createElement("div");
	node.className = "empty";
	node.innerHTML = `<b>还没有内容</b><span>${escapeHtml(text)}</span>${actionLabel ? `<button type="button">${escapeHtml(actionLabel)}</button>` : ""}`;
	if (actionLabel) node.querySelector("button")?.addEventListener("click", onAction);
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

const act = { text: "", changedAt: 0, timer: 0, slug: "" };

function activityOf() {
	const messages = state.detail?.messages ?? [];
	const now = Date.now();
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index];
		if (!message || message.fromSlug === "owner") continue;
		if (message.kind !== "think" && message.kind !== "tool" && message.kind !== "work") continue;
		if (now - message.at > 5 * 60 * 1000) return null;
		return { message, phrase: activityPhrase(message) };
	}
	return null;
}

function renderActivity() {
	const line = activityOf();
	if (!line) {
		hideActivity();
		return;
	}
	if (el.act.hidden) {
		el.act.hidden = false;
		el.act.dataset.leaving = "";
		el.actAv.innerHTML = avatarSvg({
			slug: line.message.fromSlug,
			name: line.message.fromLabel,
			size: 22,
			state: "working",
		});
		act.text = "";
		act.changedAt = 0;
	}
	if (act.slug !== line.message.fromSlug) {
		act.slug = line.message.fromSlug;
		el.actAv.innerHTML = avatarSvg({
			slug: line.message.fromSlug,
			name: line.message.fromLabel,
			size: 22,
			state: "working",
		});
	}
	el.actTime.textContent = `${Math.max(0, Math.round((Date.now() - line.message.at) / 1000))}s`;

	const next = `${line.message.fromLabel ?? ""}${line.phrase}`;
	if (next === act.text) return;
	const wait = Math.max(0, HOLD_MS - (Date.now() - act.changedAt));
	window.clearTimeout(act.timer);
	act.timer = window.setTimeout(
		() => {
			act.text = next;
			act.changedAt = Date.now();
			el.actText.textContent = next;
		},
		act.text === "" ? 0 : wait,
	);
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
	act.text = "";
	act.slug = "";
}

/* ── 标题 / 引用 / 输入 ─────────────────────────────────────────────── */

function renderHead() {
	const channel =
		state.detail?.channel ?? state.channels.find((candidate) => candidate.id === state.currentId) ?? null;
	el.paneTitle.textContent = channel?.title ?? "频道";
	// 顶栏那个 h1 是全页唯一的一级标题：桌面写产品名，手机写当前区域的名字。
	el.barTitle.textContent = desktop() ? "一人公司" : (channel?.title ?? "频道");
	const parts = [];
	if (channel) {
		const kind = kindOf(channel);
		if (kind === "project" && channel.project) parts.push(channel.project);
		if (channel.ownerLabel) parts.push(kind === "dm" ? "个人频道" : `负责人 ${channel.ownerLabel}`);
		if (channel.memberCount) parts.push(`${channel.memberCount} 人`);
	}
	el.paneSub.textContent = parts.join(" · ");
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
		String(state.replyTo.excerpt ?? "").slice(0, 60),
	)}`;
}

function autosize() {
	el.input.style.height = "auto";
	const next = Math.min(160, Math.max(30, el.input.scrollHeight));
	el.input.style.height = `${next}px`;
	const card = el.composer.querySelector(".composer-card");
	if (card) card.dataset.multi = next > 36 ? "true" : "false";
	const empty = el.input.value.trim() === "";
	el.send.disabled = empty || !state.currentId;
}

function renderAll({ veil = false } = {}) {
	renderTop();
	renderPeople();
	renderChannels();
	renderHead();
	renderReply();
	renderFlow({ veil });
	renderActivity();
	autosize();
}

/* ── 取数 ───────────────────────────────────────────────────────────── */

async function loadOrg() {
	try {
		const org = await getJSON("/api/org");
		state.org = org;
		state.people = org.people ?? [];
		state.lastOk = Date.now();
		renderPeople();
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
		renderChannels();
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
	el.skel.hidden = false;
	renderHead();
	renderChannels();
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
		}
		renderChannels();
	} catch {
		state.readMark.delete(key);
	}
}

async function loadEarlier() {
	if (state.loadingEarlier || !state.detail?.hasMore || !state.currentId) return;
	const first = state.detail.messages?.[0]?.seq;
	if (!first) return;
	state.loadingEarlier = true;
	const fromEnd = el.flow.scrollHeight - el.flow.scrollTop;
	try {
		const earlier = await getJSON(
			`/api/channels/${encodeURIComponent(state.currentId)}?limit=${PAGE}&before=${first}`,
		);
		if (state.currentId !== earlier.channel.id) return;
		const merged = [...(earlier.messages ?? []), ...(state.detail.messages ?? [])];
		state.detail = { ...state.detail, messages: merged, hasMore: earlier.hasMore };
		renderFlow({ restore: false });
		el.flow.scrollTop = el.flow.scrollHeight - fromEnd;
	} catch (error) {
		toast(error.message, "error");
	} finally {
		state.loadingEarlier = false;
	}
}

async function reload() {
	await Promise.all([loadOrg(), loadChannels(), loadAttention()]);
	if (state.currentId) await openChannel(state.currentId, { push: false });
}

/* ── SSE ────────────────────────────────────────────────────────────── */

function openChannelStream(id) {
	if (typeof EventSource === "undefined") return;
	const source = new EventSource(`/api/channels/${encodeURIComponent(id)}/stream`);
	const merge = (payload) => {
		if (state.currentId !== id || !state.detail) return;
		const message = payload?.message ?? payload;
		if (!message || typeof message.seq !== "number") return;
		const messages = state.detail.messages ?? [];
		const index = messages.findIndex((candidate) => candidate.seq === message.seq);
		if (index >= 0) messages[index] = { ...messages[index], ...message };
		else messages.push(message);
		notePresence(message);
		const pinned = isPinned();
		renderFlow({ restore: false });
		if (pinned) scrollToBottom();
		renderActivity();
	};
	source.addEventListener("create", (event) => {
		try {
			merge(JSON.parse(event.data));
		} catch {
			/* 半条 JSON 不该让整列错误 */
		}
	});
	source.addEventListener("done", (event) => {
		try {
			merge(JSON.parse(event.data));
		} catch {
			/* 同上 */
		}
	});
	source.addEventListener("token", (event) => {
		try {
			const payload = JSON.parse(event.data);
			if (state.currentId !== id || typeof payload.seq !== "number") return;
			const row = el.feed.querySelector(`.row[data-seq="${payload.seq}"] .md`);
			if (row) row.append(document.createTextNode(payload.delta ?? ""));
			if (isPinned()) scrollToBottom();
		} catch {
			/* 同上 */
		}
	});
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

/* ── 团队浮层 ───────────────────────────────────────────────────────── */

let teamReturn = null;

function renderTeam() {
	const people = state.org?.people ?? [];
	el.teamCount.textContent = `${people.length} 人`;
	const sorted = [...people].sort((left, right) => {
		const depth = (person) => (person.manager ? (person.managerLabel ? 1 : 1) : 0);
		return depth(left) - depth(right) || (left.label ?? "").localeCompare(right.label ?? "");
	});
	el.teamList.innerHTML =
		sorted
			.map(
				(person) => `<div class="crew"><span>${avatarSvg({
					slug: person.slug,
					name: person.label,
					size: 24,
					state: presenceOf(person.slug),
				})}</span><span><span class="crew-name">${escapeHtml(person.label ?? "")}</span><span class="crew-line">${escapeHtml(
					[person.title, person.project].filter(Boolean).join(" · ") || "—",
				)}</span></span><span class="crew-report">${person.managerLabel ? `向 ${escapeHtml(person.managerLabel)}` : "直接向老板"}</span></div>`,
			)
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
	for (const other of [el.layoutMenu, el.plusMenu]) {
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
	for (const item of el.layoutMenu.querySelectorAll("[data-layout]")) {
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
		const items = candidates
			.filter((candidate) => {
				if (!hit.query) return true;
				return `${candidate.label} ${candidate.slug} ${candidate.title ?? ""}`
					.toLowerCase()
					.includes(hit.query);
			})
			.slice(0, 8);
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

function highlightSeq(seq) {
	const row = el.feed.querySelector(`.row[data-seq="${seq}"]`);
	if (!row) return;
	row.scrollIntoView({ block: "center", behavior: prefersReducedMotion() ? "auto" : "smooth" });
	row.dataset.hl = "true";
	window.setTimeout(() => delete row.dataset.hl, HL_MS + 100);
}

function replyToRow(row) {
	const seq = Number(row.dataset.seq);
	if (!seq) return;
	state.replyTo = { seq, fromLabel: row.querySelector(".row-name")?.textContent ?? "消息", excerpt: rowText(row).slice(0, 80) };
	renderReply();
	el.input.focus();
}

/* ── 事件绑定 ───────────────────────────────────────────────────────── */

function bind() {
	el.refresh.addEventListener("click", () => {
		reload();
	});

	el.unreadTotal.addEventListener("click", () => {
		const items = needItems();
		if (items.length === 0) return;
		state.needIndex = (state.needIndex + 1) % items.length;
		const item = items[state.needIndex];
		if (item.channelId !== state.currentId) {
			openChannel(item.channelId).then(() => {
				if (item.seq) window.setTimeout(() => highlightSeq(item.seq), 120);
			});
		} else if (item.seq) {
			highlightSeq(item.seq);
		}
	});

	el.menuBtn.addEventListener("click", (event) => {
		event.stopPropagation();
		toggleMenu(el.layoutMenu, el.menuBtn);
	});

	el.layoutMenu.addEventListener("click", (event) => {
		const item = event.target.closest("[data-layout]");
		if (!item) return;
		setLayout(item.dataset.layout);
		withLinger(el.layoutMenu, 120);
		el.menuBtn.setAttribute("aria-expanded", "false");
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
		// 便签：把自己正在输入的内容变成一条广播出去的话（老板自己说的，带 --accent-wash）。
		const text = el.input.value.trim();
		if (!text) {
			toast("先写点什么，再存成便签");
			return;
		}
		sendMessage(`[便签] ${text}`).then((ok) => {
			if (ok) {
				el.input.value = "";
				autosize();
			}
		});
	});

	el.rows.addEventListener("click", (event) => {
		const button = event.target.closest("[data-channel]");
		if (!button) return;
		openChannel(button.dataset.channel);
	});

	el.people.addEventListener("click", (event) => {
		const button = event.target.closest("[data-slug]");
		if (!button) return;
		const slug = button.dataset.slug;
		const person = state.people.find((candidate) => candidate.slug === slug);
		const dm = state.channels.find((channel) => kindOf(channel) === "dm" && channel.title === person?.label);
		if (dm) openChannel(dm.id);
		else openTeam();
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

		const tool = target.closest("[data-act]");
		if (tool && row) {
			if (tool.dataset.act === "copy") copyRow(tool, rowText(row));
			else if (tool.dataset.act === "reply") replyToRow(row);
			else if (tool.dataset.act === "locate") highlightSeq(Number(row.dataset.seq));
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
		},
		{ passive: true },
	);

	el.composer.addEventListener("submit", (event) => {
		event.preventDefault();
		sendMessage(el.input.value);
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
	el.team.addEventListener("click", (event) => {
		if (event.target === el.team) closeTeam();
	});
	el.lightbox.addEventListener("click", () => {
		el.lightbox.hidden = true;
		el.lightboxImg.removeAttribute("src");
	});

	document.addEventListener("click", (event) => {
		if (!event.target.closest("#layout-menu, #menu-btn")) {
			if (!el.layoutMenu.hidden) {
				withLinger(el.layoutMenu, 120);
				el.menuBtn.setAttribute("aria-expanded", "false");
			}
		}
		if (!event.target.closest("#plus-menu, #plus-btn")) {
			if (!el.plusMenu.hidden) {
				withLinger(el.plusMenu, 120);
				el.plusBtn.setAttribute("aria-expanded", "false");
			}
		}
	});

	document.addEventListener("keydown", (event) => {
		if (event.key === "Escape") {
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
			if (!el.layoutMenu.hidden) withLinger(el.layoutMenu, 120);
			if (!el.plusMenu.hidden) withLinger(el.plusMenu, 120);
		}
	});

	el.team.addEventListener("keydown", trapTeamFocus);

	window.addEventListener("resize", () => {
		if (!el.mentionPop.hidden) positionMention();
		if (!el.layoutMenu.hidden) placeMenu(el.layoutMenu, el.menuBtn);
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
	if (!text || !state.currentId) return false;
	el.send.disabled = true;
	el.send.dataset.busy = "true";
	const replyTo = state.replyTo?.seq;
	try {
		await postJSON(`/api/channels/${encodeURIComponent(state.currentId)}/messages`, {
			text,
			...(replyTo ? { replyTo } : {}),
		});
		el.input.value = "";
		state.replyTo = null;
		renderReply();
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

function boot() {
	installMotionTokens();
	applyLayout();
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
			loadChannels();
			loadAttention();
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
			renderChannels();
			renderActivity();
		}
	}, TICK_MS);

	window.addEventListener("beforeunload", closeChannelStream);
}

boot();
