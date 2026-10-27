/**
 * 把核心的状态翻译成**界面要的那份 JSON**。
 *
 * 这一层只有一个职责：让 `ui/js/` 不用改一行就认得出新核心。形状是照旧核心的
 * `/api/channels` + `/api/channels/:id` + `/api/stream/org` 抄的，字段名、可空性、
 * 单位都对得上（前端是既成事实，改它比改这里贵得多）。
 *
 * 两个刻意保留的「旧」概念，都是界面需要、而核心不需要的：
 * - **数字 id**：界面到处用 `conversationId` 做 key（成员、@ 对象、看板卡片）。
 *   核心的稳定标识是 slug，但界面上要一个能排序、能当 DOM 属性的东西。这里把
 *   slug → 会话 id 的映射拿出来当 id 用，界面对它一无所知。
 * - **`kind`**：界面按 `company/leadership/project/dm` 分组。核心没有频道类型，
 *   这里从频道 id 前缀猜（`dm:` → dm，`proj:` → project，其余 → company）。
 */
import { readAllIdentities, OWNER_SLUG, chainUp, reportsOf, type Identity } from "../agent/identity.ts";
import { conversationFor, type DirectoryState } from "../agent/roster.ts";
import { unreadCount, readMarkOf, type Channel, type ChannelState, type Message } from "../channel/state.ts";

/**
 * 界面用的频道种类。
 *
 * `dm` 是「一对一的房间」，但界面要分清两种完全不同的东西，所以频道详情里另外给了
 * `dmKind`：
 * - `personal` = 某人**自己的**频道（`dm:owner-<slug>`）。他的过程、念头落在这里，
 *   它同时是拍板链的顶端 —— 「他拍不了板就问我」问的就是这里。
 * - `direct` = 两个人之间的私聊（老板去找某人说话）。
 *
 * 为什么不拆成两个 `kind`：两者都是「只有两个成员的一对一房间」，收件人规则、未读
 * 计算、界面渲染完全一样，唯一的差别是**它意味着什么**。把它塞进 `kind` 会让
 * 「怎么投递」和「怎么显示」纠缠在一起。
 */
export type ViewChannelKind = "company" | "leadership" | "project" | "dm";

/** `dm` 房间的两种含义。非 `dm` 频道没有这个字段。 */
export type ViewDmKind = "personal" | "direct";

/** 频道列表项（对应旧核心 `ChannelListItem`）。 */
export type ViewChannel = {
	id: string;
	kind: ViewChannelKind;
	/** 仅 `kind === "dm"` 时有：这是谁的频道，或者是谁和谁的私聊。 */
	dmKind?: ViewDmKind;
	/** 仅 `kind === "project"` 时有：这个项目归谁负责（`README.md` 的 `owner`）。 */
	owner?: string;
	/** 仅 `kind === "project"` 时有：负责人显示名。 */
	ownerLabel?: string;
	title: string;
	project?: string;
	unread: number;
	mentions: number;
	preview: string;
	lastAt: number;
	lastSeq: number;
	memberCount: number;
	openTasks: number;
};

/** 一条消息（对应旧核心 `MessageView`）。 */
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
};

/** 成员（对应旧核心 `ChannelView["members"]`）。 */
export type ViewMember = { id: number; slug: string; label: string; role: string; unread: number };

/** 频道详情（对应旧核心 `ChannelView`）。 */
export type ViewChannelDetail = {
	channel: Omit<ViewChannel, "unread" | "mentions" | "preview" | "openTasks">;
	members: ViewMember[];
	messages: ViewMessage[];
	hasMore: boolean;
	tasks: never[];
	pending: never[];
	serverNow: number;
};

/** 组织图上的一个人（对应旧核心 `ActorView`）。 */
export type ViewActor = {
	conversationId: number;
	/** 稳定标识。`conversationId` 是界面用的旧 id，slug 才是核心的真相。 */
	slug: string;
	label: string;
	subtitle: string;
	kind: "owner" | "role" | "project" | "staff";
	status: "busy" | "waiting" | "error" | "idle";
	tokens: number;
	awaitingYou: number;
	unanswered: number;
	activity: string;
	project?: string;
	parent?: string;
	parentSlug?: string;
	model?: string;
	/** `identity.md` 正文（档案页要显示「他是谁」，只有 slug 不够）。 */
	body?: string;
};

/** 组织快照（对应旧核心 `OrgView`）。 */
export type ViewOrg = {
	company: { name: string; model: string };
	ceo: ViewActor;
	roles: ViewActor[];
	projects: never[];
	pending: never[];
	ceoQueue: number;
	costs: { totalTokens: number; totalCostUsd: number; byProject: never[] };
	links: never[];
};

/** 频道 id → 界面种类。核心没有类型这个概念，只能从命名约定反推。 */
function kindOf(id: string): ViewChannelKind {
	if (id.startsWith("dm:")) return "dm";
	if (id.startsWith("proj:")) return "project";
	if (id.startsWith("lead:")) return "leadership";
	return "company";
}

/**
 * 一个 `dm:` 房间是谁的。
 *
 * `dm:a-b` 的成员按码点排序存（`dmId` 保证 `dm:a-b` 与 `dm:b-a` 是同一个房间），
 * 所以不能靠 id 里的位置判断「谁是主人」。真相在成员表里：**成员包含老板、且有另一个
 * 人时，它就是那个人的频道**。非老板的两人私聊目前不存在（老板是唯一能发起对话的人），
 * 出现了也按 `direct` 处理，不假装它是谁的「个人频道」。
 */
function dmKindOf(channel: Channel): ViewDmKind {
	const others = channel.members.filter((slug) => slug !== OWNER_SLUG);
	return others.length === 1 ? "personal" : "direct";
}

/** `dm:owner-<slug>` 里那个 slug。不是个人频道时返回 undefined。 */
function dmSubjectOf(channel: Channel): string | undefined {
	if (kindOf(channel.id) !== "dm") return undefined;
	const others = channel.members.filter((slug) => slug !== OWNER_SLUG);
	return others.length === 1 ? others[0] : undefined;
}

/** 由 slug 拿界面 id（会话号）。名册里没有的给 -1，界面上会显示成一串连不上的节点。 */
function idOf(directory: DirectoryState, slug: string): number {
	if (slug === OWNER_SLUG) return 0;
	return conversationFor(directory, slug) ?? -1;
}

/** 一条消息的正文预览：只取第一行、最多 60 字。 */
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

/** 频道列表。 */
export function channelList(
	state: ChannelState,
	directory: DirectoryState,
	slug = OWNER_SLUG,
	projectOwnerOf?: ProjectOwnerOf,
): ViewChannel[] {
	const out: ViewChannel[] = [];
	for (const channel of Object.values(state.channels)) {
		if (channel.archived === true) continue;
		const messages = state.messages[channel.id] ?? [];
		const last = messages[messages.length - 1];
		const unread = unreadCount(state, channel.id, slug);
		// 「@ 我」的条数：未读里点名提到我的那些。界面上它们比普通未读更红。
		const mentions = messages.filter(
			(message) => message.seq > readMarkOf(state, slug, channel.id) && message.mentions.includes(slug),
		).length;
		const project = channel.id.startsWith("proj:") ? channel.id.slice("proj:".length) : undefined;
		const owner = project === undefined ? undefined : projectOwnerOf?.(project);
		out.push({
			id: channel.id,
			kind: kindOf(channel.id),
			...(kindOf(channel.id) === "dm" ? { dmKind: dmKindOf(channel) } : {}),
			...(owner === undefined || owner === "" ? {} : { owner, ownerLabel: labelIn(directory, owner) }),
			title: channel.title,
			...(project === undefined ? {} : { project }),
			unread,
			mentions,
			preview: previewOf(last),
			lastAt: last?.at ?? channel.createdAt,
			lastSeq: last?.seq ?? 0,
			memberCount: channel.members.length,
			openTasks: 0,
		});
	}
	// 界面期望「最近的在前」：旧核心按 lastAt 降序给。
	return out.sort((left, right) => right.lastAt - left.lastAt);
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
	// 个人频道显示成那个人的名字 —— 频道建立时标题就是它，这里不重复计算。
	return {
		channel: {
			id: channel.id,
			kind: kindOf(channel.id),
			...(kindOf(channel.id) === "dm" ? { dmKind: dmKindOf(channel) } : {}),
			...(ownerSlug === undefined || ownerSlug === ""
				? {}
				: { owner: ownerSlug, ownerLabel: labelIn(directory, ownerSlug) }),
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
			// `role` 的价值在界面：项目频道里要一眼看出谁是负责人。旧核心用岗位枚举，
			// 这里只用三种能从文件里读出来的事实（老板 / 项目负责人 / 成员）。
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
		tasks: [],
		pending: [],
		serverNow: Date.now(),
	};
}

/**
 * 组织快照。
 *
 * 新核心里**没有项目、没有岗位枚举、没有成本**（它们是旧核心的业务概念），所以
 * `projects` / `pending` / `costs` 一律给空。界面上表现为「组织图只有一层人、没有
 * 项目卡、没有待办红点」——这正是新核心当前的真实状态，不装样子。
 */
export function orgView(identities: readonly Identity[], directory: DirectoryState, companyName = "一人公司"): ViewOrg {
	const toActor = (identity: Identity): ViewActor => ({
		conversationId: idOf(directory, identity.slug),
		slug: identity.slug,
		label: identity.name ?? identity.slug,
		subtitle: identity.title ?? identity.slug,
		kind: "role",
		status: "idle",
		tokens: 0,
		awaitingYou: 0,
		unanswered: 0,
		activity: "",
		...(identity.project === undefined ? {} : { project: identity.project }),
		...(identity.manager === undefined
			? {}
			: { parent: labelIn(directory, identity.manager), parentSlug: identity.manager }),
		body: identity.body,
	});

	// 「离老板最近的人」= manager 是 owner 的那一个。没有就退化成一个占位节点，
	// 否则界面上的 `.org-head` 是空的（旧核心永远有 CEO）。
	const nearest = identities.find((identity) => identity.manager === OWNER_SLUG) ?? identities[0];
	const head: ViewActor =
		nearest === undefined
			? {
					conversationId: 0,
					slug: OWNER_SLUG,
					label: "老板",
					subtitle: "还没有人向你汇报",
					kind: "owner",
					status: "idle",
					tokens: 0,
					awaitingYou: 0,
					unanswered: 0,
					activity: "",
				}
			: { ...toActor(nearest), kind: "role" };

	const roles = identities.filter((identity) => identity.slug !== nearest?.slug).map(toActor);

	return {
		company: { name: companyName, model: "" },
		ceo: head,
		roles,
		projects: [],
		pending: [],
		ceoQueue: 0,
		costs: { totalTokens: 0, totalCostUsd: 0, byProject: [] },
		links: [],
	};
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

/** 一位 agent 的档案（对应旧核心 `ActorProfile`，界面用 `ui/js/profile.js` 渲染）。 */
export async function actorProfile(
	agentsRoot: string,
	identity: Identity,
	all: readonly Identity[],
	model: string,
	registered: readonly string[],
): Promise<{
	conversationId: number;
	label: string;
	kind: "owner" | "role" | "project" | "staff";
	subtitle: string;
	role?: string;
	project?: string;
	parent?: string;
	model: string;
	charter: string;
	guide?: string;
	tools: { name: string; description: string }[];
}> {
	const line = chainUp(all, identity.slug);
	const team = reportsOf(all, identity.slug);
	const charter = [
		identity.body.trim(),
		"",
		`## 汇报线\n${line.length === 0 ? "（直接向老板汇报）" : line.join(" → ")}`,
		team.length === 0 ? "" : `## 直接向你汇报\n${team.map((item) => `- ${item.name}（${item.title ?? item.slug}）`).join("\n")}`,
	]
		.filter((part) => part !== "")
		.join("\n");
	return {
		conversationId: -1,
		label: identity.name ?? identity.slug,
		kind: "role",
		subtitle: identity.title ?? identity.slug,
		...(identity.title === undefined ? {} : { role: identity.title }),
		...(identity.project === undefined ? {} : { project: identity.project }),
		...(identity.manager === undefined ? {} : { parent: identity.manager }),
		model,
		charter,
		// 工具清单**从注册表实拍**，不读任何清单文件：档案页要说的是「它真能调什么」。
		tools: registered.map((name) => ({ name, description: "" })),
	};
}
