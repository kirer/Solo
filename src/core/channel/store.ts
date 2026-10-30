/**
 * 频道：folder 版。
 *
 * 三条决定形状的规矩：
 *
 * 1. **成员就是 `@slug`**。不用数字 `conversationId`：会话 id 会随库重建而变，
 *    而 slug（`agents/<slug>/`）是文件夹名，稳定。
 * 2. **没有「公司群 / 领导层 / 团队群 / 私聊 / 工作记录」这套预置频道**。频道是
 *    文档里的一条记录，谁需要谁建；`@所有人` 不是频道，是不 @ 任何人的时候的默认行为。
 * 3. **没有一条 `log:` 频道**。「工作记录」不是一个房间，是一条消息的 `kind`。
 *
 * 规则都放在这个文件里，且都是纯函数 —— 它们决定「谁是唤醒对象」，是整套系统里
 * 最容易写错、也最需要单测的一段。
 */
import { defineDoc } from "../runtime/index.ts";

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
	/** 发件人的 slug。我是 `owner`。 */
	from: string;
	at: number;
	/** 正文。`@slug` 在里面，解析结果另存 `mentions`。 */
	text: string;
	/** 正文里解析出的 `@slug`，去重、按出现顺序。 */
	mentions: string[];
	/** 引用的那条消息的 seq。 */
	replyTo?: number;
	/**
	 * 消息类别。生成侧只有：`chat` 普通发言、`say`（agent 说的话）、`note` 系统留痕
	 * （不唤醒、不计未读）、`question` / `decision` / `report` 语义标签。
	 *
	 * 类型是 `string` 而不是联合类型：历史库里还躺着 `think` / `tool` / `work` / `step`
	 * 这些不再产生的 kind（ADR-081 删掉过程投影后不清理旧数据），读取侧按普通行显示。
	 */
	kind: string;
	/** 附件（图片/文件）。没有附件时**不写这个键**，与 `replyTo` 一个规矩。 */
	/*
	 * 为什么是可变数组而不是 `readonly`：文档层的 `JsonValue` 里数组是 `JsonValue[]`，
	 * `readonly Attachment[]` 不满足它（`ChannelState` 整个就不符合 `JsonObject` 了）。
	 * 「调用方不该改别人给的数组」这条用 `appendMessage` 入参的 `readonly` 表达就够了。
	 */
	attachments?: Attachment[];
};

/** 一个频道。 */
export type Channel = {
	/** 频道 id：`general` / `team:alpha` / `dm:owner-cto` 之类，由建频道的人自己起。 */
	id: string;
	title: string;
	/** 成员 slug 列表。我用 `owner`。 */
	members: string[];
	/**
	 * 这个频道里「不 @ 也会被唤醒」的成员。
	 *
	 * 建群时写一次，之后就是普通字段：团队群的团队管理员、公司群里放 `owner`（收件人
	 * 永远排除发件人、也排除我，所以它不会让谁多醒一次）。私聊不需要它 ——
	 * 两个人里说话的那个会被排除，剩下的本来就会被叫醒。
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
};

export const ChannelDoc = defineDoc<ChannelState>({
	kind: "core.channels",
	version: 1,
	scope: "session",
	initial: () => ({ channels: {}, messages: {}, nextSeq: {}, readMarks: {} }),
	// 什么时候把散着的增量压成一条基线。两个理由各占一半：
	//
	// 1. **重放成本**：基线之前的历史不用再重放，崩溃恢复只重放最多 64 条增量。
	// 2. **磁盘空间**：这个文档是 `scope: "session"` 的，存储层写基线时会把该文档的
	//    旧 revision 全删（`isCurrentOnly` 为真）。也就是说「压基线」在这里同时是
	//    **唯一的回收机制** —— 不压，历史只增不减。
	//
	// 早先只按「单频道 ≥ 256 条消息」判断，结果一直不触发（最多 189 条），库里的
	// 增量无限累积到 60 MB。按增量条数判断拿得到确定的回收上限，与消息分布无关。
	//
	// 但长频道那条**必须带一个增量下限**：写成 `|| 某频道 ≥ 256 条` 就变成恒真 ——
	// 单频道一旦超过 256 条，之后**每次提交都压一份完整基线**（这个文档是 current-only，
	// 压基线会删掉旧 revision），于是「发一条消息」的成本 = 序列化整份频道历史。
	// 实测（2026-10-30）：1600 条时单条提交 0.45ms，且随消息数线性增长；3000 条时
	// 每发一条要写 200KB 以上，RSS 也跟着涨。长频道现在改成每 16 条压一次，
	// 回收上限仍然确定，但不会每条都压。
	checkpointWhen: (value, _ops, info) => {
		const longChannel = Object.values(value.messages).some((list) => list.length >= 256);
		return info.deltasSinceBase >= (longChannel ? 16 : 64);
	},
});

/** 我的 slug。不是 agent，但出现在成员表里。 */
export const OWNER = "owner";

/** 我 slug。与 `OWNER` 同值，单独的常量名便于在阅读时区分「常量」与「比较」。 */
export const OWNER_SLUG = OWNER;

/** 私聊频道的命名规则。双方 slug 排序后拼接，保证 `a-b` 与 `b-a` 是同一个频道。 */
export function dmId(a: string, b: string): string {
	const [left, right] = [a, b].sort();
	return `dm:${left}-${right}`;
}

/**
 * 一条频道是哪种会话。**只看成员表**，不看 id 前缀。
 *
 * 会话只有两种形态：恰好 `{我, 一个 agent}` 是私聊（一对一，说什么都没有第三个人
 * 听见），其余都是群聊（三个人以上，或者一个 agent 都没有的频道）。
 * 频道没有 `kind` 字段 —— 加了就要维护两处事实（成员变了、kind 没变）。
 */
export function chatKind(channel: Channel): "dm" | "group" {
	if (channel.members.length !== 2) return "group";
	if (!channel.members.includes(OWNER)) return "group";
	return "dm";
}

/** 团队频道的命名规则。 */
export function teamId(team: string): string {
	return `team:${team}`;
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
 * 从正文里解析 `@` 名字，返回**解析后的 slug**（`@我` → `owner`，`@CEO` → 那个人）。
 *
 * 传了 `roster` 就按名册严格解析：解析不出来的 token（`@import` / `@media` / `@x`）
 * **丢弃**，因为它们在成员表里不存在，留着只是噪音。
 *
 * 不传 `roster` 时保留旧行为（字面 token 原样返回）—— 旧调用点（外壳的留痕、老数据的
 * 重新投递）不因为这一层而改变语义；我的叫法由 `recipientsOf` 的兜底兜住。
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
 * 这条消息是不是在「要我拍板」。
 *
 * 判据只有一条：消息显式 @了我（`owner` 在 mentions 里）。是否真的需要我拍板，
 * 由说话人自己 @ 决定，代码不再替模型猜关键词。
 *
 * 旧实现用「要不要 / 请确认 / 等你定」这类正则嗅探正文，实测大量出现在普通 @成员
 * 的协作消息里，导致没点我的消息也被标「需要我」、并误把 owner 塞进 mentions —
 * 这正是 #4 要修的误标。关键词嗅探已于本次移除。
 */

/**
 * 谁会被这条消息唤醒。
 *
 * 四条规则，按顺序（后写的不会覆盖先写的，只做并集，最后减去发件人自己）：
 * 1. 明确 `@` 到的人 —— 只有频道成员里的才算（防止 `@` 一个不在这个房间的人
 *    凭空拿到别人房间的上下文）。
 * 2. 我发言且**没有 @ 任何人**时，频道里的第一个非我成员。这条是为了让
 *    「我随口说一句」不至于没人接 —— 只依赖成员顺序，不依赖身份。
 * 3. `wakeOnAll` 里的成员（私聊双方）。
 * 4. 发件人自己永远不唤醒（它正在说话，不需要再被叫一次）。
 *
 * 注意 `@所有人`：如果正文里出现 `@owner`，我会被列为目标。但我没有会话，
 * 投递层会跳过它（见 `deliver.ts`）。
 */
/** 正文里有没有「@某人」这个动作（不管叫不叫得应）。 */
const AT_TOKEN = /@[\p{L}\p{N}._-]+/u;

export function recipientsOf(channel: Channel, message: Message): string[] {
	const targets = new Set<string>();
	const members = new Set(channel.members);

	// 兜底再解析一次别名：老数据里存的是字面 token（`@我`），而频道成员里是 `owner`。
	// 成员过滤规则本身**不动** —— 不是这个房间的人照样 @ 不到（防止拿到别人房间的上下文）。
	for (const mention of message.mentions) {
		const slug = members.has(mention) ? mention : resolveMention(mention, EMPTY_ROSTER);
		if (slug !== undefined && members.has(slug)) targets.add(slug);
	}
	// 「我没 @ 人」才让第一个成员接。**判据看正文里有没有 @，不看解析结果**：
	// 过名册之后 `@nobody` 会解析成空数组，若按 mentions.length 判就会把「你叫了一个
	// 不存在的人」变成「叫了房间里第一个人」—— 我会以为刚才那句没人理。
	if (message.from === OWNER && message.mentions.length === 0 && !AT_TOKEN.test(message.text)) {
		const first = channel.members.find((slug) => slug !== OWNER);
		if (first !== undefined) targets.add(first);
	}
	for (const slug of channel.wakeOnAll) {
		if (members.has(slug)) targets.add(slug);
	}
	targets.delete(message.from);
	return [...targets];
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
 * **只在群聊里找**：私聊是一对一的地方，不是兜底去处 —— 否则我在群里问的一句话会被
 * 答进我和某个人的私聊（实测 2598 条噪音灌进了我的私聊）。顺序是「我是成员的群里最近
 * 活跃的那个」→ 一个群都没有才回落到我和他的私聊。
 *
 * 不新建任何频道：说话只发生在已经存在的频道里，建频道是装配和我的事。
 */
export function fallbackChannelId(state: ChannelState, slug: string): string {
	let best = dmId(OWNER, slug);
	let bestAt = Number.NEGATIVE_INFINITY;
	for (const channel of channelsOf(state, slug)) {
		if (chatKind(channel) !== "group") continue;
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
		/** 名册：给了就按名册解析 `@`（`@我` → `owner`），不给就保留字面 token。 */
		readonly roster?: MentionRoster;
		/** 正文里没写、但要额外记进 `mentions` 的 slug（例如 `decision` 自动补 `owner`）。 */
		readonly mention?: readonly string[];
		/** 附件引用（本体在磁盘上）。空数组按「没有附件」处理。 */
		readonly attachments?: readonly Attachment[];
	},
): { readonly state: ChannelState; readonly message: Message } {
	const channel = state.channels[channelId];
	if (channel === undefined) throw new Error(`频道不存在：${channelId}`);

	const seq = state.nextSeq[channelId] ?? 1;
	const mentions = parseMentions(input.text, input.roster);
	// 代码补的 @（`decision` 自动叫我）不改正文，只进 mentions —— 正文是模型的嘴，
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
 * 与 `ensureChannel` 的区别：后者见到已存在的频道就直接返回，于是「团队管理员后来才
 * 定下来」「新招的人进了团队」都不会反映到成员表里 —— 那些人明明在团队里却收不到团队
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

/**
 * 把某个 slug 在某个频道的已读位置推到 `seq`。回退不生效（已读不会变未读）。
 *
 * `seq` 会**夹到频道真实上界**：已读标记是「读到第几条」，写进一个比历史还大的数字
 * 等于声明「以后所有消息都已读」，未读数从此永远 0 —— 一条越界的请求就能让我
 * 再也看不见红点。路由层已经夹过一次，这里是第二道（唯一写入口自己兜底）。
 */
export function markRead(state: ChannelState, slug: string, channelId: string, seq: number): ChannelState {
	const current = readMarkOf(state, slug, channelId);
	const list = state.messages[channelId] ?? [];
	const lastSeq = list.length === 0 ? 0 : (list[list.length - 1]?.seq ?? 0);
	const wanted = Math.min(Math.max(Math.floor(seq), 0), lastSeq);
	if (!Number.isFinite(seq) || wanted <= current) return state;
	return {
		...state,
		readMarks: { ...state.readMarks, [slug]: { ...(state.readMarks[slug] ?? {}), [channelId]: wanted } },
	};
}

/** 频道里最近 `limit` 条消息（老的在前）。 */
export function tail(state: ChannelState, channelId: string, limit: number): Message[] {
	const list = state.messages[channelId] ?? [];
	return list.slice(Math.max(0, list.length - limit));
}

// ── `@` 解析（原 `alias.ts`）──────────────────────────────────────────────
//
// V2 有一层模糊别名：拼音、简称、身份名（`CEO`）、title 的每一段都能 @ 到人。实测它
// 确实救回了老消息里的 `@老板`，代价是「谁都能被 @ 到」—— 一个词撞上某个人的 title
// 就会把消息投给他。V3 只认三种精确写法，其余一律丢弃：
//
// 1. `slug`（目录名，唯一稳定标识）；
// 2. `name`（`identity.md` 的显示名）；
// 3. `我` / `owner` —— **必须保留**：`rules.md` 每轮都告诉模型「要让我拍板就用 `@我`」，
//    这条映射没了，拍板会静默丢失（没人被叫醒、也不报错）。
//
// 解析不出来的 token（`@import`、`@x`）丢弃：它们不是人，留着只是噪音。

/** 名册里的一个人。字段全部可选（除了 slug）：缺什么就少一种叫法。 */
export type MentionAgent = {
	/** 目录名，唯一稳定标识。 */
	readonly slug: string;
	/** `identity.md` 的 `name`（真名，例如「周砚」）。 */
	readonly name?: string | undefined;
};

/** 一份名册：我的 slug + 全公司的人。 */
export type MentionRoster = {
	/** 我的 slug，正常就是 `owner`。 */
	readonly owner: string;
	readonly agents: readonly MentionAgent[];
};

/** 没有名册时的兜底：只认我。 */
export const EMPTY_ROSTER: MentionRoster = { owner: OWNER, agents: [] };

/**
 * 我的叫法。只剩两个：`owner` 是 slug，`我` 是提示词里那个写法。
 *
 * 「老大」「老板」「boss」这些是历史别名，V3 不认 —— 提示词和界面一律用「我」。
 */
const OWNER_ALIASES: readonly string[] = [OWNER, "我"];

/** 归一：去 `@`、去首尾空格、全角转半角（`ＯＷＮＥＲ` → `owner`）、转小写。 */
function normalizeAlias(raw: string): string {
	return raw
		.normalize("NFKC")
		.trim()
		.replace(/^@+/, "")
		.trim()
		.toLowerCase();
}

/** 从一份身份清单建名册。只带 `slug` 和 `name` —— 没有 role / title 匹配了。 */
export function mentionRosterOf(
	agents: readonly { readonly slug: string; readonly name?: string | undefined }[],
	owner: string = OWNER,
): MentionRoster {
	return { owner, agents: agents.map((agent) => ({ slug: agent.slug, ...(agent.name === undefined ? {} : { name: agent.name }) })) };
}

/**
 * 把 `@` 后面的字解析成 slug。纯函数，喂一份名册。
 *
 * 顺序：slug → 我 → 显示名。都匹配不上返回 `undefined`（调用方丢弃，不瞎猜）。
 */
export function resolveMention(raw: string, roster: MentionRoster = EMPTY_ROSTER): string | undefined {
	const key = normalizeAlias(raw);
	if (key === "") return undefined;
	for (const agent of roster.agents) {
		if (normalizeAlias(agent.slug) === key) return agent.slug;
	}
	if (OWNER_ALIASES.includes(key)) return roster.owner;
	for (const agent of roster.agents) {
		if (agent.name !== undefined && normalizeAlias(agent.name) === key) return agent.slug;
	}
	return undefined;
}
