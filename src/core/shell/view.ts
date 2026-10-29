/**
 * 把核心的状态翻译成**界面要的那份 JSON**。
 *
 * 这一层只有一个职责：把文件夹与频道翻译成 `ui/web/js/` 要吃的 JSON。
 * 核心的真相是 slug 与文件，界面要的是排序过的列表与可点的锚点，翻译在这。
 *
 * 两个「界面需要、核心不需要」的概念，是这一层存在的全部理由：
 * - **数字 id**：界面到处用 `conversationId` 做 key（成员、@ 对象、看板卡片）。
 *   核心的稳定标识是 slug，但界面上要一个能排序、能当 DOM 属性的东西。这里把
 *   slug → 会话 id 的映射拿出来当 id 用，界面对它一无所知。
 * - **`kind`**：界面按 `company/leadership/project/dm` 分组。核心没有频道类型，
 *   这里从频道 id 前缀猜（`dm:` → dm，`proj:` → project，其余 → company）。
 */
import { OWNER_SLUG, type Identity } from "../agent/identity.ts";
import { conversationFor, type DirectoryState } from "../agent/roster.ts";
import {
	readMarkOf,
	unreadCount,
	type Attachment,
	type Channel,
	type ChannelState,
	type Message,
} from "../channel/state.ts";

/** 界面用的频道种类。核心没有频道类型，从 id 前缀反推。 */
export type ViewChannelKind = "company" | "leadership" | "project" | "dm";

/** 频道列表项。 */
export type ViewChannel = {
	id: string;
	kind: ViewChannelKind;
	/** 仅 `kind === "project"` 时有：这个项目归谁负责（`README.md` 的 `owner`）。 */
	owner?: string;
	/** 仅 `kind === "project"` 时有：负责人显示名。 */
	ownerLabel?: string;
	/**
	 * 仅 `kind === "project"` 且项目文档写了 `doing` 时有：一句话现状。
	 * 界面拿它当顶栏副标题的第一段；缺了这个键就什么都不画。
	 */
	doing?: string;
	title: string;
	project?: string;
	unread: number;
	mentions: number;
	preview: string;
	lastAt: number;
	lastSeq: number;
	memberCount: number;
};

/** 一条消息。 */
export type ViewMessage = {
	seq: number;
	at: number;
	from: number;
	fromSlug: string;
	fromLabel: string;
	kind: string;
	text: string;
	mentions: { id: number; label: string; read: boolean; offset: number }[];
	replyTo?: { seq: number; from: number; fromSlug: string; fromLabel: string; excerpt: string };
	read: boolean;
	/** T-016：生成状态。undefined/done = 正常；pending = 占位 loading；error = 生成失败。 */
	status?: "pending" | "done" | "error";
	/** T-016：占位归属的被唤醒人 slug。 */
	pendingFor?: string;
	/** B（通用处理中指示）：该消息是否为「开始处理…」动画占位（前端渲染动画行）。 */
	processing?: boolean;
	/** 这一轮真正开始的时刻（ADR-072）。缺省时界面退回第一条过程行的 `at`。 */
	startedAt?: number;
	/**
	 * 这条要不要老板本人看一眼。
	 *
	 * 判据在核心（`needsOwner` + 显式 @ 老板），这里只做投影 —— 界面不该自己猜关键词。
	 * 老板自己说的话永不算「需要你」。
	 */
	needsYou?: true;
	/**
	 * 附件（图片/文件）。没有附件时**不出现这个字段** —— 界面用 `?.length` 判一下够了，
	 * 不用区分「空数组」与「没有」两种差不多的状态。
	 */
	attachments?: Attachment[];
};

/** 成员。 */
export type ViewMember = { id: number; slug: string; label: string; role: string; unread: number };

/** 频道详情。 */
export type ViewChannelDetail = {
	channel: Omit<ViewChannel, "unread" | "mentions" | "preview">;
	members: ViewMember[];
	messages: ViewMessage[];
	hasMore: boolean;
	serverNow: number;
};

/**
 * 组织快照。
 *
 * 只装**界面真会看**的东西。「有没有新消息」靠 SSE 这条事件本身通知（界面收到就重拉列表），
 * 所以早先那版为旧界面凑的 `projects` / `pending` / `costs` / `links` / `ceoQueue` 全删了 ——
 * 那些字段一个消费者也没有，留着只会让下一个人以为「这里有业务概念」。
 */
export type ViewOrg = {
	company: { name: string };
	/** 全部人，按「离老板最近」优先排序（第一项是那个直接向老板汇报的人）。 */
	people: ViewActor[];
};

/** 组织图上的一个人。 */
export type ViewActor = {
	/** 稳定标识。核心只用这个。 */
	slug: string;
	label: string;
	title: string;
	project?: string;
	manager?: string;
	managerLabel?: string;
	/** `identity.md` 正文 —— 档案页要显示「他是谁」，只有 slug 不够。 */
	body: string;
};

/** 频道 id → 界面种类。核心没有类型这个概念，只能从命名约定反推。 */
function kindOf(id: string): ViewChannelKind {
	if (id.startsWith("dm:")) return "dm";
	if (id.startsWith("proj:")) return "project";
	if (id.startsWith("lead:")) return "leadership";
	return "company";
}

/** 由 slug 拿界面 id（会话号）。名册里没有的给 -1，界面上会显示成一串连不上的节点。 */
function idOf(directory: DirectoryState, slug: string): number {
	if (slug === OWNER_SLUG) return 0;
	return conversationFor(directory, slug) ?? -1;
}

/** 一条消息的正文预览：只取第一行、最多 60 字。 */
/** 「人说的话」的几种 kind。侧栏预览与「找你」共用 —— 过程投影与系统告警都不算。 */
const SPOKEN_KINDS = new Set(["chat", "say", "question", "decision", "report"]);

function previewOf(message: Message | undefined): string {
	if (message === undefined) return "";
	const first = message.text.split("\n").find((line) => line.trim() !== "") ?? "";
	const flat = first.trim();
	return flat.length > 60 ? `${flat.slice(0, 60)}…` : flat;
}

/**
 * 在正文里找 `@slug` 的位置。
 *
 * 前端用它把 @ 高亮成可点的 chip（`mentionMarks` 会校验 `text.slice(offset)` 真的是
 * `@label`，算错就不亮——所以这里算不出来时给 -1 比给个错位置好）。
 */
function offsetOf(text: string, label: string): number {
	const needle = `@${label}`;
	const at = text.indexOf(needle);
	return at < 0 ? -1 : at;
}

/**
 * 「项目归谁负责」的查询函数。
 *
 * 它来自 `projects/<slug>/README.md` —— 真相在文件里，不在频道文档里。所以这里只收
 * 一个查表函数，而不是把项目文档搬进频道状态（那会造出第二份会漂的副本）。
 */
export type ProjectOwnerOf = (project: string) => string | undefined;

/** 「这个项目的一句话现状」的查询函数。来源同上（项目文档的 `doing`）。 */
export type ProjectDoingOf = (project: string) => string | undefined;

/** 频道列表。 */
export function channelList(
	state: ChannelState,
	directory: DirectoryState,
	slug = OWNER_SLUG,
	projectOwnerOf?: ProjectOwnerOf,
	projectDoingOf?: ProjectDoingOf,
): ViewChannel[] {
	const out: ViewChannel[] = [];
	for (const channel of Object.values(state.channels)) {
		if (channel.archived === true) continue;
		const messages = state.messages[channel.id] ?? [];
		const last = messages[messages.length - 1];
		// 侧栏预览只取「人说的话」。两层挑：
		//
		// 1. 优先 `SPOKEN_KINDS`（真的在对人说话的那几种）。
		// 2. 一层都没有时退回「最后一条非 note 的」。
		//
		// 为什么要分两层：`work`/`tool` 是运行时记的命令行与工具名，一条频道里
		// 大量出现（实测侧栏整列显示 `$ cd /Users/kirer/projects/...`）。拿它当预览，
		// 老板扫一眼会以为这个频道里没人说话，全是机器输出 —— 而其实下面就有正常对话。
		// `note` 是系统告警（接力到上限、投递失败），同理不能当预览。
		const lastSpoken =
			messages.findLast((item) => SPOKEN_KINDS.has(item.kind)) ??
			messages.findLast((item) => item.kind !== "note");
		const unread = unreadCount(state, channel.id, slug);
		// 「@ 我」的条数：未读里点名提到我的那些。界面上它们比普通未读更红。
		//
		// 个人频道（dm:owner-<slug>）里，agent 自己的「过程投影」消息（kind 为
		// say/think/tool，见 projector.ts）是从它所在群/项目的发言镜像过来的，
		// 不是它主动在私聊里 @ 老板。这类镜像如果正文里带了 `@owner`（最常见就是
		// 它在群里回老板时被解析出的 mention），会让老板的个人频道误亮红点。
		// 因此这里把投影镜像排除出「@ 我」计数 —— 真实在私聊里 @ 老板的消息
		// （kind 为 chat/question，由 say 工具发出）照常计数，口径 A 不倒退。
		const isPersonalMirror = (message: Message): boolean =>
			kindOf(channel.id) === "dm" &&
			(message.kind === "say" || message.kind === "think" || message.kind === "tool");
		const mentions = messages.filter(
			(message) =>
				!isPersonalMirror(message) &&
				message.seq > readMarkOf(state, slug, channel.id) &&
				message.mentions.includes(slug),
		).length;
		const project = channel.id.startsWith("proj:") ? channel.id.slice("proj:".length) : undefined;
		const owner = project === undefined ? undefined : projectOwnerOf?.(project);
		const doing = project === undefined ? undefined : projectDoingOf?.(project);
		out.push({
			id: channel.id,
			kind: kindOf(channel.id),
			...(owner === undefined || owner === "" ? {} : { owner, ownerLabel: labelIn(directory, owner) }),
			...(doing === undefined || doing === "" ? {} : { doing }),
			title: channel.title,
			...(project === undefined ? {} : { project }),
			unread,
			mentions,
			preview: previewOf(lastSpoken),
			lastAt: last?.at ?? channel.createdAt,
			lastSeq: last?.seq ?? 0,
			memberCount: channel.members.length,
		});
	}
	// 界面期望「最近的在前」。
	return out.sort((left, right) => right.lastAt - left.lastAt);
}

/**
 * 「这条要不要老板看一眼」。
 *
 * 老板自己说的话不算（他不需要提醒自己）。判据只有一条：消息显式 @了老板。
 *
 * 旧逻辑用 `needsOwner` 做关键词嗅探（「要不要/请确认/等你定」），会把没点老板的
 * 普通 @同事 协作消息误标「需要我」—— 这正是 #4 要修的误标。关键词嗅探已移除，
 * `needsOwner` 现在恒返回 false，这里只认显式 @owner。
 */
function needsYou(message: Message): boolean {
	if (message.from === OWNER_SLUG) return false;
	return message.mentions.includes(OWNER_SLUG);
}

/** 一条消息的视图。 */
export function messageView(
	state: ChannelState,
	channel: Channel,
	message: Message,
	directory: DirectoryState,
	viewer = OWNER_SLUG,
): ViewMessage {
	const labelOf = (slug: string) => labelIn(directory, slug);
	const quoted = message.replyTo === undefined ? undefined : (state.messages[channel.id] ?? []).find((item) => item.seq === message.replyTo);
	const excerptSource = quoted?.text.split("\n").find((line) => line.trim() !== "")?.trim() ?? "";
	return {
		seq: message.seq,
		at: message.at,
		from: idOf(directory, message.from),
		fromSlug: message.from,
		fromLabel: labelOf(message.from),
		kind: message.kind,
		text: message.text,
		mentions: message.mentions.map((slug) => ({
			id: idOf(directory, slug),
			label: labelOf(slug),
			read: readMarkOf(state, slug, channel.id) >= message.seq,
			offset: offsetOf(message.text, slug),
		})),
		...(quoted === undefined
			? {}
			: {
					replyTo: {
						seq: quoted.seq,
						from: idOf(directory, quoted.from),
						fromSlug: quoted.from,
						fromLabel: labelOf(quoted.from),
						excerpt: excerptSource.length > 60 ? `${excerptSource.slice(0, 60)}…` : excerptSource,
					},
				}),
		read: readMarkOf(state, viewer, channel.id) >= message.seq,
		...(message.status === undefined ? {} : { status: message.status }),
		...(message.pendingFor === undefined ? {} : { pendingFor: message.pendingFor }),
		...(message.processing === undefined || message.processing === false ? {} : { processing: true }),
		...(message.startedAt === undefined ? {} : { startedAt: message.startedAt }),
		// 附件只透传引用（id/name/kind/bytes），文件本体走 `/api/uploads/:id`。
		// 逐字段重建是为了固定键顺序：这份 JSON 也会进 SSE 与提示词，字节要确定。
		...(message.attachments === undefined || message.attachments.length === 0
			? {}
			: {
					attachments: message.attachments.map((item) => ({
						id: item.id,
						name: item.name,
						kind: item.kind,
						bytes: item.bytes,
					})),
				}),
		...(needsYou(message) ? { needsYou: true as const } : {}),
	};
}

/** 频道详情。`limit` 给最近 N 条，`before` 往前翻页。 */
export function channelDetail(
	state: ChannelState,
	channel: Channel,
	directory: DirectoryState,
	options: {
		readonly limit?: number;
		readonly before?: number;
		readonly viewer?: string;
		readonly projectOwnerOf?: ProjectOwnerOf;
		readonly projectDoingOf?: ProjectDoingOf;
	} = {},
): ViewChannelDetail {
	const viewer = options.viewer ?? OWNER_SLUG;
	const all = state.messages[channel.id] ?? [];
	const limit = Math.min(Math.max(options.limit ?? 60, 1), 200);
	const upper = options.before === undefined ? all.length : all.findIndex((item) => item.seq >= (options.before as number));
	const end = upper < 0 ? all.length : upper;
	const start = Math.max(0, end - limit);
	const page = all.slice(start, end);
	const last = page[page.length - 1];
	const projectSlug = channel.id.startsWith("proj:") ? channel.id.slice("proj:".length) : undefined;
	const ownerSlug = projectSlug === undefined ? undefined : options.projectOwnerOf?.(projectSlug);
	const doing = projectSlug === undefined ? undefined : options.projectDoingOf?.(projectSlug);
	// 个人频道显示成那个人的名字 —— 频道建立时标题就是它，这里不重复计算。
	return {
		channel: {
			id: channel.id,
			kind: kindOf(channel.id),
			...(ownerSlug === undefined || ownerSlug === ""
				? {}
				: { owner: ownerSlug, ownerLabel: labelIn(directory, ownerSlug) }),
			...(doing === undefined || doing === "" ? {} : { doing }),
			title: channel.title,
			...(projectSlug === undefined ? {} : { project: projectSlug }),
			lastAt: last?.at ?? channel.createdAt,
			lastSeq: last?.seq ?? 0,
			memberCount: channel.members.length,
		},
		members: channel.members.map((slug) => ({
			id: idOf(directory, slug),
			slug,
			label: labelIn(directory, slug),
			// `role` 的价值在界面：项目频道里要一眼看出谁是负责人。只用三种能从文件里
			// 读出来的事实（老板 / 项目负责人 / 成员），不引岗位枚举。
			role:
				slug === OWNER_SLUG
					? "owner"
					: ownerSlug !== undefined && slug === ownerSlug
						? "lead"
						: "member",
			unread: unreadCount(state, channel.id, slug),
		})),
		messages: page.map((message) => messageView(state, channel, message, directory, viewer)),
		hasMore: start > 0,
		serverNow: Date.now(),
	};
}

/**
 * 组织快照。
 *
 * 只给「有谁、谁向谁汇报」这两件事。人按「离老板最近」优先排序：`manager` 是老板的
 * 排最前，其余按报名顺序 —— 界面左侧成员列表直接用这个顺序。
 */
export function orgView(identities: readonly Identity[], directory: DirectoryState, companyName = "Solo"): ViewOrg {
	const toActor = (identity: Identity): ViewActor => ({
		slug: identity.slug,
		label: identity.name ?? identity.slug,
		title: identity.title ?? "",
		...(identity.project === undefined ? {} : { project: identity.project }),
		...(identity.manager === undefined ? {} : { manager: identity.manager }),
		...(identity.manager === undefined ? {} : { managerLabel: labelIn(directory, identity.manager) }),
		body: identity.body,
	});

	// 知言（老板唯一直接对话的助理）固定排第一（pin to top）：任何成员/团队列表恒首位。
	const pinned = identities.filter((identity) => identity.slug === "知言");
	const rest = identities.filter((identity) => identity.slug !== "知言");
	return {
		company: { name: companyName },
		people: [...pinned.map(toActor), ...nearestOf(rest).map(toActor), ...othersOf(rest).map(toActor)],
	};
}

/** 离老板最近（manager 是老板）的排在前面，其余按原序。 */
function nearestOf(identities: readonly Identity[]): readonly Identity[] {
	return identities.filter((identity) => identity.manager === OWNER_SLUG);
}
function othersOf(identities: readonly Identity[]): readonly Identity[] {
	return identities.filter((identity) => identity.manager !== OWNER_SLUG);
}

/** slug → 显示名。名册里没有就给 slug 本身（总比空白强）。 */
export function labelIn(directory: DirectoryState, slug: string): string {
	if (slug === OWNER_SLUG) return "老板";
	return directory.labels?.[slug] ?? slug;
}

/** 名册里补上显示名（核心的 `identity.md` 是唯一事实，名册只是投影）。 */
export function withLabels(directory: DirectoryState, identities: readonly Identity[]): DirectoryState {
	const labels: Record<string, string> = { ...(directory.labels ?? {}) };
	for (const identity of identities) labels[identity.slug] = identity.name ?? identity.slug;
	return { ...directory, labels };
}

/**
 * 「找你的 N 件事」。
 *
 * 老板的抱怨是「消息太多，真正需要我的信息没有 @ 我，没法直接定位」。频道列表只能给出
 * 每个频道一个红点，回答不了「我现在该看哪一条」。这份列表把散落在所有频道里、真正
 * 等他开口的消息按时间倒序摊平，每条都带回到原频道的锚点。
 *
 * 只收 7 天内、最多 60 条：再旧的已经该由记忆处理，不该占着「待办」的位置。已读的也
 * 收（带 `read` 标记），因为「读过了但还没作答」和「没看见」是两件事，界面可以分开显示。
 */
export type AttentionItem = {
	channelId: string;
	channelKind: ViewChannelKind;
	channelTitle: string;
	seq: number;
	at: number;
	from: number;
	fromSlug: string;
	fromLabel: string;
	/** 正文第一行，最多 80 字。 */
	excerpt: string;
	read: boolean;
};

const ATTENTION_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const ATTENTION_MAX = 60;

/** 算「发言」的 kind。没写 kind 的老消息按发言算（历史数据里 kind 缺省就是说话）。 */

export function attentionItems(
	state: ChannelState,
	directory: DirectoryState,
	viewer = OWNER_SLUG,
	now = Date.now(),
): AttentionItem[] {
	const out: AttentionItem[] = [];
	for (const channel of Object.values(state.channels)) {
		if (channel.archived === true) continue;
		const mark = readMarkOf(state, viewer, channel.id);
		for (const message of state.messages[channel.id] ?? []) {
			if (now - message.at > ATTENTION_WINDOW_MS) continue;
			// 只收「说出口的话」。过程投影（think / tool / work）和系统 note 不是发言，
			// 它们里的「要不要 / 还是 / 怎么定」是模型的自言自语（实测 60 条里有 40 多条
			// 是英文内心独白），进来就把这个列表变成噪音。
			if (!SPOKEN_KINDS.has(message.kind)) continue;
			if (!needsYou(message)) continue;
			// 说给别人听的不进。`needsYou` 的判据（`要不要` / `还是` / `怎么定`）故意宽，
			// 因为模型忘了 @ 老板的代价更高；但在「找你」这个列表里必须再收一道：
			// 一条消息如果**明确点了别人**而没点老板，它就不是找老板的。
			const others = message.mentions.filter((slug) => slug !== viewer);
			if (others.length > 0 && !message.mentions.includes(viewer)) continue;
			const first = message.text.split("\n").find((line) => line.trim() !== "")?.trim() ?? "";
			out.push({
				channelId: channel.id,
				channelKind: kindOf(channel.id),
				channelTitle: channel.title,
				seq: message.seq,
				at: message.at,
				from: idOf(directory, message.from),
				fromSlug: message.from,
				fromLabel: labelIn(directory, message.from),
				excerpt: first.length > 80 ? `${first.slice(0, 80)}…` : first,
				read: mark >= message.seq,
			});
		}
	}
	return out.sort((left, right) => right.at - left.at).slice(0, ATTENTION_MAX);
}
