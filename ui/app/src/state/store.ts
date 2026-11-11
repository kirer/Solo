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
	getModels,
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
export type State = {
	/** 首屏数据都到齐了才画主界面 —— 半渲染的界面比什么都不画更像坏了。 */
	ready: boolean;
	workspaceName: string;
	people: Actor[];
	channels: Channel[];
	currentId: string | null;
	detail: ChannelDetail | null;
	/** 上翻是否还有更早的。 */
	hasMoreAbove: boolean;
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
	right: { open: boolean };
	needMenu: boolean;
	pluginSheet: boolean;
	settings: boolean;
	/** 拉群卡片：填名字、勾人。 */
	newGroup: boolean;
	/** 一键重置的确认浮层：设置 → 数据里点开。 */
	resetOpen: boolean;
	/** 装完带前端的插件后问「要不要重启」：值是插件显示名，`null` 是不问。 */
	restartOpen: string | null;
	/** 正在引用的那条消息（seq + 摘要），发出去就清空。 */
	reply: { seq: number; label: string; excerpt: string } | null;
	/** 「后台任务」面板：开着没有、看的是谁（`null` = 还没选人）。 */
	tasks: { open: boolean; who: string | null };
	/** 插件占的一整屏（插件 slug；`null` = 没有）。和任务屏互斥，也是 `app.page` 插槽的开关。 */
	pluginView: string | null;
	/** 右侧工作台开着看哪个插件（`null` = 没有）。`dock` 插槽的开关，占右栏那一层。 */
	dock: string | null;
	/** 右栏里翻到的插件页（`app.page` 那一格；`null` = 没有）。右栏这一叠纸的上一层，不是弹窗。 */
	rightPage: string | null;
	/** 右栏里推入的文件预览（正文里点的那个相对路径；`null` = 没有）。与插件页同一层。 */
	rightFile: string | null;
	/**
	 * 从正文里「转成附件」的那个文件（右栏预览层点的那颗按钮）。
	 *
	 * 只作一次性交接：输入卡看见它就把它塞进附件队列，然后 `takeStaged()` 清空。
	 * 为什么不直接改 Composer 的 state：那个 state 在输入卡里，右栏碰不到它。
	 */
	staged: { readonly path: string; readonly id: string; readonly name: string; readonly kind: "image" | "file"; readonly bytes: number } | null;
	/** 右栏拖出来的宽度（px，资料 / 任务 / 工作台共用）；`null` = 没拖过，348。 */
	dockWidth: number | null;
	/**
	 * 进这一屏时的未读起点（`seq` 比它大的算新的）。
	 *
	 * 在**切频道那一刻**定住，之后不再动：否则消息流里那条「以下是新的」会随着
	 * 新消息往下跑，永远读不完。`null` = 进来时没有未读，不画那条线。
	 */
	unreadBefore: number | null;
	/** 内置浏览器开着看哪个地址（`null` = 关着）。正文里点外链就开在这里。 */
	browser: string | null;
	/** 右侧栏的返回栈：栈底永远是当前频道。 */
	trail: RightEntry[];
	/**
	 * 这一屏是推入还是退回。只管换屏动画的方向（`App` 写成 `data-nav`，CSS 据此选
	 * `slide-in-right` / `slide-in-left`）；不参与任何数据判断。
	 */
	nav: "fwd" | "back";
	/** 右侧栏正在看的那个人（`null` = 看频道本身）。 */
	person: PersonProfile | null;
	/**
	 * 第一次打开的引导：`null` = 不引导。这台机器一只模型都没有时停在 `welcome`，
	 * 「开始」进 `model`（稿子 10 / 11）；接上模型之后回到聊天，不再出现。
	 */
	setupStep: "welcome" | "model" | null;
};

const THEME_KEY = "solo.theme";
const DOCK_WIDTH_KEY = "solo.dockWidth";

function read<K extends string>(key: string, allowed: readonly K[], fallback: K): K {
	// 没有 localStorage 的环境（node 里跑单测、未来的 SSR）读不到就按缺省来：这里只是偏好，不是状态。
	if (typeof localStorage === "undefined") return fallback;
	const value = localStorage.getItem(key);
	return allowed.includes(value as K) ? (value as K) : fallback;
}

/** 拖过的宽度：读得到、是正数才算数（旧值坏了就回到默认宽度，不报错）。 */
/** 右栏最窄 320、最宽给正文留 420 —— 和 `PanelGrip` 拖拽时的夹取区间同一个数。 */
export const DOCK_MIN = 320;
export const DOCK_KEEP_MAIN = 420;

/**
 * 把右栏宽度夹进当前窗口可用的区间。
 *
 * 拖拽时 `PanelGrip` 已经夹过一次，但落盘的数是**在别的窗口尺寸下**算出来的：
 * 从 1920 拔到 1280 再读，442 就未必还有位置。所以读的时候按当前窗口再夹一次，
 * 不然右栏会宽过屏幕、把正文挤没（宽度为 0 的分区就是这条路的极端）。
 */
export function clampDockWidth(width: number, innerWidth: number): number {
	const most = Math.max(DOCK_MIN, innerWidth - DOCK_KEEP_MAIN);
	return Math.min(most, Math.max(DOCK_MIN, width));
}

function readDockWidth(): number | null {
	if (typeof localStorage === "undefined") return null;
	const value = Number(localStorage.getItem(DOCK_WIDTH_KEY));
	if (!Number.isFinite(value) || value <= 0) return null;
	// 窗口尺寸在 `localStorage` 里没有记录，只能在读的时候按当前窗口夹：
	// 没有 `window`（测试 / SSR）就先按拖拽区间兜住下限。
	const view = typeof window === "undefined" ? DOCK_MIN + DOCK_KEEP_MAIN + DOCK_MIN : window.innerWidth;
	return clampDockWidth(value, view);
}

const initial: State = {
	ready: false,
	workspaceName: "Solo",
	people: [],
	channels: [],
	currentId: null,
	detail: null,
	hasMoreAbove: false,
	loadingEarlier: false,
	attention: [],
	attentionUnread: 0,
	presence: new Map(),
	runs: new Map(),
	conn: { ok: true, lastOkAt: Date.now() },
	theme: read(THEME_KEY, ["system", "light", "dark"], "system"),
	right: { open: false },
	needMenu: false,
	pluginSheet: false,
	settings: false,
	newGroup: false,
	resetOpen: false,
	restartOpen: null,
	reply: null,
	tasks: { open: false, who: null },
	pluginView: null,
	dock: null,
	rightPage: null,
	rightFile: null,
	staged: null,
	dockWidth: readDockWidth(),
	unreadBefore: null,
	browser: null,
	trail: [{ kind: "channel" }],
	nav: "fwd",
	person: null,
	setupStep: null,
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
				patch({ detail: { ...state.detail, channel: withSettings(strip(mine), state.detail.channel) } });
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
 * 列表项覆盖详情时，把只存在于详情里的两样带回来。
 *
 * `/api/channels` 的列表项不带共享指令与接话规则（它们只在详情里，也不该跟着侧栏
 * 每条都传一遍）。少了这一步，每次组织推送都会把右栏打回「未写 / 默认」—— 接口
 * 里明明有值，界面显示没有。
 */
export function withSettings(next: ChannelDetail["channel"], prev: ChannelDetail["channel"]): ChannelDetail["channel"] {
	if (next.id !== prev.id) return next;
	return {
		...next,
		...(prev.bulletin === undefined ? {} : { bulletin: prev.bulletin }),
		...(prev.responder === undefined ? {} : { responder: prev.responder }),
	};
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

/** 引导的两步进出（稿子 10 / 11）。接上模型之后由 `bootstrap` 清掉。 */
export function setSetupStep(step: "welcome" | "model" | null): void {
	patch({ setupStep: step });
}

export async function bootstrap(): Promise<void> {
	const org = await getOrg();
	applyOrg(org);
	// 一台还没接过模型的机器：先引导（稿子 10 / 11）。直接放进来只会得到一个
	// 「发得出话、但没有一只模型在跑」的界面。列不出来不代表没配，别把人拦在引导里。
	let configured = true;
	try {
		configured = (await getModels()).models.length > 0;
	} catch {
		configured = true;
	}
	if (!configured) {
		patch({ ready: true, setupStep: "welcome" });
		return;
	}
	await refreshLists();
	patch({ setupStep: null });
	// 首屏是和助理的那个对话（稿子 01）：这一屏本来就能直接说话，
	// 列表是它的第二屏。没有助理（组织还没建起来）就先停在列表。
	const assistant = org.people.find((person) => person.assistant === true);
	const dm = state.channels.find(
		(channel) => channel.kind === "dm" && assistant !== undefined && channel.title === assistant.label,
	);
	patch({ ready: true });
	if (dm !== undefined) await openChannel(dm.id);
	else if (assistant !== undefined) await openWithPerson(assistant.slug);
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

/** 频道设置改完之后重拉详情（SSE 也会推，但界面自己发起的改动别等它）。 */
export async function refreshDetail(): Promise<void> {
	const id = getState().currentId;
	if (id !== null) await reloadDetail(id);
}

/** 重拉当前频道的详情。只有频道投影变了才走；期间切走了就不覆盖。 */
async function reloadDetail(id: string): Promise<void> {
	try {
		const detail = await getChannel(id);
		if (getState().currentId !== id) return;
		patch({ detail, hasMoreAbove: detail.hasMoreAbove });
	} catch {
		// 拉不到就等下一次组织推送再试，别把当前屏清空。
	}
}

/**
 * 详情回来之后，把未读横幅的落点定成**真起点**。
 *
 * - 进来时列表说没未读（`null`）→ 还是 `null`，不画线，行为一点不变；
 * - 没说没未读 → 服务端的 `readMark`（我看过的最后一条）就是线。
 *   它比这一页最早那条还早（整页都是新的），也用不着 -1 那种糊法：`buildRows`
 *   拿「第一个 seq 大于它」的位置插，一样插在页首，条数按**真未读**算。
 */
export function unreadBeforeOf(placeholder: number | null, detail: ChannelDetail): number | null {
	if (placeholder === null) return null;
	return detail.readMark;
}

export async function openChannel(id: string | null): Promise<void> {
	// `null` = 回到「没选频道」。手机上是返回列表，桌面上是清空中栏。
	if (id === null) {
		patch({ currentId: null, unreadBefore: null, detail: null, hasMoreAbove: false, reply: null, runs: new Map(), tasks: { open: false, who: null }, pluginView: null, rightPage: null, rightFile: null, nav: "back" });
		return;
	}
	// 未读起点在这一刻定住（`null` = 列表里没未读；具体 seq 等详情回来再定）。
	// **不能在这儿反推**：下一句就把 `detail` 清成 `null` 了，拿「当前屏最后一条」当起点
	// 永远是 undefined，只能退化成 -1 —— 横幅于是插在首屏最顶上，条数按整屏虚报。
	// 真正的起点只有服务端知道（它手里有我的已读水位），所以详情一回来就补上，见 `unreadBeforeOf`。
	const listed = getState().channels.find((channel) => channel.id === id);
	const unreadBefore = (listed?.unread ?? 0) > 0 && getState().currentId !== id ? -1 : null;

	// 切频道先清 detail：否则新频道的消息会先画到旧频道那屏上（半秒的错位）。
	// 人物案不属于任何一个频道：换频道就退回栈底，否则右栏会停在上一个人的档案上。
	patch({
		currentId: id,
		detail: null,
		hasMoreAbove: false,
		unreadBefore,
		reply: null,
		needMenu: false,
		runs: new Map(),
		tasks: { open: false, who: null },
		pluginView: null,
		rightPage: null,
		rightFile: null,
		person: null,
		trail: [{ kind: "channel" }],
		nav: "fwd",
		// 手机上资料是一整屏：切频道时它若还开着，会直接挡住刚点开的这个对话。
		...(typeof window !== "undefined" && window.matchMedia("(max-width: 900px)").matches
			? { right: { open: false } }
			: {}),
	});
	const done = mark("channel:open");
	const detail = await getChannel(id);
	done();
	// 期间又切走了就别覆盖。
	if (getState().currentId !== id) return;
	patch({ detail, hasMoreAbove: detail.hasMoreAbove, unreadBefore: unreadBeforeOf(unreadBefore, detail) });
	// 右栏不跟着频道自动开：切一个频道就弹一层资料会把对话挤走（手机上直接挡住整屏）。
	// 开不开只由顶栏那颗「资料」和插件入口决定。
	// 助理那屏没有那颗「资料」（顶栏是设置），右栏开着就再也关不掉 —— 进这一屏时收起来。
	const assistant = getState().people.find((person) => person.assistant === true);
	if (detail.channel.kind === "dm" && assistant !== undefined && detail.channel.title === assistant.label) {
		patch({ right: { open: false } });
	}
	if (detail.channel.kind === "dm") {
		// 私聊页看的是对面那个人：把他在所有频道里的轮次拉回来（也是 `live` 行要用的）。
		const partner = detail.members.find((member) => member.slug !== "owner");
		if (partner !== undefined) void loadPersonRuns(partner.slug);
	}
	void readToEnd(id, detail.messages);
}

export async function loadEarlier(): Promise<void> {
	const { currentId, detail, hasMoreAbove, loadingEarlier } = state;
	if (currentId === null || detail === null || !hasMoreAbove || loadingEarlier) return;
	const earliest = detail.messages[0]?.seq ?? 1;
	if (earliest <= 1) {
		patch({ hasMoreAbove: false });
		return;
	}
	patch({ loadingEarlier: true });
	const done = mark("channel:earlier");
	try {
		const page = await getEarlier(currentId, earliest);
		const merged = mergeMessages(page.messages, getState().detail?.messages ?? []);
		patch({
			detail: getState().detail === null ? null : { ...getState().detail!, messages: merged },
			// 服务端说没更早的了；本地裁剪被裁空了也当没有（不然会一直转圈）。
			hasMoreAbove: page.hasMoreAbove && merged.length > 0,
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

export function setRight(right: Partial<State["right"]>): void {
	patch({
		right: { ...state.right, ...right },
		...(right.open === true ? { nav: "fwd" as const } : right.open === false ? { nav: "back" as const } : {}),
	});
}

export function setConn(ok: boolean): void {
	patch({ conn: ok ? { ok: true, lastOkAt: Date.now() } : { ...state.conn, ok: false } });
}

/** 引用哪一条。`null` 是不引用。 */
export function setReply(reply: State["reply"]): void {
	patch({ reply });
}

/** 整屏互斥：打开一个就关掉其它 —— 两屏叠着画会互相压住，Esc 该关谁也只能靠猜。 */
export function setSettings(open: boolean): void {
	patch({
		settings: open,
		nav: open ? "fwd" : "back",
		// 离开设置（或重新进入）都先把重置确认收掉：它只在设置页里成立。
		resetOpen: false,
		restartOpen: null,
		...(open
			? {
					needMenu: false,
					pluginSheet: false,
					newGroup: false,
					pluginView: null,
					tasks: { open: false, who: getState().tasks.who },
				}
			: {}),
	});
}


/** 插件页（左栏那一格，整屏不是浮层）。 */
export function setPluginSheet(open: boolean): void {
	patch({
		pluginSheet: open,
		nav: open ? "fwd" : "back",
		...(open
			? {
					restartOpen: null,
					// 插件清单开在设置弹窗里：返回就是回到设置的清单。
					settings: true,
					needMenu: false,
					newGroup: false,
					pluginView: null,
					tasks: { open: false, who: getState().tasks.who },
				}
			: {}),
	});
}

/** 一键重置的确认浮层。和别的浮层互斥；确认之后应用会自己退出重开。 */
export function setResetOpen(open: boolean): void {
	patch({
		resetOpen: open,
		...(open ? { needMenu: false, pluginSheet: false, newGroup: false, restartOpen: null } : {}),
	});
}

/** 装完带前端的插件后的重启询问。和别的浮层互斥；`null` 是关掉。 */
export function setRestartOpen(plugin: string | null): void {
	patch({
		restartOpen: plugin,
		// 不关插件页：这个浮层就是从那一屏弹出来的，关了会落回聊天。
		...(plugin === null ? {} : { needMenu: false, newGroup: false, resetOpen: false }),
	});
}

/** 拉群卡片。 */
export function setNewGroup(open: boolean): void {
	patch({
		newGroup: open,
		...(open ? { needMenu: false, pluginSheet: false, settings: false, restartOpen: null } : {}),
	});
}

export function setNeedMenu(open: boolean): void {
	patch({ needMenu: open, ...(open ? { settings: false, newGroup: false, restartOpen: null } : {}) });
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
	// 后台任务是右栏的一态（桌面）或那一层整屏浮层（手机）：右栏必须打开，
	// 其余整屏让路（§13.3）。
	patch({
		nav: "fwd",
		tasks: { open: true, who },
		right: { open: true },
		needMenu: false,
		restartOpen: null,
		pluginView: null,
		pluginSheet: false,
		settings: false,
	});
	if (who !== null) void loadPersonRuns(who);
}

export function setTasksWho(slug: string): void {
	patch({ tasks: { open: true, who: slug } });
	void loadPersonRuns(slug);
}

export function closeTasks(): void {
	// 「聊天」那格也走这里：它同时是「离开任何第二屏，回到聊天」。
	// 手机：任务就是整屏那层浮层，退出它等于收起右栏；桌面：回到资料表，右栏不动。
	const mobile =
		typeof window !== "undefined" && window.matchMedia("(max-width: 640px)").matches;
	patch({
		nav: "back",
		tasks: { open: false, who: getState().tasks.who },
		pluginView: null,
		settings: false,
		pluginSheet: false,
		...(mobile ? { right: { open: false } } : {}),
	});
}

/** 打开一个插件页（`app.page` 插槽里 slug 对得上的那一格）。 */
export function openPluginView(slug: string): void {
	patch({
		nav: "fwd",
		pluginView: slug,
		dock: null,
		rightPage: null,
		rightFile: null,
		tasks: { open: false, who: getState().tasks.who },
		restartOpen: null,
		pluginSheet: false,
		// 插件页开在设置弹窗里（同一个容器）：返回落回设置的清单。
		settings: true,
		needMenu: false,
		right: { open: false },
	});
}

/** 回到聊天。Esc 与插件页自己的返回键都走这里。 */
export function closePluginView(): void {
	patch({ pluginView: null, nav: "back" });
}

/** 打开右侧工作台：占右栏那一层（不是另开一列，也不占正文宽度）。 */
export function openDock(slug: string): void {
	patch({ nav: "fwd", dock: slug, rightPage: null, rightFile: null, tasks: { open: false, who: getState().tasks.who }, right: { open: true }, settings: false, pluginSheet: false, pluginView: null });
}

/** 收起工作台：回右栏的上一层（资料页），右栏本身不关。 */
export function closeDock(): void {
	patch({ dock: null, nav: "back" });
}

/** 在右栏里推入一个插件页（不弹窗）：占右栏那一层，返回退回资料页。 */
export function openRightPage(slug: string): void {
	patch({ nav: "fwd", rightPage: slug, dock: null, pluginView: null, rightFile: null, settings: false, pluginSheet: false, tasks: { open: false, who: getState().tasks.who }, right: { open: true } });
}

/** 收起右栏里的插件页：回资料页，右栏本身不关。 */
export function closeRightPage(): void {
	patch({ rightPage: null, nav: "back" });
}

/** 在右栏里推入一份文件预览（正文里点到的相对路径）：和插件页同一层，返回退回资料页。 */
export function openRightFile(path: string): void {
	patch({ nav: "fwd", rightFile: path, rightPage: null, dock: null, pluginView: null, settings: false, pluginSheet: false, tasks: { open: false, who: getState().tasks.who }, right: { open: true } });
}

/**
 * 右栏预览层里点「转成附件」：把这个待发附件交给输入卡。
 *
 * 交接完顺手收起预览层 —— 附件已经进了输入卡的队列，原地留着一层纸只会挡住要发的话。
 */
export function stageToComposer(file: { readonly path: string; readonly id: string; readonly name: string; readonly kind: "image" | "file"; readonly bytes: number }): void {
	patch({ staged: file, rightFile: null, nav: "back" });
}

/** 输入卡取走交接（取一次就清）：返回 `null` 表示没有待接的。 */
export function takeStaged(): State["staged"] {
	const pending = getState().staged;
	if (pending !== null) patch({ staged: null });
	return pending;
}

/** 收起右栏里的文件预览：回资料页，右栏本身不关。 */
export function closeRightFile(): void {
	patch({ rightFile: null, nav: "back" });
}

/** 拖右栏的左边线：宽度记进偏好，换页 / 下次打开还是这么宽。`null` 回到默认 348。 */
export function setDockWidth(width: number | null): void {
	patch({ dockWidth: width });
	if (typeof localStorage === "undefined") return;
	if (width === null) localStorage.removeItem(DOCK_WIDTH_KEY);
	else localStorage.setItem(DOCK_WIDTH_KEY, String(Math.round(width)));
}

/** 在 Solo 里开一个外链（正文里点链接、内置浏览器里改地址都走这里）。 */
export function openBrowser(url: string): void {
	patch({ browser: url });
}

export function closeBrowser(): void {
	patch({ browser: null });
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
		// 私聊里点的就是对面那个人：这一屏本来就是他的资料表，不再压一层 ——
		// 否则「返回」第一次看起来什么都没变，要按两次才回到聊天。
		const peer =
			state.detail !== null &&
			state.detail.channel.kind === "dm" &&
			state.detail.members.some((member) => member.slug === slug && member.slug !== "owner");
		if (peer) {
			patch({ nav: "fwd", right: { open: true } });
			return;
		}
		// 右栏本来关着（群里点头像）：人物案就是这一层的根，「返回」直接收起，
		// 不该先退到「群的资料页」再退一次。
		const trail: RightEntry[] =
			state.right.open === false ? [{ kind: "person", slug }] : [...state.trail, { kind: "person", slug }];
		patch({ nav: "fwd", person: profile, trail, right: { open: true } });
	} catch (error) {
		throw error;
	}
}

/**
 * 顶栏那颗「资料」：永远是这个频道自己的资料表。
 *
 * 刚才点过头像、钻进过某个人的人物案时，`person` 和 `trail` 还停在那儿 ——
 * 不重置的话，再点「资料」看到的还是那个人的档案，像开错了页。
 */
export function openChannelInfo(): void {
	patch({ nav: "fwd", person: null, trail: [{ kind: "channel" }], right: { open: true } });
}

/** 退一层。栈底是频道，再退就只剩频道本身（仍然显示，不打空）。 */
export function backRight(): void {
	if (state.trail.length <= 1) return;
	const trail = state.trail.slice(0, -1);
	const last = trail[trail.length - 1];
	if (last === undefined || last.kind === "channel") {
		patch({ nav: "back", trail, person: null });
		return;
	}
	void getPerson(last.slug)
		.then((profile) => patch({ nav: "back", trail, person: profile }))
		.catch(() => patch({ nav: "back", trail, person: null }));
}
