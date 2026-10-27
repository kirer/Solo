/**
 * 频道的 IO 层：读写 `ChannelDoc`、投递、已读标记。
 *
 * 纯逻辑全在 `src/domain/channels.ts`（无 IO、可单测）。这里只做四件事：
 *
 * 1. **读**：把 `ChannelDoc` 快照成 `ChannelState`
 * 2. **写**：一次提交内追加消息（并同步已读位置）
 * 3. **投递**：写完后交给 `deliver()` 唤醒该唤醒的人
 * 4. **标记**：已读 / @ 已读
 *
 * 三条硬约束（见 docs/COMMS.md §3）：
 * - 写频道 ≠ 唤醒所有人。唤醒规则是 `recipientsOf()` 的纯函数。
 *  - 投递失败**不能**让消息丢失：消息已经落库，下次读频道仍能看到。
 *  - 已读位置只前进不后退（`advanceRead` 保证）。
 */
import { BACKGROUND_CONTEXT, type CompanyRuntime, type Context } from "../runtime/index.ts";
import {
	appendMessage,
	MAX_MESSAGES_PER_CHANNEL,
	dmChannelId,
	OWNER_ID,
	createChannel,
	emptyChannelState,
	hasMember,
	markMentionRead,
	member,
	parseChannelId,
	recipientsOf,
	advanceRead,
	type AppendInput,
	type Channel,
	type ChannelMessage,
	type ChannelState,
	type Member,
	type MemberRole,
} from "../domain/channels.ts";
import { CompanyDoc, type CompanyState } from "./docs.ts";
import { ChannelDoc } from "./channels-doc.ts";
import { deliver, type DeliverOutcome } from "./deliver.ts";
import { buildOrg, type Org } from "./org-model.ts";
import { labelOf, ownerOfChannel } from "../domain/membership.ts";

export { ChannelDoc } from "./channels-doc.ts";

// ── 读 ──────────────────────────────────────────────────────────────────────

/** 读整个频道文档。 */
export async function readChannels(
	runtime: CompanyRuntime,
	context: Context = BACKGROUND_CONTEXT,
): Promise<ChannelState> {
	return (await runtime.harness.snapshot(ChannelDoc, context)) ?? emptyChannelState();
}

/** 读一个频道。 */
export async function readChannel(
	runtime: CompanyRuntime,
	channelId: string,
	context: Context = BACKGROUND_CONTEXT,
): Promise<Channel | undefined> {
	const state = await readChannels(runtime, context);
	return state.channels[channelId];
}

/** 从公司索引推导组织结构（成员关系判定的输入）。 */
export async function readOrg(
	runtime: CompanyRuntime,
	context: Context = BACKGROUND_CONTEXT,
): Promise<{ org: Org; company: CompanyState | undefined }> {
	const company = await runtime.harness.snapshot(CompanyDoc, context);
	return { org: buildOrg(company), company };
}

// ── 写 ──────────────────────────────────────────────────────────────────────

/**
 * 从正文里解析 @ 提及（服务端兜底）。
 *
 * 为什么服务端也要解析：前端的 @ 选择器只是便利，老板完全可能手打
 * 「@许砚舟」而不点候选。不解析的话这条消息不会唤醒任何人——正是
 * 「消息发出去没人理」的老问题。
 *
 * 匹配策略：按频道成员的名字做**最长优先**匹配，避免「林」误匹配「林越」。
 */
export function parseMentions(text: string, channel: Channel, org: Org): number[] {
	const candidates = Object.values(channel.members)
		.map((member) => ({ id: member.conversationId, label: labelOf(org, member.conversationId) }))
		.filter((candidate) => candidate.label !== "" && candidate.label !== `会话 ${candidate.id}`)
		.sort((left, right) => right.label.length - left.label.length);

	const found = new Set<number>();
	for (const candidate of candidates) {
		// 名字前后不能紧邻文字，否则「@林越」会误命中「@林越舟」
		const pattern = new RegExp(`@${escapeRegExp(candidate.label)}(?![\\p{L}\\p{N}])`, "u");
		if (pattern.test(text)) found.add(candidate.id);
	}
	// 角色别名
	if (/@负责人(?!\p{L})/u.test(text) && channel.project !== undefined) {
		const leader = org.projectLeaders[channel.project];
		if (leader !== undefined) found.add(leader);
	}
	return [...found];
}

/**
 * 某个人「按规则应该在这个频道里」吗。
 *
 * 这是 `ensureAllChannels()` 里那段成员构造的**镜像**，抽出来只为一件事：
 * 让 `postToChannel()` 能判断「频道缺人」并触发自愈。
 *
 * 为什么需要它：真实事故（贪吃蛇端到端实验）——员工入职后没有加入任何频道，
 * 公司大群还是 9 人、项目群只有负责人一个。`@开发-游戏实现` 在 `parseMentions`
 * 里被「只保留频道成员」过滤掉，**一个人都没被唤醒**，任务派下去了但对方永远
 * 不知道，界面上看不出任何异常。
 *
 * 与 `ensureAllChannels()` 的一致性由 `test/unit/channel-membership.test.ts` 守着。
 */
export function shouldBeIn(channelId: string, conversationId: number, org: Org): boolean {
	// 老板在每一个「群」和每一条私聊里（他的要求：在任何地方都能派任务）。
	//
	// `log:*` 在 UX-7 之后也算（原仅 `canView` 放行）：老板要能在这个人的工作记录里
	// 「随时插话」，所以他必须是参与者——否则 `markChannelRead` 找不到成员
	// （`markChannelRead` 里 `members[cid]` 为 undefined 就 return），他自己发的消息
	// 会一直显示未读，成员列表与 @ 候选里也没有他。
	//
	// 注：老板的话**写在 `dm:`**（不是 `log:`），所以这里仅解决「可见 + 能写」；
	// 「每句都唤醒」靠 `dm` 自身的兜底（`domain/channels.ts` 的 `resolveMentions`）
	// 与「老板发言没 @ → 唤醒频道 owner」，与本行无关。
	if (conversationId === OWNER_ID) return true;
	const person = org.people.find((entry) => entry.conversationId === conversationId);
	if (person === undefined || person.archived === true) return false;

	if (channelId === "company") return true;
	if (channelId === "leadership") return person.role === "ceo" || person.role === "management";

	// 项目群：该项目的负责人 + 该项目员工（管理层不算成员，他们靠 canView 旁观）
	if (channelId.startsWith("proj:")) {
		const slug = channelId.slice("proj:".length);
		return person.project === slug;
	}

	// 私聊与工作记录：只有本人（老板已在上面返回 true）
	if (channelId.startsWith("dm:") || channelId.startsWith("log:")) {
		return channelId.slice(channelId.indexOf(":") + 1) === String(conversationId);
	}

	return false;
}

/** 转义正则元字符。 */
function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** 追加消息的结果。 */
export type PostResult = {
	readonly channel: Channel;
	readonly message: ChannelMessage;
	/** 投递结果；`undefined` 表示没有要唤醒的人。 */
	readonly delivery?: DeliverOutcome;
};

/**
 * 往频道追加一条消息，并唤醒该唤醒的人。
 *
 * 这是整个系统里**唯一**的「发消息」入口。`deliver()` 只负责唤醒，不负责落库；
 * 落库与唤醒在这里成对完成，避免「消息没存但人醒了」或「消息存了但没人知道」。
 *
 * 频道不存在时抛错（不静默丢弃）：调用方必须先 `ensureChannel`。
 */
export async function postToChannel(
	runtime: CompanyRuntime,
	channelId: string,
	input: AppendInput,
	options: { readonly wake?: boolean; readonly context?: Context } = {},
): Promise<PostResult> {
	const context = options.context ?? BACKGROUND_CONTEXT;

	const { org } = await readOrg(runtime, context);
	// 频道自愈：**不只是「不存在」**。
	//
	// 真实事故（贪吃蛇端到端实验）：员工入职后没有加入任何频道——公司大群还是
	// 9 人、项目群只有负责人一个。于是 `@开发-游戏实现` 在 `parseMentions` 里
	// 被「只保留频道成员」过滤掉，**一个人都没被唤醒**，任务派下去了但对方永远
	// 不知道。整条链静默停摆，界面上看不出任何异常。
	//
	// 所以这里检查两件事：频道存在吗、该在的人都在吗。缺任何一样就整体补齐。
	{
		const existing = await readChannels(runtime, context);
		const channel = existing.channels[channelId];
		const missingMembers =
			channel !== undefined &&
			[...org.people.map((person) => person.conversationId), OWNER_ID].some(
				(id) => id !== undefined && channel.members[String(id)] === undefined && shouldBeIn(channelId, id, org),
			);
		if (channel === undefined || missingMembers) {
			await ensureAllChannels(runtime, context);
		}
	}

	// 解析 @ 要用**自愈之后**的成员表：刚入群的员工这一刻才第一次能被 @ 到。
	const channelBefore = await readChannel(runtime, channelId, context);
	if (channelBefore === undefined) throw new Error(`频道不存在：${channelId}`);
	// **正文里的 @ 必须在这里解析**，不能只依赖调用方传 `mentions`。
	//
	// 真实事故（老板的「系统」项目）：CPO 用 `say` 发了一条
	// 「@CEO「系统」项目已创建完成…」——`say` 的语义是「说一句，不唤醒任何人」，
	// 它不解析正文，于是这条消息的 `mentions` 是空的，**CEO 从来没被唤醒**。
	// 项目建好了、slug 报了，但整条链静默停摆：CEO 一直 idle，老板看到的是
	// 「流程不动了」，而界面上一切正常（消息在、@ 在正文里、任务都 done）。
	//
	// 修在这里而不是修 `say`：这是**唯一**的发消息入口，所有工具（say / ask /
	// assign_task / 系统通知 / HTTP 入站）都经过它。只在 `say` 里补一次，下次
	// 新增的工具还会踩同一个坑。写了 @ 就该唤醒，这是人对「@」的唯一理解。
	//
	// `ask` / `assign_task` 已经自己解析过，重复解析是幂等的（Set 去重）。
	const parsedMentions = parseMentions(input.text, channelBefore, org);
	const input_: AppendInput =
		parsedMentions.length === 0
			? input
			: { ...input, mentions: [...new Set([...(input.mentions ?? []), ...parsedMentions])] };

	const result = await runtime.harness.commit(async (tx) => {
		const doc = await tx.doc(ChannelDoc);
		const state = doc as ChannelState;
		const next = appendMessage(state, channelId, input_);
		// **按路径写，不整频道替换。**
		//
		// 演进过三版：①清空所有键再 Object.assign 整个 state（130KB/条）；
		// ②只赋值 `doc.channels[id] = nextChannel`（实测 49.6KB/条，因为 chord 的
		// `["s", path, value]` 是整值替换，频道里有 800 条消息就重写 800 条）；
		// ③现在这样，push 一条 + 改两个数字（实测 141 字节，350 倍差距）。
		appendMessageInPlace(state, channelId, next.message);
		return next.message;
	}, context);

	const channel = (await readChannel(runtime, channelId, context)) as Channel;

	// 发送方自己算已读（否则会看到自己发的未读）
	await markChannelRead(runtime, channelId, input.from, result.seq, context);

	if (options.wake === false) return { channel, message: result };

	const targets = wakeTargets(org, channel, result);
	if (targets.length === 0) return { channel, message: result };

	const delivery = await deliver(
		runtime,
		{ channel, message: result, targets },
		context,
	);
	return { channel, message: result, delivery };
}

/**
 * 把一条新消息写进 overlay —— **只碰这条消息和两个数字**。
 *
 * `pi-durable` 的 `tx.doc()` 返回可写 overlay，底层按「路径」生成 delta。
 * `doc.channels[id] = nextChannel` 是整值替换：频道里有 800 条消息就重写 800 条
 * （实测 49.6KB/条）；`messages.push()` + 改 `lastSeq`/`nextSeq` 只产生 3 个 op
 * （实测 141 字节）。
 */
function appendMessageInPlace(state: ChannelState, channelId: string, message: ChannelMessage): void {
	const channel = state.channels[channelId];
	if (channel === undefined) return;
	channel.messages.push(message);
	// 裁剪与 `domain/channels.ts` 的 appendMessage 保持一致：只保留最近 N 条。
	const excess = channel.messages.length - MAX_MESSAGES_PER_CHANNEL;
	if (excess > 0) channel.messages.splice(0, excess);
	channel.lastSeq = message.seq;
	state.nextSeq = message.seq + 1;
}

/**
 * 算唤醒对象：委托给 `domain/channels.ts` 的纯函数，注入「频道 owner」解析。
 *
 * owner 的映射**不在本文件里重写**——`src/domain/membership.ts` 的
 * `ownerOfChannel(org, channel)` 是唯一真相源（它以前零生产调用，于是这里
 * 和 `src/server/http.ts` 各写了一份 switch，三份实现迟早会分叉）。
 */
function wakeTargets(org: Org, channel: Channel, message: ChannelMessage): readonly number[] {
	return recipientsOf(channel, message, (target) => ownerOfChannel(org, target));
}

// ── 已读 ────────────────────────────────────────────────────────────────────

/** 把某人在某频道的读位置推到一个 seq。 */
export async function markChannelRead(
	runtime: CompanyRuntime,
	channelId: string,
	conversationId: number,
	seq: number,
	context: Context = BACKGROUND_CONTEXT,
): Promise<void> {
	await runtime.harness.commit(async (tx) => {
		const doc = await tx.doc(ChannelDoc);
		const channel = (doc as ChannelState).channels[channelId];
		if (channel === undefined) return;
		// 只写 `members[cid].lastReadSeq` 这一个路径（实测 62 字节）。
		// 以前是整频道替换（49.6KB），而 GET /api/channels/:id 每次都调这里。
		const member = channel.members[String(conversationId)];
		if (member === undefined) return;
		if (seq <= member.lastReadSeq) return;
		member.lastReadSeq = seq;
	}, context);
}

/** 把某人在某频道的读位置推到最新。 */
export async function markAllRead(
	runtime: CompanyRuntime,
	channelId: string,
	conversationId: number,
	context: Context = BACKGROUND_CONTEXT,
): Promise<void> {
	const channel = await readChannel(runtime, channelId, context);
	if (channel === undefined) return;
	await markChannelRead(runtime, channelId, conversationId, channel.lastSeq, context);
}

/**
 * 标记「某人已读了这个频道里**到 `seq` 为止**的所有 @」（灰点变绿点）。
 *
 * 为什么是「到 seq 为止」而不是「就这一条」：前端上报的是「我渲染到的最后
 * 一条」（`openChannel` 里的 `view.messages.at(-1).seq`），而一个人一次会
 * 看到几十条。旧实现只把 `seq` 这一条标已读，于是：
 * - 用户翻了 60 条，中间那些 @ 的 `readBy` 永远不更新 → 绿点永远是灰的；
 * - 只有恰好停在「被 @ 的那一条」才会变绿，实测几乎不可能。
 * 这就是老板报的「已读状态的点不好使」。
 *
 * 语义对齐微信/Slack：读到第 N 条 = 第 N 条之前（含）的都读过了。
 * 只 push 新的已读者 id，不重写整条消息列表。
 */
export async function markMentionSeen(
	runtime: CompanyRuntime,
	channelId: string,
	seq: number,
	conversationId: number,
	context: Context = BACKGROUND_CONTEXT,
): Promise<void> {
	await runtime.harness.commit(async (tx) => {
		const doc = await tx.doc(ChannelDoc);
		const state = doc as ChannelState;
		const channel = state.channels[channelId];
		if (channel === undefined) return;
		for (const message of channel.messages) {
			if (message.seq > seq) break;
			if (!message.mentions.includes(conversationId)) continue;
			if (message.readBy.includes(conversationId)) continue;
			message.readBy.push(conversationId);
		}
	}, context);
}

// ── 频道生命周期 ────────────────────────────────────────────────────────────

/** 确保频道存在（幂等）。成员缺谁补谁。 */
export async function ensureChannel(
	runtime: CompanyRuntime,
	input: {
		readonly id: string;
		readonly kind: Channel["kind"];
		readonly title: string;
		readonly project?: string;
		/** 应该在这个频道里的会话（老板用 0）。 */
		readonly members: readonly { readonly conversationId: number; readonly role: MemberRole; readonly wakeOnAll?: boolean }[];
	},
	context: Context = BACKGROUND_CONTEXT,
): Promise<Channel> {
	const now = Date.now();
	return runtime.harness.commit(async (tx) => {
		const doc = await tx.doc(ChannelDoc);
		const state = doc as ChannelState;
		const existing = state.channels[input.id];
		if (existing === undefined) {
			const members: Member[] = input.members.map((entry) =>
				member(entry.conversationId, entry.role, now, entry.wakeOnAll === true),
			);
			const next = createChannel(state, {
				id: input.id,
				kind: input.kind,
				title: input.title,
				...(input.project === undefined ? {} : { project: input.project }),
				members,
				at: now,
			});
			const created = next.channels[input.id];
			if (created !== undefined) (doc as ChannelState).channels[input.id] = created;
			return created as Channel;
		}

		// 已存在：补齐缺失成员（新招的员工、新立项的项目）
		let updated = existing;
		for (const entry of input.members) {
			if (hasMember(updated, entry.conversationId)) continue;
			updated = {
				...updated,
				members: {
					...updated.members,
					[String(entry.conversationId)]: member(entry.conversationId, entry.role, now, entry.wakeOnAll === true),
				},
			};
		}
		if (updated !== existing) {
			(doc as ChannelState).channels[input.id] = updated;
		}
		return updated;
	}, context);
}

/** 把某个会话加进频道（幂等）。 */
export async function joinChannel(
	runtime: CompanyRuntime,
	channelId: string,
	conversationId: number,
	role: MemberRole,
	options: { readonly wakeOnAll?: boolean; readonly context?: Context } = {},
): Promise<void> {
	const context = options.context ?? BACKGROUND_CONTEXT;
	await runtime.harness.commit(async (tx) => {
		const doc = await tx.doc(ChannelDoc);
		const state = doc as ChannelState;
		const channel = state.channels[channelId];
		if (channel === undefined || hasMember(channel, conversationId)) return;
		const next: Channel = {
			...channel,
			members: {
				...channel.members,
				[String(conversationId)]: member(conversationId, role, Date.now(), options.wakeOnAll === true),
			},
		};
		(doc as ChannelState).channels[channelId] = next;
	}, context);
}

/**
 * 归档一个频道（项目删除、脏数据清理时用）。
 *
 * 不再出现在列表里，但历史保留——删了就没了，而频道里可能已经有真实对话。
 */
export async function archiveChannel(
	runtime: CompanyRuntime,
	channelId: string,
	context: Context = BACKGROUND_CONTEXT,
): Promise<void> {
	await runtime.harness.commit(async (tx) => {
		const doc = await tx.doc(ChannelDoc);
		const state = doc as ChannelState;
		const channel = state.channels[channelId];
		if (channel === undefined) return;
		(doc as ChannelState).channels[channelId] = { ...channel, archived: true };
	}, context);
}

// ── 启动自愈 ────────────────────────────────────────────────────────────────

/**
 * 确保所有标准频道都存在，成员正确。
 *
 * 幂等，每次启动跑一遍。覆盖四种情况：
 * 1. 公司大群 / 领导层群不存在 → 建
 * 2. 每个项目没有项目群 → 建
 * 3. 每个会话没有个人工作记录 → 建
 * 4. 新招的员工 / 新立的项目 → 补进对应的群
 */
export async function ensureAllChannels(
	runtime: CompanyRuntime,
	context: Context = BACKGROUND_CONTEXT,
): Promise<{ readonly created: readonly string[] }> {
	const { org, company } = await readOrg(runtime, context);
	if (company === undefined || company.company.name === "") return { created: [] };

	const before = await readChannels(runtime, context);
	const created: string[] = [];

	// 1) 公司大群：全部在职人员 + 老板
	await ensureChannel(
		runtime,
		{
			id: "company",
			kind: "company",
			title: "公司大群",
			members: org.people
				.filter((person) => person.archived !== true)
				.map((person) => ({ conversationId: person.conversationId, role: person.role })),
		},
		context,
	);

	// 2) 领导层群：老板 + CEO + 管理层
	await ensureChannel(
		runtime,
		{
			id: "leadership",
			kind: "leadership",
			title: "领导层",
			members: [
				// 老板必须在领导层群里（他要在所有群里，见 ADR-030 决策 4）。
				// 曾经漏了：`canView` 靠「老板能看全部」兜着，界面上看不出异常，
				// 但未读/@ 计数与 @ 候选里都没有他——他在群里说话也没人知道。
				{ conversationId: OWNER_ID, role: "owner" as const, wakeOnAll: true },
				...org.people
					.filter((person) => person.archived !== true && (person.role === "ceo" || person.role === "management"))
					.map((person) => ({ conversationId: person.conversationId, role: person.role })),
			],
		},
		context,
	);

	// 3) 项目群：老板 + 负责人 + 该项目员工
	for (const [slug, project] of Object.entries(company.projects)) {
		if (project.status === "terminated" || project.status === "archived") continue;
		const leaderId = org.projectLeaders[slug];
		// 负责人自身的 project 也是本 slug，必须排除，否则会被下面那行覆盖成 staff
		const staff = org.people.filter(
			(person) => person.project === slug && person.archived !== true && person.conversationId !== leaderId,
		);
		await ensureChannel(
			runtime,
			{
				id: `proj:${slug}`,
				kind: "project",
				title: project.name,
				project: slug,
				members: [
					// 老板必须在每个项目群里：他要求「在任何地方、任何群、任何私聊派任务」，
					// 少了他这一条，`canView` 靠「老板能看全部」兜着，但未读/@ 计数、
					// 成员列表、@ 候选都会漏掉他（曾经就是这样，项目群显示「1 人」）。
					{ conversationId: OWNER_ID, role: "owner" as const, wakeOnAll: true },
					...(leaderId === undefined ? [] : [{ conversationId: leaderId, role: "leader" as const, wakeOnAll: true }]),
					...staff.map((person) => ({ conversationId: person.conversationId, role: "staff" as const })),
				],
			},
			context,
		);
	}

	// 4) 私聊：老板 ↔ 每个人一条（老板 + 对方两人）
	//
	// 为什么必须有：老板要能在**任何地方**派任务（ADR-030 决策 4）。
	// 私聊是最直接的那个「任何地方」——不用先想「这事该在哪个群说」。
	// 而且私聊里**不用 @**（见 domain/channels.ts 的 resolveMentions）：
	// 两个人说话，说给谁听是显然的。
	for (const person of org.people) {
		// 老板自己不是「和老板的私聊」——那会多出一个跟自己说话的频道。
		if (person.archived === true || person.conversationId === OWNER_ID) continue;
		await ensureChannel(
			runtime,
			{
				id: dmChannelId(person.conversationId),
				kind: "dm",
				title: person.label,
				// 老板也必须在成员里：否则对方在私聊里回话时，老板不算「频道成员」，
				// 未读数/@ 都会漏掉（老板要能在这个会话里看到回应）。
				members: [
					{ conversationId: OWNER_ID, role: "owner", wakeOnAll: true },
					{ conversationId: person.conversationId, role: person.role, wakeOnAll: true },
				],
			},
			context,
		);
	}

	// 5) 清理旧形态的频道（#4 / #15）：`log:<id>` 与「老板和自己的私聊」。
	//
	// `log:` 曾经是「每个 agent 一条工作记录频道」（UX-7）。老板的结论是它多余：
	// 工作流水本来就长在私聊里（`/api/staff/:id/activity`），再开一条频道等于
	// 同一件事有两个真相源。现在**不再创建**，并把老库里已有的归档——
	// 归档而不是删除：历史消息要能翻回去，只是左侧列表不再给入口。
	//
	// 归档必须放在最后：`shouldBeIn` 仍然认 `log:` 前缀，万一有在途写入不会炸。
	for (const id of Object.keys(before.channels)) {
		if (!id.startsWith("log:")) continue;
		if (before.channels[id]?.archived === true) continue;
		await archiveChannel(runtime, id, context);
	}

	// 6) 清理：老板和自己的私聊是旧版本留下的脏数据，归档掉
	if (before.channels[dmChannelId(OWNER_ID)] !== undefined) {
		await archiveChannel(runtime, dmChannelId(OWNER_ID), context);
	}

	const after = await readChannels(runtime, context);
	for (const id of Object.keys(after.channels)) {
		if (before.channels[id] === undefined) created.push(id);
	}
	return { created };
}

/** 频道标识的解析（转发，便于 server 层使用）。 */
export { parseChannelId };

// ── 拍板投递 ────────────────────────────────────────────────────────────────

/** 一条已完成的拍板。 */
export type DecisionDelivery = {
	/** 待决项编号（`esc:1277:2` / `disp:...`）。 */
	readonly key: string;
	/** 问题正文（会截断，只用于界面上让人认出是哪一件）。 */
	readonly question: string;
	/** 决定内容。 */
	readonly answer: string;
	/** 拍板人（显示名或权限位）。 */
	readonly answeredBy: string;
	/** 提问方会话（决定投递到这里）。 */
	readonly askerConversationId: number;
	/** 提问方的显示名（喂给 `to` 字段）。 */
	readonly askerLabel: string;
	/** 是不是处置类（暂搁 / 放弃），界面上措辞不同。 */
	readonly disposition?: boolean;
};

/**
 * 把拍板结果投给提问方。
 *
 * 以前这是一个独立模块（`decision-delivery.ts`，142 行），理由是躲开
 * `escalation → disposition` 的动态导入环。但它做的是「往一个会话投一条唤醒
 * 输入并落一条条目」——和 `postToChannel` 完全同一件事，只是少做了三样：
 *
 * - 不查未读摘要 → 提问方醒来时不知道频道里还有别人说过什么
 * - 不带记忆简报 → 同一条唤醒里少了上下文
 * - 不写 `ReplyContextDoc` → 它在这个频道里回复时，默认频道会错
 *
 * 于是同一个事实有了两条实现（ADR-028 要消灭的正是这个）。合并后只有一条：
 * 拍板结果本身就是一条**频道消息**（`kind: "decision"`），它走
 * `postToChannel` 的落库 + `deliver` 的唤醒，不多不少。
 *
 * 投到哪个频道：提问方有私聊就用私聊（`dm:<id>`，一对一，最贴合「对你拍板」
 * 的语义），否则退到公司大群。
 */
export async function deliverDecision(
	runtime: CompanyRuntime,
	decision: DecisionDelivery,
	context: Context = BACKGROUND_CONTEXT,
): Promise<void> {
	const decider = decision.answeredBy === "owner" ? "老板" : decision.answeredBy;
	const kindLabel = decision.disposition === true ? "处置已定" : "拍板结果";
	const body = [
		`【${kindLabel}】${decider} 对「${summarize(decision.question)}」的答复：`,
		decision.answer,
		`（编号 ${decision.key}，已记录在案，无需再确认）`,
	].join("\n");

	try {
		// 频道自愈：拍板不能因为「这个库还没建过频道」就静默消失。
		//
		// 以前不建频道也能投——它直接往会话流里塞一条 `app.decision`，不需要
		// 频道存在。合并进频道之后，这个前提消失了：刚 bootstrap 的库、跑测试
		// 临时目录、被清过频道的老库，都可能一条频道都没有。此时静默 return
		// 会让拍板结果彻底丢掉（提问方永远等不到），比抛错更坏。
		let channels = await readChannels(runtime, context);
		if (Object.keys(channels.channels).length === 0) {
			await ensureAllChannels(runtime, context);
			channels = await readChannels(runtime, context);
		}
		const dmId = `dm:${decision.askerConversationId}`;
		const channelId =
			channels.channels[dmId] !== undefined
				? dmId
				: channels.channels.company !== undefined
					? "company"
					: dmId;
		// 一条频道都没有（`ensureAllChannels` 在没 bootstrap 的库上是空操作）时，
		// 直接把这条私聊建出来。拍板结果必须送到提问方手上，没有「没地方投」这个结局。
		if (channels.channels[channelId] === undefined) {
			await ensureChannel(
				runtime,
				{
					id: dmId,
					kind: "dm",
					title: `与 ${decision.askerConversationId} 的私聊`,
					members: [
						{ conversationId: OWNER_ID, role: "owner", wakeOnAll: true },
						{ conversationId: decision.askerConversationId, role: "staff", wakeOnAll: true },
					],
				},
				context,
			);
			channels = await readChannels(runtime, context);
		}
		// 提问方必须在这个频道里，否则它既看不到也回不了话。
		if (channels.channels[channelId]?.members[String(decision.askerConversationId)] === undefined) {
			await joinChannel(runtime, channelId, decision.askerConversationId, "staff", { context });
		}
		await postToChannel(
			runtime,
			channelId,
			{
				from: OWNER_ID,
				fromLabel: "系统",
				kind: "decision",
				text: body,
				mentions: [decision.askerConversationId],
				refs: { pendingKey: decision.key },
			},
			{ context },
		);
	} catch (error) {
		process.stderr.write(
			`[拍板投递失败] ${decision.key}: ${error instanceof Error ? error.message : String(error)}\n`,
		);
	}
}

/** 问题压成一行，用于「对『…』的答复」这种引用。 */
function summarize(question: string): string {
	const flat = question.replace(/\s+/g, " ").trim();
	return flat.length <= 60 ? flat : `${flat.slice(0, 60)}…`;
}
