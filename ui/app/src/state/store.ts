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
	createGroup as createGroupApi,
	getAttention,
	getChannel,
	getChannels,
	getEarlier,
	getOrg,
	getPerson,
	getPersonTurns,
	getTurn,
	markRead as markReadApi,
	openDirectMessage,
	sendMessage,
} from "../api/client.ts";
import type { Actor, AttentionItem, Channel, ChannelDetail, Message, Org, PersonProfile, Turn } from "../api/types.ts";
import { assistantSlug, sortChannels } from "../lib/format.ts";
import { mark } from "../lib/jank.ts";

export type Presence = "idle" | "working" | "thinking" | "asleep";
export type Theme = "system" | "light" | "dark";
export type Side = "open" | "rail";

export type State = {
	/** 首屏数据都到齐了才画主界面 —— 半渲染的界面比什么都不画更像坏了。 */
	ready: boolean;
	workspaceName: string;
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
	 * 每个成员最近跑过的轮次，**按人分桶**（`slug → Turn[]`，按发生时间排）。
	 *
	 * 群聊与私聊同一张表：聊天流里的 `live` 行与「后台任务」面板都读它。
	 * 折叠版只有摘要（`stepCount` / `summary`）；展开时 `loadTurn` 再拉步骤。
	 */
	runs: Map<string, Turn[]>;
	/** SSE 通不通。`lastOkAt` 用来在断线时显示「最后一次成功」。 */
	conn: { ok: boolean; lastOkAt: number };
	theme: Theme;
	side: Side;
	right: { open: boolean };
	needMenu: boolean;
	pluginSheet: boolean;
	settings: boolean;
	team: boolean;
	/** 拉群卡片：填名字、勾人。 */
	newGroup: boolean;
	/** 正在引用的那条消息（seq + 摘要），发出去就清空。 */
	reply: { seq: number; label: string; excerpt: string } | null;
	/** 「后台任务」面板：开着没有、看的是谁（`null` = 还没选人）。 */
	tasks: { open: boolean; who: string | null };
	/** 右侧栏的返回栈：栈底永远是当前频道。 */
	trail: RightEntry[];
	/** 右侧栏正在看的那个人（`null` = 看频道本身）。 */
	person: PersonProfile | null;
};

const THEME_KEY = "solo.theme";
const SIDE_KEY = "solo.side";

function read<K extends string>(key: string, allowed: readonly K[], fallback: K): K {
	// 没有 localStorage 的环境（node 里跑单测、未来的 SSR）读不到就按缺省来：这里只是偏好，不是状态。
	if (typeof localStorage === "undefined") return fallback;
	const value = localStorage.getItem(key);
	return allowed.includes(value as K) ? (value as K) : fallback;
}

const initial: State = {
	ready: false,
	workspaceName: "Solo",
	people: [],
	channels: [],
	currentId: null,
	detail: null,
	hasMore: false,
	loadingEarlier: false,
	attention: [],
	attentionUnread: 0,
	presence: new Map(),
	runs: new Map(),
	conn: { ok: true, lastOkAt: Date.now() },
	theme: read(THEME_KEY, ["system", "light", "dark"], "system"),
	side: read(SIDE_KEY, ["open", "rail"], "open"),
	right: { open: false },
	needMenu: false,
	pluginSheet: false,
	settings: false,
	team: false,
	newGroup: false,
	reply: null,
	tasks: { open: false, who: null },
	trail: [{ kind: "channel" }],
	person: null,
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
	try {
		const [channels, attention] = await Promise.all([getChannels(), getAttention()]);
		patch({
			channels: sortChannels(channels.channels, assistantSlug(state.people)),
			attention: attention.items,
			attentionUnread: attention.unread,
		});
		setConn(true);
		// 列表里的未读数变了，顶部标题（当前频道）也要跟着变 —— 用 detail 的 channel 覆盖一次。
		if (state.currentId !== null) {
			const mine = channels.channels.find((channel) => channel.id === state.currentId);
			// 频道没了 = 解散了团队、或私聊被归档：别再把它留在中栏，退回落地页。
			if (mine === undefined) {
				void openChannel(null);
			} else if (state.detail !== null) {
				// 标题 / 成员数变了（改名、加人）：整屏重拉，不然顶栏和成员框停在旧样子。
				if (state.detail.channel.title !== mine.title || state.detail.channel.memberCount !== mine.memberCount) {
					void reloadDetail(mine.id);
				}
				patch({ detail: { ...state.detail, channel: strip(mine) } });
			}
		}
	} catch {
		// 侧栏刷新失败就是「连不上」：SSE 断线时也在同一条路上标，界面只画一个状态。
		setConn(false);
	}
}

function strip(channel: Channel): ChannelDetail["channel"] {
	const { unread: _unread, mentions: _mentions, preview: _preview, ...rest } = channel;
	return rest;
}

/**
 * 收下一份组织快照：人、组织名、以及「谁此刻在跑」。
 *
 * `activity` 只在**有会话在跑**时出现 —— 没有这个键就是待命，界面不自己编状态。
 * 界面现在只拿它画头像的忙态；输入卡上方不再有活动条（ADR-008）。
 */
export function applyOrg(org: Org): void {
	const presence = new Map<string, { state: Presence; at: number }>();
	for (const actor of org.people) {
		const found = actor.activity;
		if (found === undefined) continue;
		presence.set(actor.slug, { state: found.state, at: found.since });
	}
	patch({ workspaceName: org.workspace.name, people: org.people, presence });
}

export async function bootstrap(): Promise<void> {
	const org = await getOrg();
	applyOrg(org);
	await refreshLists();
	// 进来不替人选频道：中栏先站着落地页，选不选、进哪个由我定。
	patch({ ready: true });
}

/* ── 频道 ───────────────────────────────────────────────────────────── */

/**
 * 点侧栏第一格（助理）：先开（或复用）和这个人的私聊，再打开它。
 *
 * 每个成员都有私聊（装配 / 招人时自动建）。这里仍然调一次 `openDirectMessage`：
 * 它是幂等的，用来兜住「侧栏还是旧的」这类中间态。
 */
export async function openWithPerson(slug: string): Promise<void> {
	const { id } = await openDirectMessage(slug);
	await refreshLists();
	await openChannel(id);
}

/** 我拉一个群：建完刷新侧栏并进去。成员是 slug；我自己由服务端加。 */
export async function makeGroup(title: string, members: readonly string[]): Promise<void> {
	const { id } = await createGroupApi(title, members);
	setNewGroup(false);
	await refreshLists();
	await openChannel(id);
}

/** 重拉当前频道的详情。只有频道投影变了才走；期间切走了就不覆盖。 */
async function reloadDetail(id: string): Promise<void> {
	try {
		const detail = await getChannel(id);
		if (getState().currentId !== id) return;
		patch({ detail, hasMore: detail.hasMore });
	} catch {
		// 拉不到就等下一次组织推送再试，别把当前屏清空。
	}
}

export async function openChannel(id: string | null): Promise<void> {
	// `null` = 回到「没选频道」。手机上是返回列表，桌面上是清空中栏。
	if (id === null) {
		patch({ currentId: null, detail: null, hasMore: false, reply: null, runs: new Map(), tasks: { open: false, who: null } });
		return;
	}
	// 切频道先清 detail：否则新频道的消息会先画到旧频道那屏上（半秒的错位）。
	// 人物案不属于任何一个频道：换频道就退回栈底，否则右栏会停在上一个人的档案上。
	patch({
		currentId: id,
		detail: null,
		hasMore: false,
		reply: null,
		needMenu: false,
		runs: new Map(),
		tasks: { open: false, who: null },
		person: null,
		trail: [{ kind: "channel" }],
	});
	const done = mark("channel:open");
	const detail = await getChannel(id);
	done();
	// 期间又切走了就别覆盖。
	if (getState().currentId !== id) return;
	patch({ detail, hasMore: detail.hasMore });
	if (detail.channel.kind === "dm") {
		// 私聊页看的是对面那个人：把他在所有频道里的轮次拉回来（也是 `live` 行要用的）。
		const partner = detail.members.find((member) => member.slug !== "owner");
		if (partner !== undefined) void loadPersonRuns(partner.slug);
	}
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
 * 「后一批赢」很关键：同一个 seq 两次到达时必须取新的那份（补历史与 SSE 会重叠）。
 * 按到达顺序 push 会出现重复行和乱序 —— 那正是我报过「刷新后少了几句」的样子。
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
	done();
}

/**
 * 发一条消息。`replyToSeq` 给我一个「显式引用」的入口：回答选项时正文是选项文字，
 * 引用必须指向那条选择消息（输入框里手点的引用走 `state.reply`，两者不会同时出现）。
 */
export async function send(text: string, attachmentIds: readonly string[] = [], replyToSeq?: number): Promise<void> {
	const { currentId, reply } = state;
	if (currentId === null) return;
	const trimmed = text.trim();
	if (trimmed === "" && attachmentIds.length === 0) return;
	const quoted = replyToSeq ?? reply?.seq;
	patch({ reply: null });
	const done = mark("send");
	try {
		await sendMessage(currentId, {
			text: trimmed,
			...(quoted === undefined ? {} : { replyTo: quoted }),
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
		// 已读失败不该打扰我：下一次进这个频道还会再试一次。
	}
	// 已读位置变了就把列表拉一次：徽标上的未读数跟着清掉（不刷新的话它要等下一次
	// 组织推送才消失 —— 实测「点开频道，红点还在」）。
	void refreshLists();
}

/* ── 轨迹（从会话条目派生，不落库：ADR-001） ────────────────────────── */

/**
 * 一帧轨迹并进「按人」的表：同一轮（`channelId + seq`）覆盖，其余原样。
 *
 * 跨频道的 `seq` 会重复（每个频道自己数），所以键里必须带 `channelId`。
 *
 * 折叠帧不带 `steps`：已经有步骤的那一轮不能被一次轮询打回「还没读」。
 * 步骤只会越来越多，所以新帧没有就留着旧的那份。
 */
export function upsertRun(runs: Map<string, Turn[]>, turn: Turn): Map<string, Turn[]> {
	const next = new Map(runs);
	const old = (next.get(turn.slug) ?? []).find(
		(item) => item.channelId === turn.channelId && item.seq === turn.seq,
	);
	const merged: Turn =
		old !== undefined && old.steps !== undefined && turn.steps === undefined
			? old.truncated === true
				? { ...turn, steps: old.steps, truncated: true }
				: { ...turn, steps: old.steps }
			: turn;
	const list = (next.get(turn.slug) ?? []).filter(
		(item) => item.channelId !== turn.channelId || item.seq !== turn.seq,
	);
	list.push(merged);
	list.sort((left, right) => left.startedAt - right.startedAt);
	next.set(turn.slug, list);
	return next;
}

/**
 * SSE 推来一帧轨迹（`trace` 事件）：群聊与私聊走同一条路。
 *
 * 不按「当前频道」过滤：这张表是按人分的，后台任务那屏能看到别的频道里跑过的轮次 ——
 * 表格自己用 `channelId + seq` 去重，不会混到别的频道那一行上。
 */
export function applyTurn(turn: Turn): void {
	patch({ runs: upsertRun(state.runs, turn) });
}

/**
 * 拉一个人的轮次（任务面板 / 私聊页）。
 *
 * `limit` 只影响这一次请求；已经在这张表里的更早轮次不会被丢掉。
 */
export async function loadPersonRuns(slug: string, limit = 30): Promise<void> {
	let result: { turns: Turn[] };
	try {
		result = await getPersonTurns(slug, limit);
	} catch {
		return;
	}
	let runs = getState().runs;
	for (const turn of result.turns) runs = upsertRun(runs, turn);
	patch({ runs });
}

/**
 * 展开一轮：把步骤拉回来（折叠版没有）。
 *
 * 找不到（没被叫醒 / 条目已被压缩）就把步骤记成空数组 —— 「确实没有过程」比一直转圈诚实。
 */
export async function loadTurn(turn: Turn): Promise<void> {
	if (turn.steps !== undefined) return;
	try {
		// 工作记录里的轮次可能发生在别的频道：按它自己的 `channelId` 拉步骤。
		const result = await getTurn(turn.channelId, turn.seq, turn.slug);
		const full = result.turn;
		if (full !== null) {
			applyTurn(full);
			return;
		}
	} catch {
		// 拉失败就当作没有过程，下次展开还会再试一次。
	}
	applyTurn({ ...turn, steps: [] });
}

/* ── 界面开关（都落 localStorage） ──────────────────────────────────── */

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

/** 浮层互斥：打开一个就关掉其它 —— 同时开着两个，Esc 该关谁变成靠猜。 */
export function setSettings(open: boolean): void {
	patch({ settings: open, ...(open ? { needMenu: false, pluginSheet: false, team: false, newGroup: false } : {}) });
}

export function setTeam(open: boolean): void {
	patch({ team: open, ...(open ? { pluginSheet: false, settings: false, newGroup: false } : {}) });
}

/** 插件浮层（左栏「团队管理」下面那一格）。 */
export function setPluginSheet(open: boolean): void {
	patch({ pluginSheet: open, ...(open ? { team: false, settings: false, needMenu: false, newGroup: false } : {}) });
}

/** 拉群卡片。 */
export function setNewGroup(open: boolean): void {
	patch({ newGroup: open, ...(open ? { needMenu: false, pluginSheet: false, settings: false, team: false } : {}) });
}

export function setNeedMenu(open: boolean): void {
	patch({ needMenu: open, ...(open ? { settings: false, newGroup: false } : {}) });
}

/**
 * 「后台任务」面板：打开时默认看这个频道里正在跑的那个人 → 私聊对象 → 最近跑过的那个。
 *
 * 传 `slug` 就是点名看谁（点 `live` 行、点人像条都走这里）。
 */
export function openTasks(slug?: string): void {
	const state = getState();
	const who =
		slug ??
		state.tasks.who ??
		runningSlugs(state).find((item) => inChannel(state, item)) ??
		dmPartner(state) ??
		[...state.runs.keys()][0] ??
		// 还没人跑过、也不在私聊里：挑第一个人，让这一屏一打开就有一列东西可看。
		state.people.find((actor) => actor.slug !== "owner")?.slug ??
		null;
	patch({ tasks: { open: true, who }, needMenu: false });
	if (who !== null) void loadPersonRuns(who);
}

export function setTasksWho(slug: string): void {
	patch({ tasks: { open: true, who: slug } });
	void loadPersonRuns(slug);
}

export function closeTasks(): void {
	patch({ tasks: { open: false, who: getState().tasks.who } });
}

/** 正在跑的人（`presence` 是派生状态，这里只做排序用）。 */
export function runningSlugs(state: State): string[] {
	return [...state.presence.entries()]
		.filter(([, value]) => value.state === "working" || value.state === "thinking")
		.sort((left, right) => left[1].at - right[1].at)
		.map(([slug]) => slug);
}

function inChannel(state: State, slug: string): boolean {
	return state.currentId !== null && (state.runs.get(slug) ?? []).some((turn) => turn.channelId === state.currentId);
}

function dmPartner(state: State): string | undefined {
	if (state.detail?.channel.kind !== "dm") return undefined;
	return state.detail.members.find((member) => member.slug !== "owner")?.slug;
}

/* ── 右侧栏：详情可以往里钻（频道 → 人 → 再点频道里的人） ────────────── */

/** 栈底永远是「当前频道」，所以「返回」总是能退出一个人物案。 */
export type RightEntry = { kind: "channel" } | { kind: "person"; slug: string };

/** 进一个人的人物案。拉不到就抛（由调用方 toast），并把栈恢复原样。 */
export async function openPerson(slug: string): Promise<void> {
	try {
		const profile = await getPerson(slug);
		patch({ person: profile, trail: [...state.trail, { kind: "person", slug }], right: { open: true } });
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
