/**
 * 读：把状态投影成界面要的那几份 JSON。
 *
 * 每一个都是「取一份快照 → 调 `view/` 的纯函数 → 返回 DTO」。这里不碰 request / response，
 * 也不做序列化 —— 序列化是 `interface/http` 的事。这样同样的读法能被 SSE、HTTP、
 * 以及将来任何别的入口共用一份。
 */
import { dirname, join } from "node:path";
import { conversationFor, type DirectoryState } from "../agent/roster.ts";
import { oneLine } from "../oneline.ts";
import type {
	AttentionItem,
	TeamDoingOf,
	TeamLeadOf,
	ViewActor,
	ViewChannel,
	ViewChannelDetail,
	ViewMessage,
	ViewOrg,
} from "../view/dto.ts";
import { OWNER_SLUG, type Identity } from "../agent/identity.ts";
import { redact } from "../agent/secrets.ts";
import { appendMemory, memoryDigest, memoryTimeline, readMemory, removeSection, sectionsOf, writeMemory } from "../agent/memory.ts";
import { listSkills } from "../agent/skills.ts";
import type { ViewPersonMemory, ViewPersonProfile } from "../view/dto.ts";
import { chatKind, readMarkOf, unreadCount, type Channel, type ChannelState, type Message } from "../channel/store.ts";
import { AppError } from "./errors.ts";
import type { Snapshots } from "./snapshot.ts";
import type { CoreServices } from "./types.ts";

/** 频道列表 + 两个汇总数（侧栏顶部那两个红点）。 */
export type ChannelListResult = {
	readonly channels: ViewChannel[];
	readonly unread: { readonly total: number; readonly mentions: number };
};

/** 「能 @ 谁」的候选。 */
export type MentionCandidate = {
	readonly id: number;
	readonly label: string;
	readonly slug: string;
	readonly title: string;
};

export function createRead(shell: CoreServices, snapshots: Snapshots) {
	/** 组织快照。界面的组织图与顶栏都吃这一份。 */
	async function readOrg(): Promise<ViewOrg> {
		const { identities, directory } = await snapshots.snapshot();
		return orgView(identities, directory);
	}

	async function readChannelList(): Promise<ChannelListResult> {
		const { directory, channels, teamLeadOf, teamDoingOf } = await snapshots.snapshot();
		const list = channelList(channels, directory, OWNER_SLUG, teamLeadOf, teamDoingOf);
		return {
			channels: list,
			unread: {
				total: list.reduce((sum, channel) => sum + channel.unread, 0),
				mentions: list.reduce((sum, channel) => sum + channel.mentions, 0),
			},
		};
	}

	/** 一个频道的详情（首屏一页消息 + 成员 + 是否还有更早的）。 */
	async function readChannelDetail(
		id: string,
		options: { readonly limit?: number | undefined; readonly before?: number | undefined } = {},
	): Promise<ViewChannelDetail> {
		const { directory, channels, teamLeadOf, teamDoingOf } = await snapshots.snapshot();
		const channel = channels.channels[id];
		if (channel === undefined) throw new AppError("not-found", "频道不存在或无权查看");
		const { limit, before } = options;
		return channelDetail(channels, channel, directory, {
			teamLeadOf,
			teamDoingOf,
			...(limit !== undefined && Number.isFinite(limit) && limit > 0 ? { limit } : {}),
			...(before !== undefined && Number.isFinite(before) && before > 0 ? { before } : {}),
		});
	}

	/** 「找我」：跨频道、需要我本人看一眼的消息。 */
	async function readAttention(): Promise<{ items: AttentionItem[]; unread: number }> {
		const { directory, channels } = await snapshots.snapshot();
		const items = attentionItems(channels, directory);
		return { items, unread: items.filter((item) => !item.read).length };
	}

	/** 这个频道能 @ 谁。频道不存在就是空列表（不是 404：侧栏还没加载完时会问一次）。 */
	async function readMentionable(id: string): Promise<{ candidates: MentionCandidate[] }> {
		const { identities, directory, channels } = await snapshots.snapshot();
		const channel = channels.channels[id];
		if (channel === undefined) return { candidates: [] };
		// `title` 取自 `identity.md` 的 title（与团队视图同源），让 @ 浮窗显示
		// 「名字 / 身份 / @slug」三层，我要的身份信息就在这里。
		const identityTitle = (slug: string): string => {
			const found = identities.find((item) => item.slug === slug);
			return found?.title ?? "";
		};
		return {
			candidates: channel.members
				.filter((slug) => slug !== OWNER_SLUG)
				.map((slug) => ({
					id: idOf(directory, slug),
					label: shell.labelOf(slug),
					slug,
					title: identityTitle(slug),
				})),
		};
	}

	/** 档案页里「他在哪些频道」那一栏：成员表是真相，界面不用自己比。 */
	async function channelsOf(slug: string): Promise<{ id: string; kind: "dm" | "group"; title: string }[]> {
		const state = await shell.channels();
		return Object.values(state.channels ?? {})
			.filter((channel) => channel.members.includes(slug))
			.map((channel) => ({ id: channel.id, kind: chatKind(channel), title: channel.title }));
	}

	return { readOrg, readChannelList, readChannelDetail, readAttention, readMentionable, channelsOf };
}

export type Read = ReturnType<typeof createRead>;

// ── 人（原 `people.ts`）─────────────────────────────────────────────────
// 并进这里的原因：「读一个人」和「读一个频道」是同一个用例的另一半 —— 都是把盘上的
// 事实投影成界面要的形状，拆两个文件的结果是两边各自拼一遍 label 与 memory。

/**
 * 一个人的档案与记忆。
 *
 * 界面右上角那个「详情」面板与记忆抽屉要的所有东西都在这里取，**不给界面对磁盘的
 * 访问权**（它会拿 slug 去拼路径），也不让它自己去读技能目录 —— 那等于把「路径怎么拼」
 * 这份知识复制到前端，两处早晚不一致。
 */

/** 记忆一次写操作的请求体。 */
export type MemoryEditBody = {
	readonly op?: string;
	readonly heading?: string;
	readonly text?: string;
};

export function createPeople(shell: CoreServices, snapshots: Snapshots, read: Read) {
	/**
	 * 只认名册里的 slug —— 这既挡住了路径穿越，也让「查一个不存在的人」老实回 404，
	 * 而不是先建出一个空目录。
	 */
	function requireSlug(directory: DirectoryState, slug: string): void {
		if (!(slug in directory.slugToConversation) || slug === OWNER_SLUG) {
			throw new AppError("not-found", "没有这个人");
		}
	}

	/** 档案：身份 / 技能 / 记忆概况 / 所在频道。 */
	async function readPersonProfile(slug: string): Promise<ViewPersonProfile> {
		const { identities, directory } = await snapshots.snapshot();
		requireSlug(directory, slug);
		const skills = await listSkills({ workspace: dirname(shell.agentsRoot), agents: shell.agentsRoot }, slug);
		const identity = identities.find((candidate) => candidate.slug === slug);
		const source = (await readMemory(join(shell.agentsRoot, slug))) ?? "";
		return {
			slug,
			label: labelIn(directory, slug),
			title: identity?.title ?? "",
			...(identity?.team === undefined ? {} : { team: identity.team }),
			manager: identity?.manager ?? "",
			managerLabel: identity?.manager === undefined ? "" : labelIn(directory, identity.manager),
			body: identity?.body ?? "",
			skills: skills.map((skill) => ({
				name: skill.name,
				description: skill.description,
				scope: skill.scope,
				overrides: skill.overrides === true,
			})),
			memory: {
				exists: source !== "",
				entries: sectionsOf(source).length,
				digest: memoryDigest(source) ?? null,
			},
			channels: await read.channelsOf(slug),
		};
	}

	/** 记忆全文 + 按小节拆开的条目（带 `.memory-journal.jsonl` 的留痕）。 */
	async function readPersonMemory(slug: string): Promise<ViewPersonMemory> {
		const { directory } = await snapshots.snapshot();
		requireSlug(directory, slug);
		const agentDir = join(shell.agentsRoot, slug);
		const source = (await readMemory(agentDir)) ?? "";
		const stamps = await memoryTimeline(agentDir);
		return {
			slug,
			label: withLabels(directory, []).labels?.[slug] ?? slug,
			exists: source !== "",
			digest: memoryDigest(source) ?? null,
			// `at`/`by`/`op` 来自 `.memory-journal.jsonl`。手写进 memory.md 的条目没有日志，
			// 就照实给 `null` —— 不拿「现在」去冒充「当时」（ADR-016）。
			entries: sectionsOf(source).map((section) => {
				const stamp = stamps.get(section.heading);
				return {
					heading: section.heading,
					body: section.body,
					at: stamp?.at ?? null,
					by: stamp?.by ?? null,
					op: stamp?.op ?? null,
				};
			}),
			raw: source,
		};
	}

	/**
	 * 删一条 / 添一条记忆。
	 *
	 * `actor` 由调用方给（网页写 `owner:web`，agent 自己 `remember` 写 `agent`），
	 * 这样以后真出错时，「这条是人在面板上删的」和「它自己改的」能一眼分开。
	 */
	async function editPersonMemory(
		slug: string,
		body: MemoryEditBody,
		actor: string,
	): Promise<{ ok: true; entries: number }> {
		const { directory } = await snapshots.snapshot();
		requireSlug(directory, slug);
		const agentDir = join(shell.agentsRoot, slug);
		if (body.op === "forget") {
			const source = (await readMemory(agentDir)) ?? "";
			// 重建交给 `removeSection`：删除必须和 `sectionsOf` 用同一套分段口径，
			// 在这里手拼行切片实测会把后面的节写坏（删末节最容易被漏）。
			const next = removeSection(source, body.heading ?? "");
			if (next === undefined) throw new AppError("not-found", "没有这一条记忆（可能已经被删掉）");
			const result = await writeMemory(agentDir, next, actor);
			return { ok: true, entries: sectionsOf(result.source).length };
		}
		if (body.op === "add") {
			// 网页上贴进来的这条也会进提示词，跟 agent 自己 `remember` 一样过脱敏。
			const result = await appendMemory(agentDir, redact(body.text ?? "", dirname(shell.agentsRoot)), new Date(), actor);
			if (!result.changed) throw new AppError("bad-request", result.message);
			return { ok: true, entries: sectionsOf(result.source).length };
		}
		throw new AppError("bad-request", "op 只能是 forget 或 add");
	}

	return { readPersonProfile, readPersonMemory, editPersonMemory };
}

// ── 投影（原 `view/index.ts`）─────────────────────────────────────────────
// 并进这里的原因：投影函数只被「读」这一个用例用（`read.ts` / `snapshot.ts` / `hub.ts`），
// 单独一层是为了当年「界面契约唯一权威」那个抽象；现在契约只剩 `dto.ts`（纯类型、零 IO），
// 函数跟着用例走，少一层跳转、少一处「改字段要改两个地方」。

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
 * - **`kind`**：界面只需要知道「私聊还是群聊」。这是成员表的事（恰好 `{我, 一个
 *   agent}` 就是私聊），所以这里直接转 `chatKind()` 的结果，不猜 id 前缀。
 */

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

/** 「人说的话」的几种 kind。侧栏预览与「找你」共用 —— 过程投影与系统告警都不算。 */
const SPOKEN_KINDS = new Set(["chat", "say", "question", "decision", "report"]);

/** 一条消息的正文预览：只取第一行、压成一行、最多 60 字。 */
function previewOf(message: Message | undefined): string {
	if (message === undefined) return "";
	const first = message.text.split("\n").find((line) => line.trim() !== "") ?? "";
	return oneLine(first, 60);
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
	teamLeadOf?: TeamLeadOf,
	teamDoingOf?: TeamDoingOf,
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
		// 大量出现（实测侧栏整列显示 `$ cd /Users/kirer/teams/...`）。拿它当预览，
		// 我扫一眼会以为这个频道里没人说话，全是机器输出 —— 而其实下面就有正常对话。
		// `note` 是系统告警（接力到上限、投递失败），同理不能当预览。
		const lastSpoken =
			messages.findLast((item) => SPOKEN_KINDS.has(item.kind)) ??
			messages.findLast((item) => item.kind !== "note");
		const unread = unreadCount(state, channel.id, slug);
		// 「@ 我」的条数：未读里点名提到我的那些。界面上它们比普通未读更红。
		const mentions = messages.filter(
			(message) => message.seq > readMarkOf(state, slug, channel.id) && message.mentions.includes(slug),
		).length;
		const team = channel.id.startsWith("team:") ? channel.id.slice("team:".length) : undefined;
		const lead = team === undefined ? undefined : teamLeadOf?.(team);
		const doing = team === undefined ? undefined : teamDoingOf?.(team);
		out.push({
			id: channel.id,
			kind: chatKind(channel),
			...(lead === undefined || lead === "" ? {} : { lead, leadLabel: labelIn(directory, lead) }),
			...(doing === undefined || doing === "" ? {} : { doing }),
			title: titleOf(channel, directory),
			...(team === undefined ? {} : { team }),
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
 * 「这条要不要我看一眼」。
 *
 * 我自己说的话不算（他不需要提醒自己）。判据只有一条：消息显式 @了我。
 *
 * 旧逻辑用关键词嗅探（「要不要/请确认/等你定」），会把没点我的
 * 普通 @成员 协作消息误标「需要我」—— 这正是 #4 要修的误标。关键词嗅探已移除，
 * 关键词嗅探已删除（连同同名函数），这里只认显式 @owner。
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

	const quoted = message.replyTo === undefined ? undefined : (state.messages[channel.id] ?? []).find((item) => item.seq === message.replyTo);
	const excerptSource = quoted?.text.split("\n").find((line) => line.trim() !== "")?.trim() ?? "";
	return {
		seq: message.seq,
		at: message.at,
		from: idOf(directory, message.from),
		fromSlug: message.from,
		fromLabel: labelIn(directory, message.from),
		kind: message.kind,
		text: message.text,
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
						excerpt: excerptSource.length > 60 ? `${excerptSource.slice(0, 60)}…` : excerptSource,
					},
				}),
		read: readMarkOf(state, viewer, channel.id) >= message.seq,
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
		readonly teamLeadOf?: TeamLeadOf;
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
	const leadSlug = teamSlug === undefined ? undefined : options.teamLeadOf?.(teamSlug);
	const doing = teamSlug === undefined ? undefined : options.teamDoingOf?.(teamSlug);
	// 私聊的标题是那个人的名字（`titleOf` 现算，不读频道里存的那份）。
	return {
		channel: {
			id: channel.id,
			kind: chatKind(channel),
			...(leadSlug === undefined || leadSlug === ""
				? {}
				: { lead: leadSlug, leadLabel: labelIn(directory, leadSlug) }),
			...(doing === undefined || doing === "" ? {} : { doing }),
			title: titleOf(channel, directory),
			...(teamSlug === undefined ? {} : { team: teamSlug }),
			lastAt: last?.at ?? channel.createdAt,
			lastSeq: last?.seq ?? 0,
			memberCount: channel.members.length,
		},
		members: channel.members.map((slug) => ({
			id: idOf(directory, slug),
			slug,
			label: labelIn(directory, slug),
			// `role` 的价值在界面：团队频道里要一眼看出谁是团队管理员。只用三种能从文件里
			// 读出来的事实（我 / 团队管理员 / 成员），不引身份枚举。
			role:
				slug === OWNER_SLUG
					? "owner"
					: leadSlug !== undefined && slug === leadSlug
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
 * 只给「有谁、谁向谁汇报」这两件事。人按「离我最近」优先排序：`manager` 是我的
 * 排最前，其余按报名顺序 —— 界面左侧成员列表直接用这个顺序。
 */
export function orgView(identities: readonly Identity[], directory: DirectoryState, companyName = "Solo"): ViewOrg {
	const toActor = (identity: Identity): ViewActor => ({
		slug: identity.slug,
		label: identity.name ?? identity.slug,
		title: identity.title ?? "",
		...(identity.team === undefined ? {} : { team: identity.team }),
		...(identity.manager === undefined ? {} : { manager: identity.manager }),
		...(identity.manager === undefined ? {} : { managerLabel: labelIn(directory, identity.manager) }),
		body: identity.body,
	});

	// 知言（我唯一直接对话的助理）固定排第一（pin to top）：任何成员/团队列表恒首位。
	const pinned = identities.filter((identity) => identity.slug === "知言");
	const rest = identities.filter((identity) => identity.slug !== "知言");
	return {
		company: { name: companyName },
		people: [...pinned.map(toActor), ...nearestOf(rest).map(toActor), ...othersOf(rest).map(toActor)],
	};
}

/** 离我最近（manager 是我）的排在前面，其余按原序。 */
function nearestOf(identities: readonly Identity[]): readonly Identity[] {
	return identities.filter((identity) => identity.manager === OWNER_SLUG);
}
function othersOf(identities: readonly Identity[]): readonly Identity[] {
	return identities.filter((identity) => identity.manager !== OWNER_SLUG);
}

/** slug → 显示名。名册里没有就给 slug 本身（总比空白强）。 */
export function labelIn(directory: DirectoryState, slug: string): string {
	if (slug === OWNER_SLUG) return "我";
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
 * 我的抱怨是「消息太多，真正需要我的信息没有 @ 我，没法直接定位」。频道列表只能给出
 * 每个频道一个红点，回答不了「我现在该看哪一条」。这份列表把散落在所有频道里、真正
 * 等他开口的消息按时间倒序摊平，每条都带回到原频道的锚点。
 *
 * 只收 7 天内、最多 60 条：再旧的已经该由记忆处理，不该占着「待办」的位置。已读的也
 * 收（带 `read` 标记），因为「读过了但还没作答」和「没看见」是两件事，界面可以分开显示。
 */
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
			// 只收「说出口的话」。历史的过程投影（think / tool / work）和系统 note 不是发言，
			// 它们里的「要不要 / 还是 / 怎么定」是模型的自言自语（实测 60 条里有 40 多条
			// 是英文内心独白），进来就把这个列表变成噪音。
			if (!SPOKEN_KINDS.has(message.kind)) continue;
			if (!needsYou(message)) continue;
			// 说给别人听的不进。`needsYou` 的判据（`要不要` / `还是` / `怎么定`）故意宽，
			// 因为模型忘了 @ 我的代价更高；但在「找你」这个列表里必须再收一道：
			// 一条消息如果**明确点了别人**而没点我，它就不是找我的。
			const others = message.mentions.filter((slug) => slug !== viewer);
			if (others.length > 0 && !message.mentions.includes(viewer)) continue;
			const first = message.text.split("\n").find((line) => line.trim() !== "")?.trim() ?? "";
			out.push({
				channelId: channel.id,
				channelKind: chatKind(channel),
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
