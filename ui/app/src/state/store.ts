/**
 * 一个进程内的小 store。
 *
 * 为什么不用状态库：全部状态就是一个对象，改法是「patch 一份新对象」，
 * 订阅靠 `useSyncExternalStore`。真正的复杂度不在状态管理，而在
 * 「一条消息该画成什么」（见 `stream/model.ts`）—— 那一块是纯函数，单独测。
 *
 * 一条纪律：**不要在这里读 DOM、不要在这里 setTimeout 做渲染**。
 * 上一个版本把「追加一行」「滚动到底」都写成命令式 DOM 操作，
 * 于是 SSE 一密集就出现整列重建、顺序错乱、动画被打断的一堆毛病。
 */

import {
	getAttention,
	getChannel,
	getChannels,
	getEarlier,
	getOrg,
	getPerson,
	markRead as markReadApi,
	sendMessage,
} from "../api/client.ts";
import type { Actor, AttentionItem, Channel, ChannelDetail, Message, PersonProfile } from "../api/types.ts";
import { mark } from "../lib/jank.ts";

export type Presence = "idle" | "working" | "thinking" | "asleep";
export type Layout = "flat" | "bubble";
export type Theme = "system" | "light" | "dark";
export type Side = "open" | "rail";
export type RightTab = "detail" | "files";

export type State = {
	/** 首屏数据都到齐了才画主界面 —— 半渲染的界面比什么都不画更像坏了。 */
	ready: boolean;
	company: string;
	people: Actor[];
	channels: Channel[];
	currentId: string | null;
	detail: ChannelDetail | null;
	/** 上翻是否还有更早的。 */
	hasMore: boolean;
	loadingEarlier: boolean;
	attention: AttentionItem[];
	attentionUnread: number;
	presence: Map<string, { state: Presence; at: number }>;
	/**
	 * 「他正在说的那句话」：还没落库的草稿正文，按 slug。
	 *
	 * 只有正在生成的才有；真消息一到就删（见 `applyMessage`）——
	 * 草稿是**临时**的，绝不能和已落库的消息并存，否则同一句话会出现两遍。
	 */
	drafts: Map<string, { text: string; at: number }>;
	lastSeen: Map<string, number>;
	/** SSE 通不通。`lastOkAt` 用来在断线时显示「最后一次成功」。 */
	conn: { ok: boolean; lastOkAt: number };
	layout: Layout;
	theme: Theme;
	side: Side;
	right: { open: boolean; tab: RightTab };
	needMenu: boolean;
	settings: boolean;
	team: boolean;
	/** 正在引用的那条消息（seq + 摘要），发出去就清空。 */
	reply: { seq: number; label: string; excerpt: string } | null;
	/** 右侧栏的返回栈：栈底永远是当前频道。 */
	trail: RightEntry[];
	/** 右侧栏正在看的那个人（`null` = 看频道本身）。 */
	person: PersonProfile | null;
	/** 记忆抽屉正在看谁（`null` = 抽屉关着）。 */
	memoryPerson: { slug: string; label: string } | null;
};

const LAYOUT_KEY = "ai-company.layout";
const THEME_KEY = "ai-company.theme";
const SIDE_KEY = "ai-company.side";

function read<K extends string>(key: string, allowed: readonly K[], fallback: K): K {
	const value = localStorage.getItem(key);
	return allowed.includes(value as K) ? (value as K) : fallback;
}

const initial: State = {
	ready: false,
	company: "Solo",
	people: [],
	channels: [],
	currentId: null,
	detail: null,
	hasMore: false,
	loadingEarlier: false,
	attention: [],
	attentionUnread: 0,
	presence: new Map(),
	drafts: new Map(),
	lastSeen: new Map(),
	conn: { ok: true, lastOkAt: Date.now() },
	layout: read(LAYOUT_KEY, ["flat", "bubble"], "bubble"),
	theme: read(THEME_KEY, ["system", "light", "dark"], "system"),
	side: read(SIDE_KEY, ["open", "rail"], "open"),
	right: { open: false, tab: "detail" },
	needMenu: false,
	settings: false,
	team: false,
	reply: null,
	trail: [{ kind: "channel" }],
	person: null,
	memoryPerson: null,
};

let state: State = initial;
const listeners = new Set<() => void>();

export function getState(): State {
	return state;
}

export function subscribe(listener: () => void): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

export function patch(change: Partial<State> | ((current: State) => Partial<State>)): void {
	const next = typeof change === "function" ? change(state) : change;
	state = { ...state, ...next };
	for (const listener of listeners) listener();
}

/* ── 列表与快照 ─────────────────────────────────────────────────────── */

/** 拉频道列表 + 「找你」清单。org 推送很密，调用方要自己去抖。 */
export async function refreshLists(): Promise<void> {
	const [channels, attention] = await Promise.all([getChannels(), getAttention()]);
	patch({
		channels: sortChannels(channels.channels),
		attention: attention.items,
		attentionUnread: attention.unread,
	});
	// 列表里的未读数变了，顶部标题（当前频道）也要跟着变 —— 用 detail 的 channel 覆盖一次。
	if (state.currentId !== null) {
		const mine = channels.channels.find((channel) => channel.id === state.currentId);
		if (mine !== undefined && state.detail !== null) {
			patch({ detail: { ...state.detail, channel: strip(mine) } });
		}
	}
}

function sortChannels(list: readonly Channel[]): Channel[] {
	return [...list].sort((left, right) => right.lastAt - left.lastAt);
}

function strip(channel: Channel): ChannelDetail["channel"] {
	const { unread: _unread, mentions: _mentions, preview: _preview, ...rest } = channel;
	return rest;
}

export async function bootstrap(): Promise<void> {
	const org = await getOrg();
	patch({ company: org.company.name, people: org.people });
	await refreshLists();
	// 进来就落到「最近有动静的那个频道」——空着中栏等于让人先做一次选择。
	// 只在宽屏上自动落一个频道：手机上中栏是「第二屏」，一进来就跳进去等于
	// 让人先按三次返回才能看到列表。
	const first = getState().channels[0];
	if (getState().currentId === null && first !== undefined && window.matchMedia("(min-width: 861px)").matches) {
		void openChannel(first.id);
	}
	patch({ ready: true });
}

/* ── 频道 ───────────────────────────────────────────────────────────── */

export async function openChannel(id: string | null): Promise<void> {
	// `null` = 回到「没选频道」。手机上是返回列表，桌面上是清空中栏。
	if (id === null) {
		patch({ currentId: null, detail: null, hasMore: false, reply: null });
		return;
	}
	// 切频道先清 detail：否则新频道的消息会先画到旧频道那屏上（半秒的错位）。
	patch({ currentId: id, detail: null, hasMore: false, reply: null, needMenu: false, drafts: new Map() });
	const done = mark("channel:open");
	const detail = await getChannel(id);
	done();
	// 期间又切走了就别覆盖。
	if (getState().currentId !== id) return;
	patch({ detail, hasMore: detail.hasMore });
	notePresenceOf(detail.messages);
	void readToEnd(id, detail.messages);
}

export async function loadEarlier(): Promise<void> {
	const { currentId, detail, hasMore, loadingEarlier } = state;
	if (currentId === null || detail === null || !hasMore || loadingEarlier) return;
	const earliest = detail.messages[0]?.seq ?? 1;
	if (earliest <= 1) {
		patch({ hasMore: false });
		return;
	}
	patch({ loadingEarlier: true });
	const done = mark("channel:earlier");
	try {
		const page = await getEarlier(currentId, earliest);
		const merged = mergeMessages(page.messages, getState().detail?.messages ?? []);
		patch({
			detail: getState().detail === null ? null : { ...getState().detail!, messages: merged },
			hasMore: page.hasMore,
		});
	} finally {
		done();
		patch({ loadingEarlier: false });
	}
}

/**
 * 按 seq 合并两批消息：去重、升序，后一批赢。
 *
 * 「后一批赢」很关键：占位（`processing: true` 的「开始处理…」）会被正文原地覆盖，
 * 同一个 seq 两次到达时必须取新的那份。按到达顺序 push 会出现重复行和乱序 ——
 * 那正是老板报过「刷新后少了几句」的样子。
 */
export function mergeMessages(older: readonly Message[], newer: readonly Message[]): Message[] {
	const bySeq = new Map<number, Message>();
	for (const message of older) bySeq.set(message.seq, message);
	for (const message of newer) bySeq.set(message.seq, message);
	return [...bySeq.values()].sort((left, right) => left.seq - right.seq);
}

/** SSE 推来一条（新增或原地更新）。 */
export function applyMessage(id: string, message: Message): void {
	// SSE 一条一条到达，卡顿发生时最需要知道的就是「是不是正在合并消息」。
	const done = mark("sse:apply");
	const current = getState();
	if (current.currentId !== id || current.detail === null) return;
	const messages = current.detail.messages;
	const index = messages.findIndex((candidate) => candidate.seq === message.seq);
	let next: Message[];
	if (index < 0) {
		// 比窗口还早的消息（服务端补历史）不能直接 push 到末尾，否则顺序错乱。
		next = mergeMessages(messages, [message]);
	} else {
		next = messages.slice();
		next[index] = message;
	}
	patch({ detail: { ...current.detail, messages: next } });
	// 真消息到了，他刚才的草稿就该消失 —— 否则同一句话会以「正在说…」和气泡两种形态并存。
	if (message.fromSlug !== undefined && current.drafts.has(message.fromSlug)) {
		const drafts = new Map(current.drafts);
		drafts.delete(message.fromSlug);
		patch({ drafts });
	}
	if (message.fromSlug !== "owner") notePresence(message);
	done();
}

/**
 * 收到一条草稿（模型正在生成、还没落库的那句话）。
 *
 * 只认当前频道里的人：别的频道的草稿推过来也没处显示。
 */
export function applyDraft(slug: string, text: string): void {
	const current = getState();
	if (current.detail === null) return;
	const member = current.detail.members.some((item) => item.slug === slug);
	if (!member) return;
	const drafts = new Map(current.drafts);
	drafts.set(slug, { text, at: Date.now() });
	patch({ drafts });
}

export async function send(text: string, attachmentIds: readonly string[] = []): Promise<void> {
	const { currentId, reply } = state;
	if (currentId === null) return;
	const trimmed = text.trim();
	if (trimmed === "" && attachmentIds.length === 0) return;
	patch({ reply: null });
	const done = mark("send");
	try {
		await sendMessage(currentId, {
			text: trimmed,
			...(reply === null ? {} : { replyTo: reply.seq }),
			...(attachmentIds.length === 0 ? {} : { attachments: [...attachmentIds] }),
		});
	} catch (error) {
		patch({ reply });
		throw error;
	} finally {
		done();
	}
}

async function readToEnd(id: string, messages: readonly Message[]): Promise<void> {
	const last = messages[messages.length - 1];
	if (last === undefined) return;
	try {
		await markReadApi(id, last.seq);
	} catch {
		// 已读失败不该打扰老板：下一次进这个频道还会再试一次。
	}
}

/* ── 在场（推导，不落库） ───────────────────────────────────────────── */

const LIVE_MS = 5 * 60 * 1000;
const ASLEEP_MS = 6 * 60 * 60 * 1000;

/**
 * 一个 agent 现在在干什么。
 *
 * 后端没有「在线状态」这个概念 —— 它是从消息流里推导出来的：think 就是「在想」、
 * tool/work 就是「在做」，说了话就是「待命」，很久没动静就是「睡了」。
 * 推导放在前端是因为它是**显示**问题：同一条消息在别人眼里和在你眼里含义相同。
 */
export function presenceOf(slug: string | null, now = Date.now()): Presence {
	if (slug === null) return "idle";
	const live = state.presence.get(slug);
	if (live !== undefined && now - live.at < LIVE_MS) return live.state;
	const seen = state.lastSeen.get(slug);
	if (seen !== undefined && now - seen > ASLEEP_MS) return "asleep";
	return "idle";
}

function notePresence(message: Message): void {
	notePresenceOf([message]);
}

function notePresenceOf(messages: readonly Message[]): void {
	const presence = new Map(state.presence);
	const lastSeen = new Map(state.lastSeen);
	for (const message of messages) {
		if (message.fromSlug === "owner") continue;
		lastSeen.set(message.fromSlug, message.at);
		let next: Presence = "idle";
		if (message.kind === "think") next = "thinking";
		else if (message.kind === "tool" || message.kind === "work") next = "working";
		const current = presence.get(message.fromSlug);
		// 一句「好」不该把「在做」熄灭：只有更强的状态才覆盖，idle 只在没有状态时写。
		if (next === "idle" && current !== undefined) continue;
		presence.set(message.fromSlug, { state: next, at: message.at });
	}
	patch({ presence, lastSeen });
}

/* ── 界面开关（都落 localStorage） ──────────────────────────────────── */

export function setLayout(layout: Layout): void {
	localStorage.setItem(LAYOUT_KEY, layout);
	patch({ layout });
}

export function setTheme(theme: Theme): void {
	localStorage.setItem(THEME_KEY, theme);
	patch({ theme });
}

export function setSide(side: Side): void {
	localStorage.setItem(SIDE_KEY, side);
	patch({ side });
}

export function setRight(right: Partial<State["right"]>): void {
	patch({ right: { ...state.right, ...right } });
}

export function setConn(ok: boolean): void {
	patch({ conn: ok ? { ok: true, lastOkAt: Date.now() } : { ...state.conn, ok: false } });
}

/** 引用哪一条。`null` 是不引用。 */
export function setReply(reply: State["reply"]): void {
	patch({ reply });
}

/** 三个浮层互斥：打开一个就关掉另一个 —— 同时开着两个，Esc 该关谁变成靠猜。 */
export function setSettings(open: boolean): void {
	patch({ settings: open, ...(open ? { needMenu: false } : {}) });
}

export function setTeam(open: boolean): void {
	patch({ team: open });
}

export function setNeedMenu(open: boolean): void {
	patch({ needMenu: open, ...(open ? { settings: false } : {}) });
}

/** 只刷「找你」，不动频道列表 —— org 推送很密，整条侧栏跟着重排最费事。 */
export async function refreshAttention(): Promise<void> {
	const data = await getAttention();
	patch({ attention: data.items, attentionUnread: data.unread });
}

export function setAttention(items: AttentionItem[], unread: number): void {
	patch({ attention: items, attentionUnread: unread });
}

/* ── 右侧栏：详情可以往里钻（频道 → 人 → 再点频道里的人） ────────────── */

/** 栈底永远是「当前频道」，所以「返回」总是能退出一个人物案。 */
export type RightEntry = { kind: "channel" } | { kind: "person"; slug: string };

export function pushRight(entry: RightEntry): void {
	patch({ trail: [...state.trail, entry] });
}

/** 进一个人的人物案。拉不到就抛（由调用方 toast），并把栈恢复原样。 */
/** 打开某个人的记忆抽屉。没有档案页的人（老大）也能看，所以不走 `openPerson`。 */
export function openMemory(slug: string, label: string): void {
	patch({ memoryPerson: { slug, label } });
}

export function closeMemory(): void {
	patch({ memoryPerson: null });
}

export async function openPerson(slug: string): Promise<void> {
	try {
		const profile = await getPerson(slug);
		patch({ person: profile, trail: [...state.trail, { kind: "person", slug }], right: { open: true, tab: "detail" } });
	} catch (error) {
		throw error;
	}
}

/** 退一层。栈底是频道，再退就只剩频道本身（仍然显示，不打空）。 */
export function backRight(): void {
	if (state.trail.length <= 1) return;
	const trail = state.trail.slice(0, -1);
	const last = trail[trail.length - 1];
	if (last === undefined || last.kind === "channel") {
		patch({ trail, person: null });
		return;
	}
	void getPerson(last.slug)
		.then((profile) => patch({ trail, person: profile }))
		.catch(() => patch({ trail, person: null }));
}

/** 切频道：右侧栏回到「这个频道」。 */
export function resetRight(): void {
	patch({ trail: [{ kind: "channel" }], person: null });
}
