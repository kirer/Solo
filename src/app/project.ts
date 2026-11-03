/**
 * 投影：核心状态 → 界面要的那份 JSON。
 *
 * 这一层只有一个职责：把文件夹与频道翻译成 `ui` 要吃的 JSON。
 * 核心的真相是 slug 与文件，界面要的是排序过的列表与可点的锚点，翻译在这。
 *
 * 两个「界面需要、核心不需要」的概念，是这一层存在的全部理由：
 * - **数字 id**：界面到处用 `conversationId` 做 key（成员、@ 对象、看板卡片）。
 *   核心的稳定标识是 slug，但界面上要一个能排序、能当 DOM 属性的东西。这里把
 *   slug → 会话 id 的映射拿出来当 id 用，界面对它一无所知。
 * - **`kind`**：界面只需要知道「私聊还是群聊」。这是成员表的事（恰好 `{我, 一个
 *   agent}` 就是私聊），所以这里直接转 `chatKind()` 的结果，不猜 id 前缀。
 *
 * 纯函数、无 IO：状态由调用方递进来，所以单测可以直接喂一个假频道。
 */
import { OWNER_SLUG, labelsOf, type Identity } from "../core/agent/identity.ts";
import { type MemoryStamp } from "../core/agent/memory.ts";
import { sectionsOf } from "../core/md/memory.ts";
import { conversationFor, labelIn, type DirectoryState } from "../core/agent/roster.ts";
import { chatKind, spokenKind, type Channel, type ChannelState, type Message } from "../core/channel/types.ts";
import { readMarkOf, unreadCount } from "../core/channel/rules.ts";
import { excerptOf } from "../core/md/oneline.ts";
import type {
	AttentionItem,
	TeamDoingOf,
	ViewActor,
	ViewChannel,
	ViewChannelDetail,
	ViewMemoryEntry,
	ViewMessage,
	ViewOrg,
} from "../view/dto.ts";

/**
 * 频道显示成什么标题：私聊是**对方的名字**，群聊是频道自己的标题（团队频道就是团队名）。
 *
 * 私聊不存「对方是谁」这个字段 —— 成员表里除了我之外的另一个就是它，名字从名册现取，
 * 改了 `identity.md` 下一条消息就生效。
 */
function titleOf(channel: Channel, directory: DirectoryState): string {
	if (chatKind(channel) !== "dm") return channel.title;
	const other = channel.members.find((slug) => slug !== OWNER_SLUG);
	return other === undefined ? channel.title : labelIn(directory, other);
}

/**
 * 由 slug 拿界面 id（会话号）。名册里没有的给 -1，界面上会显示成一串连不上的节点。
 *
 * 界面侧（`app/`）也用它：id 的算法只能有一份，否则「@ 浮窗里的 id」与「成员列表里的
 * id」会漂成两个数，界面上点谁都点不开。
 */
export function idOf(directory: DirectoryState, slug: string): number {
	if (slug === OWNER_SLUG) return 0;
	return conversationFor(directory, slug) ?? -1;
}

/**
 * 显示用正文：我只有「我」这一个叫法，`owner` 是内部 slug。
 * 模型偶尔照规矩原文写出 `@owner`（实测知言这么写过），界面上一律显示成 `@我`。
 * 只改投影，不改落盘的那份 —— 提示词与历史记录仍是模型自己写的字。
 */
const OWNER_TOKEN = /(?<![A-Za-z0-9._%+-])@owner(?![\p{L}\p{N}_-])/gu;
function spokenText(text: string): string {
	return text.replace(OWNER_TOKEN, "@我");
}

/** 一条消息的正文预览：只取第一行、压成一行、最多 60 字。 */
function previewOf(message: Message | undefined): string {
	return message === undefined ? "" : excerptOf(spokenText(message.text), 60);
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

/** 频道列表。 */
export function channelList(
	state: ChannelState,
	directory: DirectoryState,
	slug = OWNER_SLUG,
	teamDoingOf?: TeamDoingOf,
): ViewChannel[] {
	const out: ViewChannel[] = [];
	for (const channel of Object.values(state.channels)) {
		if (channel.archived === true) continue;
		const messages = state.messages[channel.id] ?? [];
		const last = messages[messages.length - 1];
		// 侧栏预览只取「人说的话」：系统告警与旧版本的过程行（`$ cd …`、工具名）都不是发言，
		// 拿它们当预览，我扫一眼会以为这个频道里没人说话 —— 而其实下面就有正常对话。
		// 判据只有 `spokenKind` 一处。
		const lastSpoken = messages.findLast((item) => spokenKind(item.kind));
		const unread = unreadCount(state, channel.id, slug);
		// 「@ 我」的条数：未读里**点名找我**的那些（判据同 `needsYou`：正文第一个点名的是我）。
		// 界面上它们比普通未读更红。
		const mentions = messages.filter(
			(message) => message.seq > readMarkOf(state, slug, channel.id) && addressedTo(message, slug),
		).length;
		const team = channel.id.startsWith("team:") ? channel.id.slice("team:".length) : undefined;
		const doing = team === undefined ? undefined : teamDoingOf?.(team);
		out.push({
			id: channel.id,
			kind: chatKind(channel),
			...(doing === undefined || doing === "" ? {} : { doing }),
			title: titleOf(channel, directory),
			...(team === undefined ? {} : { team }),
			unread,
			mentions,
			preview: previewOf(lastSpoken),
			lastAt: last?.at ?? channel.createdAt,
			lastSeq: last?.seq ?? 0,
			memberCount: channel.members.length,
			members: channel.members.filter((slug) => slug !== OWNER_SLUG),
		});
	}
	// 界面期望「最近的在前」。
	return out.sort((left, right) => right.lastAt - left.lastAt);
}

/**
 * 这条消息是不是**点名找这个人**：正文里第一个被点名的人就是他。
 *
 * 为什么不是「mentions 里有他」：一句话里可以顺手提到好几个人。真实的一条是
 * 「@林越 方向变了……改完 @沈舟 复测、@我 报一句新增了什么」—— 这条是派活给林越的，
 * 里面的 `@我` 是**让林越回头找我**，不是现在找我。按「点没点到我」算，它会挂上
 * 「需要你」、进「找你」列表、侧栏还亮一个数字，全是假的。
 *
 * 判据只看顺序：先说谁，就是说给谁。引用回复补进来的作者排在最后，抢不了第一。
 */
function addressedTo(message: Message, slug: string): boolean {
	if (message.from === slug) return false;
	return message.mentions[0] === slug;
}

/** 「这条要不要我看一眼」。我自己说的话不算（不需要提醒自己）。 */
function needsYou(message: Message): boolean {
	return addressedTo(message, OWNER_SLUG);
}

/** 一条消息的视图。 */
export function messageView(
	state: ChannelState,
	channel: Channel,
	message: Message,
	directory: DirectoryState,
	viewer = OWNER_SLUG,
): ViewMessage {

	const quoted = message.replyTo === undefined ? undefined : (state.messages[channel.id] ?? []).find((item) => item.seq === message.replyTo);
	return {
		seq: message.seq,
		at: message.at,
		from: idOf(directory, message.from),
		fromSlug: message.from,
		fromLabel: labelIn(directory, message.from),
		// 界面只认两种 kind：旧数据里的语义标签算发言，过程行算留痕（不画）。
		kind: spokenKind(message.kind) ? "chat" : "note",
		...(message.noteOf === undefined ? {} : { noteOf: message.noteOf }),
		text: spokenText(message.text),
		mentions: message.mentions.map((slug) => ({
			id: idOf(directory, slug),
			label: labelIn(directory, slug),
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
						fromLabel: labelIn(directory, quoted.from),
						excerpt: excerptOf(spokenText(quoted.text), 60),
					},
				}),
		read: readMarkOf(state, viewer, channel.id) >= message.seq,
		...(message.options === undefined || message.options.length === 0
			? {}
			: { options: [...message.options] }),
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
		/** 助理的 slug（身份目录在应用根下的那些人）。成员角色要靠它标「助理」。 */
		readonly assistants?: readonly string[];
		readonly teamDoingOf?: TeamDoingOf;
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
	const teamSlug = channel.id.startsWith("team:") ? channel.id.slice("team:".length) : undefined;
	const assistants = new Set(options.assistants ?? []);
	const doing = teamSlug === undefined ? undefined : options.teamDoingOf?.(teamSlug);
	// 私聊的标题是那个人的名字（`titleOf` 现算，不读频道里存的那份）。
	return {
		channel: {
			id: channel.id,
			kind: chatKind(channel),
			...(doing === undefined || doing === "" ? {} : { doing }),
			title: titleOf(channel, directory),
			...(teamSlug === undefined ? {} : { team: teamSlug }),
			lastAt: last?.at ?? channel.createdAt,
			lastSeq: last?.seq ?? 0,
			memberCount: channel.members.length,
			members: channel.members.filter((slug) => slug !== OWNER_SLUG),
		},
		members: channel.members.map((slug) => ({
			id: idOf(directory, slug),
			slug,
			label: labelIn(directory, slug),
			// `role` 的价值在界面：一眼看出谁是我、谁是助理。只有三种，都是文件里读得出来的事实。
			role: slug === OWNER_SLUG ? "owner" : assistants.has(slug) ? "assistant" : "member",
			unread: unreadCount(state, channel.id, slug),
		})),
		messages: page.map((message) => messageView(state, channel, message, directory, viewer)),
		hasMore: start > 0,
	};
}

/**
 * 组织快照：有谁、谁在哪个团队。
 *
 * 助理排最前（界面左侧成员列表直接用这个顺序），其余按名册顺序。谁是助理由传进来的
 * `assistants` 说了算 —— 这个投影不认识文件夹，也不该自己去推谁「离我最近」。
 */
export function orgView(
	identities: readonly Identity[],
	orgName = "Solo",
	assistants: readonly string[] = [],
): ViewOrg {
	const assistantSet = new Set(assistants);
	const toActor = (identity: Identity): ViewActor => ({
		slug: identity.slug,
		label: identity.name ?? identity.slug,
		title: identity.title ?? "",
		...(identity.team === undefined ? {} : { team: identity.team }),
		...(assistantSet.has(identity.slug) ? { assistant: true as const } : {}),
		body: identity.body,
	});
	const first = identities.filter((identity) => assistantSet.has(identity.slug));
	const rest = identities.filter((identity) => !assistantSet.has(identity.slug));
	return {
		workspace: { name: orgName },
		people: [...first,...rest].map(toActor),
	};
}

/** 名册里补上显示名（核心的 `identity.md` 是唯一事实，名册只是投影）。 */
export function withLabels(directory: DirectoryState, identities: readonly Identity[]): DirectoryState {
	return { ...directory, labels: { ...(directory.labels ?? {}), ...labelsOf(identities) } };
}

/**
 * 「找你的 N 件事」。
 *
 * 我的抱怨是「消息太多，真正需要我的信息没有 @ 我，没法直接定位」。频道列表只能给出
 * 每个频道一个红点，回答不了「我现在该看哪一条」。这份列表把散落在所有频道里、真正
 * 等他开口的消息按时间倒序摊平，每条都带回到原频道的锚点。
 *
 * 只收 7 天内、最多 60 条：再旧的已经该由记忆处理，不该占着「待办」的位置。已读的也
 * 收（带 `read` 标记），因为「读过了但还没作答」和「没看见」是两件事，界面可以分开显示。
 */
const ATTENTION_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const ATTENTION_MAX = 60;

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
			// 只收「说出口的话」。旧版本的过程投影（think / tool / work）和系统 note 不是发言，
			// 它们里的「要不要 / 还是 / 怎么定」是模型的自言自语（实测 60 条里有 40 多条
			// 是英文内心独白），进来就把这个列表变成噪音。
			if (!spokenKind(message.kind)) continue;
			// 点名找我的才进（别人在先、末尾顺手 @我 的那种是派活给别人，见 `addressedTo`）。
			if (!needsYou(message)) continue;
			out.push({
				channelId: channel.id,
				channelTitle: channel.title,
				seq: message.seq,
				at: message.at,
				from: idOf(directory, message.from),
				fromSlug: message.from,
				fromLabel: labelIn(directory, message.from),
				excerpt: excerptOf(spokenText(message.text), 80),
				read: mark >= message.seq,
			});
		}
	}
	return out.sort((left, right) => right.at - left.at).slice(0, ATTENTION_MAX);
}
/**
 * 记忆全文 → 逐条。
 *
 * 有日志（个人记忆的 `.memory-journal.jsonl`）就带上时间与作者；没有就照实给 `null` ——
 * 不拿「现在」去冒充「当时」（ADR-016）。团队记忆没有日志，全靠这一条。
 */
export function memoryEntries(source: string, stamps?: ReadonlyMap<string, MemoryStamp>): ViewMemoryEntry[] {
	return sectionsOf(source).map((section) => {
		const stamp = stamps?.get(section.heading);
		return {
			heading: section.heading,
			body: section.body,
			at: stamp?.at ?? null,
			by: stamp?.by ?? null,
			op: stamp?.op ?? null,
		};
	});
}
