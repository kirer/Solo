/**
 * **DTO 的唯一权威**：界面吃的每一种 JSON，这里定义一次。
 *
 * 三条规矩：
 * 1. **零 import。** 这份文件只写形状，不 import 任何东西（连 `node:*` 都不），
 *    所以 `ui/app/` 可以直接 `export type *` 再导出它，不需要跨进程手抄一份镜像。
 * 2. **没有函数、没有 IO、没有常量逻辑。** 投影函数在 `view/index.ts`，这里只有 `type`。
 * 3. **字段就是线上的键名。** 改这里的字段名等于改 HTTP 契约 →
 *    先改 `docs/WEB-API.md`，再改这里，再改投影。
 *
 * 反向的约束：核心的领域类型（`channel/state.ts` 的 `Channel`、`agent/identity.ts`
 * 的 `Identity`）**不许**为了界面加字段。「界面要但核心不需要」的东西（数字 id、
 * `kind`、预览、显示名）全部在这一层算出来。
 */

/**
 * 界面用的会话种类。**只有两种**，由成员表推导（见 `channel/state.ts` 的 `chatKind`）。
 *
 * 以前这里是 `company | leadership | team | dm`，靠 id 前缀反推 —— 于是「公司频道」和
 * 「团队频道」在界面上长得不一样，而它们实际上是同一种东西：一个群。
 */
export type ViewChannelKind = "dm" | "group";

/** 「团队归谁负责」的查询函数。真相在 `teams/<slug>/README.md`，不在频道文档里。 */
export type TeamLeadOf = (team: string) => string | undefined;

/** 「这个团队的一句话现状」的查询函数。来源同上（团队文档的 `doing`）。 */
export type TeamDoingOf = (team: string) => string | undefined;

/** 频道列表项。 */
export type ViewChannel = {
	id: string;
	kind: ViewChannelKind;
	/** 仅团队频道有：这个团队归谁负责（`README.md` 的 `lead`）。 */
	lead?: string;
	/** 仅团队频道有：团队管理员显示名。 */
	leadLabel?: string;
	/**
	 * 仅团队频道且团队文档写了 `doing` 时有：一句话现状。
	 * 界面拿它当顶栏副标题的第一段；缺了这个键就什么都不画。
	 */
	doing?: string;
	title: string;
	team?: string;
	unread: number;
	mentions: number;
	preview: string;
	lastAt: number;
	lastSeq: number;
	memberCount: number;
};

/** 一条消息里被 @ 的人。 */
export type ViewMention = { id: number; label: string; read: boolean; offset: number };

/** 引用回复指向的那条（只留够界面画一格的内容）。 */
export type ViewReply = {
	seq: number;
	from: number;
	fromSlug: string;
	fromLabel: string;
	excerpt: string;
};

/** 附件引用。文件本体走 `/api/uploads/<id>`。 */
export type ViewAttachment = { id: string; name: string; kind: "image" | "file"; bytes: number };

/** 一条消息。 */
export type ViewMessage = {
	seq: number;
	at: number;
	from: number;
	fromSlug: string;
	fromLabel: string;
	kind: string;
	text: string;
	mentions: ViewMention[];
	replyTo?: ViewReply;
	read: boolean;
	/**
	 * 这条要不要我本人看一眼。
	 *
	 * 判据在核心（只认显式 @ 我），这里只做投影 —— 界面不该自己猜关键词。
	 * 我自己说的话永不算「需要你」。
	 */
	needsYou?: true;
	/**
	 * 附件（图片/文件）。没有附件时**不出现这个字段** —— 界面用 `?.length` 判一下够了，
	 * 不用区分「空数组」与「没有」两种差不多的状态。
	 */
	attachments?: ViewAttachment[];
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
 * 所以早先那版为旧界面凑的 `teams` / `pending` / `costs` / `links` / `ceoQueue` 全删了 ——
 * 那些字段一个消费者也没有，留着只会让下一个人以为「这里有业务概念」。
 */
export type ViewOrg = {
	company: { name: string };
	/** 全部人，按「离我最近」优先排序（第一项是那个直接向我汇报的人）。 */
	people: ViewActor[];
};

/** 组织图上的一个人。 */
export type ViewActor = {
	/** 稳定标识。核心只用这个。 */
	slug: string;
	label: string;
	title: string;
	team?: string;
	manager?: string;
	managerLabel?: string;
	/** `identity.md` 正文 —— 档案页要显示「他是谁」，只有 slug 不够。 */
	body: string;
};

/** 「找我」列表里的一条。 */
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

/** 一个人的一项技能。`scope` 是它从哪一层读来的（个人层 / 公司层）。 */
export type ViewSkill = {
	name: string;
	description: string;
	scope: "personal" | "company";
	overrides: boolean;
};

/** 记忆里的一条（按小节拆开）。 */
export type ViewMemoryEntry = {
	heading: string;
	body: string;
	at: string | null;
	by: string | null;
	op: "add" | "edit" | null;
};

/** 一个人的记忆全文 + 按小节拆开的条目。 */
export type ViewPersonMemory = {
	slug: string;
	label: string;
	exists: boolean;
	digest: string | null;
	entries: ViewMemoryEntry[];
	raw: string;
};

/** 一个人的档案。 */
export type ViewPersonProfile = {
	slug: string;
	label: string;
	title: string;
	team?: string;
	manager: string;
	managerLabel: string;
	body: string;
	skills: ViewSkill[];
	/** `entries` 是**条数**（档案页只显示概况），全文在 `/api/people/:slug/memory`。 */
	memory: { exists: boolean; entries: number; digest: string | null };
	channels: { id: string; kind: ViewChannelKind; title: string }[];
};

/** 文件树里的一格。 */
export type ViewFileEntry = { name: string; kind: "dir" | "file"; bytes: number; at: number };

/** 目录一页。`truncated` = 这页之后还有。 */
export type ViewFilesList = {
	path: string;
	parent: string | null;
	entries: ViewFileEntry[];
	total: number;
	truncated: boolean;
};

/** 一个文件的内容（二进制只报 `bytes`，`text` 为空串）。 */
export type ViewFileText = {
	path: string;
	parent: string | null;
	file: { name: string; bytes: number; binary: boolean; text: string };
};

/** 上传成功的回执。 */
export type ViewUploaded = { id: string; name: string; kind: "image" | "file"; bytes: number };

/**
 * 发一条消息的回执。
 *
 * `delivered` / `failed` 是**收件人 slug 列表**（本条消息唤醒了几个人），不是计数 ——
 * 界面用 `?.length` 自己数。`docs/WEB-API.md` 里写的 `number` 是漂了的旧口径。
 */
export type ViewPost = { ok: true; seq: number; delivered: string[]; failed: string[] };

/** 把已读位置推到某条。 */
export type ViewOk = { ok: true };

/** `/api/files` 的两种回答：列目录，或者一个文件的内容。 */
export type ViewFiles = ViewFilesList | ViewFileText;
