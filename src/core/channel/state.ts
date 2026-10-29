/**
 * 频道：folder 版。
 *
 * 三条决定形状的规矩：
 *
 * 1. **成员就是 `@slug`**。不用数字 `conversationId`：会话 id 会随库重建而变，
 *    而 slug（`agents/<slug>/`）是文件夹名，稳定。
 * 2. **没有「公司群 / 领导层 / 项目群 / 私聊 / 工作记录」这套预置频道**。频道是
 *    文档里的一条记录，谁需要谁建；`@所有人` 不是频道，是不 @ 任何人的时候的默认行为。
 * 3. **没有一条 `log:` 频道**。「工作记录」不是一个房间，是一条消息的 `kind`。
 *
 * 规则都放在这个文件里，且都是纯函数 —— 它们决定「谁是唤醒对象」，是整套系统里
 * 最容易写错、也最需要单测的一段。
 */
import { defineDoc } from "../runtime/index.ts";
import { EMPTY_ROSTER, resolveMention, type MentionRoster } from "./alias.ts";

/**
 * 一条消息带的一个附件。**只有引用，没有内容。**
 *
 * 文件本体在 `<workspace>/uploads/<id>`，这里只放展示与下载要用的元数据。
 * 为什么不在文档里存 base64：频道文档是**一条**文档，每次写入都是一条增量 op，
 * 一条 3 MB 的图片会让这个频道的每条消息都在同一条时间线上多背 3 MB —— 这里
 * 已经吃过一次「一条消息重写整个频道」（189 条频道涨到 27 MB），见 ADR-050。
 */
export type Attachment = {
	/** 上传接口分配的 id（`crypto.randomUUID()`），同时也是磁盘上的文件名。 */
	id: string;
	/** 原始文件名。界面显示与下载时的默认名都取它。 */
	name: string;
	/** 类别。**由服务端按 mime 重算**，客户端传什么都不算数。 */
	kind: "image" | "file";
	bytes: number;
};

/** 一条频道消息。 */
export type Message = {
	/** 频道内自增序号，从 1 开始。全系统唯一的消息锚点（引用回复存的就是它）。 */
	seq: number;
	/** 发件人的 slug。老板是 `owner`。 */
	from: string;
	at: number;
	/** 正文。`@slug` 在里面，解析结果另存 `mentions`。 */
	text: string;
	/** 正文里解析出的 `@slug`，去重、按出现顺序。 */
	mentions: string[];
	/** 引用的那条消息的 seq。 */
	replyTo?: number;
	/**
	 * 消息类别。`chat` 是普通发言；`note` 是系统写的留痕（不唤醒、不计未读）；
	 * `work` 是工作记录（不唤醒、不计未读 —— 是自己的执行留痕）；
	 * 其余是给界面用的语义标签（`task` / `report` / `decision`）。
	 */
	kind: string;
	/**
	 * T-016：生成状态。undefined/未设 = done（历史消息兼容，一律按已生成处理）。
	 * `pending` = 占位生成的消息（@某人后其占位气泡，loading 中）；`done` = 已生成完毕；
	 * `error` = 生成失败（占位兜底显示「处理中，稍候刷新」）。
	 */
	status?: "pending" | "done" | "error";
	/** T-016：占位消息归属的「被唤醒人」slug（与 `from` 相同，仅用于前端关联 @ 动作与占位气泡）。 */
	pendingFor?: string;
	/** T-016：处理中指示占位（显示动画文案「X 开始处理…」），被真实回复原地覆盖后消失。 */
	processing?: boolean;
	/** 附件（图片/文件）。没有附件时**不写这个键**，与 `replyTo` / `status` 一个规矩。 */
	/*
	 * 为什么是可变数组而不是 `readonly`：文档层的 `JsonValue` 里数组是 `JsonValue[]`，
	 * `readonly Attachment[]` 不满足它（`ChannelState` 整个就不符合 `JsonObject` 了）。
	 * 「调用方不该改别人给的数组」这条用 `appendMessage` 入参的 `readonly` 表达就够了。
	 */
	attachments?: Attachment[];
};

/** 一个频道。 */
export type Channel = {
	/** 频道 id：`general` / `proj:alpha` / `dm:owner-cto` 之类，由建频道的人自己起。 */
	id: string;
	title: string;
	/** 成员 slug 列表。老板用 `owner`。 */
	members: string[];
	/**
	 * 这个频道里「不 @ 也会被唤醒」的成员。私聊把双方都放进去，
	 * 群聊一般是空数组（老板发言时特例，见 `recipientsOf`）。
	 */
	wakeOnAll: string[];
	createdAt: number;
	archived?: true;
};

export type ChannelState = {
	channels: Record<string, Channel>;
	messages: Record<string, Message[]>;
	/** 每个频道的下一个 seq。分开存是为了「只 append 一条消息」时不用重写整个数组。 */
	nextSeq: Record<string, number>;
	/** `slug → 频道 id → 已读到的 seq`。只记自己读过的位置。 */
	readMarks: Record<string, Record<string, number>>;
	/**
	 * 投影游标：`会话 id → 已投影的最大 `pi.assistant` 条目 id`。
	 *
	 * 运行时把 agent 会话里的 `pi.assistant` 条目投影成个人频道消息（think/say/tool）。
	 * 这条游标决定「只投影新产出的」，且重启后能接着上次的进度，**不重复投影**历史
	 * 条目（否则每次重启个人频道都会长出一批重复的思考/文案卡）。持久化在文档里，
	 * 因为重启后内存 Map 是空的，不回灌就会重头来过。
	 */
	cursors?: Record<string, number>;
};

export const ChannelDoc = defineDoc<ChannelState>({
	kind: "core.channels",
	version: 1,
	scope: "session",
	initial: () => ({ channels: {}, messages: {}, nextSeq: {}, readMarks: {}, cursors: {} }),
	// 什么时候把散着的增量压成一条基线。两个理由各占一半：
	//
	// 1. **重放成本**：基线之前的历史不用再重放，崩溃恢复只重放最多 64 条增量。
	// 2. **磁盘空间**：这个文档是 `scope: "session"` 的，存储层写基线时会把该文档的
	//    旧 revision 全删（`isCurrentOnly` 为真）。也就是说「压基线」在这里同时是
	//    **唯一的回收机制** —— 不压，历史只增不减。
	//
	// 早先只按「单频道 ≥ 256 条消息」判断，结果一直不触发（最多 189 条），库里的
	// 增量无限累积到 60 MB。按增量条数判断拿得到确定的回收上限，与消息分布无关。
	checkpointWhen: (value, _ops, info) =>
		info.deltasSinceBase >= 64 || Object.values(value.messages).some((list) => list.length >= 256),
});

/** 老板的 slug。不是 agent，但出现在成员表里。 */
export const OWNER = "owner";

/** 老板 slug。与 `OWNER` 同值，单独的常量名便于在阅读时区分「常量」与「比较」。 */
export const OWNER_SLUG = OWNER;

/** 私聊频道的命名规则。双方 slug 排序后拼接，保证 `a-b` 与 `b-a` 是同一个频道。 */
export function dmId(a: string, b: string): string {
	const [left, right] = [a, b].sort();
	return `dm:${left}-${right}`;
}

/**
 * 一个人的**个人频道**：他和老板的私聊。
 *
 * 为什么个人频道就是「和老板的私聊」而不是另建一个房间：升到顶只能是一个人 —— 老板。
 * 于是这条链的顶端（「助理拍不了板就问我」）和每个人的「记录落在自己频道」是同一个
 * 房间，不需要第二套命名。员工在个人频道里记自己的过程，项目里只放需要别人看见的。
 */
export function personalId(slug: string): string {
	return dmId(OWNER, slug);
}

/** 项目频道的命名规则。 */
export function projectId(project: string): string {
	return `proj:${project}`;
}

/**
 * 从正文里解析 `@slug`。slug 允许字母、数字、中文、`-`、`_`。
 *
 * 前面不能紧跟字母数字或 `._-`：否则 `hi@example.com` 会被解析成 `@example`，
 * 一个从来不存在的 agent 就凭空多了一条唤醒记录。这个 lookbehind 是唯一
 * 让邮箱不被误认的办法 —— 事后过滤「看起来像邮箱的」只会漏。
 */
const MENTION = /(?<![\p{L}\p{N}._-])@([\p{L}\p{N}_-]+)/gu;

/**
 * 从正文里解析 `@` 名字，返回**解析后的 slug**（`@老板` → `owner`，`@CEO` → 那个人）。
 *
 * 传了 `roster` 就按名册严格解析：解析不出来的 token（`@import` / `@media` / `@x`）
 * **丢弃**，因为它们在成员表里不存在，留着只是噪音。
 *
 * 不传 `roster` 时保留旧行为（字面 token 原样返回）—— 旧调用点（外壳的留痕、老数据的
 * 重新投递）不因为这一层而改变语义；老板的叫法由 `recipientsOf` 的兜底兜住。
 */
export function parseMentions(text: string, roster?: MentionRoster): string[] {
	const out: string[] = [];
	for (const match of text.matchAll(MENTION)) {
		const raw = match[1];
		if (raw === undefined) continue;
		const slug = roster === undefined ? raw : resolveMention(raw, roster);
		if (slug !== undefined && !out.includes(slug)) out.push(slug);
	}
	return out;
}

/**
 * 这条消息是不是在「要老板拍板」。
 *
 * 为什么由代码判断而不是指望模型自觉：实测含「请确认/要不要/等你定」的消息里，大量
 * 没有 @ 老板，老板的回复率只有 1.06%。模型会写「要你定」，然后忘了 @ 你。
 *
 * 只列 7 个信号，宁可多叫一次老板，也不要让一件等人拍板的事静默躺着。
 */
const OWNER_SIGNALS: readonly RegExp[] = [
	/请老板/,
	/请确认/,
	/需(?:要)?你(?:定|确认|拍板)?/,
	/等你定|你定|老板定/,
	/要不要/,
	/还是/, // 「是 A 还是 B」的唯一共同词
	/怎么定/,
];

export function needsOwner(text: string): boolean {
	return OWNER_SIGNALS.some((signal) => signal.test(text));
}

/**
 * 谁会被这条消息唤醒。
 *
 * 四条规则，按顺序（后写的不会覆盖先写的，只做并集，最后减去发件人自己）：
 * 1. 明确 `@` 到的人 —— 只有频道成员里的才算（防止 `@` 一个不在这个房间的人
 *    凭空拿到别人房间的上下文）。
 * 2. 老板发言且**没有 @ 任何人**时，频道里的第一个非老板成员。这条是为了让
 *    「老板随口说一句」不至于没人接 —— 只依赖成员顺序，不依赖岗位。
 * 3. `wakeOnAll` 里的成员（私聊双方）。
 * 4. 发件人自己永远不唤醒（它正在说话，不需要再被叫一次）。
 *
 * 注意 `@所有人`：如果正文里出现 `@owner`，老板会被列为目标。但老板没有会话，
 * 投递层会跳过它（见 `deliver.ts`）。
 */
export function recipientsOf(channel: Channel, message: Message): string[] {
	const targets = new Set<string>();
	const members = new Set(channel.members);

	// 兜底再解析一次别名：老数据里存的是字面 token（`@老板`），而频道成员里是 `owner`。
	// 成员过滤规则本身**不动** —— 不是这个房间的人照样 @ 不到（防止拿到别人房间的上下文）。
	for (const mention of message.mentions) {
		const slug = members.has(mention) ? mention : resolveMention(mention, EMPTY_ROSTER);
		if (slug !== undefined && members.has(slug)) targets.add(slug);
	}
	if (message.from === OWNER && message.mentions.length === 0) {
		const first = channel.members.find((slug) => slug !== OWNER);
		if (first !== undefined) targets.add(first);
	}
	for (const slug of channel.wakeOnAll) {
		if (members.has(slug)) targets.add(slug);
	}
	targets.delete(message.from);
	return [...targets];
}

/**
 * 一个频道里 agent 之间最多能自动接多少棒。
 *
 * 项目频道用 `wakeOnAll` 让「不 @ 人也能把负责人叫醒」，于是 A 回复 → 唤醒 B →
 * B 回复 → 又唤醒 A。没有上限就是无限循环烧钱。上限按频道规模给：人多一个回合里
 * 该说的也更多。至少 3，否则 0 个 agent 的频道一上来就锁死。
 */
export function relayLimit(channel: Channel): number {
	const agents = channel.members.filter((slug) => slug !== OWNER).length;
	// **只有一个人能说话时没有「接力」**。
	//
	// 这个上限存在的唯一理由是 A 回 → 唤醒 B → B 回 → 又唤醒 A 的无限循环。
	// 投递时收件人一定会排除发件人自己，所以「老板 + 一个 agent」的私聊里，
	// 那个 agent 说完话之后**没有任何人**会被再叫醒 —— 循环根本起不来，
	// 上限只会在他汇报到第 4 条时把他嘴堵上。实测就发生过：私聊里 197 条消息
	// 有 150 多条是「接力到上限」这条告警。
	return agents <= 1 ? Number.POSITIVE_INFINITY : Math.max(3, 3 * agents);
}

/**
 * 老板在这条频道里最后说了一句之后，agent 已经自动接了几棒。
 *
 * **老板从没在这个频道说过话时，从频道建立算起**。早先这里是 `return 0`（「不惩罚」），
 * 结果项目频道里的老板一次不开口，上限就永远不触发 —— 那正是唯一真会烧钱失控的地方。
 * 老板一开口就归零，所以「新频道」不会反而更严。
 * `note` / `work` 不算接力：那是系统留痕和执行过程，不是 agent 在跟人说话；
 * 它们也不能打断计数（`note` 的 from 是 `OWNER`，若当成老板发言就会把计数清零）。
 */
export function botHopsSinceOwner(state: ChannelState, channelId: string): number {
	const list = state.messages[channelId] ?? [];
	let last = -1;
	for (let index = list.length - 1; index >= 0; index -= 1) {
		const item = list[index]!;
		if (item.from !== OWNER) continue;
		if (item.kind === "note" || item.kind === "work") continue;
		last = index;
		break;
	}
	return list
		.slice(last + 1)
		.filter((item) => item.from !== OWNER && item.kind !== "note" && item.kind !== "work").length;
}

/** 某个 slug 在一个频道里读到了哪里。0 表示一条没读。 */
export function readMarkOf(state: ChannelState, slug: string, channelId: string): number {
	return state.readMarks[slug]?.[channelId] ?? 0;
}

/** 一个频道里，对某个 slug 来说未读的消息条数。自己发的不算未读。 */
export function unreadCount(state: ChannelState, channelId: string, slug: string): number {
	const mark = readMarkOf(state, slug, channelId);
	const list = state.messages[channelId] ?? [];
	let count = 0;
	for (const message of list) {
		if (message.seq > mark && message.from !== slug && message.kind !== "note" && message.kind !== "work") count += 1;
	}
	return count;
}

/**
 * 没被叫醒、也没指定频道时，最后一级兜底在哪儿说话。
 *
 * **先排掉个人频道**：`mine[0]` 可能正是「我和老板的私聊」，于是老板在群里问的一句话
 * 被答进私聊（实测 2598 条噪音灌进了老板私聊）。所以顺序是「我所在的非个人频道里最近
 * 活跃的那个」→ 个人频道。
 */
export function fallbackChannelId(state: ChannelState, slug: string): string {
	const personal = personalId(slug);
	let best = personal;
	let bestAt = Number.NEGATIVE_INFINITY;
	for (const channel of channelsOf(state, slug)) {
		if (channel.id === personal) continue;
		const list = state.messages[channel.id] ?? [];
		const at = list.length === 0 ? channel.createdAt : list[list.length - 1]!.at;
		if (at > bestAt) {
			best = channel.id;
			bestAt = at;
		}
	}
	return best;
}

/** 某个 slug 能看到的频道（成员表里包含它，且没归档）。 */
export function channelsOf(state: ChannelState, slug: string): Channel[] {
	return Object.values(state.channels)
		.filter((channel) => channel.archived !== true && channel.members.includes(slug))
		.sort((a, b) => a.createdAt - b.createdAt);
}

/**
 * 追加一条消息，返回新的 state 与落地的消息。
 *
 * 纯函数：seq 分配、mentions 解析、readMarks 都没动（发件人自己的已读位置由
 * 调用方决定 —— 「发完自己就算读过」是 UI 的语义，不是频道的语义）。
 *
 * **返回的 `state` 只用来算，不要直接写回文档。** 它带着一整份新的消息数组，
 * 写回文档就是「整值替换该频道全部历史」（一条消息重写整条时间线，见
 * `post.ts` 里那段实测数字）。真正的落地走 `postMessage`：它只拿这里的
 * `message`，然后往文档代理给出的那个数组上 push 一个元素。
 */
export function appendMessage(
	state: ChannelState,
	channelId: string,
	input: {
		readonly from: string;
		readonly text: string;
		readonly at: number;
		readonly kind?: string;
		readonly replyTo?: number;
		/** 名册：给了就按名册解析 `@`（`@老板` → `owner`），不给就保留字面 token。 */
		readonly roster?: MentionRoster;
		/** 正文里没写、但要额外记进 `mentions` 的 slug（例如 `decision` 自动补 `owner`）。 */
		readonly mention?: readonly string[];
		/** T-016：占位消息的生成状态（缺省 undefined → done）。 */
		readonly status?: "pending" | "done" | "error";
		/** T-016：占位归属的被唤醒人 slug。 */
		readonly pendingFor?: string;
		/** T-016：处理中指示占位标记。 */
		readonly processing?: boolean;
		/** 附件引用（本体在磁盘上）。空数组按「没有附件」处理。 */
		readonly attachments?: readonly Attachment[];
	},
): { readonly state: ChannelState; readonly message: Message } {
	const channel = state.channels[channelId];
	if (channel === undefined) throw new Error(`频道不存在：${channelId}`);

	const seq = state.nextSeq[channelId] ?? 1;
	const mentions = parseMentions(input.text, input.roster);
	// 代码补的 @（`decision` 自动叫老板）不改正文，只进 mentions —— 正文是模型的嘴，
	// 不该被系统塞字；而「提醒谁」是系统的责任。
	for (const raw of input.mention ?? []) {
		const slug = resolveMention(raw, input.roster ?? EMPTY_ROSTER);
		if (slug !== undefined && !mentions.includes(slug)) mentions.push(slug);
	}
	// 引用一条消息 = 等同于 @ 它的作者：回复本身就带有「我是在跟你说」的语义。
	const replyTo = input.replyTo;
	const quotedFrom =
		replyTo === undefined
			? undefined
			: (state.messages[channelId] ?? []).find((item) => item.seq === replyTo)?.from;
	const mentionList =
		quotedFrom === undefined || quotedFrom === input.from || mentions.includes(quotedFrom)
			? mentions
			: [...mentions, quotedFrom];

	const message: Message = {
		seq,
		from: input.from,
		at: input.at,
		text: input.text,
		mentions: mentionList,
		kind: input.kind ?? "chat",
		...(replyTo === undefined ? {} : { replyTo }),
		...(input.status === undefined ? {} : { status: input.status }),
		...(input.pendingFor === undefined ? {} : { pendingFor: input.pendingFor }),
		...(input.processing === undefined ? {} : { processing: input.processing }),
		...(input.attachments === undefined || input.attachments.length === 0
			? {}
			: {
					// 逐字段重建、顺序照抄类型声明：文档要求**字节确定**（ADR-005）。同一个附件
					// 换个 key 顺序写进去，就是另一份字节，会让提示词与文档校验都出现假差异。
					attachments: input.attachments.map((item) => ({
						id: item.id,
						name: item.name,
						kind: item.kind,
						bytes: item.bytes,
					})),
				}),
	};

	return {
		state: {
			...state,
			messages: { ...state.messages, [channelId]: [...(state.messages[channelId] ?? []), message] },
			nextSeq: { ...state.nextSeq, [channelId]: seq + 1 },
		},
		message,
	};
}

/** 建频道；已存在时原样返回（幂等）。 */
export function ensureChannel(
	state: ChannelState,
	input: { readonly id: string; readonly title: string; readonly members: string[]; readonly wakeOnAll?: string[]; readonly at: number },
): ChannelState {
	if (state.channels[input.id] !== undefined) return state;
	const channel: Channel = {
		id: input.id,
		title: input.title,
		members: [...new Set(input.members)],
		wakeOnAll: [...new Set(input.wakeOnAll ?? [])],
		createdAt: input.at,
	};
	return { ...state, channels: { ...state.channels, [input.id]: channel } };
}

/**
 * 建频道，或者把缺的人补进去（幂等）。
 *
 * 与 `ensureChannel` 的区别：后者见到已存在的频道就直接返回，于是「项目负责人后来才
 * 定下来」「新招的人进了项目」都不会反映到成员表里 —— 那些人明明在项目里却收不到项目
 * 频道的话。这里两个动作合成一个，调用点不用自己判「建还是补」。
 */
export function upsertChannel(
	state: ChannelState,
	input: { readonly id: string; readonly title: string; readonly members: string[]; readonly wakeOnAll?: string[]; readonly at: number },
): ChannelState {
	const chann = state.channels[input.id];
	if (chann === undefined) return ensureChannel(state, input);
	const missing = input.members.filter((slug) => !chann.members.includes(slug));
	if (missing.length === 0) return state;
	return {
		...state,
		channels: { ...state.channels, [input.id]: { ...chann, members: [...chann.members, ...missing] } },
	};
}

/** 把某个 slug 在某个频道的已读位置推到 `seq`。回退不生效（已读不会变未读）。 */
export function markRead(state: ChannelState, slug: string, channelId: string, seq: number): ChannelState {
	const current = readMarkOf(state, slug, channelId);
	if (seq <= current) return state;
	return {
		...state,
		readMarks: { ...state.readMarks, [slug]: { ...(state.readMarks[slug] ?? {}), [channelId]: seq } },
	};
}

/** 频道里最近 `limit` 条消息（老的在前）。 */
export function tail(state: ChannelState, channelId: string, limit: number): Message[] {
	const list = state.messages[channelId] ?? [];
	return list.slice(Math.max(0, list.length - limit));
}
