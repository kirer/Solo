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
 * 三条硬约束（见 docs/design/COMMS-REFACTOR.md §3）：
 * - 写频道 ≠ 唤醒所有人。唤醒规则是 `recipientsOf()` 的纯函数。
 *  - 投递失败**不能**让消息丢失：消息已经落库，下次读频道仍能看到。
 *  - 已读位置只前进不后退（`advanceRead` 保证）。
 */
import { BACKGROUND_CONTEXT, type CompanyRuntime, type Context } from "../runtime/index.ts";
import {
	appendMessage,
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
	const result = await runtime.harness.commit(async (tx) => {
		const doc = await tx.doc(ChannelDoc);
		const next = appendMessage(doc as ChannelState, channelId, input);
		// 一次提交内替换整个文档（pi-durable 的文档是不可变的，只能整体写）
		for (const key of Object.keys(doc as object)) {
			delete (doc as Record<string, unknown>)[key];
		}
		Object.assign(doc as Record<string, unknown>, next.state);
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
 * 算唤醒对象：委托给 `domain/channels.ts` 的纯函数，注入「频道 owner」解析。
 *
 * owner 是「老板发言没 @ 时该叫醒谁」：公司群/领导层 → CEO，项目群 → 该项目负责人。
 * 这个映射依赖组织结构（org），而 domain 层只认频道本身，所以在这里注入。
 */
function wakeTargets(org: Org, channel: Channel, message: ChannelMessage): readonly number[] {
	const ownerOf = (target: Channel): number | undefined => {
		switch (target.kind) {
			case "company":
			case "leadership":
				return org.ceoId;
			case "project":
				return target.project === undefined ? undefined : org.projectLeaders[target.project];
			case "dm":
			case "log": {
				const id = Number(target.id.slice(target.id.indexOf(":") + 1));
				return Number.isFinite(id) ? id : undefined;
			}
		}
	};
	return recipientsOf(channel, message, ownerOf);
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
		const next = advanceRead(channel, conversationId, seq);
		if (next === channel) return;
		const channels = { ...(doc as ChannelState).channels, [channelId]: next };
		(doc as { channels: unknown }).channels = channels;
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

/** 标记「某人已读了这条消息的 @」（灰点变绿点）。 */
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
		const next = markMentionRead(channel, seq, conversationId);
		if (next === channel) return;
		(doc as { channels: unknown }).channels = { ...state.channels, [channelId]: next };
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
			(doc as { channels: unknown }).channels = next.channels;
			return next.channels[input.id] as Channel;
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
			(doc as { channels: unknown }).channels = { ...state.channels, [input.id]: updated };
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
		(doc as { channels: unknown }).channels = { ...state.channels, [channelId]: next };
	}, context);
}

/** 归档一个频道（项目删除时用）。 */
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
		(doc as { channels: unknown }).channels = {
			...state.channels,
			[channelId]: { ...channel, archived: true },
		};
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
			members: org.people
				.filter((person) => person.archived !== true && (person.role === "ceo" || person.role === "management"))
				.map((person) => ({ conversationId: person.conversationId, role: person.role })),
		},
		context,
	);

	// 3) 项目群：老板 + 负责人 + 该项目员工
	for (const [slug, project] of Object.entries(company.projects)) {
		if (project.status === "terminated" || project.status === "archived") continue;
		const leaderId = org.projectLeaders[slug];
		const staff = org.people.filter((person) => person.project === slug && person.archived !== true);
		await ensureChannel(
			runtime,
			{
				id: `proj:${slug}`,
				kind: "project",
				title: project.name,
				project: slug,
				members: [
					...(leaderId === undefined ? [] : [{ conversationId: leaderId, role: "leader" as const, wakeOnAll: true }]),
					...staff.map((person) => ({ conversationId: person.conversationId, role: "staff" as const })),
				],
			},
			context,
		);
	}

	// 4) 个人工作记录：每个会话一个
	for (const person of org.people) {
		await ensureChannel(
			runtime,
			{
				id: `log:${person.conversationId}`,
				kind: "log",
				title: `${person.label}的工作记录`,
				members: [{ conversationId: person.conversationId, role: person.role, wakeOnAll: true }],
			},
			context,
		);
	}

	const after = await readChannels(runtime, context);
	for (const id of Object.keys(after.channels)) {
		if (before.channels[id] === undefined) created.push(id);
	}
	return { created };
}

/** 频道标识的解析（转发，便于 server 层使用）。 */
export { parseChannelId };
