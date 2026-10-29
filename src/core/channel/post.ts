/**
 * 发消息：落库 + 唤醒，成对完成。
 *
 * 这是新核心里唯一「写频道」的入口。落库与唤醒必须在同一个地方做，否则会出现
 * 两种静默失败：
 *
 * - **存了没叫**（消息在，人不知道）——踩过一次：`say` 不解析正文里的
 *   `@`，CPO 用 `say` 发了「@CEO 项目已建好」，CEO 从来没被唤醒，项目静默停摆。
 * - **叫了没存**（人醒来看不到东西）——不会报错，只会让 agent 反复「你说什么？」。
 *
 * 所以 `postMessage` 里三件事固定这个顺序：解析 @ → 写文档 → 唤醒收件人。
 */
import type { Conversation, Harness } from "../runtime/index.ts";
import { BACKGROUND_CONTEXT, type Context } from "../runtime/index.ts";
import {
	ChannelDoc,
	OWNER,
	appendMessage,
	botHopsSinceOwner,
	parseMentions,
	recipientsOf,
	relayLimit,
	type Attachment,
	type Channel,
	type ChannelState,
	type Message,
} from "./state.ts";
import { EMPTY_ROSTER } from "./alias.ts";
import type { MentionRoster } from "./alias.ts";
import {
	deliver,
	coalesceQueue,
	liveConversations,
	renderDigest,
	type DeliverIssue,
	type DeliverResult,
	type WakeRecord,
} from "./deliver.ts";
import { renderUnanswered } from "./unanswered.ts";

// T-016 v2：占位填充时的逐字增量推送钩子。由 serveCore 在启动时挂载（写进 channelClients），
// 未挂载时为空操作 —— post.ts 不依赖 shell/serve，避免循环依赖。
// 语义：某条 pending 占位被真实回复原地填充时，推 `token`（分片增量）+ `done`（全文兜底）。
type ChannelStreamHook = (channelId: string, seq: number, fullText: string) => void;
let channelStreamHook: ChannelStreamHook | undefined;
export function setChannelStreamHook(hook: ChannelStreamHook | undefined): void {
	channelStreamHook = hook;
}

/** T-016 v2：该频道是否还有前端 SSE 订阅（serveCore 注入的查询函数）。无人订阅则不产生增量事件。 */
let channelClientsHas: (channelId: string) => boolean = () => false;
export function setChannelClientsHas(fn: (channelId: string) => boolean): void {
	channelClientsHas = fn;
}

export type PostResult = {
	readonly channel: Channel;
	readonly message: Message;
	/** 没唤醒任何人时是空数组。 */
	readonly delivery: DeliverResult;
	/** 这条被并进了上一条过程话（没有新增消息，也没有新的唤醒）。 */
	readonly merged?: boolean;
};

export type PostInput = {
	readonly channelId: string;
	readonly from: string;
	readonly text: string;
	readonly at: number;
	readonly kind?: string;
	readonly replyTo?: number;
	/** 名册：给了就按名册把 `@老板` / `@CEO` 落库成规范 slug。 */
	readonly roster?: MentionRoster;
	/** 正文里没写、但要记进 `mentions` 的 slug（`decision` 自动补 `owner` 走这条）。 */
	readonly mention?: readonly string[];
	/** 不想唤醒任何人（比如系统留痕）。缺省会唤醒。 */
	readonly wake?: false;
	/** T-016：占位消息生成状态（缺省 undefined → done）。 */
	readonly status?: "pending" | "done" | "error";
	/** T-016：占位归属的被唤醒人 slug。 */
	readonly pendingFor?: string;
	/** T-016：处理中指示占位（显示动画文案「开始处理…」）。被真实回复原地覆盖后消失。 */
	readonly processing?: boolean;
	/** 附件引用。必须在这里给（不是事后补），否则投递时还不知道有图，模型就看不见。 */
	readonly attachments?: readonly Attachment[];
	/** 过程话（ADR-065）。可以连发；30 秒内同一人的连续过程话并进上一条。 */
	readonly step?: boolean;
};

export type PostDeps = {
	readonly harness: Harness;
	readonly state: ChannelState;
	readonly conversationOf: (slug: string) => Promise<Conversation | undefined>;
	readonly labelOf?: (slug: string) => string;
	readonly rememberWake?: (slug: string, wake: WakeRecord) => Promise<void>;
	/** 附件根目录。给了模型就能真的看见消息里的图片。 */
	readonly uploadsRoot?: string;
};

/**
 * 过程话的合并窗口。
 *
 * ds-bot 的 `ROOM_STEP_GAP_MS = 30_000`（`constants.js`）是这个数：30 秒内同一个人连发的
 * 过程话算同一个动作。窗口太大 → 五分钟后的新进展被塞进旧消息，读者以为那条消息没变；
 * 太小 → 「我先看下」和「找到了」又分成两条。
 */
const STEP_MERGE_MS = 30_000;

/**
 * 这条过程话能不能并进上一条：同一个人、上一条也是过程话、30 秒内、不是占位、没人被 @。
 *
 * 「有人被 @」不合并是一条硬规矩：`@` 意味着「这句话必须叫醒他」，把它并进一条
 * 已经投递过的消息里，被 @ 的人就永远收不到新的那次投递。
 */
function stepMergeIndex(list: readonly Message[], input: PostInput): number {
	if (input.step !== true || input.wake === false) return -1;
	const last = list[list.length - 1];
	if (last === undefined) return -1;
	if (last.from !== input.from || last.step !== true) return -1;
	if (last.status === "pending" || last.processing === true) return -1;
	if (input.at - last.at > STEP_MERGE_MS || input.at < last.at) return -1;
	if (parseMentions(input.text).some((slug) => slug !== input.from)) return -1;
	return list.length - 1;
}

/**
 * 试着把这条过程话并进上一条，成功就返回（没有新消息、没有新唤醒）。
 *
 * 为什么合并之后**不再投递**：并入的是同一个人同一个动作的后续几句话，读的人
 * 下一次被叫醒时会看到完整正文。每并入一次都再叫醒一遍，一个人写三段过程就打扰
 * 收件人三次 —— 那正是要消除的东西。
 */
async function mergeStep(
	deps: PostDeps,
	input: PostInput,
	channelMeta: Channel,
	context: Context,
): Promise<PostResult | undefined> {
	const list = deps.state.messages[input.channelId] ?? [];
	const index = stepMergeIndex(list, input);
	if (index < 0) return undefined;
	const expected = list[index]!.seq;
	let seq = 0;
	await deps.harness.commit(async (tx) => {
		const doc = await tx.doc(ChannelDoc);
		const state = doc as ChannelState;
		const arr = state.messages[input.channelId] as Message[] | undefined;
		const prev = arr?.[index];
		// 期间有人插了一条，位置已经变了：放弃合并，退化成一条新消息（调用方会重走正常路径）。
		if (prev === undefined || prev.seq !== expected) return;
		const joined = `${prev.text}\n${input.text}`.trim();
		arr![index] = {
			...prev,
			text: joined,
			at: input.at,
			mentions: parseMentions(joined),
		};
		seq = prev.seq;
	}, context);
	if (seq === 0) return undefined;
	return {
		channel: channelMeta,
		message: JSON.parse(JSON.stringify(list[index])) as Message,
		delivery: { delivered: [], failed: [], skipped: [] },
		merged: true,
	};
}

/**
 * 一轮结束：把这个人在这个频道里、属于这一轮的未填占位**删掉**。
 *
 * 为什么是删而不是标 `status: "error"`：占位是 `kind: "chat"` 的单人消息，标成 error 之后
 * 它就是一条看得见的「他说了一句开始处理」—— 未读数、侧栏 preview、消息流全被污染。
 * 它本来就不该算一句话，没人来填就该当没发生过。
 *
 * `upToAt` 是这一轮由哪条消息唤醒的：只删 `at <= upToAt` 的占位。老板中途插话会顺手
 * 建一条**新的**占位（`at` 更大），不能被这一轮的收尾连带删掉。
 */
export async function removePlaceholders(
	deps: { readonly harness: PostDeps["harness"] },
	channelId: string,
	slug: string,
	upToAt: number,
	context: Context,
): Promise<number> {
	let removed = 0;
	await deps.harness.commit(async (tx) => {
		const doc = (await tx.doc(ChannelDoc)) as ChannelState;
		const list = doc.messages[channelId] as Message[] | undefined;
		if (list === undefined) return;
		// 从后往前删：splice 之后下标会变，倒序遍历不用重算。
		for (let index = list.length - 1; index >= 0; index -= 1) {
			const message = list[index];
			if (message === undefined) continue;
			if (message.from !== slug || message.processing !== true) continue;
			if (message.at > upToAt) continue;
			list.splice(index, 1);
			removed += 1;
		}
	}, context);
	return removed;
}

/** 占位最长活多久。与前端 `PLACEHOLDER_TTL_MS` 同一个数（10 分钟）。 */
export const PLACEHOLDER_TTL_MS = 10 * 60_000;

/**
 * 启动时清掉「早就没人管」的处理中占位。
 *
 * 只清**已经不会有结果的**：占位超过 TTL，且这个人此刻没有在跑的一轮（`busySlugs`）。
 * 老板插话后刚建的新占位属于新一轮，`at` 是「刚才」，既超不过 TTL 也不在忙碌名单外，
 * 所以不会被误清 —— 这条判据是这次返工的重点（上一版只按年龄，会把新一轮的也扫掉）。
 */
export async function expireStalePlaceholders(
	harness: { commit: PostDeps["harness"]["commit"] },
	options: { readonly maxAgeMs?: number; readonly busySlugs?: ReadonlySet<string> } = {},
	context: Context = BACKGROUND_CONTEXT,
): Promise<number> {
	const maxAgeMs = options.maxAgeMs ?? PLACEHOLDER_TTL_MS;
	const busy = options.busySlugs ?? new Set<string>();
	const now = Date.now();
	let removed = 0;
	await harness.commit(async (tx) => {
		const doc = (await tx.doc(ChannelDoc)) as ChannelState;
		for (const channelId of Object.keys(doc.messages)) {
			const list = doc.messages[channelId] as Message[] | undefined;
			if (list === undefined) continue;
			for (let index = list.length - 1; index >= 0; index -= 1) {
				const message = list[index];
				if (message === undefined || message.processing !== true) continue;
				if (busy.has(message.from)) continue;
				if (now - message.at < maxAgeMs) continue;
				list.splice(index, 1);
				removed += 1;
			}
		}
	}, context);
	return removed;
}

/**
 * 追一条系统留痕到频道。`note` 不唤醒、不计未读（见 `Message.kind`），所以这里不碰
 * 投递层，否则「系统说一下没人被叫醒」会反过来叫醒人。
 */
async function appendNote(deps: PostDeps, channelId: string, text: string, at: number, context: Context): Promise<void> {
	await deps.harness.commit(async (tx) => {
		const doc = (await tx.doc(ChannelDoc)) as ChannelState;
		const next = appendMessage(doc, channelId, { from: OWNER, text, at, kind: "note" });
		const list = doc.messages[channelId];
		if (list === undefined) doc.messages[channelId] = [next.message];
		else (list as Message[]).push(next.message);
		doc.nextSeq[channelId] = next.message.seq + 1;
	}, context);
}

/** 投递没成时给老板留一句话。分开列，不糊成一句：两种原因的处置完全不同。 */
function renderIssues(seq: number, issues: readonly DeliverIssue[], labelOf: (slug: string) => string): string {
	return issues
		.map((issue) =>
			issue.reason === "failed"
				? `#${seq} 叫了 @${labelOf(issue.slug)}，投递失败：${issue.detail ?? "未知原因"}。`
				: `#${seq} 叫了 @${labelOf(issue.slug)}，但它还没有会话（还没被打开过）—— 这条不会有人答。`,
		)
		.join("\n");
}

/**
 * 频道写入的串行闸。
 *
 * 为什么需要：同一个进程里所有 agent 的 `say` 是**并发**的，而它们都往同一个
 * `ChannelDoc` 上 commit。实测撞出过这个：两个 `say` 同时进来，其中一个 commit 拿到
 * 已被释放的读覆盖层，报 `Cannot use a settled overlay` —— 而那条消息**已经写进去了**，
 * 于是模型看到报错就重试，频道里出现两条一模一样的「在。」。
 *
 * 串行化的代价是频道写入排队（毫秒级，一次 commit），换来的是「一次调用 = 一条消息」
 * 这条最基本的保证。
 */
let writing: Promise<unknown> = Promise.resolve();

function serialized<T>(operation: () => Promise<T>): Promise<T> {
	const next = writing.then(operation, operation);
	writing = next.catch(() => undefined);
	return next;
}

/**
 * 写一条消息并唤醒该唤醒的人。
 *
 * 文档写入用 `commit` + 路径式追加（推一条 + 改两个数字），**不整频道替换**：
 * 一个群频道可以有 800 条消息，整值替换会让每条消息重写整个频道（实测
 * 49.6KB/条 vs 141 字节）。
 */
export async function postMessage(
	deps: PostDeps,
	input: PostInput,
	context: Context = BACKGROUND_CONTEXT,
): Promise<PostResult> {
	return serialized(() => postMessageUnlocked(deps, input, context));
}

/**
 * B（通用处理中机制）：从一条落库消息推导出「需要在其所在频道生成 processing 占位的接收方」。
 * - @某人：mention 中除发起方外的频道成员；
 * - 直接发给某人：dm 频道的另一成员（即接收方）；
 * - 普通无指向群消息：无接收方（不误触发）。
 * 老板（owner）一律不生成 processing 占位：他是发起方/主语，自己不会「处理」；
 *   被 @ 或处于与别人的私聊时也不在此处生成（即便他是接收方身份）。
 */
function collectProcessingTargets(mentions: readonly string[], channel: Channel | undefined, from: string, channelId: string): readonly string[] {
	const set = new Set<string>();
	// 只给「非发起方、且非老板」的接收人：老板是发起方/主语，自己不会「处理」，
	// 无论是被 @ 还是身处与别人的私聊，都永远不生成 processing 占位。
	for (const mention of mentions) {
		if (mention !== from && mention !== OWNER && channel?.members.includes(mention)) set.add(mention);
	}
	if (channelId.startsWith("dm:") && channel !== undefined) {
		const other = channel.members.find((member) => member !== from && member !== OWNER);
		if (other !== undefined) set.add(other);
	}
	return [...set];
}

async function postMessageUnlocked(deps: PostDeps, input: PostInput, context: Context): Promise<PostResult> {
	const channel = deps.state.channels[input.channelId];
	if (channel === undefined) throw new Error(`频道不存在：${input.channelId}`);

	let created: Message | undefined;
	let filledSeq: number | undefined;
	let filledText = "";
	let cappedLimit = 0;
	let filledRealReply = false;
	// 接力上限：这条落库前先数一下 agent 已经自动接了几棒。
	// 判在 appendMessage **之前**：之后这条自己也会被算进去（第 3 棒就会被误拦）。
	const hops = botHopsSinceOwner(deps.state, input.channelId);
	const limit = relayLimit(channel);
	// 显式 @ 当场突破上限：上限是为了拦「A 回 B、B 又回 A」的自动接力，
	// 不是为了拦住一个想清楚要叫谁的人。上面那条 note 就是这么告诉模型的，
	// 文案和代码必须一致，否则它会以为自己能 @ 人而其实叫不醒。
	const addressed = [...parseMentions(input.text), ...parseMentions(input.text, input.roster ?? EMPTY_ROSTER)].some(
		(slug) => slug !== input.from && channel.members.includes(slug),
	);
	// 提交之前先把「后面还要读到的东西」抄成纯数据：提交一关，读覆盖层就释放了，
	// 而成员列表、wakeOnAll、各人未读都要在提交之后才用得上（见下面的注释）。
	const channelMeta: Channel = {
		...channel,
		members: [...channel.members],
		wakeOnAll: [...channel.wakeOnAll],
	};
	// 过程话先看能不能并进上一条（并进去就没有新消息、没有新唤醒）。
	const stepped = await mergeStep(deps, input, channelMeta, context);
	if (stepped !== undefined) return stepped;
	const digests = new Map<string, string>();
	for (const slug of channelMeta.members) {
		if (slug === OWNER) continue;
		digests.set(slug, renderDigest(deps.state, slug));
	}
	const capped =
		input.wake !== false &&
		input.from !== OWNER &&
		input.kind !== "note" &&
		!addressed &&
		hops >= limit;
	if (capped) cappedLimit = limit;
	await deps.harness.commit(async (tx) => {
		const doc = await tx.doc(ChannelDoc);
		const state = doc as ChannelState;
		// 序号以**消息本身**为准，不以 `nextSeq` 为准。
		//
		// 实测（2026-10-29）：`nextSeq["company"]` 是 19 而频道里已经有 36 条消息，于是新消息
		// 拿到了 #20 —— 和一条旧消息撞号。撞号的后果不是「多一条」，是序列唯一的假设塌了：
		// 前端按 seq 去重、按 `[data-seq=N]` 定位、补历史时按 seq 合并，全都指向错的那条，
		// 症状就是「刷新以后少了几句」。这类不一致只能在这里兜（唯一写入口），
		// 让它自愈，而不是要求所有调用方都保证 `nextSeq` 正确。
		const highestSeq = (doc.messages[input.channelId] ?? []).reduce((max, item) => (item.seq > max ? item.seq : max), 0);
		if ((doc.nextSeq[input.channelId] ?? 1) <= highestSeq) doc.nextSeq[input.channelId] = highestSeq + 1;
		// appendMessage 返回的是新 state；这里只要它算好的 message，写入按路径原地做。
		const next = appendMessage(state, input.channelId, {
			from: input.from,
			text: input.text,
			at: input.at,
			...(input.kind === undefined ? {} : { kind: input.kind }),
			...(input.replyTo === undefined ? {} : { replyTo: input.replyTo }),
			...(input.roster === undefined ? {} : { roster: input.roster }),
			...(input.mention === undefined ? {} : { mention: input.mention }),
			...(input.status === undefined ? {} : { status: input.status }),
			...(input.pendingFor === undefined ? {} : { pendingFor: input.pendingFor }),
		...(input.processing === undefined ? {} : { processing: input.processing }),
			...(input.attachments === undefined ? {} : { attachments: input.attachments }),
			...(input.step === undefined ? {} : { step: input.step }),
		});
		// **只有一个元素被追加**，所以必须让文档层看见「数组长了一格」而不是「这个键换了个
		// 新数组」。两者写下去的消息一样，代价差三个数量级：
		//
		//   原地 push → `["p",["messages",频道],N,0,[消息]]`，约等于消息本身大小；
		//   整值替换 → `["s",["messages",频道],[…整个频道历史]]`，**每条消息重写全部历史**。
		//
		// 实测（`test/core/channel-write.test.ts`）：200 字的消息，append 320 字节、
		// 整值替换 582 字节且随历史线性变长。一个 189 条消息的频道因此涨到 27 MB。
		//
		// 注意 `push` 必须作用在**文档代理给出的那个数组**上：`doc.messages[id] ??=` 之后
		// 再 push 本地变量不算数（那不是代理，提交时不会有任何 op，消息静默消失）。
		const list = doc.messages[input.channelId];
		// 是否「闭环回复」：这条消息会填充接收方（input.from）在频道里自己的待办占位
		// （status=pending && pendingFor=from && processing/空）。闭环回复是上一轮待办的产出，
		// 天然不是「待 from 响应的新待办」——由此严格绑定 processing 的触发判据，回环本不存在。
		const fillIdx =
			list !== undefined && input.status !== "pending" && (input.text ?? "").trim() !== ""
				? // 取**最后**一个匹配的占位：同一个人的历史里可能躺着好几条没被回复的
					// 「开始处理…」（以前每轮都会留一条），填最早的那条等于把答案塞进一条
					// 早已滚出屏幕的旧消息里 —— 实测补发时写进了 #26 而当时频道已经有 #43。
					(list as Message[]).findLastIndex(
						(m) => m.status === "pending" && m.pendingFor === input.from && (m.processing === true || (m.text ?? "").trim() === ""),
					)
			: -1;
		filledRealReply = fillIdx >= 0;
		const isClosedLoopReply = filledRealReply;
		// B（通用处理中底层机制）：主消息指向某人（@他 / 直接发给他）时，在同一 commit 内为其生成 processing 占位，
		// 由该人本轮真实回复原地覆盖（T-016 吸收条件已放宽到 processing 即吸收）。所有入口（owner / agent say / 系统派发）
		// 统一经此，不在 say/群聊/私聊各自硬编码。占位自身不递归（它 status=pending，吸收分支不反建）；主消息已是回复
		// 填充或占位时（filledRealReply / status==="pending"）不新建；非 @ / 非直接发给自己的普通群消息不误触发。
		// 仅计算接收方，实际落盘在主消息推送分支内（同一 commit、复用已兜底的文档数组）。
		const processingTargets =
			input.status !== "pending" && input.kind !== "note" && input.wake !== false && !isClosedLoopReply
				? collectProcessingTargets(next.message.mentions ?? [], channel, input.from, input.channelId)
				: [];

		// T-016 占位吸收：非占位消息（真实发言）落到频道时，若本频道还有一条
		// `status==="pending" && pendingFor===input.from && text===""` 的占位（自己之前被 @ 后留的 loading 气泡），
		// 就**原地填充**它（把 text/mentions/kind/at 写成真实回复、status 置 done），不另开一条 —— 占位即最终消息。
		// 占位创建时 text="" 不会命中（被吸收的是非空消息）。
		let finalMessage: Message = next.message;
		if (filledRealReply) {
			const arr = list as Message[];
			const idx = fillIdx;
			if (idx >= 0) {
				// 下标替换 = 数组结构性变更，文档代理稳定落盘（保留占位原 seq/from/pendingFor）。
				const placeholder = arr[idx]!;
				filledSeq = placeholder.seq;
				filledText = input.text;
				arr[idx] = {
					...placeholder,
					text: input.text,
					mentions: next.message.mentions,
					kind: next.message.kind,
					at: input.at,
					status: "done",
					// 覆盖后不再是处理中占位：去掉 processing 标记，前端按普通 say 行渲染（不显示动画）。
					processing: false,
				};
				finalMessage = arr[idx]!;
			}
		}
		if (finalMessage === next.message) {
			const bucket = doc.messages[input.channelId];
			if (bucket === undefined) doc.messages[input.channelId] = [next.message];
			else (bucket as Message[]).push(next.message);
			state.nextSeq[input.channelId] = next.message.seq + 1;
			// B：processing 占位与主消息同一数组落盘（bucket 此时已兜底，必为数组）。
			const arrNow = doc.messages[input.channelId] as Message[];
			for (const target of processingTargets) {
				const placeholder = appendMessage(state, input.channelId, {
					from: target,
					text: `开始处理`,
					at: input.at,
					kind: "chat",
					status: "pending",
					pendingFor: target,
					processing: true,
					// 这一轮真正开始于**触发这条消息的时刻**。占位被填充时 `...placeholder`
					// 会把 `startedAt` 带过来（ADR-072）—— 界面靠它算真实用时，
					// 不靠投影落库的 `at`（那个晚一个首包）。
					startedAt: input.at,
				}).message;
				(arrNow as Message[]).push(placeholder);
				state.nextSeq[input.channelId] = placeholder.seq + 1;
			}
		}
		// 接力到上限：**只落消息、不投递**，再留一条 note 说清楚为什么没人被叫醒。
		// 不投递就是暂停：消息已经在频道里任何人随时能读到，「继续」不需要按钮 ——
		// 老板一发言 `botHopsSinceOwner` 自动归零。
		// 但**连着记就不记了**：上限一旦触发，之后每条 agent 消息都会被拦，
		// 每拦一条写一条 note 结果就是频道里几百行「接力到上限」—— 实测一个私聊里
		// 197 条消息有 150 多条是这个。人对同一条告警看第二遍就没有新信息了。
		// 所以只在「上一条不是这条 note」时补一次，等于把连续拦截合并成一条。
		// 判据是「老板上次说话之后已经报过警没有」，不是「上一条是不是 note」：
		// 每条被拦的消息本身也会落库，所以上一条永远是那条消息，不是 note。
		// 用 `doc` 里的活数组，不能用 `deps.state` 的旧快照 —— 快照里没有刚追加的 note。
		const trail = (doc.messages[input.channelId] as Message[] | undefined) ?? [];
		// note 也是 `from: OWNER`，所以不能只按 from 找 —— 要不它会把自己当成「老板刚说过话」。
		const lastOwnerAt = trail.findLastIndex((item) => item.from === OWNER && item.kind !== "note");
		const alreadyNoted = trail
			.slice(lastOwnerAt + 1)
			.some((item) => item.kind === "note" && item.text.startsWith("接力到上限（"));
		if (capped && !alreadyNoted) {
			const noted = appendMessage(state, input.channelId, {
				from: OWNER,
				text: `接力到上限（${cappedLimit} 次）：这条只记下，没人被叫醒。老板说一句，或者自己 @ 人，就能接着走。`,
				at: input.at,
				kind: "note",
			});
			(doc.messages[input.channelId] as Message[]).push(noted.message);
			state.nextSeq[input.channelId] = noted.message.seq + 1;
		}
		// 抄成纯对象再交出去：`finalMessage` 是这次事务里的代理，事务一关就不能再读
		// （`Cannot use a settled overlay`），而收件人计算、投递、返回给工具都要用它。
		created = JSON.parse(JSON.stringify(finalMessage)) as Message;
	}, context);

	const message = created as Message;

	const liveChannel = channelMeta;
	// T-016 v2：占位被真实回复原地填充 → 推逐字增量（token 分片 + done 全文兜底）。
	// 后端落库层已写好最终全文，这里只负责「把全文按片推给前端做渐显」，不重复写库。
	if (filledSeq !== undefined && channelClientsHas(liveChannel.id) && channelStreamHook !== undefined) {
		channelStreamHook(liveChannel.id, filledSeq, filledText);
	}
	if (input.wake === false || input.kind === "note") {
		return { channel: liveChannel, message, delivery: { delivered: [], failed: [], skipped: [] } };
	}
	if (capped) return { channel: liveChannel, message, delivery: { delivered: [], failed: [], skipped: [] } };

	// 老板没有会话：它是「人」，不是 agent。`deliver` 会把它算进 skipped。
	const targets = recipientsOf(liveChannel, message).filter((slug) => slug !== OWNER);
	if (targets.length === 0) {
		return { channel: liveChannel, message, delivery: { delivered: [], failed: [], skipped: [] } };
	}
	// 谁手上还有活：投递会打断他，正文要说明「这是插话，不是新任务」。
	// 取不到就当没人忙 —— 宁可少一句话，也不能让每次投递都失败。
	const busy = await liveConversations(deps.harness, context).catch(() => new Set<number>());
	const labelOf = deps.labelOf ?? ((slug: string) => slug);
	const delivery = await deliver(
		{
			// 摘要用**写之前**的 state：这条新消息已经在正文里了，再算进未读数会重复。
			digests,
			channel: liveChannel,
			message,
			targets,
			busy,
			// 合并唤醒（也负责老板插队）：同一个会话最多留一个「还没开始」的排队项。
			// 谁连发几条（老板三句、agent 的过程话与追问）都只排一个唤醒，最后一条取代
			// 前面没开始的那些 —— 消息都在频道里，少的只是重复唤醒。
			// 这里只撤 `queued`，正在跑的那一轮不碰（撤它会连新消息一起吞掉，实测过）。
			coalesceQueue: (conversationId, keepRequestId) =>
				coalesceQueue(deps.harness, conversationId, keepRequestId, context),
			conversationOf: deps.conversationOf,
			...(deps.labelOf === undefined ? {} : { labelOf: deps.labelOf }),
			...(deps.rememberWake === undefined ? {} : { rememberWake: deps.rememberWake }),
			...(deps.uploadsRoot === undefined ? {} : { uploadsRoot: deps.uploadsRoot }),
			// 这一轮结算时收掉没被填的占位：他没在这个频道说话，占位就没人来填，
			// 留着就是一条永远转圈的「开始处理…」（实测挂过 175 分钟）。
			removePlaceholders: (slug) => removePlaceholders(deps, liveChannel.id, slug, message.at, context),
			// 这一轮他一个字都没产出（最常见的是模型引用失效）：留一行，别让频道里
			// 只剩一条占位「开始处理…」。等待在后台，不占投递这条线。
			noteUnanswered: async ({ label, seq, reason }) => {
				await appendNote(deps, liveChannel.id, renderUnanswered(seq, label, reason), Date.now(), BACKGROUND_CONTEXT);
			},
			// 没人被叫醒就说一句：只写 stderr 的话，频道里一片空白，
			// 老板看到的「我说了没人理」和「系统挂了」长得一模一样。
			notify: async (issues) => {
				await appendNote(deps, liveChannel.id, renderIssues(message.seq, issues, labelOf), Date.now(), context);
			},
		},
		context,
	);
	return { channel: liveChannel, message, delivery };
}

