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
 * 反向的约束：核心的领域类型（`channel/state.ts` 的 `Channel`、`documents/member/identity.ts`
 * 的 `Identity`）**不许**为了界面加字段。「界面要但核心不需要」的东西（数字 id、
 * `kind`、预览、显示名）全部在这一层算出来。
 */

/**
 * 界面用的会话种类。**只有两种**，由成员表推导（见 `channel/state.ts` 的 `chatKind`）。
 *
 * 以前这里靠 id 前缀反推 —— 于是「全员频道」和
 * 「团队频道」在界面上长得不一样，而它们实际上是同一种东西：一个群。
 */
export type ViewChannelKind = "dm" | "group";

/** 「这个团队的一句话现状」的查询函数。来源同上（团队文档的 `doing`）。 */
export type TeamDoingOf = (team: string) => string | undefined;

/** 频道列表项。 */
export type ViewChannel = {
	id: string;
	kind: ViewChannelKind;
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
	/**
	 * 成员的 slug（**不含我**）：群头像按它画，别拿全名册前四个人凑 ——
	 * 那会让每个群的头像长成一样，且和这个群里到底有谁无关。
	 */
	members: string[];
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
	/** 只有两种：`chat` 发言、`note` 系统留痕。旧数据的 kind 在投影层已归一（ADR-061）。 */
	kind: "chat" | "note";
	/** 系统留痕的种类：`run` = 后台命令跑完（界面收成一行，点开看全文）。 */
	noteOf?: string;
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
	/** 等我选的选项（2–6 个）。有它就说明这条在等我回答，输入框会换成选项卡。 */
	options?: string[];
};

/** 成员。`role` 只有三种，都是文件里读得出来的事实：我 / 助理 / 成员。 */
export type ViewMember = {
	id: number;
	slug: string;
	label: string;
	role: "owner" | "assistant" | "member";
	unread: number;
};

/**
 * 这个频道没人 @ 时谁接话。缺省 = 老行为（团队频道叫助理、全员频道接上一位）。
 * `@` 永远优先于它。
 */
export type ViewChannelResponder =
	| { kind: "lead"; slug: string }
	| { kind: "mentions" }
	| { kind: "everyone" };

/** 频道详情。 */
export type ViewChannelDetail = {
	channel: Omit<ViewChannel, "unread" | "mentions" | "preview"> & {
		/** 这个频道的共享指令：每轮贴在投递正文里。没写就不出现。 */
		bulletin?: string;
		/** 接话规则。没写就不出现（界面显示为「默认」）。 */
		responder?: ViewChannelResponder;
	};
	members: ViewMember[];
	messages: ViewMessage[];
	/**
	 * **上面**还有没有更早的消息（能往上翻页）。
	 *
	 * 叫这个名是为了把话说全：它只回答「上面还有没有」。原来叫 `hasMore`，看着像
	 * 「两边都还有」，`around` 取一页之后（目标夹在中间、上面下面都有）这个误读会让人
	 * 以为下面翻不动，于是漏掉几千条。要「下面还有没有」再加字段，别让这一个兼职。
	 */
	hasMoreAbove: boolean;
	/**
	 * 我对这个频道「看过的最后一条」的 seq（没读过就是 0）。
	 *
	 * 界面拿它当未读横幅的落点：`seq > readMark` 的才是新的。**别用「这一页最后一条」
	 * 去反推** —— 一页装不下全部时那是本页边界，跟看没看过没关系（原来的实现正是这么错的，
	 * 横幅插到了首屏最顶上，条数按整屏几十条虚报）。
	 */
	readMark: number;
};

/**
 * 组织快照。
 *
 * 只装**界面真会看**的东西。「有没有新消息」靠 SSE 这条事件本身通知（界面收到就重拉列表），
 * 所以早先那版为旧界面凑的 `teams` / `pending` / `costs` / `links` / `ceoQueue` 全删了 ——
 * 那些字段一个消费者也没有，留着只会让下一个人以为「这里有业务概念」。
 */
export type ViewOrg = {
	workspace: { name: string };
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
	/** 他是助理（身份目录在应用根下）。界面拿它置顶、标「助理」。 */
	assistant?: true;
	/** `identity.md` 正文 —— 档案页要显示「他是谁」，只有 slug 不够。 */
	body: string;
	/**
	 * 此刻在干什么。**没有这个键 = 待命**（不是 `state: "idle"`）。
	 * 由会话的 live 状态派生，结算即消失。
	 */
	activity?: ViewActivity;
	/**
	 * 最近一次没答上来的原因。**没有这个键 = 没有失败**。
	 * 有 `activity` 时以 activity 为准（新的一轮可能还带着上一次失败，失败不是当下状态）。
	 */
	lastFailure?: ViewLastFailure;
};

/** 「找我」列表里的一条。 */
export type AttentionItem = {
	channelId: string;
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

/** 一个人的一项技能。`scope` 是它从哪一层读来的（个人层 / 全员层）。 */
export type ViewSkill = {
	name: string;
	description: string;
	scope: "personal" | "team" | "all";
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

/** 一个人的记忆：按小节拆开的条目。 */
export type ViewPersonMemory = {
	slug: string;
	label: string;
	entries: ViewMemoryEntry[];
};

/** 一个人的档案。 */
export type ViewPersonProfile = {
	slug: string;
	label: string;
	title: string;
	team?: string;
	assistant: boolean;
	body: string;
	skills: ViewSkill[];
	channels: { id: string; kind: ViewChannelKind; title: string; members: string[] }[];
	/** 他此刻用的模型 `provider/modelId`；没有模型（还没配）就是空串。 */
	model: string;
};

/** 一个团队的档案：`teams/<slug>/README.md` 的正文 + 团队记忆。 */
export type ViewTeamProfile = {
	slug: string;
	name: string;
	status: string;
	/** 一句话现状（「谁在做什么」）。没写就不出现。 */
	doing?: string;
	/** README 正文：目标 / 验收标准 / 不做什么 / 当前进展。 */
	body: string;
	/** 团队层技能（`teams/<slug>/skills/`），这个团队的人都会。 */
	skills: ViewSkill[];
	memory: { entries: ViewMemoryEntry[] };
};

/**
 * 一轮里的一步。
 *
 * **只从会话条目派生，不落库**（ADR-001）。没有耗时就**不出现** `ms`，没有 diff 就
 * 不出现 `diff` —— 界面上每个数字都要有出处。
 */
export type ViewStep = {
	/** 会话条目里的 toolCall id（稳定；前端拿它做 key 与展开状态）。 */
	id: string;
	/** 没有 `say`：说出口的话是频道消息，不进过程。 */
	kind: "think" | "run" | "file-read" | "file-write" | "chats" | "history" | "remember" | "hire" | "tool";
	/** 服务端算好的一行人话（`运行 npm test` / `读了 a.ts`）。 */
	title: string;
	status: "running" | "ok" | "failed";
	/** 毫秒。工具结果的时间戳减去调用的时间戳；拿不到就没有。 */
	ms?: number;
	/** 调用开始的时刻（毫秒）。只给进行中的步骤算「已运行多久」。 */
	startedAt?: number;
	/** `run`：命令行。 */
	command?: string;
	/** 工具返回的文字（≤ 8 KB，已剥 ANSI，尾部带截断说明）：命令输出、读到的文件、其他工具的回执。 */
	output?: string;
	/** `run`：退出码（能从输出里读到时）。 */
	exitCode?: number;
	/** 输出被截断。 */
	truncated?: true;
	/** `file-*`：工作区相对路径。 */
	path?: string;
	/** `file-write`：这次写入的行数。 */
	added?: number;
	/** `think` / `remember` / `file-write`：正文（思考、记下的内容、写入的内容）。 */
	text?: string;
	/** 未知工具的原名。 */
	tool?: string;
};

/**
 * 一轮（一次唤醒）的轨迹。
 *
 * 切分：会话条目里 `kind === "core.channel"` 且 `data.channelId/seq` 对上的那条，
 * 到下一条 `core.channel` 之间。
 */
export type ViewTurn = {
	channelId: string;
	/**
	 * 这一轮发生在哪个频道（显示名）。频道归档 / 目录删掉之后列表里已经没有它了，
	 * 但历史里的轮次还要说得出「在哪儿跑的」—— 所以名字跟着轮次走。
	 */
	channelTitle?: string;
	/** 触发这一轮的消息 seq。 */
	seq: number;
	slug: string;
	label: string;
	status: "running" | "done" | "failed" | "aborted";
	startedAt: number;
	/** = 回复消息的 at；还在跑就没有。 */
	endedAt?: number;
	/** 他最终说出口的那条。 */
	replySeq?: number;
	/** 触发这一轮的消息（任务面板的块头）。条目还在但消息已被回收时没有。 */
	trigger?: {
		/** 发这条消息的人（slug；`owner` = 我）。 */
		readonly from: string;
		/** 正文，截 200 字。 */
		readonly text: string;
	};
	stepCount: number;
	/** 折叠行右端的确定性摘要（`运行 2 条命令 · 读了 3 个文件`）。 */
	summary: string;
	/** 步骤被截断（> 200 步）。 */
	truncated?: true;
	/** 只在展开时出现：`GET /api/channels/:id/turn` 与 SSE 的 `trace` 事件带，列表不带。 */
	steps?: ViewStep[];
};

/** 一个人此刻在干什么。由会话的 live 状态派生，结算即消失。 */
export type ViewActivity = {
	state: "thinking" | "working";
	/** 开始时刻（毫秒）。 */
	since: number;
	/** 这一轮在哪个频道。 */
	channelId?: string;
};

/**
 * 最近一次没答上来的原因。`reason` 是底座的原始原因（`model_error` 等），
 * `text` 是服务端按文案目录翻好的一句人话，界面直接画；`detail` 是底座给的细节。
 */
export type ViewLastFailure = {
	reason: string;
	detail?: string;
	text: string;
};

/** 上传成功的回执。 */
export type ViewUploaded = { id: string; name: string; kind: "image" | "file"; bytes: number };

/**
 * 一个插件。
 *
 * `client` 只表示「有前端入口」：地址由界面按 slug 拼（`/api/plugins/<slug>/client.js`）。
 * 没有它就是纯后端插件。`error` 是它没装上的原因 —— 界面照列，但要让人看出这个没生效。
 */
export type ViewPlugin = {
	slug: string;
	name: string;
	description: string;
	enabled: boolean;
	client?: true;
	error?: string;
	/**
	 * 系统动作的账：要了哪些、批了哪些、还差哪些。
	 *
	 * **`pending` 非空 = 那几条现在不能用**（默认全不给）。界面上的「待确认」读它。
	 * 一个权限都没要的插件不出现这一段。
	 */
	permissions?: {
		declared: readonly string[];
		granted: readonly string[];
		pending: readonly string[];
	};
	/** 它带来了什么（工具 / 提示词段 / 接口 / 听消息 / 分发策略）。没装上或这次没加载时不出现。 */
	brings?: {
		tools: readonly string[];
		prompt: boolean;
		routes: number;
		listens: boolean;
		policies: number;
	};
};

/**
 * 发一条消息的回执。
 *
 * `delivered` / `failed` 是**收件人 slug 列表**（本条消息唤醒了几个人），不是计数 ——
 * 界面用 `?.length` 自己数。`docs/WEB-API.md` 里写的 `number` 是漂了的旧口径。
 */
export type ViewPost = { ok: true; seq: number; delivered: string[]; failed: string[] };

/** 把已读位置推到某条。 */
export type ViewOk = { ok: true };
