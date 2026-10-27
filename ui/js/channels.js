/**
 * 频道视图：左侧频道列表 + 中间消息流 + 右侧成员/任务。
 *
 * 设计见 `docs/design/COMMS-REFACTOR.md` §7。四件事：
 *
 * 1. **频道列表**：公司群 / 领导层 / 项目群 / 私聊 / 个人记录，带未读徽章
 * 2. **消息流**：气泡 + @ 已读点（灰=未读，绿=已读）+ 任务卡片
 * 3. **输入框**：@ 选择器、附件、发送
 * 4. **右侧**：成员列表（含各自未读）、本频道任务
 *
 * 数据全部来自 `/api/channels*`。SSE 的 org 事件只是「该刷新了」的信号，
 * 不做增量合并——频道消息量远小于会话流，全量拉最不容易出错。
 */
import { escapeAttr, escapeHtml, relTime, clockTime, copyText, formatCost, formatTokens } from "./format.js";
import { icon } from "./icons.js";
import { renderMarkdown } from "./markdown.js";
// UX-7：工作记录复用 T-22 提取的渲染函数，与组织页聊天视觉一致。
import { renderThinking, renderTool } from "./feed-render.js";
// #2：角色档案面板。与对话面板共用同一个渲染器（profile.js），只是换挂载点。
import { initProfile } from "./profile.js";
// 待办卡片：右侧对话面板删掉之后，老板拍板的唯一入口就在消息流里。
import { initPending } from "./pending.js";

const $ = (id) => document.getElementById(id);

/** 待办卡片渲染器（在 initChannels 里创建）。 */
let pendingCards = null;

const state = {
	channels: [],
	activeId: null,
	view: null,
	/**
	 * 服务端时钟减本地时钟的差值（毫秒）。
	 *
	 * 任务耗时一端是服务端写下的时间戳、另一端是「现在」。前端拿本地
	 * `Date.now()` 当「现在」，本机时钟偏快就会算出负数（界面显示
	 * 「-3 分钟」）。每次拉到频道视图就用它下发的 `serverNow` 重算一次。
	 */
	clockSkew: 0,
	/** @ 选择器里当前候选。 */
	mentionCandidates: [],
	mentionQuery: "",
	mentionStart: -1,
	/** @ 候选当前高亮项（上下键移动，回车/Tab 选中）。 */
	mentionActive: 0,
	/** 当前候选列表（与 DOM 顺序一致）。 */
	mentionItems: [],
	loading: false,
	lastFetchAt: 0,
	/** 请求令牌：只让「最后一次点击的那个频道」的响应落地。 */
	reqToken: 0,
	/** 发送锁：连按两次 Enter 不会发两条。 */
	sending: false,
	/** 翻页锁：连点「加载更早」不会重复请求同一页。 */
	loadingEarlier: false,
	/** 已经播报过的最大 seq（读屏只播新消息，不重播历史）。 */
	announcedSeq: 0,
	/** 播报基线所属的频道（切频道要重置，否则会把历史当成新消息念）。 */
	announcedChannel: null,
	/** 已展开全文的消息（按 seq）。轮询全量重渲染后要靠它恢复，否则一点就白点。 */
	expanded: new Set(),
	/** 成员栏是否展开（UX-6）。默认收起：老板要的是「点开才看」，不是「删掉」。
	 *  切频道**保留**用户当下的意图（负责人 #79 拍板），不重置。 */
	membersOpen: false,
	/** #1/#4：私聊的流水（thinking / tool）分页状态。`null` = 未加载过。
	 *  不再有 tab：流水直接混进消息流，默认折叠。 */
	activity: null,
	/** #1/#4：流水请求令牌（防止旧响应覆盖新频道）。 */
	activityToken: 0,
	/** #1/#4：懒加载锁。 */
	activityLoading: false,
	/** #2：上一次流水对应的 staffId（同一个人的 SSE 刷新不重拉流水）。 */
	activityChannel: null,
	/** #2：上一次流水对应的最后一条消息 seq（消息没变就不重建流水）。 */
	activityLastSeq: undefined,
	/** #4：当前档案面板对应的频道 id（换频道要收起面板）。 */
	profileChannel: null,
	/** #5：正在引用回复的消息（`{seq, label, text}`）；null = 没在引用。 */
	replyTo: null,
	/** #5：当前选中的消息 seq（浮窗里的操作对象）。 */
	actionSeq: null,
	/** #6：上一次渲染用的视图签名。相同就跳过整段 DOM 重建。 */
	viewSignature: "",
};
const el = {
	root: null,
	layout: null,
	list: null,
	title: null,
	sub: null,
	body: null,
	input: null,
	send: null,
	members: null,
	tasks: null,
	mention: null,
	announcer: null,
	/** 成员栏整栏（UX-6 / UX-8）。 */
	side: null,
	/** 成员栏开关按钮（UX-6）。 */
	sideToggle: null,
	/** #2：角色档案开关与面板（私聊里展开对方的档案）。 */
	fold: null,
	dock: null,
	/** #5：消息操作浮窗、引用预览条。 */
	actions: null,
	replyBar: null,
	replyText: null,
	replyCancel: null,
};

/**
 * 频道类型 → 分组标题（#3）。
 *
 * 老板的口径：左侧只留两个分组 —— **群组**（公司 / 领导层 / 项目）与**成员**（私聊）。
 * 五个 kind 塌成两组是「私聊取代工作记录」的必然结果：`log:` 频道已经不建了
 * （见 src/company/channels.ts 的 ensureAllChannels），剩下的四种 kind 天然分成
 * 「一群人」和「一个人」。
 *
 * 分组的视觉排序也在这里：群组在前、成员在后。
 */
const GROUPS = [
	{ key: "groups", label: "群组", kinds: ["company", "leadership", "project"] },
	{ key: "people", label: "成员", kinds: ["dm"] },
];

// ── 数据 ──────────────────────────────────────────────────────────────────

async function fetchJson(path, options) {
	const response = await fetch(path, { headers: { accept: "application/json" }, ...options });
	if (!response.ok) {
		// 服务端的错误体是中文可读的（"频道不存在"），丢掉它前端就只剩 "HTTP 404"。
		let detail = "";
		try {
			const body = await response.json();
			if (typeof body?.error === "string") detail = body.error;
		} catch {
			/* 非 JSON 错误体：退回状态码 */
		}
		throw new Error(detail === "" ? `HTTP ${response.status}` : detail);
	}
	const contentType = response.headers.get("content-type") ?? "";
	if (!contentType.includes("application/json")) throw new Error("接口未就绪");
	return response.json();
}

async function loadChannels() {
	try {
		const data = await fetchJson("/api/channels");
		state.channels = Array.isArray(data.channels) ? data.channels : [];
		state.lastFetchAt = Date.now();
		renderList(data.unread);
		// 没有选中频道时自动选第一个（有 @ 的优先）。
		// 手机上是两屏布局：先给列表，别把用户直接推进某个会话。
		const narrow = window.matchMedia("(max-width: 860px)").matches;
		if (state.activeId === null && state.channels.length > 0 && !narrow) {
			await openChannel(state.channels[0].id);
		} else if (state.activeId !== null) {
			// 保持当前选中；只更新列表徽章
			updateActiveRow();
		}
	} catch (error) {
		renderListError(error instanceof Error ? error.message : "未知错误");
	}
}

/**
 * 一份「渲染结果会变吗」的签名（#6 性能）。
 *
 * 只算**影响 DOM 的东西**：频道元信息、每条消息的 seq / 已读 / 提及已读、
 * 成员与任务的 id 集合、待办的关键字段。故意不含 `at` 以外的时序噪声，
 * 也不含流水——流水有自己的 `activityLastSeq` 判断。
 *
 * 为什么用拼接字符串而不是深比较：一次频道视图最多 60 条消息，拼 60 个短串
 * 是微秒级；深比较要递归整棵树，反而更慢，而且 `JSON.stringify` 会把
 * `undefined` 字段吞掉，两种「不同」会算出同一个签名。
 */
/**
 * 「要不要重渲染」的判据。
 *
 * ⚠️ **规则（WORKING-AGREEMENTS 第 51 条）**：签名必须覆盖**所有影响渲染的输入**。
 * 漏一个字段 = 那个字段变了也不会重绘 = 「改了不生效」的静默 bug。
 *
 * **踩过的坑（两次，同一类）**：
 * 1. 2026-10-27 改名后成员列表仍显示旧名 —— 原签名只取 `member.id` + `member.unread`，
 *    **漏了 `member.label` 和 `member.role`**。改名后 id/unread 都没变 → 签名不变 →
 *    前端认为「没变化」→ 不重绘 → 列表永远停在旧名。
 * 2. 同日 T-33 的 `dataset.view !== "channels"` 前置条件让「不在频道视图时收到新消息」
 *    也不刷新 —— 同类：判断条件没覆盖所有该覆盖的情况。
 *
 * **所以这里不再手工列举字段**：直接对「渲染所需的整份数据」做稳定序列化再哈希。
 * 好处：以后任何渲染函数新增字段，**自动被覆盖**，不用记得回来同步这里。
 * 代价：任何字段变动都会触发重绘（略多几次渲染，可忽略）。
 *
 * 序列化必须**稳定**（键顺序固定），否则同一份数据会算出不同哈希、导致每次都重绘。
 */
function stableStringify(value) {
	if (value === null || typeof value !== "object") return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
	const keys = Object.keys(value).sort();
	return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
}

function viewSignature() {
	const view = state.view;
	if (view === null) return "";
	// 整份视图数据（channel / messages / members / tasks / pending / hasMore）
	// 全部参与签名——见上面的规则与两次踩坑记录。
	return stableStringify(view);
}

/**
 * 打开（或刷新）一个频道。
 *
 * 三个必须守住的约束，都是踩过的坑：
 *
 * 1. **请求令牌**：以前用 `if (state.loading) return;` 直接丢弃并发请求——用户在
 *    加载中点另一个频道，那一下点击就静默消失了。现在用 reqToken：只有最后
 *    一次点击的响应能落地，早到的直接丢。
 * 2. **不抢用户的屏**：手机上是「列表页 / 会话页」两屏。只有用户**主动点频道**
 *    才切到 main；轮询刷新不能把人从列表页踢进会话页。
 * 3. **保住滚动位置与展开状态**：轮询会全量重渲染消息流，无条件
 *    `scrollToBottom()` 会把正在翻历史的用户拽回底部。
 */
async function openChannel(id, { userInitiated = true } = {}) {
	const token = ++state.reqToken;
	state.activeId = id;
	// 切频道必须重拉 @ 候选：候选是「本频道成员」，否则会 @ 到不在群里的人
	if (userInitiated) void loadMentionCandidates();
	// 手机上是「列表页 → 会话页」两屏，用户主动进会话才切到 main
	if (userInitiated && el.layout !== null) el.layout.dataset.pane = "main";
	// #4：切频道就收起成员浮层（窄屏下它是覆盖在会话上的，不收起会挡住新会话）
	if (userInitiated && state.membersOpen) {
		state.membersOpen = false;
		applyMembersOpen();
	}
	updateActiveRow();
	const keepScroll = userInitiated ? null : captureScroll();
	try {
		const view = await fetchJson(`/api/channels/${encodeURIComponent(id)}?limit=60`);
		if (token !== state.reqToken) return; // 用户已经切到别的频道了
		// 时钟校正：视图里有 `serverNow`，用它算一次偏移（旧后端没这个字段就不动）。
		if (Number.isFinite(view.serverNow)) state.clockSkew = view.serverNow - Date.now();
		// 轮询刷新时，如果用户已经往前翻过页，把更早的那些消息保住——
		// 否则每 4 秒一次刷新就把翻页结果冲掉，用户永远读不到历史。
		if (!userInitiated && state.view !== null && state.view.channel.id === id) {
			const firstFetched = view.messages[0]?.seq ?? Number.POSITIVE_INFINITY;
			const older = state.view.messages.filter((message) => message.seq < firstFetched);
			if (older.length > 0) {
				state.view = { ...view, messages: [...older, ...view.messages] };
			} else {
				state.view = view;
			}
		} else {
			state.view = view;
		}
		// #6 性能：内容没变就整段不重建。
		// 以前每个 org SSE（4s 一次、有时一次来好几条）都会走完这五行，
		// 每次都是 `el.body.replaceChildren(...)` 全量重建——正在读消息时页面
		// 闪一下、`<details>` 的展开态被抹掉、正在播放的图片/代码复制按钮全部
		// 复位（老板 #2「消息不停乱滚」的第二个来源）。现在比对一次签名，
		// 没变就只更新必须更新的（列表徽章、已读上报），不动 DOM。
		const signature = viewSignature();
		if (signature !== state.viewSignature) {
			state.viewSignature = signature;
			renderHeader();
			renderMessages();
			renderMembers();
			renderTasks();
			// 必须在 renderMembers() 之后：成员栏的可见性依赖当前频道的 kind（UX-6 / UX-8）
			applyMembersOpen();
		}
		// #1 / #4：切频道时重拉流水（只有私聊有）。流水到了会再渲染一次，
		// 先把频道消息画出来，不让老板盯着空白等。
		//
		// 刷新（SSE / 轮询）时分两种情况：
		// · 换人了 → 必须重拉；
		// · 同一个人但消息没变（比如只是组织图变了）→ 不重拉，
		//   否则每次 SSE 都把流水整段重建，页面就在原地抖一下（老板 #2「乱滚」）。
		const staffId = activityStaffId();
		const lastSeq = view.messages.at(-1)?.seq;
		const needsActivity =
			staffId !== null &&
			(userInitiated || staffId !== state.activityChannel || lastSeq !== state.activityLastSeq);
		if (needsActivity) void resetActivity({ keepScroll: !userInitiated, stickBottom: userInitiated });
		state.activityLastSeq = lastSeq;
		if (keepScroll === null) scrollToBottom();
		else restoreScroll(keepScroll);
		// 已读要前端**显式**上报：GET 不再有副作用（否则轮询/手机列表页也会清未读）。
		// 只报到真正渲染出来的最后一条，中间的未读不会被吞。
		if (lastSeq !== undefined) {
			void fetchJson(`/api/channels/${encodeURIComponent(id)}/read`, {
				method: "POST",
				headers: { "content-type": "application/json", accept: "application/json" },
				body: JSON.stringify({ seq: lastSeq }),
			}).catch(() => {
				/* 已读上报失败不打扰用户：下一轮会再报 */
			});
		}
		// 同步列表徽章
		const row = state.channels.find((channel) => channel.id === id);
		if (row !== undefined) {
			row.unread = 0;
			row.mentions = 0;
			renderList();
		}
	} catch (error) {
		if (token !== state.reqToken) return;
		renderBodyError(error instanceof Error ? error.message : "加载失败");
	}
}

/**
 * 往前翻一页。
 *
 * 只把结果**插到前面**（`state.view.messages` 合并），不整段重拉——否则用户
 * 翻到第 5 页时一次轮询又回到最近 60 条。滚动位置按「新增高度」补偿，
 * 视觉上停在原来看的那条上。
 */
async function loadEarlier(before) {
	const channelId = state.activeId;
	if (channelId === null || !Number.isFinite(before) || before <= 0) return;
	if (state.loadingEarlier) return;
	state.loadingEarlier = true;
	const heightBefore = el.body?.scrollHeight ?? 0;
	const topBefore = el.body?.scrollTop ?? 0;
	try {
		const page = await fetchJson(`/api/channels/${encodeURIComponent(channelId)}?limit=60&before=${before}`);
		if (state.activeId !== channelId || state.view === null) return;
		const known = new Set(state.view.messages.map((message) => message.seq));
		const older = page.messages.filter((message) => !known.has(message.seq));
		state.view = {
			...state.view,
			messages: [...older, ...state.view.messages],
			hasMore: page.hasMore,
		};
		renderMessages();
		if (el.body !== null) {
			// 内容变高了，补偿差值让视口停在原来的位置
			el.body.scrollTop = topBefore + (el.body.scrollHeight - heightBefore);
		}
	} catch (error) {
		notify(error instanceof Error ? error.message : "加载更早的消息失败", "error");
	} finally {
		state.loadingEarlier = false;
	}
}

/**
 * 读屏播报：只念**这一次真正新增**的消息。
 *
 * 为什么单独一块：消息区整段 `innerHTML` 重渲染，如果它自己挂 `aria-live`，
 * 每 4 秒轮询一次就把全部历史重播一遍，读屏用户根本没法用。
 */
function announceNewMessages(view) {
	if (el.announcer === null) return;
	// 切频道时基线归零：新频道里的历史不该被当成「刚来了一条」
	if (state.announcedChannel !== view.channel.id) {
		state.announcedChannel = view.channel.id;
		state.announcedSeq = view.messages.at(-1)?.seq ?? 0;
		return;
	}
	// 老板自己发的不用念（他刚打完字），只念别人说的
	const fresh = view.messages.filter((message) => message.seq > state.announcedSeq && message.from !== 0);
	if (fresh.length === 0) return;
	state.announcedSeq = fresh.at(-1).seq;
	const last = fresh.at(-1);
	el.announcer.textContent =
		fresh.length === 1
			? `${last.fromLabel}：${last.text.slice(0, 120)}`
			: `${fresh.length} 条新消息，最新来自 ${last.fromLabel}：${last.text.slice(0, 80)}`;
}

/** 记下消息区的滚动位置（是否贴底 + 距底距离）。 */
function captureScroll() {
	if (el.body === null) return null;
	const distance = el.body.scrollHeight - el.body.scrollTop - el.body.clientHeight;
	return { distance, atBottom: distance < 48 };
}

function restoreScroll(saved) {
	if (el.body === null || saved === null) return;
	if (saved.atBottom) {
		// 用户在底部：新消息进来后应该跟着到底，否则看不到最新一条。
		// 走同一个带一帧兜底的实现（D-012：smooth 下同步赋值不可靠）。
		scrollToBottom();
		return;
	}
	// 内容可能变高了（新消息进来），按「距底距离」还原比按绝对 scrollTop 稳
	el.body.scrollTop = el.body.scrollHeight - el.body.clientHeight - saved.distance;
}

async function sendMessage(text) {
	const channelId = state.activeId;
	if (channelId === null || text.trim() === "") return;
	// 连按两次 Enter 不该发两条
	if (state.sending) return;
	state.sending = true;
	const sentText = text;
	// `mentions` 不再由前端算（旧的 `extractMentions` 只按成员名 `includes`，
	// 与后端的 `parseMentions` 是两套算法：后端认「@负责人」别名、要求名字
	// 后面不紧邻文字、只保留频道成员。两边不一致时界面高亮了却没人被唤醒）。
	// 现在只传正文 + 引用 seq，@ 谁完全由 POST /messages 的 handler 决定。
	// #7「用回复取代 @」：引用改成**结构化字段**，不再往正文里拼 Markdown 引用块。
	//
	// 旧做法的两处问题：①被引用的人不会被唤醒（`mentions` 里没有他），
	// 「回复」变成纯装饰；②正文里多出一段 `> 某某：xxx`，复制消息会把别人的话
	// 一起带走。现在只传 seq，服务端在 `appendMessage` 里把原消息的发送方
	// 回填进 `mentions`，前端按 `replyTo` 渲染引用块。
	const replySeq = state.replyTo === null ? undefined : state.replyTo.seq;
	try {
		el.send?.setAttribute("disabled", "");
		await fetchJson(`/api/channels/${encodeURIComponent(channelId)}/messages`, {
			method: "POST",
			headers: { "content-type": "application/json", accept: "application/json" },
			body: JSON.stringify({ text: sentText, ...(replySeq === undefined ? {} : { replyTo: replySeq }) }),
		});
		// 只有输入框里还是刚发出去的那段文字才清空。
		// 曾经无条件 `el.input.value = ""`：发送途中用户切频道并开始打新草稿，
		// 草稿被这条旧响应抹掉。
		if (el.input !== null && el.input.value === sentText) {
			el.input.value = "";
			autoSize();
		}
		if (state.replyTo !== null) setReplyTo(null);
		// 同理：发送途中用户已经切走，就不要把人拽回旧频道
		if (state.activeId === channelId) await openChannel(channelId, { userInitiated: false });
		await loadChannels();
	} catch (error) {
		notify(error instanceof Error ? error.message : "发送失败", "error");
	} finally {
		state.sending = false;
		el.send?.removeAttribute("disabled");
	}
}


// ── #5：消息操作浮窗（复制 / 引用回复） ──────────────────────────────────

/** 引用预览里的一行原文：压成单行、剪到 60 字。多行引用会把输入区顶得很高。 */
function quoteLine(target) {
	const flat = String(target.text ?? "")
		.replace(/\s+/g, " ")
		.trim();
	const clipped = flat.length > 60 ? `${flat.slice(0, 60)}…` : flat;
	return `${target.label}：${clipped}`;
}

/** 设置 / 清除引用目标（同时改预览条）。 */
function setReplyTo(target) {
	state.replyTo = target;
	if (el.replyBar !== null) el.replyBar.hidden = target === null;
	if (el.replyText !== null) el.replyText.textContent = target === null ? "" : quoteLine(target);
	if (target !== null) el.input?.focus?.({ preventScroll: true });
}

/** 关掉消息浮窗。 */
function closeActions() {
	if (el.actions === null) return;
	el.actions.hidden = true;
	el.actions.replaceChildren();
	state.actionSeq = null;
}

/**
 * 在点击位置附近弹出消息操作浮窗。
 *
 * 为什么自己算位置而不用 popover API：`popover` 需要重写整块 DOM 的锚定逻辑，
 * 而这里只要「贴着这条消息右上角、不超出视口」十几行就够。
 */
function openActions(message, anchor) {
	if (el.actions === null || el.body === null) return;
	const seq = Number(message.dataset.seq);
	const found = state.view?.messages.find((item) => item.seq === seq);
	if (found === undefined) return;
	state.actionSeq = seq;
	el.actions.replaceChildren();
	const copy = document.createElement("button");
	copy.type = "button";
	copy.className = "ch-action";
	copy.dataset.action = "copy";
	copy.textContent = "复制";
	const reply = document.createElement("button");
	reply.type = "button";
	reply.className = "ch-action";
	reply.dataset.action = "reply";
	reply.textContent = "引用回复";
	el.actions.append(copy, reply);
	el.actions.hidden = false;

	const box = el.body.getBoundingClientRect();
	const rect = anchor.getBoundingClientRect();
	const own = el.actions.getBoundingClientRect();
	// 默认放在消息右上角；右边放不下就翻到左侧，上边不够就翻到下方。
	let left = rect.right - own.width;
	let top = rect.top - own.height - 6;
	if (top < box.top + 4) top = rect.bottom + 6;
	if (left < box.left + 4) left = box.left + 4;
	if (left + own.width > box.right - 4) left = box.right - own.width - 4;
	el.actions.style.left = `${Math.round(left - box.left)}px`;
	el.actions.style.top = `${Math.round(top - box.top)}px`;
}

// ── 渲染：频道列表 ─────────────────────────────────────────────────────────

/**
 * 头像：走服务端 `/api/avatar/:name`。
 *
 * 为什么不用首字母：中文名的第一个字区分度极低（「林越」「林墨」都是「林」），
 * 而头像的作用是扫视时快速认人。服务端按名字稳定生成同一张脸，重启不变。
 */
function avatar(label, size = 32, extraClass = "") {
	const src = `/api/avatar/${encodeURIComponent(label)}?size=${size * 2}`;
	// onerror 兜底：头像接口挂了（或离线）时显示首字，而不是一个破图标
	const initial = escapeAttr(label.slice(0, 1));
	return (
		`<img class="ch-av ${extraClass}" src="${escapeAttr(src)}" alt="" width="${size}" height="${size}" loading="lazy" decoding="async"` +
		` onerror="this.replaceWith(Object.assign(document.createElement('span'),{className:'ch-av ch-av--fallback ${extraClass}',textContent:'${initial}'}))">`
	);
}

function renderList(unread) {
	if (el.list === null) return;
	const grouped = new Map();
	for (const channel of state.channels) {
		const list = grouped.get(channel.kind) ?? [];
		list.push(channel);
		grouped.set(channel.kind, list);
	}

	const html = [`<div class="ch-list-head"><b>频道</b><span>${state.channels.length}</span></div>`];
	for (const group of GROUPS) {
		// 老库里残留的 log: 频道不再展示（数据不删，只是前端不给入口）。
		const items = group.kinds.flatMap((kind) => grouped.get(kind) ?? []);
		if (items.length === 0) continue;
		html.push(`<div class="ch-group"><span>${escapeHtml(group.label)}</span></div>`);
		for (const channel of items) {
			const active = channel.id === state.activeId;
			const badge =
				channel.mentions > 0
					? `<b class="ch-badge ch-badge--mention">${channel.mentions}</b>`
					: channel.unread > 0
						? `<b class="ch-badge">${channel.unread}</b>`
						: "";
			// 未完成任务数是后端算好的（`listChannels` 按 `isTerminal` 过滤），
			// 前端只负责显示。0 件时不写「0 个未完成」——「零」不是信息，是噪音。
			const openTasks =
				channel.openTasks > 0
					? `<span class="ch-row-tasks">${channel.openTasks} 个未完成</span>`
					: "";
			html.push(
				[
					`<button class="ch-row" type="button" data-id="${escapeAttr(channel.id)}"`,
					` data-active="${active ? "true" : "false"}"`,
					` data-mention="${channel.mentions > 0 ? "true" : "false"}">`,
					avatar(channel.title, 32),
					`<span class="ch-row-main">`,
					`<span class="ch-row-title">${escapeHtml(channel.title)}</span>`,
					channel.preview === "" ? "" : `<span class="ch-row-preview">${escapeHtml(channel.preview)}</span>`,
					`</span>`,
					`<span class="ch-row-side">`,
					channel.lastAt > 0 ? `<span class="ch-row-time">${escapeHtml(relTime(channel.lastAt))}</span>` : `<span class="ch-row-time">—</span>`,
					badge,
					openTasks,
					`</span>`,
					`</button>`,
				].join(""),
			);
		}
	}
	el.list.innerHTML = html.join("") || `<div class="ch-empty">还没有频道</div>`;
	for (const button of el.list.querySelectorAll(".ch-row")) {
		if (button.dataset.id === undefined) continue;
		button.addEventListener("click", () => openChannel(button.dataset.id));
	}
	// 顶栏徽章：**从 state.channels 自己算**。
	// 以前用 `unread?.mentions ?? 0`——renderList() 无参调用时 unread 是 undefined，
	// 顶栏 @ 徽章就被清空了（openChannel / 展开全文 后都会调一次）。
	const total =
		unread?.mentions ??
		state.channels.reduce((sum, channel) => sum + (channel.mentions ?? 0), 0);
	const badge = $("ch-unread");
	if (badge !== null) {
		badge.textContent = total > 0 ? String(total) : "";
		badge.hidden = total === 0;
	}
}

function updateActiveRow() {
	if (el.list === null) return;
	for (const row of el.list.querySelectorAll(".ch-row")) {
		row.dataset.active = row.dataset.id === state.activeId ? "true" : "false";
	}
	// 当前频道变了要广播：看板据此高亮对应卡片，不必自己去猜频道状态。
	window.dispatchEvent(
		new CustomEvent("aic:channel", { detail: { channelId: state.activeId ?? "" } }),
	);
}

function renderListError(message) {
	if (el.list === null) return;
	el.list.innerHTML = `<div class="ch-empty">频道没拉到（${escapeHtml(message)}）</div>`;
}

// ── 渲染：头部 / 消息 / 成员 / 任务 ────────────────────────────────────────

/**
 * 这个频道要不要显示「成员」这一栏（UX-6）。
 *
 * dm（私聊）与 log（个人工作记录）都不显示：
 *   · dm：成员恒为 2 人（老板 + 对方），列表信息量 ≈ 0，而「和谁在聊」
 *     已经写在标题与 `.ch-sub` 的「私聊 · 2 人」里了；
 *   · log：log 里只有一个人（`src/company/channels.ts:552-554` 建 log 频道时
 *     members 只有 [本人]），它本身就不是对话，列「成员」等于列一个人。
 *
 * **只按 kind 判，不按 id 前缀判**：`dm:<id>` 与 `log:<id>` 是两个不同频道，
 * 而 kind 由服务端给出（`ChannelListItem.kind`，`src/domain/channels.ts:19` 的 5 种），是权威值。
 *
 * 用白名单而非黑名单：后端 `CHANNEL_KINDS` 以后若新增类型，黑名单会让新类型
 * **默认显示**成员（可能是错的），白名单会让它**默认不显示**（安全的默认）。
 */
function showsMembers() {
	const kind = state.view?.channel.kind;
	return kind === "company" || kind === "leadership" || kind === "project";
}

/**
 * 把成员栏的展开态写到 DOM（UX-6 / UX-8）。
 *
 * 四个状态位必须一起写，缺一个就会出现「看得见点不到」或「读屏念不出来」：
 *   1. `.ch-layout[data-side]` —— CSS 控制三栏栅格宽度 + 窄屏浮层（UX-8）；
 *   2. `#ch-side.hidden`     —— dm/log 整栏不占位（不是透明），这是 UX-6 的 6-c；
 *   3. `#ch-side.inert`      —— 收起时退出 tab 序列与无障碍树（收起 ≠ 删除）；
 *   4. `aria-expanded`       —— 按钮语义。
 */
function applyMembersOpen() {
	const available = showsMembers();
	const open = available && state.membersOpen;
	if (el.layout !== null) el.layout.dataset.side = open ? "open" : "closed";
	if (el.sideToggle !== null) {
		el.sideToggle.hidden = !available;
		el.sideToggle.setAttribute("aria-expanded", open ? "true" : "false");
	}
	if (el.side !== null) {
		el.side.hidden = !available;
		el.side.inert = !open;
	}
}

function renderHeader() {
	const view = state.view;
	if (view === null || el.title === null) return;
	// #4：换了频道就收起档案面板。以前它是个一直展开的下拉，切到别的私聊
	// 还挂着上一个人的档案——老板的原话是「展开后切换到其他聊天也还展示着」。
	if (state.profileChannel !== view.channel.id) {
		state.profileChannel = view.channel.id;
		if (profile?.isOpen() === true) profile.close();
	}
	el.title.textContent = view.channel.title;
	const kindLabel = {
		company: "全员",
		leadership: "管理层",
		project: "项目群",
		dm: "私聊",
		log: "工作记录",
	}[view.channel.kind];
	// 公司群的标题就叫「公司大群」，别再重复一遍类型
	const parts = view.channel.kind === "company" ? [] : [kindLabel];
	parts.push(`${view.channel.memberCount} 人`);
	el.sub.textContent = parts.join(" · ");

	// #2：档案按钮只在私聊里出现——私聊的标题就是那个人，档案有明确指向。
	// 群聊里「这个群的档案」没有定义（成员清单已经在右侧成员栏里了）。
	const hasPerson = activityStaffId() !== null;
	if (el.fold !== null) {
		el.fold.hidden = !hasPerson;
		if (!hasPerson) {
			el.fold.dataset.state = "closed";
			el.fold.setAttribute("aria-expanded", "false");
			if (profile?.isOpen() === true) profile.close();
		}
		const label = hasPerson ? `查看 ${view.channel.title} 的角色档案` : "角色档案";
		el.fold.title = label;
		el.fold.setAttribute("aria-label", label);
	}
}

// ── #1 / #4：私聊的流水（思考 + 工具调用）混进消息流 ──────────────────────

/** 一页拉多少条流水。 */
const ACTIVITY_PAGE = 30;

/**
 * 当前私聊对应的员工会话 id（`dm:1897` → `1897`）。
 *
 * 只有私聊才拉流水：群聊里「谁的流水」没有唯一答案，混进来会让群消息流噪音爆炸。
 */
function activityStaffId() {
	const id = state.view?.channel.id ?? "";
	if (!id.startsWith("dm:")) return null;
	const n = Number(id.slice(3));
	return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * 流水条目的统一时间（毫秒）。
 *
 * 流水来自会话 feed，消息来自频道文档，两边时钟同源但字段不同（`at` 都有）。
 * 归并排序必须用同一个键，否则同一条消息会被排到错误的位置。
 */
function itemAt(item) {
	return typeof item.at === "number" ? item.at : 0;
}

/**
 * 把「频道消息」与「员工流水」归并成一条时间线。
 *
 * 为什么不合并数据源：一个是频道文档（`ChannelMessage`），一个是会话 feed
 * （`ActivityItem`），生命周期与保留策略都不同。只在渲染层归并，两边都能独立演进。
 *
 * 排序用 `at`（毫秒），相同时间按「消息在前、流水在后」——老板自己说的话
 * 应该出现在引发它的那次思考之后。
 */
function timelineOf(view) {
	const rows = [];
	for (const message of view.messages) rows.push({ kind: "message", at: message.at, message });
	const staffId = activityStaffId();
	const page = state.activity;
	if (staffId !== null && page !== null) {
		for (const item of page.items) {
			// `assistant` 跳过：它就是「这个人在私聊里说的话」，频道消息里已经有了，
			// 再渲染一遍等于每句话出现两次。
			if (item.kind !== "thinking" && item.kind !== "tool") continue;
			rows.push({ kind: "trace", at: itemAt(item), item });
		}
	}
	rows.sort((a, b) => a.at - b.at || (a.kind === "message" ? -1 : 1));
	return rows;
}

/**
 * 渲染一条流水（思考 / 工具调用）。
 *
 * 默认折叠（`<details>`）：老板要的是「能看见他想了什么」，不是「被每一步工具调用打断」。
 * 复用 feed-render.js 的渲染器，与组织页对话面板视觉一致。
 */
function renderTrace(item) {
	const row = document.createElement("div");
	row.className = "ch-trace";
	row.dataset.kind = item.kind;
	if (item.kind === "tool") {
		if (item.isError === true) row.dataset.error = "true";
		row.append(renderTool(item));
	} else {
		row.append(renderThinking(item));
	}
	const time = document.createElement("time");
	time.className = "ch-trace-time";
	time.textContent = clockTime(item.at);
	row.append(time);
	return row;
}

/**
 * 把连续的流水折成一组。
 *
 * 为什么必须折：实测一次任务会产生几十条 `bash` / `edit` 调用，逐条铺开会把私聊
 * 变成工具日志——老板的原话是「太长了，最好是 1、2、3 列举，详情收缩」。
 * 所以连续流水收进一个 `<details>`，摘要行写「12 步操作 · 12:07–12:23」，
 * 点开才是逐条明细。失败的工具调用会破组（单独露出），因为那是要看的东西。
 */
function renderTraceGroup(items) {
	const failed = items.some((item) => item.kind === "tool" && item.isError === true);
	const box = document.createElement("details");
	box.className = "ch-trace-group";
	if (failed) box.open = true;
	box.dataset.error = failed ? "true" : "false";

	const summary = document.createElement("summary");
	summary.className = "ch-trace-summary";
	const first = items[0]?.at ?? 0;
	const last = items.at(-1)?.at ?? first;
	const tools = items.filter((item) => item.kind === "tool").length;
	const thoughts = items.length - tools;
	const parts = [];
	if (tools > 0) parts.push(`${tools} 步操作`);
	if (thoughts > 0) parts.push(`${thoughts} 段思考`);
	const span = last - first < 60_000 ? clockTime(first) : `${clockTime(first)}–${clockTime(last)}`;
	summary.textContent = `${parts.join(" · ")} · ${span}${failed ? " · 有失败" : ""}`;
	box.append(summary);

	for (const item of items) box.append(renderTrace(item));
	return box;
}

/** 顶部「加载更早的记录」哨兵：只在用户**手动往上滑到顶**时才自动续页。
 *
 * 为什么写得这么绕（老板 #2「消息不停乱滚」的真因）：
 * 旧实现每次 `renderMessages()` 都无条件 `observe(sentinel)`，且 rootMargin=120px。
 * 私聊一打开，哨兵还没进视口就已满足 120px 判定，回调立刻 `loadMoreActivity()`
 * → 又有一页历史插到顶部 → 又一次 render → 又命中… 实测打开 `dm:161`
 * 会一口气连拉 17 页（500+ 条流水），消息区高度从 678px 逐帧涨到 1379px，
 * 看起来就是「一直在乱滚」。
 *
 * 关键认识：**「现在位于顶部」不等于「用户想往上翻」**。程序化
 * `scrollToBottom()` 之前、首帧布局还没定稿时，`scrollTop` 也是 0，
 * `scroll` 事件同样会触发。所以只认 `wheel` / `touchmove` / ↑ 键这类
 * **人手动作**（见 `onUserScrollAttempt`），命中一次立刻断开，
 * 翻完等下一次人手动作再判。
 */
let activityObserver = null;
function disarmActivitySentinel() {
	if (activityObserver !== null) {
		activityObserver.disconnect();
		activityObserver = null;
	}
}
function armActivitySentinel() {
	if (activityObserver !== null) return;
	if (typeof IntersectionObserver !== "function") return; // 降级：只能点按钮
	const body = el.body;
	if (body === null || body.scrollTop > 8) return; // 不在顶部就不翻历史
	const page = state.activity;
	if (page === null || page.hasMore !== true) return;
	const node = body.querySelector(".ch-activity-more");
	if (node === null) return;
	activityObserver = new IntersectionObserver(
		(entries) => {
			for (const entry of entries) {
				if (entry.isIntersecting !== true) continue;
				disarmActivitySentinel(); // 一次只翻一页
				void loadMoreActivity();
			}
		},
		{ root: body, rootMargin: "0px" },
	);
	activityObserver.observe(node);
}
/** 一组流水的 key：首尾 item 的 id 就足够区分（同一组只会被追加，不会被改动）。 */
function traceKey(items) {
	const first = items[0]?.id ?? "?";
	const last = items.at(-1)?.id ?? "?";
	return `t:${first}..${last}`;
}

/** 渲染后只需解绑：DOM 已重建，旧观察器指向已移除的节点。 */
function observeActivitySentinel() {
	disarmActivitySentinel();
}

/** 人手动作 → 若已滑到顶就武装（真正的判定在 armActivitySentinel 里）。 */
function onUserScrollAttempt() {
	if (el.body === null) return;
	if (el.body.scrollTop <= 8) armActivitySentinel();
	else disarmActivitySentinel();
}

/** 加载更早的一页流水（`before` 用 item seq）。 */
async function loadMoreActivity() {
	const staffId = activityStaffId();
	const page = state.activity;
	if (staffId === null || page === null || !page.hasMore) return;
	if (state.activityLoading) return;
	state.activityLoading = true;
	const token = state.activityToken;
	const before = page.items[0]?.seq;
	const heightBefore = el.body?.scrollHeight ?? 0;
	const topBefore = el.body?.scrollTop ?? 0;
	try {
		const query = before === undefined ? `limit=${ACTIVITY_PAGE}` : `limit=${ACTIVITY_PAGE}&before=${before}`;
		const next = await fetchJson(`/api/staff/${staffId}/activity?${query}`);
		if (token !== state.activityToken) return; // 用户已经切走
		const known = new Set(page.items.map((item) => item.id));
		const older = (Array.isArray(next.items) ? next.items : []).filter((item) => !known.has(item.id));
		state.activity = { items: [...older, ...page.items], hasMore: next.hasMore === true };
		state.activityLoading = false;
		renderMessages();
		if (el.body !== null) {
			el.body.scrollTop = topBefore + (el.body.scrollHeight - heightBefore);
		}
	} catch (error) {
		state.activityLoading = false;
		if (token !== state.activityToken) return;
		notify(error instanceof Error ? error.message : "加载更早的记录失败", "error");
	}
}

/** 切到某个私聊时重置并拉第一页流水。非私聊频道清空。
 *
 * `keepScroll`：刷新（SSE / 轮询）时传 true——流水到了会二次重渲染，
 * 消息区高度从「只有聊天」变成「聊天 + 流水」，不保滚动就会被浏览器
 * 的 scroll-anchoring 反复纠正，看起来就是「消息不停乱滚」（老板 #2）。
 *
 * `stickBottom`：用户**主动点开**频道时传 true。这时 openChannel 已经先
 * `scrollToBottom()` 画了消息，流水随后才到；若第二次重绘不管滚动，
 * 浏览器会把 scrollTop 留在旧内容的位置上——实测打开 `dm:161` 时
 * scrollTop 从 678（贴底）被打回 0，人看到的是这一小时的流水开头，
 * 就是老板说的「一打开就乱滚」。#2 的修法有两条：
 *   ① 主动打开 → 流水到了再贴一次底（stickBottom）；
 *   ② 内容没变就不重绘（下面 `sameActivity`），SSE 抖动不再把页面推来推去。
 */
async function resetActivity({ keepScroll = false, stickBottom = false } = {}) {
	state.activityToken += 1;
	state.activity = null;
	state.activityLoading = false;
	if (activityObserver !== null) {
		activityObserver.disconnect();
		activityObserver = null;
	}
	const staffId = activityStaffId();
	state.activityChannel = staffId;
	if (staffId === null) return;
	const token = state.activityToken;
	const saved = keepScroll ? captureScroll() : null;
	try {
		const page = await fetchJson(`/api/staff/${staffId}/activity?limit=${ACTIVITY_PAGE}`);
		if (token !== state.activityToken) return;
		const items = Array.isArray(page.items) ? page.items : [];
		const hasMore = page.hasMore === true;
		// 内容一模一样就不重绘：openChannel 在 SSE / 轮询里每几秒就会调到这里，
		// 无条件重绘等于每几秒把整段流水拆了重建一次，视口必然抖。
		if (sameActivity(state.activity, items, hasMore)) return;
		state.activity = { items, hasMore };
		// 流水到了再重渲染一次：先把频道消息画出来，不让老板盯着空白等。
		renderMessages();
		if (stickBottom) scrollToBottom();
		else if (saved !== null) restoreScroll(saved);
	} catch {
		if (token !== state.activityToken) return;
		// 流水拉不到不算错误：对话本身还在，只是看不到思考过程。
		state.activity = { items: [], hasMore: false };
	}
}

/** 两页流水是否「同一份」（条数、首尾 id、是否还有更早）。 */
function sameActivity(previous, items, hasMore) {
	if (previous === null || previous.hasMore !== hasMore) return false;
	if (previous.items.length !== items.length) return false;
	if (items.length === 0) return true;
	return previous.items[0]?.id === items[0]?.id && previous.items.at(-1)?.id === items.at(-1)?.id;
}
function renderMessages() {
	const view = state.view;
	if (view === null || el.body === null) return;
	announceNewMessages(view);
	const rows = timelineOf(view);
	const pendingNodes = pendingHtml(view);
	if (rows.length === 0) {
		el.body.innerHTML = `<div class="ch-empty">还没有消息。${view.channel.kind === "project" ? "在项目群里 @ 某人开始协作。" : ""}</div>`;
		el.body.append(...pendingNodes);
		return;
	}

	const fragment = document.createDocumentFragment();
	// 更早的消息：服务端有 before 游标（每频道保留 800 条），前端以前硬编码
	// `?limit=60` 且从不翻页，用户只能看到最近 60 条，更早的等于不存在。
	if (view.hasMore) {
		const firstSeq = view.messages[0]?.seq ?? 0;
		fragment.append(keyed(htmlToNode(`<button class="ch-load-more" type="button" data-before="${firstSeq}">加载更早的消息</button>`), "more-messages"));
	}
	// 流水还有更早的：哨兵放在最上面，滚到顶自动续（#1：私聊里历史要能一路往回翻）。
	if (state.activity !== null && state.activity.hasMore) {
		fragment.append(
			htmlToNode(
				`<div class="ch-activity-more"><button class="ch-load-more" type="button">加载更早的记录</button></div>`,
			),
		);
	}

	let lastFrom = null;
	let lastAt = 0;
	let lastDay = "";
	for (let index = 0; index < rows.length; index += 1) {
		const row = rows[index];
		const at = row.at;
		const day = dayKey(at);
		if (day !== lastDay) {
			fragment.append(keyed(htmlToNode(`<div class="ch-day">${escapeHtml(dayLabel(at))}</div>`), `day:${day}`));
			lastDay = day;
			lastAt = 0; // 换天后不再跟「上一条」比间隔
		} else if (lastAt > 0 && at - lastAt > 5 * 60_000) {
			// #6：同一天内间隔超过 5 分钟插一条时间条（对齐微信）。
			// 旧实现只在换发送人时给一条时间，连着说 20 条只有第一条有——老板
			// 看不出「这段话是上午还是下午说的」。流水（trace）也参与计时，
			// 但时间条只在**消息**之间插：一组流水自带 `12:07–12:23` 的跨度摘要。
			fragment.append(keyed(htmlToNode(`<div class="ch-time-divider">${escapeHtml(clockTime(at))}</div>`), `gap:${at}`));
			lastAt = 0;
		}

		if (row.kind === "trace") {
			// 流水不参与「同一个人连续发言折叠」：它夹在消息之间，视觉上必须独立成行。
			lastFrom = null;
			lastAt = 0;
			// 连续的流水攒成一组再渲染（见 renderTraceGroup）。
			// **失败的工具调用会破组**：它必须立刻可见，不能被折进「N 步操作」里。
			const batch = [];
			while (index < rows.length && rows[index].kind === "trace") {
				const item = rows[index].item;
				if (item.kind === "tool" && item.isError === true) {
					if (batch.length > 0) {
						fragment.append(keyed(renderTraceGroup(batch), traceKey(batch)));
						batch.length = 0;
					}
					fragment.append(keyed(renderTraceGroup([item]), traceKey([item])));
					index += 1;
					continue;
				}
				batch.push(item);
				index += 1;
			}
			if (batch.length > 0) fragment.append(keyed(renderTraceGroup(batch), traceKey(batch)));
			continue;
		}

		const message = row.message;
		const grouped = message.from === lastFrom && at - lastAt < 5 * 60_000 && message.kind === "chat";
		lastFrom = message.from;
		lastAt = at;

		if (message.kind === "system") {
			fragment.append(keyed(htmlToNode(`<div class="ch-system">${escapeHtml(message.text)}</div>`), `m:${message.seq}`));
			continue;
		}
		if (message.kind === "task" || message.kind === "report") {
			fragment.append(keyed(htmlToNode(renderCard(message)), `m:${message.seq}`));
			continue;
		}

		fragment.append(
			keyed(htmlToNode(
				[
					// #5：带 data-seq，点消息弹「复制 / 引用回复」浮窗。
					`<div class="ch-msg" data-from="${message.from}" data-seq="${message.seq}" data-grouped="${grouped ? "true" : "false"}">`,
					// 头像始终渲染（折叠时 CSS 隐藏）：留空会让 grid 把正文挤进 32px 列
					renderAvatar(message),
					`<div class="ch-msg-main">`,
					grouped ? "" : renderMsgHead(message),
					renderQuote(message),
					renderBubble(message.text, message.seq, message.kind, message.mentions),
					renderMentions(message),
					renderAcks(message),
					`</div>`,
					`</div>`,
				].join(""),
			), `m:${message.seq}`),
		);
	}

	// #6：**增量替换**，不再整段 `replaceChildren`。
	//
	// 老板的原话是「消息一直刷新」。真因不是请求多（那已经在 #2 里改成「内容没变
	// 就不重绘」了），而是每次重绘都把整棵子树换掉：`<details>` 的展开态丢、
	// 正在播放的图片重新解码、`scroll-anchoring` 把视口推走。
	//
	// 这里按 `data-key` 对齐：key 相同就保留旧节点（如果内容 signature 变了才整体
	// 换成新的），key 不存在的才插入。一页 90 条里通常只有 1~2 条是新的，
	// 实际 DOM 变动从「90 个节点全换」降到「1 个节点插入」。
	patchBody(fragment);
	// 补：新插入的节点上的「展开全文」按钮需要绑事件（见下方遍历）
	// 待办排在最后一条消息之后：它是「有人在等你回话」，属于对话的延续，
	// 不是另一块区域（顶部黄框那套做法用户明确否掉过）。
	el.body.append(...pendingNodes);
	for (const button of el.body.querySelectorAll(".ch-load-more[data-before]")) {
		button.addEventListener("click", () => loadEarlier(Number(button.dataset.before)));
	}
	for (const button of el.body.querySelectorAll(".ch-activity-more .ch-load-more")) {
		button.addEventListener("click", () => void loadMoreActivity());
	}
	observeActivitySentinel();
	// 展开全文（事件委托：消息流每次全量重渲染，逐个绑定会漏）
	for (const button of el.body.querySelectorAll(".ch-expand")) {
		button.addEventListener("click", () => {
			const seq = Number(button.dataset.seq);
			if (Number.isFinite(seq)) state.expanded.add(seq);
			const bubble = button.previousElementSibling;
			if (bubble !== null) bubble.dataset.collapsed = "false";
			button.remove();
		});
	}
}

/**
 * 给节点打 key（需求 #6「一直刷新」的增量渲染基础）。
 *
 * key 只用来做「同一个东西还是不是它」的判断：key 一样就复用旧节点，
 * 内层内容变了就整体替换（见 `patchBody`）。不追求真正的 DOM diff——
 * 频道一页只有 90 条，换节点比递归比较更便宜，也不会因为状态漏同步而出错。
 */
let patchSeqCounter = 0;
function keyed(node, key) {
	if (node instanceof HTMLElement) node.dataset.key = key;
	return node;
}

/**
 * 按 `data-key` 把 fragment 里的节点合并进 `el.body`。
 *
 * - key 相同 + 内容相同 → **保留旧节点**（`<details>` 展开态、图片解码都留住）
 * - key 相同 + 内容不同 → 用新节点替换旧的（位置不变）
 * - key 是新的 → 插到正确位置
 * - 旧列表里有的 key 在新列表里没有 → 删掉
 *
 * 「内容相同」用一个开销极低的 signature（`outerHTML` 长度 + 首尾 32 字节）判断：
 * 真正的 `outerHTML` 全量比较在 90 条 × 每条 2KB 时反而是负担，而这个 signature
 * 已经足够区分「多了一个已读点 / 多了一张图」这类真实变化。
 */
function patchBody(fragment) {
	const body = el.body;
	if (body === null) return;
	const incoming = [...fragment.children];
	// 旧节点的 key → 节点。没有 key 的旧节点（理论上不该有）一律丢弃重建。
	const existing = new Map();
	for (const node of body.children) {
		const key = node instanceof HTMLElement ? node.dataset.key : undefined;
		if (key !== undefined) existing.set(key, node);
	}
	const seen = new Set();
	for (let index = 0; index < incoming.length; index += 1) {
		const next = incoming[index];
		const key = next instanceof HTMLElement ? next.dataset.key : undefined;
		if (key === undefined) continue;
		seen.add(key);
		const previous = existing.get(key);
		if (previous === undefined) {
			body.insertBefore(next, body.children[index] ?? null);
			continue;
		}
		if (signatureOf(previous) === signatureOf(next)) {
			// 内容没变：保留旧节点，但要把它挪到正确位置（消息顺序可能变）
			body.insertBefore(previous, body.children[index] ?? null);
			continue;
		}
		body.replaceChild(next, previous);
		// replaceChild 会让 next 离开 fragment，后面的 index 计算仍然按 body.children 走
		body.insertBefore(next, body.children[index] ?? null);
	}
	for (const [key, node] of existing) {
		if (seen.has(key)) continue;
		node.remove();
	}
	// 干掉残留的、无 key 的旧节点（例如切频道时旧频道的空态提示）
	for (const node of [...body.children]) {
		const key = node instanceof HTMLElement ? node.dataset.key : undefined;
		if (key === undefined && !incoming.includes(node)) node.remove();
	}
	patchSeqCounter += 1;
}

/** 节点的内容指纹：长度 + 首尾片段，够分辨「有没有变」。 */
function signatureOf(node) {
	const html = node.outerHTML;
	if (html.length <= 64) return html;
	return `${html.length}:${html.slice(0, 32)}:${html.slice(-32)}`;
}

/** 把一段 HTML 字符串变成节点（用于往 fragment 里塞，避免 innerHTML 整段重建）。 */
function htmlToNode(html) {
	const template = document.createElement("template");
	template.innerHTML = html.trim();
	return template.content.firstElementChild ?? document.createElement("div");
}

/**
 * 当前频道里等老板拍板的卡片节点。
 *
 * 数据来自 `/api/channels/:id` 的 `pending`（后端算好归属与权限），这里只负责画。
 * 没传 `pending` 字段（旧后端）时静默降级成空数组，不至于整片消息流白屏。
 */
function pendingHtml(view) {
	if (pendingCards === null) return [];
	const items = Array.isArray(view.pending) ? view.pending : [];
	return items.map((item) => pendingCards.render(item));
}

/**
 * 正文里的 `@名字` 加高亮（需求 #6）。
 *
 * **为什么不再在前端猜**：以前这里在 `renderMarkdown()` 出来的 HTML 串上找
 * `@名字`，还要维护一个 `<code>/<pre>/<a>` 的深度计数躲开代码区。两个问题：
 * 一是脆（`**@林越**` 这种被标签拆开的就命中不了），二是**和真正被 @ 的人
 * 可能不是一回事**——前端按「成员名是否出现在正文里」猜，后端按
 * `parseMentions` 的正则猜，两套算法不一致时界面高亮了却没人被唤醒。
 *
 * 现在 `MessageView.mentions` 自带 `offset`（后端在原文上算好的起点），
 * 前端只做一件事：**按偏移量切片**。高亮的人就是后端真的抽中的人。
 *
 * 实现上不「切段分别渲染」——那样会把跨 `@` 的 Markdown 拆碎（`**@林越**`
 * 会变成两段半个粗体）。做法是把 mention 从**原文**里换成 `\u0001序号\u0001`
 * 占位符，整段交给 `renderMarkdown()`（它自己转义），最后在**已转义的 HTML**
 * 上只把占位符换回 span。占位符是控制符，`escapeHtml()` 不碰它；替换进去的
 * 内容只有 `escapeHtml(原文切片)`——**没有 XSS 面**。
 */
const MENTION_SLOT = "\u0001";

function highlightMentions(text, mentions) {
	const marks = mentionMarks(text, mentions);
	if (marks.length === 0) return renderMarkdown(text);
	const slots = [];
	let source = "";
	let cursor = 0;
	for (const mark of marks) {
		source += stripSlot(text.slice(cursor, mark.offset));
		slots.push(`<span class="ch-at">${escapeHtml(text.slice(mark.offset, mark.end))}</span>`);
		source += `${MENTION_SLOT}${slots.length - 1}${MENTION_SLOT}`;
		cursor = mark.end;
	}
	source += stripSlot(text.slice(cursor));
	// 占位符换回来：`renderMarkdown` 只转义 `&<>"'`，控制符原样穿过，
	// 所以这里一定能在输出里找到它。
	return renderMarkdown(source).replace(
		/\u0001(\d+)\u0001/g,
		(whole, index) => slots[Number(index)] ?? whole,
	);
}

/** 模型自己写出 `\u0001数字\u0001` 时不能让它冒充我们的占位符。 */
function stripSlot(text) {
	return text.includes(MENTION_SLOT) ? text.split(MENTION_SLOT).join("") : text;
}

/**
 * 把 `mentions` 归一化成 `{ offset, end }` 列表：
 *
 * - `offset === -1`（后端没在正文里找到）直接丢——**宁可不亮也不要错位**；
 * - 偏移量必须真的指着一个 `@该成员名`，对不上就是脏数据，丢；
 * - 重叠的只留第一个（后端已经按顺序推进，这里只是兜底）。
 */
function mentionMarks(text, mentions) {
	if (!Array.isArray(mentions)) return [];
	const valid = [];
	for (const mention of mentions) {
		const offset = mention?.offset;
		const label = mention?.label;
		if (typeof offset !== "number" || typeof label !== "string" || offset < 0 || label === "") continue;
		const end = offset + label.length + 1;
		if (text.slice(offset, offset + 1) !== "@") continue;
		if (text.slice(offset + 1, end) !== label) continue;
		valid.push({ offset, end });
	}
	valid.sort((left, right) => left.offset - right.offset);
	const marks = [];
	let cursor = 0;
	for (const mark of valid) {
		if (mark.offset < cursor) continue;
		marks.push(mark);
		cursor = mark.end;
	}
	return marks;
}

/**
 * 正文气泡。
 *
 * 长报告（agent 经常一次输出几百行）在聊天流里会把别的消息全挤出屏幕。
 * 超过 ~28 行就折叠，点「展开全文」再看——和飞书/Slack 的长消息处理一致。
 */
/**
 * 正文气泡。
 *
 * 长文折叠的阈值按 `kind` 分化（#13「上报精简」）：
 *
 * - `chat` / `question`：老板自己读的对话，28 行才折；
 * - `report` / `decision` / `system`：**自动上报**——这类文本由 agent 生成，
 *   动辄几十行把群聊刷屏，老板真正要的是「结论在哪」。所以超过 6 行就折，
 *   只留开头几行当摘要，全文点开看。折叠不丢内容：完整 Markdown 仍然渲染，
 *   只是视觉上收起来。
 *
 * 这个阈值只在**渲染层**：数据、上下文注入、审计都不受影响。
 */
const COLLAPSE_LINES = { chat: 28, question: 28, task: 12, ack: 6, report: 6, decision: 6, system: 6 };

function renderBubble(text, seq, kind = "chat", mentions = []) {
	const html = highlightMentions(text, mentions);
	const lines = (text.match(/\n/g) ?? []).length + 1;
	const limit = COLLAPSE_LINES[kind] ?? 28;
	const long = lines > limit || text.length > (limit >= 28 ? 1600 : limit * 60);
	if (!long) return `<div class="ch-bubble">${html}</div>`;
	// 展开状态存在 state 里而不是 DOM 上：消息流每次轮询全量重渲染，
	// 只改 DOM 的 dataset 等于「点了展开，下一轮又收回去」。
	const open = state.expanded.has(seq);
	return [
		`<div class="ch-bubble" data-collapsed="${open ? "false" : "true"}">${html}</div>`,
		open ? "" : `<button class="ch-expand" type="button" data-seq="${seq}">展开全文（${lines} 行）</button>`,
	].join("");
}

function renderAvatar(message) {
	return avatar(message.fromLabel, 32);
}

/** 日期键：用于插入「今天 / 昨天 / 8月3日」分隔线。 */
function dayKey(at) {
	const date = new Date(at);
	return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

function dayLabel(at) {
	const date = new Date(at);
	const today = new Date();
	const sameDay = (a, b) =>
		a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
	if (sameDay(date, today)) return "今天";
	const yesterday = new Date(today.getTime() - 86_400_000);
	if (sameDay(date, yesterday)) return "昨天";
	return `${date.getMonth() + 1} 月 ${date.getDate()} 日`;
}

function renderMsgHead(message) {
	return [
		`<div class="ch-msg-head">`,
		`<b>${escapeHtml(message.fromLabel)}</b>`,
		message.from === 0 ? `<span class="ch-tag ch-tag--owner">老板</span>` : "",
		`<span class="ch-time">${escapeHtml(clockTime(message.at))}</span>`,
		`</div>`,
	].join("");
}

/**
 * 引用块（#7）：这条消息在回复哪一条。
 *
 * 数据来自服务端 `replyTo`（`src/server/channels-view.ts` 现查原消息算的摘要）。
 * 服务端查不到就不下发这个字段——被引用的消息可能已被 800 条上限裁掉，
 * 也可能早于当前分页，这时界面上什么都不显示，比显示一个点不动的死链好。
 */
function renderQuote(message) {
	const quoted = message.replyTo;
	if (quoted === undefined || quoted === null) return "";
	return [
		`<button class="ch-quote" type="button" data-quote="${quoted.seq}">`,
		`<b>${escapeHtml(quoted.fromLabel)}</b>`,
		`<span>${escapeHtml(quoted.excerpt)}</span>`,
		`</button>`,
	].join("");
}

/** @ 的已读点：灰 = 未读，绿 = 已读。 */
function renderMentions(message) {
	if (message.mentions.length === 0) return "";
	const dots = message.mentions
		.map(
			(mention) =>
				`<span class="ch-mention" title="${escapeAttr(mention.label)}：${mention.read ? "已读" : "未读"}">` +
				`<i data-read="${mention.read ? "true" : "false"}"></i>@${escapeHtml(mention.label)}</span>`,
		)
		.join("");
	return `<div class="ch-mentions">${dots}</div>`;
}

/**
 * 老板这条消息的受理回执（`MessageView.acks`）。
 *
 * 只渲染状态，**不回显 ack 的 text**：那只是本条消息的前 280 字，上面气泡里已有全文。
 * 样式比正文弱一级（muted 小字），它不是消息，是「事件进度」。
 * 后端不给 `acks` 时返回空串（旧后端 / 非老板消息 / 超出装填上限）。
 */
function renderAcks(message) {
	const acks = message.acks ?? [];
	if (acks.length === 0) return "";
	const chips = acks
		.map((ack) => {
			const member = state.view?.members.find((item) => item.id === ack.conversationId);
			const who = member?.label ?? `#${ack.conversationId}`;
			// 后端的 plan 是「立即处理 / 当前工具结束后处理」，从对方视角看就是「它」。
			const plan = ack.plan === "立即处理" ? "立即处理" : ack.plan.replace(/^当前/, "它当前");
			const doing = ack.busyWith === null ? "" : `（${ack.busyWith}）`;
			const title = `${who} · ${plan}${doing} · ${clockTime(ack.at)}`;
			return (
				`<span class="ch-ack" data-busy="${ack.busy ? "true" : "false"}" title="${escapeAttr(title)}">` +
				`已投递给 ${escapeHtml(who)} · ${escapeHtml(plan)}${escapeHtml(doing)}</span>`
			);
		})
		.join("");
	return `<div class="ch-acks">${chips}</div>`;
}

/** 任务 / 回报卡片。 */
function renderCard(message) {
	const taskId = message.refs?.taskId;
	const lines = message.text.split("\n");
	const title = lines[0] ?? "";
	const rest = lines.slice(1).join("\n");
	return [
		`<div class="ch-card" data-kind="${escapeAttr(message.kind)}">`,
		`<div class="ch-card-head">`,
		taskId === undefined ? "" : `<b class="ch-card-id">${escapeHtml(taskId)}</b>`,
		`<span class="ch-card-title">${escapeHtml(title.replace(/^【|】$/g, ""))}</span>`,
		`<span class="ch-time">${escapeHtml(clockTime(message.at))}</span>`,
		`</div>`,
		rest === "" ? "" : `<div class="ch-card-body">${renderMarkdown(rest)}</div>`,
		renderMentions(message),
		`</div>`,
	].join("");
}

function renderMembers() {
	const view = state.view;
	if (view === null || el.members === null) return;
	const html = view.members
		.map(
			// 成员可点：点一下直接进和 TA 的私聊频道（dm:<id>）。
			// 以前是纯文本，看到「林越」想问一句却没法开私聊。
			(member) => [
				`<li class="ch-member" data-role="${escapeAttr(member.role)}">`,
				`<button class="ch-member-btn" type="button" data-dm="${member.id}" title="和 ${escapeAttr(member.label)} 私聊">`,
				avatar(member.label, 22, "ch-av--sm"),
				`<span class="ch-member-main">`,
				// 老板口径（T-34 第 2 项）：显示为「名字(职位)」，职位小字淡色。
				// 以前是上下两行（名字一行、职位一行），老板要求改成同行括号形式。
				`<b>${escapeHtml(member.label)}</b>`,
				`<span class="ch-member-role">(${escapeHtml(roleLabel(member.role))})</span>`,
				`</span>`,
				member.unread > 0 ? `<b class="ch-badge">${member.unread}</b>` : "",
				`</button>`,
				`</li>`,
			].join(""),
		)
		.join("");
	el.members.innerHTML = html;
	for (const button of el.members.querySelectorAll(".ch-member-btn")) {
		button.addEventListener("click", () => {
			const id = Number(button.dataset.dm);
			if (!Number.isFinite(id)) return;
			// 私聊频道由 ensureAllChannels 建好，命名固定 `dm:<conversationId>`
			const dmId = `dm:${id}`;
			const exists = state.channels.some((channel) => channel.id === dmId);
			if (!exists) {
				notify("还没有和这个人的私聊频道", "error");
				return;
			}
			state.expanded.clear();
			openChannel(dmId);
		});
	}
}

const TASK_STATUS_LABEL = {
	todo: "待做",
	doing: "在做",
	blocked: "阻塞",
	review: "待验收",
	done: "已完成",
	cancelled: "已取消",
};

/** 三段的顺序（#11）：在做 → 待做 → 已完成。取消的单独沉底。 */
const TASK_SECTIONS = [
	{ key: "active", label: "在做", statuses: ["doing", "review", "blocked"] },
	{ key: "todo", label: "待做", statuses: ["todo"] },
	{ key: "done", label: "已完成", statuses: ["done", "cancelled"] },
];

/**
 * 侧栏任务区（#11 任务可追溯）。
 *
 * 旧实现是一条平铺列表，只显示 id / 标题 / 状态——老板从上面看不出
 * 「谁在做、做了多久、烧了多少钱」，那正是 #11 要的。
 *
 * 现在按三段分组，每条补两行元信息：
 * - 在做 / 已完成：耗时（`startedAt` → `doneAt ?? now`）
 * - 已完成：token 与成本（`usage`，由后端在 `done` 时结算）
 *
 * 耗时每秒都在变，所以**不在这里自己定时重绘**——会话流本来就会周期性刷新
 * （SSE / 轮询），`viewSignature` 会带上时间，跟着一起更新就够了。
 */
function renderTasks() {
	const view = state.view;
	if (view === null || el.tasks === null) return;
	if (view.tasks.length === 0) {
		el.tasks.innerHTML = `<li class="ch-empty ch-empty--inline">还没有任务</li>`;
		return;
	}
	const now = Date.now() + state.clockSkew;
	const rows = [];
	for (const section of TASK_SECTIONS) {
		const items = view.tasks.filter((task) => section.statuses.includes(task.status));
		// 「已完成」只留最近 5 条：任务多了以后侧栏会被历史撑满
		const shown = section.key === "done" ? items.slice(-5).reverse() : items;
		if (shown.length === 0) continue;
		rows.push(`<li class="ch-task-group">${escapeHtml(section.label)} · ${items.length}</li>`);
		for (const task of shown) rows.push(taskRowHtml(task, now));
	}
	el.tasks.innerHTML = rows.join("");
}

/** 一条任务：标题行 + 一行元信息（负责人 / 耗时 / 用量）。 */
function taskRowHtml(task, now) {
	const meta = [];
	const assignee = state.view?.members.find((member) => member.id === task.assignee);
	if (assignee !== undefined) meta.push(escapeHtml(assignee.label));
	const elapsed = elapsedLabel(task, now);
	if (elapsed !== "") meta.push(elapsed);
	if (task.usage !== undefined && task.usage.tokens > 0) {
		// 成本低于 1 分钱时不显示：`$0.00` 只会让人以为没花钱
		const cost = task.usage.costUsd >= 0.01 ? ` · ${formatCost(task.usage.costUsd)}` : "";
		meta.push(`${formatTokens(task.usage.tokens)}${cost}`);
	}
	return [
		`<li class="ch-task" data-status="${escapeAttr(task.status)}">`,
		`<span class="ch-task-title" title="${escapeAttr(task.title)}">`,
		`<span class="ch-task-id">${escapeHtml(task.id)}</span>`,
		escapeHtml(task.title),
		`</span>`,
		`<span class="ch-task-status">${escapeHtml(TASK_STATUS_LABEL[task.status] ?? task.status)}</span>`,
		meta.length === 0 ? "" : `<span class="ch-task-meta">${meta.join(" · ")}</span>`,
		`</li>`,
	].join("");
}

/**
 * 「做了 2 小时 15 分」；没有 `startedAt` 返回空串。
 *
 * `now` 由调用方传入，且已经过 `clockSkew` 校正：任务时间戳是服务端写的，
 * 拿本机时钟当「现在」会把本机偏差算进耗时（本机快 3 分会显示「-3 分钟」）。
 */
function elapsedLabel(task, now) {
	const start = task.startedAt;
	if (start === undefined) return "";
	// 终态用 `doneAt` 定格；还在跑就是「到现在为止」——所以每轮渲染都要重算（`now` 是入参）
	const end = task.doneAt ?? now;
	const ms = end - start;
	// 校正后仍然为负：本机时钟和服务端的偏差比 `clockSkew` 捕捉到的还大
	// （比如页面开了很久没刷新）。宁说「刚刚」，不显示一个负号让人怀疑数据坏了。
	if (ms < 0) return "刚刚";
	if (ms < 60_000) return "不到 1 分钟";
	const minutes = Math.floor(ms / 60_000);
	if (minutes < 60) return `${minutes} 分钟`;
	const hours = Math.floor(minutes / 60);
	const rest = minutes % 60;
	if (hours < 24) return rest === 0 ? `${hours} 小时` : `${hours} 小时 ${rest} 分`;
	return `${Math.floor(hours / 24)} 天`;
}

function renderBodyError(message) {
	if (el.body === null) return;
	el.body.innerHTML = `<div class="ch-empty">${escapeHtml(message)}</div>`;
}

/**
 * 滚到消息区底部（D-012）。
 *
 * **为什么不能只写 `el.body.scrollTop = el.body.scrollHeight`**（旧实现）：
 *
 * 1. `.ch-body` 在 `channels.css:304` 声明了 `scroll-behavior: smooth`，
 *    此时给 `scrollTop` 赋值**不会立即到位**，而是启动一段平滑动画。
 *    页面刚刷新、频道刚加载时，紧随的 `renderList()`（会重写左栏 DOM）、
 *    首帧构图、字体/头像解码都可能打断这段动画 —— 动画被取消后就停在原位（顶部）。
 *    这就是「刷新后消息停在最上面」的直接原因，而不是 `scrollHeight` 读到了旧值：
 *    `scrollHeight` 是布局属性，访问时会**强制同步 reflow**，拿到的总是当前最新值。
 * 2. 即使能到位，也只在「内容已定高」时成立；本函数另加一帧重试兜底，
 *    因为首帧时 `.ch-body` 可能刚被 `hidden` 切回来、或被父级布局推迟。
 *
 * 实现：先临时关掉平滑（瞬时赋值），再等一帧确认，必要时重试一次。
 * 不挂 `scrollend`（浏览器支持参差），也不用定时器轮询。
 */
function scrollToBottom() {
	if (el.body === null) return;
	// 关掉平滑：本次是「直接看最新消息」，不该让用户看一小段滚动动画。
	// 必须恢复原值 —— 否则后续用户手动滚动也会失去平滑。
	const previous = el.body.style.scrollBehavior;
	el.body.style.scrollBehavior = "auto";
	const jump = () => {
		if (el.body === null) return;
		el.body.scrollTop = el.body.scrollHeight;
	};
	jump();
	// 等一帧：首帧后布局可能才最终定稿（父级 tick、字体度量、flex 行高）。
	// 若仍未到底（`scrollHeight === 0` 说明当时还不可布局，或高度变了），再补一次。
	if (typeof requestAnimationFrame === "function") {
		requestAnimationFrame(() => {
			if (el.body === null) return;
			const gap = el.body.scrollHeight - el.body.scrollTop - el.body.clientHeight;
			// 容差 2px：亚像素舍入会让 gap 恒为 0.5 之类的小值。
			if (gap > 2) jump();
			el.body.style.scrollBehavior = previous;
		});
	} else {
		// 无 rAF（极旧环境）时退回同步恢复，保持行为与改动前一致。
		el.body.style.scrollBehavior = previous;
	}
}

function roleLabel(role) {
	return { owner: "老板", ceo: "CEO", management: "管理层", leader: "项目负责人", staff: "员工" }[role] ?? role;
}

// ── 输入框：@ 选择器 ──────────────────────────────────────────────────────

async function loadMentionCandidates() {
	if (state.activeId === null) return;
	try {
		const data = await fetchJson(`/api/channels/${encodeURIComponent(state.activeId)}/mentionable`);
		state.mentionCandidates = Array.isArray(data.candidates) ? data.candidates : [];
	} catch {
		state.mentionCandidates = [];
	}
}

function onInput() {
	autoSize();
	updateMentionPopup();
}

function autoSize() {
	if (el.input === null) return;
	el.input.style.height = "auto";
	el.input.style.height = `${Math.min(el.input.scrollHeight, 160)}px`;
}

/** 光标前是否正在输入 @。 */
function detectMention(value, caret) {
	const before = value.slice(0, caret);
	const at = before.lastIndexOf("@");
	if (at < 0) return null;
	// `@` 前一个字符必须是空白或行首：否则 `a@b.com`、`foo@bar` 也会弹候选
	if (at > 0 && !/[\s(（【\[]/.test(before[at - 1])) return null;
	// @ 后面不能有空格（否则已经不是在选人）
	const query = before.slice(at + 1);
	if (/\s/.test(query)) return null;
	return { start: at, query };
}

function updateMentionPopup() {
	if (el.input === null || el.mention === null) return;
	const detected = detectMention(el.input.value, el.input.selectionStart ?? 0);
	if (detected === null) {
		el.mention.hidden = true;
		state.mentionStart = -1;
		state.mentionItems = [];
		return;
	}
	state.mentionStart = detected.start;
	state.mentionQuery = detected.query;
	const query = detected.query.toLowerCase();
	const list = state.mentionCandidates.filter((candidate) => candidate.label.toLowerCase().includes(query));
	if (list.length === 0) {
		el.mention.hidden = true;
		state.mentionItems = [];
		return;
	}
	const items = list.slice(0, 8);
	state.mentionItems = items;
	// 高亮项越界就夹回来（用户打字把候选从 8 个筛到 2 个时）
	if (state.mentionActive >= items.length) state.mentionActive = 0;
	el.mention.hidden = false;
	el.mention.innerHTML = items
		.map(
			(candidate, index) =>
				`<button type="button" class="ch-mention-item" data-label="${escapeAttr(candidate.label)}"` +
				` data-active="${index === state.mentionActive ? "true" : "false"}">` +
				avatar(candidate.label, 18, "ch-av--xs") +
				`<b>${escapeHtml(candidate.label)}</b>` +
				`<span>${escapeHtml(roleLabel(candidate.role))}</span>` +
				`</button>`,
		)
		.join("");
	for (const button of el.mention.querySelectorAll(".ch-mention-item")) {
		// mousedown 里 preventDefault：否则 input 先 blur，弹层被关掉，click 永远到不了
		button.addEventListener("mousedown", (event) => {
			event.preventDefault();
			insertMention(button.dataset.label);
		});
	}
	el.mention.querySelectorAll(".ch-mention-item").forEach((button, index) => {
		button.addEventListener("mousemove", () => {
			if (state.mentionActive === index) return;
			state.mentionActive = index;
			el.mention.querySelectorAll(".ch-mention-item").forEach((other, otherIndex) => {
				other.dataset.active = otherIndex === index ? "true" : "false";
			});
		});
	});
}

/** 上下键移动高亮（不重渲染整段：只改 data-active，避免闪烁与丢焦点）。 */
function moveMentionActive(step) {
	const count = state.mentionItems.length;
	if (count === 0) return;
	state.mentionActive = (state.mentionActive + step + count) % count;
	if (el.mention === null) return;
	const buttons = el.mention.querySelectorAll(".ch-mention-item");
	buttons.forEach((button, index) => {
		button.dataset.active = index === state.mentionActive ? "true" : "false";
	});
	buttons[state.mentionActive]?.scrollIntoView({ block: "nearest" });
}

/** 选中当前高亮的候选。 */
function pickMentionActive() {
	const item = state.mentionItems[state.mentionActive];
	if (item === undefined) return false;
	insertMention(item.label);
	return true;
}

function insertMention(label) {
	if (el.input === null) return;
	const value = el.input.value;
	const start = state.mentionStart >= 0 ? state.mentionStart : value.lastIndexOf("@");
	if (start < 0) return;
	const caret = el.input.selectionStart ?? value.length;
	const next = `${value.slice(0, start)}@${label} ${value.slice(caret)}`;
	el.input.value = next;
	const position = start + label.length + 2;
	el.input.setSelectionRange(position, position);
	el.input.focus();
	el.mention.hidden = true;
	autoSize();
}

// ── 交互 ──────────────────────────────────────────────────────────────────

/**
 * 提示。
 *
 * 曾经只 dispatch 一个 `aic:toast` CustomEvent —— 全前端**零监听器**，
 * 所以「发送失败」是彻底静默的。现在由 app.js 注入真正的 toast。
 */
let toast = null;
/** #2：频道里的角色档案面板（initChannels 里赋值）。 */
let profile = null;
function notify(text, tone = "info") {
	if (toast !== null) toast(text, tone);
	else if (tone === "error") console.error("[频道]", text);
}

/** 挂载到 #channels 容器（由 app.js 在切到频道视图时调用）。 */
export function initChannels({ onToast, fetchProfile } = {}) {
	toast = typeof onToast === "function" ? onToast : null;
	el.root = $("channels");
	if (el.root === null) return { refresh: () => {}, open: () => {} };
	el.layout = el.root.querySelector(".ch-layout");
	if (el.layout !== null) el.layout.dataset.pane = "list";
	el.list = $("ch-list");
	el.title = $("ch-title");
	el.sub = $("ch-sub");
	el.body = $("ch-body");
	el.input = $("ch-input");
	el.send = $("ch-send");
	el.members = $("ch-members");
	el.tasks = $("ch-tasks");
	el.announcer = $("ch-announcer");
	el.mention = $("ch-mention-popup");
	el.side = $("ch-side");
	el.sideToggle = $("ch-side-toggle");
	el.fold = $("ch-fold");
	el.dock = $("ch-dock");
	el.actions = $("ch-msg-actions");
	el.replyBar = $("ch-reply-bar");
	el.replyText = $("ch-reply-text");
	el.replyCancel = $("ch-reply-cancel");

	// 待办卡片：答复/处置成功后重拉一次频道，让卡片从流里消失。
	// 不直接删 DOM——成功与否的真相在后端，重拉一次最不容易两边不一致。
	pendingCards = initPending({
		onSettled: () => {
			if (state.activeId !== null) void openChannel(state.activeId, { userInitiated: false });
		},
	});
	// 卡片在消息流里，每次轮询都整段重建，所以用事件委托（逐卡绑定会每轮泄漏 listener）。
	// 另外：滚动到顶才武装上翻哨兵（老板 #2「乱滚」的修法，详见 armActivitySentinel）。
	// 「想往上翻」只认人手动作；`scroll` 事件程序化滚动也会触发，靠它判会连翻历史。
	el.body?.addEventListener("wheel", onUserScrollAttempt, { passive: true });
	el.body?.addEventListener("touchmove", onUserScrollAttempt, { passive: true });
	el.body?.addEventListener("keydown", (event) => {
		if (event.key === "ArrowUp" || event.key === "PageUp" || event.key === "Home") onUserScrollAttempt();
	});
	el.body?.addEventListener("click", (event) => {
		if (pendingCards.onClick(event)) event.preventDefault();
	});
	el.body?.addEventListener("submit", (event) => {
		pendingCards.onSubmit(event);
	});
	el.body?.addEventListener("keydown", (event) => {
		pendingCards.onKeydown(event);
	});

	// #2：角色档案面板。与对话面板共用 profile.js，只是挂载到 #ch-dock、
	// 由 #ch-fold 控制。`fetchProfile` 由 initChannels 的 options 注入（app.js 提供）。
	profile = initProfile({
		fetchProfile: typeof fetchProfile === "function" ? fetchProfile : undefined,
		dock: el.dock,
		trigger: el.fold,
		variant: "side",
		onToggle: (open) => {
			if (el.fold === null) return;
			el.fold.dataset.state = open ? "open" : "closed";
			el.fold.setAttribute("aria-expanded", String(open));
		},
	});
	el.fold?.addEventListener("click", () => {
		const id = activityStaffId();
		if (id === null) return;
		if (profile.isOpen()) profile.close();
		else profile.open(id, { label: state.view?.channel.title ?? "职工" });
	});

	// #5：点消息弹浮窗（复制 / 引用回复）。
	// 用事件委托：消息流每次刷新都全量重建，逐条绑定会漏、也会泄漏 listener。
	el.body?.addEventListener("click", (event) => {
		const target = event.target instanceof Element ? event.target : null;
		if (target === null) return;
		// 点在按钮 / 链 / 待办卡片 / 展开全文上时不弹浮窗（那些控件有自己的行为）
		if (target.closest("button, a, .pend, .ch-card, details, summary") !== null) return;
		const message = target.closest(".ch-msg[data-seq]");
		if (!(message instanceof HTMLElement)) {
			closeActions();
			return;
		}
		openActions(message, message);
	});
	el.body?.addEventListener("scroll", () => closeActions(), { passive: true });

	el.actions?.addEventListener("click", async (event) => {
		const button = event.target instanceof Element ? event.target.closest(".ch-action") : null;
		if (!(button instanceof HTMLElement)) return;
		const seq = state.actionSeq;
		const found = state.view?.messages.find((item) => item.seq === seq);
		closeActions();
		if (found === undefined) return;
		if (button.dataset.action === "copy") {
			const ok = await copyText(found.text);
			notify(ok ? "已复制" : "复制失败，请手动选中", ok ? "info" : "error");
			return;
		}
		setReplyTo({ seq: found.seq, label: found.fromLabel, text: found.text });
	});

	// #7：点引用块跳到被引用的那条（找不到就提示，不要静默无反应）
	el.body?.addEventListener("click", (event) => {
		const button = event.target instanceof Element ? event.target.closest(".ch-quote") : null;
		if (!(button instanceof HTMLElement)) return;
		const seq = Number(button.dataset.quote);
		const target = el.body?.querySelector(`.ch-msg[data-seq="${seq}"]`);
		if (!(target instanceof HTMLElement)) {
			notify("原消息已不在当前范围（可能太早，或被 800 条上限裁掉了）", "info");
			return;
		}
		target.scrollIntoView({ block: "center", behavior: "smooth" });
		target.dataset.flash = "true";
		setTimeout(() => {
			delete target.dataset.flash;
		}, 1200);
	});

	el.replyCancel?.addEventListener("click", () => setReplyTo(null));
	// 点空白处 / Esc 关浮窗（用 pointerdown，这样点完立刻消失而不会先触发 click）
	document.addEventListener(
		"pointerdown",
		(event) => {
			if (el.actions === null || el.actions.hidden) return;
			const target = event.target instanceof Node ? event.target : null;
			if (target === null) return;
			if (el.actions.contains(target)) return;
			closeActions();
		},
		{ passive: true },
	);
	window.addEventListener("keydown", (event) => {
		if (event.key === "Escape") closeActions();
	});

	$("ch-back")?.addEventListener("click", () => {
		if (el.layout !== null) el.layout.dataset.pane = "list";
		// #4：手机上「返回频道列表」必须顺手收起成员浮层，否则成员栏会盖在列表上
		if (state.membersOpen) {
			state.membersOpen = false;
			applyMembersOpen();
		}
	});

	// 成员栏开关（UX-6）：只切 state + 重写 DOM 属性，不重拉数据、不重建 DOM。
	el.sideToggle?.addEventListener("click", () => {
		state.membersOpen = !state.membersOpen;
		applyMembersOpen();
	});

	el.send?.addEventListener("click", () => sendMessage(el.input?.value ?? ""));
	el.input?.addEventListener("input", onInput);
	el.input?.addEventListener("keydown", (event) => {
		// **中文输入法**：选候选词时按 Enter 也会触发 keydown，key 同样是 "Enter"。
		// 不挡住就会把拼音/半截中文直接发出去（chat.js 早就有这个判断，频道漏了）。
		if (event.isComposing || event.keyCode === 229) return;

		const popupOpen = el.mention !== null && !el.mention.hidden;
		if (popupOpen) {
			if (event.key === "ArrowDown" || event.key === "ArrowUp") {
				event.preventDefault();
				moveMentionActive(event.key === "ArrowDown" ? 1 : -1);
				return;
			}
			if ((event.key === "Enter" || event.key === "Tab") && !event.shiftKey) {
				event.preventDefault();
				if (pickMentionActive()) return;
			}
			if (event.key === "Escape") {
				event.preventDefault();
				el.mention.hidden = true;
				state.mentionItems = [];
				return;
			}
		}

		if (event.key === "Enter" && !event.shiftKey) {
			event.preventDefault();
			sendMessage(el.input?.value ?? "");
		}
	});

	// 切到频道视图时才加载（避免启动就多两个请求）
	let loaded = false;
	const ensureLoaded = async () => {
		if (loaded) return;
		loaded = true;
		try {
			await loadChannels();
		} catch {
			// 失败要允许重试：以前 loaded 在 await 前就置 true，一次失败就永久空白
			loaded = false;
		}
	};

	// org SSE 推送 → 刷新（节流）
	let pending = null;
	window.addEventListener("aic:org", () => {
		if (document.body.dataset.view !== "channels") return;
		if (pending !== null) return;
		pending = window.setTimeout(async () => {
			pending = null;
			await loadChannels();
			// 手机停在列表页时不要自动进会话（会把人踢离列表并顺手标已读）
			const onListPane = el.layout === null || el.layout.dataset.pane !== "main";
			const narrow = window.matchMedia("(max-width: 860px)").matches;
			if (state.activeId !== null && !(narrow && onListPane)) {
				await openChannel(state.activeId, { userInitiated: false });
			}
		}, 400);
	});

	return {
		async refresh() {
			await ensureLoaded();
			if (state.activeId !== null) {
				await loadMentionCandidates();
			}
		},
		/** 切换频道后必须重拉候选：@ 列表是「本频道成员」，不然会 @ 到不在群里的人。 */
		reloadCandidates: loadMentionCandidates,
		open: openChannel,
		loadMentionCandidates,
	};
}
