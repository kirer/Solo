/**
 * 被打断工作的 checkpoint 机械推导（ADR-026 落地第二步 / 决策 4）。
 *
 * 硬要求：**不花 token、不调模型**。全部从已经落盘的数据算出来：
 * - 活跃任务：`harness.inspect()` 的 `tasks`（state + record）
 * - 进度：会话条目里的 `pi.assistant`（工具调用）与 `pi.tool-result`（工具返回）配对
 * - 用量：`UsageDoc` 的累计 token
 * - 下达人/项目：同会话最近一条 `app.delegate` 条目
 *
 * 为什么单独放一个纯函数文件：推导逻辑要能被测试直接喂数据验证，
 * 不需要真的跑一个被打断的会话。副作用（读库写待办）留在调用方。
 */

import { BACKGROUND_CONTEXT, type Context } from "../runtime/index.ts";
import type { CompanyRuntime } from "../runtime/index.ts";
import { conversationUsage } from "./cost.ts";
import { AuditDoc, CompanyDoc, ROLE_LABELS } from "./docs.ts";
// 运行时导入 PendingDoc 不会形成循环：escalation.ts 对 disposition.ts 只有 `import type`，
// 编译后被擦除，运行时不存在「disposition → escalation → disposition」的环。
import { PendingDoc, levelOfConversation } from "./escalation.ts";
import { deliverDecision } from "./channels.ts";
import type { PendingItem } from "./escalation.ts";

/**
 * 一个任务在会话流里的进度事实。
 *
 * 注意：这些类型要能原样序列化进 `PendingItem`（受底层 `JsonObject` 约束），
 * 所以**不出现 `undefined`**——未知一律用 `null` 或省略。用 undefined 会在
 * JSON 往返后消失，导致「字段在读回来时不存在」这种难查的差异。
 */
export type TaskProgress = {
	/** 已完成（有返回）的工具调用次数。 */
	readonly completedToolCalls: number;
	/** 已发起（含未返回）的工具调用次数。 */
	readonly totalToolCalls: number;
	/** 当前处于第几步（1 起）。 */
	readonly step: number;
	/** 共几步；无法机械预知时为 null。 */
	readonly totalSteps: number | null;
	/** 本轮已耗 token（来自 UsageDoc 累计）。 */
	readonly tokensUsed: number;
};

/** 被打断工作的完整快照，用于生成结构化处置待办。字段全部 JSON 友好。 */
export type InterruptedWork = {
	readonly taskId: string;
	readonly taskKind: string;
	readonly conversationId: number;
	/** 任务开始时刻；未知为 null。 */
	readonly startedAt: number | null;
	/** 所属项目 slug；未知为 null。 */
	readonly project: string | null;
	/** 下达人标签（app.delegate.from）；未知为 null。 */
	readonly assignedBy: string | null;
	/** 下达人的会话 id；未知为 null。 */
	readonly assignedByConversationId: number | null;
	readonly progress: TaskProgress;
};

/** 从条目里数工具调用。只认 `pi.assistant` 的 toolCall 与 `pi.tool-result` 的 toolCallId 配对。 */
export function countToolCalls(
	entries: readonly {
		readonly kind: string;
		readonly model?: readonly unknown[];
	}[],
): { completed: number; total: number } {
	const calls = new Map<string, boolean>(); // callId -> hasResult

	for (const entry of entries) {
		if (entry.kind === "pi.assistant") {
			const message = entry.model?.[0] as
				| { readonly content?: readonly { readonly type: string; readonly id?: string }[] }
				| undefined;
			for (const part of message?.content ?? []) {
				if (part.type !== "toolCall" || part.id === undefined) continue;
				if (!calls.has(part.id)) calls.set(part.id, false);
			}
		} else if (entry.kind === "pi.tool-result") {
			const message = entry.model?.[0] as { readonly toolCallId?: string } | undefined;
			const id = message?.toolCallId;
			if (id !== undefined && calls.has(id)) calls.set(id, true);
		}
	}

	let completed = 0;
	for (const hasResult of calls.values()) if (hasResult) completed += 1;
	return { completed, total: calls.size };
}

/**
 * 推导进度。
 *
 * 「第几步 / 共几步」的口径：一个工具调用算一步。
 * `step` 用**已完成+1**（即正在做的那一步），而不是已完成数——
 * 说「第 3 步 / 共 5 步」时人的直觉是「已经走到第 3 步」，与「已完成 2 次」并不矛盾。
 */
export function deriveProgress(
	toolCalls: { completed: number; total: number },
	tokensUsed: number,
): TaskProgress {
	// 没有工具调用时不能说「第 0 步」——人看到会以为进度丢了。
	// 统一取「已完成 + 1」，上限由总步数约束；总步数未知时不封顶。
	const raw = toolCalls.completed + 1;
	const step = toolCalls.total === 0 ? raw : Math.min(raw, toolCalls.total);
	return {
		completedToolCalls: toolCalls.completed,
		totalToolCalls: toolCalls.total,
		step,
		// 总步数无法机械预知（模型可能继续调用），只在已有调用里给出下界
		totalSteps: toolCalls.total === 0 ? null : toolCalls.total,
		tokensUsed,
	};
}

/** 从条目里找最近一条 `app.delegate`，取下达人与项目。 */
export function findAssignment(
	entries: readonly { readonly kind: string; readonly data?: unknown }[],
): { from: string | null; project: string | null } {
	for (let index = entries.length - 1; index >= 0; index -= 1) {
		const entry = entries[index];
		if (entry === undefined || entry.kind !== "app.delegate") continue;
		const data = entry.data as { readonly from?: unknown; readonly project?: unknown } | undefined;
		return {
			from: typeof data?.from === "string" ? data.from : null,
			project: typeof data?.project === "string" ? data.project : null,
		};
	}
	return { from: null, project: null };
}

/** 把进度渲染成一句话（给人看，出现在待办问题正文里）。 */
export function describeProgress(progress: TaskProgress): string {
	const total = progress.totalSteps;
	const stepText = total === null ? `已进行到第 ${progress.step} 步` : `第 ${progress.step} 步 / 共 ${total} 步`;
	const tokenText =
		progress.tokensUsed >= 1000
			? `${Math.round(progress.tokensUsed / 1000)}k token`
			: `${progress.tokensUsed} token`;
	return `${stepText}，已完成 ${progress.completedToolCalls} 次工具调用，已耗 ${tokenText}`;
}

// ── 处置待办（决策 4 / 决策 5）──────────────────────────────────────────────
//
// 复用 PendingDoc，不新建文档：处置问题本质上就是一条「等人回答、带默认值和期限」
// 的待决项，和升级链走同一套读写与展示通道。
// 区别只在于它多带了几个字段（默认值、期限、被打断的工作快照、恢复条件）。

/** 处置选项。默认只能是可逆的那一侧（ADR-026 决策 4/5）。 */
export const DISPOSITION_OPTIONS = ["shelve", "abandon"] as const;
export type DispositionOption = (typeof DISPOSITION_OPTIONS)[number];

/** 处置默认值：暂搁。唯一可逆的选项。 */
export const DEFAULT_DISPOSITION: DispositionOption = "shelve";

/** 处置问题的回答期限：5 分钟。到期按默认值（暂搁）执行，问题留在待办里可事后改。 */
export const DISPOSITION_DEADLINE_MS = 5 * 60_000;

/** 恢复条件默认值：30 分钟后提醒下达人。 */
export const DEFAULT_RESUME_AFTER_MS = 30 * 60_000;

/** 一个处置待办的附加载荷（序列化进 PendingItem.disposition）。 */
export type DispositionOptionEntry = {
	id: DispositionOption;
	label: string;
	recommended: boolean;
};

/**
 * 处置待办的附加载荷。
 *
 * 这个类型是**落盘数据**，不是接口契约：它必须满足底层 `JsonObject` 约束
 * （不能有 readonly 数组、不能有 undefined 值），否则 `PendingDoc` 编译不过。
 * 新增字段时优先用「省略」而不是 `undefined`。
 */
export type DispositionPayload = {
	/** 这是「处置」类待办，区别于普通升级。 */
	type: "disposition";
	/** 被打断工作的快照。 */
	work: InterruptedWork;
	/** 选项（人类可读）。 */
	options: DispositionOptionEntry[];
	/** 默认处置与到期时刻。 */
	defaultDisposition: DispositionOption;
	deadlineAt: number;
	/** 暂搁时的恢复条件（必有默认值，暂搁不允许没有它）。 */
	resumeAfterMs: number;
	resumeNote: string;
	/** 实际生效的默认值是否已经由超时兜底执行。 */
	appliedDefault?: DispositionOption;
	appliedAt?: number;
	/** 已定的处置（人回答或超时默认）。 */
	disposition?: DispositionOption;
	decidedBy?: "human" | "timeout-default";
	/** 恢复条件（人可改）。 */
	resumeCondition?: string;
	/**
	 * 定下处置的时刻与「恢复提醒」的到期时刻（ADR-026 决策 4/5）。
	 *
	 * 决策 4 要求暂搁必须带恢复条件，而恢复条件的语义是「到点提醒下达人」。
	 * `resumeAt` 就是那一刻：暂搁时 = decidedAt + resumeAfterMs；
	 * 直接放弃没有恢复提醒，所以没有这个字段。
	 */
	decidedAt?: number;
	resumeAt?: number;
	/** 已经提醒过下达人的时刻；写入它保证同一件事只提醒一次（巡检每轮都跑）。 */
	resumeRemindedAt?: number;
};

/** 生成处置问题的正文：结构化、带事实、带推荐，不是开放提问（ADR-026 决策 4）。 */
export function buildDispositionQuestion(work: InterruptedWork): string {
	const project = work.project ?? "(未记录项目)";
	const task = `${work.taskKind}#${work.taskId}`;
	return [
		`被打断的工作：${project} / ${task}`,
		`进度：${describeProgress(work.progress)}`,
		`选项：① 暂搁（推荐）② 永久放弃`,
		`若暂搁：需要恢复条件（默认 30 分钟后提醒下达人）`,
		`（${DISPOSITION_DEADLINE_MS / 60_000} 分钟内未答复，按「暂搁」执行，问题留在待办可事后改）`,
	].join("\n");
}

/** 默认选项清单。 */
export function defaultOptions(): DispositionPayload["options"] {
	return [
		{ id: "shelve", label: "暂搁", recommended: true },
		{ id: "abandon", label: "永久放弃", recommended: false },
	];
}

/**
 * 判断一条暂搁是否成立。
 *
 * ADR-026 决策 4 的硬要求：**没有恢复条件的「暂搁」不是暂停，是让工作无声烂掉**。
 * 所以这里必须有一个「有效的恢复条件」才算成立——默认值也算（默认就是
 * 「30 分钟后提醒下达人」），但空字符串/纯空白不算。
 */
export function hasResumeCondition(payload: DispositionPayload): boolean {
	const explicit = payload.resumeCondition?.trim();
	if (explicit !== undefined && explicit !== "") return true;
	// 默认恢复条件始终存在且为正数时，视为成立
	return typeof payload.resumeAfterMs === "number" && payload.resumeAfterMs > 0;
}

/**
 * 校验处置答案是否合法，并归一化成 { disposition, resumeCondition }。
 *
 * 返回 `undefined` 表示答案不合规，调用方必须拒绝（绝不能悄悄按默认值放过）。
 */
export type DispositionAnswerResult =
	| { readonly ok: true; readonly disposition: DispositionOption; readonly resumeCondition: string }
	| { readonly ok: false; readonly reason: string };

export function parseDispositionAnswer(
	answer: string,
	payload: DispositionPayload,
): DispositionAnswerResult {
	const text = answer.trim();
	if (text === "") return { ok: false, reason: "答复为空：请明确选「暂搁」或「永久放弃」" };

	const shelve = /暂搁|暂停|shelve/i.test(text);
	const abandon = /放弃|abandon/i.test(text);
	if (!shelve && !abandon) return { ok: false, reason: "答复不合法：请明确选「暂搁」或「永久放弃」" };
	// 同时提到两个视为说不清，拒绝，让对方明确
	if (shelve && abandon) return { ok: false, reason: "答复含糊：请只选「暂搁」或「永久放弃」其中一个" };

	if (abandon) return { ok: true, disposition: "abandon", resumeCondition: "" };

	// 暂搁：**恢复条件是必填项**（ADR-026 决策 4 原文：「没有恢复条件的暂搁
	// 不是暂停，是让工作无声烂掉」）。
	//
	// 这里刻意**不**在缺省时自动补「默认 30 分钟」文案。原先那样写，
	// 会让下游「暂搁必须带恢复条件」的拒绝分支永不触发——等于把必填项
	// 悄悄变成可选项，与 ADR 直接冲突（审计/沈砺行指出）。
	// 默认文案只属于「超时兜底」（见 shouldApplyTimeoutDefault）。
	const custom = text.replace(/.*?(暂搁|暂停|shelve)\s*[:：,，]?\s*/i, "").trim();
	if (!isMeaningfulResumeCondition(custom)) {
		// 只说了「暂搁」没说条件 → 明确告诉对方缺什么，而不是笼统说「不合法」
		return { ok: false, reason: "暂搁必须带恢复条件：请写明「暂搁：<什么情况/什么时候> 再继续」" };
	}
	return { ok: true, disposition: "shelve", resumeCondition: custom };
}

/**
 * 恢复条件是否「真的写了东西」。
 *
 * 光判 `trim() === ""` 不够（实测发现）：`"暂搁。"` / `"暂搁！"` / `"暂搁..."`
 * 去掉关键词后剩一个标点，trim 后非空，于是能通过「必填」校验，
 * 但恢复条件其实等于没写——这正是 ADR-026 决策 4 要防的「让工作无声烂掉」。
 *
 * 所以：必须至少含一个**字母/数字/汉字**，纯标点/空白一律不算。
 */
export function isMeaningfulResumeCondition(condition: string): boolean {
	const text = condition.trim();
	if (text === "") return false;
	// \p{L} 字母（含汉字）、\p{N} 数字；标点、空白、符号都不算
	return /[\p{L}\p{N}]/u.test(text);
}

/**
 * 超时兜底：未答复时按默认（暂搁）执行。
 *
 * 返回是否应该执行兜底，以及归一化后的处置。
 * 只在「已到期限」且「尚未定过处置」时成立。
 */
export function shouldApplyTimeoutDefault(
	payload: DispositionPayload,
	now: number,
): { apply: true; disposition: DispositionOption; resumeCondition: string } | { apply: false } {
	if (payload.disposition !== undefined) return { apply: false };
	if (now < payload.deadlineAt) return { apply: false };
	return {
		apply: true,
		disposition: payload.defaultDisposition,
		resumeCondition: `默认：${payload.resumeAfterMs / 60_000} 分钟后提醒下达人`,
	};
}

// ── 落库操作（走 PendingDoc / AuditDoc，复用现有机制）──────────────────────
//
// 这些函数要访问运行时，所以放在文件末尾，纯函数在前便于单测。


/** 处置待办的 key 前缀，便于从一堆升级里筛出来。 */
export const DISPOSITION_KEY_PREFIX = "disp:";

/** 生成一个处置待办的 key（同一任务同一时刻只该有一条）。 */
export function dispositionKey(taskId: string, at: number): string {
	return `${DISPOSITION_KEY_PREFIX}${taskId}:${at}`;
}

/**
 * 创建一条处置待办。
 *
 * 这是「打断发生时」的落库动作（ADR-026 决策 4）：
 * - 结构化、带事实、带推荐
 * - 默认暂搁（唯一可逆项）
 * - 5 分钟期限
 * - 恢复条件带默认值（30 分钟后提醒下达人）
 *
 * 幂等：同一 key 已存在则不重复插入（打断可能被重试）。
 */
export async function createDispositionPending(
	runtime: CompanyRuntime,
	work: InterruptedWork,
	options: { readonly now?: number; readonly resumeAfterMs?: number } = {},
	context: Context = BACKGROUND_CONTEXT,
): Promise<{ key: string; created: boolean }> {
	const now = options.now ?? Date.now();
	const resumeAfterMs = options.resumeAfterMs ?? DEFAULT_RESUME_AFTER_MS;
	const key = dispositionKey(work.taskId, now);

	const payload: DispositionPayload = {
		type: "disposition",
		work,
		options: defaultOptions(),
		defaultDisposition: DEFAULT_DISPOSITION,
		deadlineAt: now + DISPOSITION_DEADLINE_MS,
		resumeAfterMs,
		resumeNote: `默认：${Math.round(resumeAfterMs / 60_000)} 分钟后提醒下达人`,
	};

	// 处置归「被打断工作的下达人」（ADR-026 决策 1）。
	//
	// `level` 是**权限位**（owner / ceo / cto… / leader:<slug>），不是显示名。
	// 原先这里直接把 `app.delegate.from`（中文显示名，如「老板」「许砚舟」）塞进 level，
	// 导致：① pending_list / answer_pending 按 level 精确匹配时永远匹配不上，
	// 看起来像「不是到你这一级」的权限拒绝，实际是数据口径错；
	// ② feed 的 awaitingOwner 用 `level === "owner"` 判断，与项目终止确认混在一条布尔里。
	// 现在一律用 levelOfConversation 反查（ADR-027：所有身份解析必须走统一入口）。
	const company = await runtime.harness.snapshot(CompanyDoc, context);
	const assignedByConversationId = work.assignedByConversationId ?? work.conversationId;
	// 兜底顺序：下达人的层级 → 若下达人本身是员工则用其直属上级 → CEO。
	// 原先反查不到就留空串，结果是这条处置**谁都答不了**（level 精确匹配永远失败），
	// 永久卡在待办里——违反 ADR-026 决策 5「等待必须有默认值与期限」。
	const delegatorAsStaff = Object.values(company?.staff ?? {}).find(
		(person) => person.conversationId === assignedByConversationId,
	);
	const derivedLevel =
		levelOfConversation(company, assignedByConversationId) ?? delegatorAsStaff?.manager ?? "ceo";

	const created = await runtime.harness.commit(async (tx) => {
		const pending = await tx.doc(PendingDoc);
		if (pending.items.some((item) => item.key === key)) return false;

		pending.items.push({
			key,
			question: buildDispositionQuestion(work),
			// 反查不到就**不设权限位**（空串），退化为「只公示、不授权」，
			// 绝不能拿显示名冒充权限位。
			level: derivedLevel ?? "",
			from: work.assignedBy ?? "被打断的工作",
			fromConversationId: assignedByConversationId,
			askedAt: now,
			disposition: payload,
			// 真实提问方：处置归「被打断工作的下达人」，拍板结果也该投回给他。
			originConversationId: assignedByConversationId,
			...(work.project === null ? {} : { project: work.project }),
		});
		return true;
	}, context);

	return { key, created };
}

/**
 * 读一条处置待办（含是否已被答复）。
 *
 * 读时兜底（审计 D-01 建议①）：先把已到期的处置项就地按默认值结算，再返回。
 * 为什么放在读点而不是只靠看门狗：看门狗只在「有进程在跑」时驱动，
 * 而 ADR-026 决策 5 的「到期按暂搁执行」是协议条款，不该依赖服务常驻。
 * 读点兜底是幂等的（settleDisposition 内部会判「已有结论」）。
 */
export async function readDisposition(
	runtime: CompanyRuntime,
	key: string,
	options: { readonly now?: number } = {},
	context: Context = BACKGROUND_CONTEXT,
): Promise<{ item: PendingItem; payload: DispositionPayload } | undefined> {
	await settleDueDispositions(runtime, options.now ?? Date.now(), context);
	const state = await runtime.harness.snapshot(PendingDoc, context);
	const item = state?.items.find((entry) => entry.key === key && entry.disposition !== undefined);
	if (item?.disposition === undefined) return undefined;
	return { item, payload: item.disposition };
}

/**
 * 读时兜底入口：把**已到期且未定处置**的处置项按默认值结算。
 *
 * 由任何「读待办」的路径顺手调用（readDisposition / listPendingForDisplay）。
 * 幂等、静默：结算失败只影响那一条，不抛出、不影响读取本身。
 *
 * @returns 本次结算掉的条数
 */
export async function settleDueDispositions(
	runtime: CompanyRuntime,
	now: number = Date.now(),
	context: Context = BACKGROUND_CONTEXT,
): Promise<number> {
	try {
		// 快速短路：没有到期项就不进 commit，避免每次读都写库。
		const state = await runtime.harness.snapshot(PendingDoc, context);
		const hasDue = (state?.items ?? []).some(
			(item) =>
				item.disposition !== undefined &&
				item.answer === undefined &&
				// 已被人驳回/标记已解决的，不该再被超时兜底「答」一遍。
				item.disposed === undefined &&
				shouldApplyTimeoutDefault(item.disposition, now).apply,
		);
		if (!hasDue) return 0;
		return await applyDueDispositionDefaults(runtime, now, context);
	} catch {
		// 兜底失败不能连累读取方（界面/工具仍需拿到待办）
		return 0;
	}
}


/**
 * 定下处置（人回答，或超时兜底）。
 *
 * 两条硬约束（ADR-026 决策 4/5）：
 * 1. **暂搁必须有恢复条件**——没有就不允许成立，直接返回拒绝原因。
 * 2. **实际用了哪个默认值必须写进留痕**——否则事后分不清「机器决定了」和「人决定了」。
 *
 * @returns `{ ok: true }` 或 `{ ok: false, reason }`
 */
export async function settleDisposition(
	runtime: CompanyRuntime,
	input: {
		readonly key: string;
		readonly answer: string;
		readonly answeredBy: string;
		/** 是否由超时兜底触发（决定留痕里的 decidedBy）。 */
		readonly viaTimeout?: boolean;
		/** 判定与留痕用的时刻；默认 `Date.now()`。注入它才能断言 `appliedAt`（审计 D-06）。 */
		readonly now?: number;
	},
	context: Context = BACKGROUND_CONTEXT,
): Promise<{ ok: true; disposition: DispositionOption; resumeCondition: string } | { ok: false; reason: string }> {
	const now = input.now ?? Date.now();
	let result:
		| { ok: true; disposition: DispositionOption; resumeCondition: string }
		| { ok: false; reason: string } = { ok: false, reason: "待办不存在" };
	let delivered:
		| {
				question: string;
				askerConversationId: number;
				askerLabel: string;
				disposition: DispositionOption;
				resumeCondition: string;
		  }
		| undefined;

	await runtime.harness.commit(async (tx) => {
		const pending = await tx.doc(PendingDoc);
		const index = pending.items.findIndex((item) => item.key === input.key);
		if (index < 0) {
			result = { ok: false, reason: "待办不存在" };
			return;
		}
		const item = pending.items[index];
		if (item?.disposition === undefined) {
			result = { ok: false, reason: "该待办不是处置类" };
			return;
		}
		// ADR-026 决策 5：「问题留在待办，**事后可改**」+「默认值可被事后推翻」。
		//
		// 所以「已有结论」不能一律拒：已有结论来自**超时默认**时，人后来回答应该能推翻它
		// （机器代你选了可逆的那一侧，你回来改主意是协议允许的）。
		// 而**人自己已经答过**的，不允许通过这个函数反复改——那会让留痕变成儿戏，
		// 且重复提交（网络重试）会静默改掉老板的决定。区分靠 `decidedBy`。
		const already = item.disposition.disposition !== undefined;
		const byTimeoutDefault = item.disposition.decidedBy === "timeout-default";
		if (already && !byTimeoutDefault) {
			result = { ok: false, reason: "该处置已有结论" };
			return;
		}

		const parsed = parseDispositionAnswer(input.answer, item.disposition);
		if (!parsed.ok) {
			result = { ok: false, reason: parsed.reason };
			return;
		}

		// 再兜一次：防止调用方绕过 parseDispositionAnswer 传空条件进来。
		// 用与 parseDispositionAnswer 同一个判定（含标点不算写），不另立口径。
		if (parsed.disposition === "shelve" && !isMeaningfulResumeCondition(parsed.resumeCondition)) {
			result = { ok: false, reason: "暂搁必须带恢复条件" };
			return;
		}

		// 决策 4/5 的「恢复条件」是**可执行**的：暂搁要有一个 `resumeAt`，
		// 到期由巡检提醒下达人（见 applyDueResumeReminders）。重新定处置时把
		// 提醒标记清掉，这样「推翻默认值」之后也会按新条件重新提醒一次。
		const nextDisposition: DispositionPayload = {
			...item.disposition,
			disposition: parsed.disposition,
			resumeCondition: parsed.resumeCondition,
			decidedBy: input.viaTimeout === true ? "timeout-default" : "human",
			decidedAt: now,
			...(input.viaTimeout === true ? { appliedDefault: parsed.disposition, appliedAt: now } : {}),
		};
		if (parsed.disposition === "shelve") {
			nextDisposition.resumeAt = now + item.disposition.resumeAfterMs;
		} else if (nextDisposition.resumeAt !== undefined) {
			delete nextDisposition.resumeAt;
		}
		if (nextDisposition.resumeRemindedAt !== undefined) delete nextDisposition.resumeRemindedAt;

		pending.items[index] = {
			...item,
			answer: input.answer,
			answeredBy: input.answeredBy,
			disposition: nextDisposition,
		};

		// 留痕（决策 8）：timing / disposition / 覆盖了什么 / 实际用了哪个默认值
		//
		// 审计写不进去**不能**让处置失败：处置已经定下来了（上面已改 pending.items），
		// 因为「记不下账」而回滚会让人以为没答过、反复重答。降级为尽力而为。
		const note = [
			`disposition=${parsed.disposition}`,
			`via=${input.viaTimeout === true ? "timeout-default" : "human"}`,
			`default=${item.disposition.defaultDisposition}`,
			`covered=${item.disposition.work.taskKind}#${item.disposition.work.taskId}`,
			`tools=${item.disposition.work.progress.completedToolCalls}/${item.disposition.work.progress.totalToolCalls}`,
			`tokens=${item.disposition.work.progress.tokensUsed}`,
			parsed.disposition === "shelve" ? `resume=${parsed.resumeCondition}` : "resume=n/a",
		].join(" ");
		try {
			const audit = await tx.doc(AuditDoc, item.fromConversationId as never);
			audit.events.push({
				at: now,
				type: "decide",
				from: input.answeredBy,
				to: item.from,
				note,
				ref: input.key,
			});
		} catch {
			// 会话不存在（例如下达人标签不是真实会话）时审计写不进去，处置照常生效。
			// 这里刻意吞掉：留痕是附加价值，不能反过来卡住决策落地。
		}

		result = { ok: true, disposition: parsed.disposition, resumeCondition: parsed.resumeCondition };
		delivered = {
			question: item.question,
			askerConversationId: item.originConversationId ?? item.fromConversationId,
			askerLabel: item.from,
			// 在闭包里单独记一份：闭包外的 `result` 会被 TS 收窄成初始分支，
			// 读 result.disposition 会被判成 never（实际运行时是有的）。
			disposition: parsed.disposition,
			resumeCondition: parsed.resumeCondition,
		};
	}, context);

	// 处置一旦成立，必须让下达人看得见「它到底怎么了」（见 decision-delivery.ts）。
	// 处置类额外带 disposition 标记，界面措辞是「处置已定」而不是「拍板结果」。
	// 超时兜底（viaTimeout）也投递：那是「机器代你选了可逆的一侧」，更需要让人知道。
	if (delivered !== undefined) {
		const headline =
			delivered.disposition === "shelve" ? `暂搁：${delivered.resumeCondition}` : "永久放弃";
		await deliverDecision(
			runtime,
			{
				key: input.key,
				question: delivered.question,
				answer: headline,
				answeredBy: input.answeredBy,
				askerConversationId: delivered.askerConversationId,
				askerLabel: delivered.askerLabel,
				disposition: true,
			},
			context,
		);
	}
	return result;
}

/**
 * 扫描到期的处置待办并按默认值兜底执行。
 *
 * 这是决策 5「到期行为：按暂搁执行，问题留在待办事后可改」的落地。
 * 由调用方定期驱动（看门狗或 HTTP 侧），本函数不自己起定时器——
 * 定时器会绑定到某个进程实例，重启后丢失，反而不如「每次巡检顺手扫一遍」可靠。
 *
 * @returns 本轮兜底执行的条数
 */
export async function applyDueDispositionDefaults(
	runtime: CompanyRuntime,
	now: number = Date.now(),
	context: Context = BACKGROUND_CONTEXT,
): Promise<number> {
	const state = await runtime.harness.snapshot(PendingDoc, context);
	const due = (state?.items ?? []).filter((item) => {
		if (item.disposition === undefined) return false;
		if (item.answer !== undefined) return false;
		// 已处置的跳过（同上，避免把人的决定覆盖成机器默认值）。
		if (item.disposed !== undefined) return false;
		const check = shouldApplyTimeoutDefault(item.disposition, now);
		return check.apply;
	});

	let applied = 0;
	for (const item of due) {
		const payload = item.disposition;
		if (payload === undefined) continue;
		// 超时兜底必须**自带**恢复条件：人没写，机器就用协议规定的默认值
		// （30 分钟后提醒下达人）。注意不能只传 "暂搁"——恢复条件现在是必填项，
		// 空条件会被 parseDispositionAnswer 拒绝，兜底就永远不成立。
		const resumeCondition = `默认：${Math.round(payload.resumeAfterMs / 60_000)} 分钟后提醒下达人`;
		const result = await settleDisposition(
			runtime,
			{
				key: item.key,
				answer: `暂搁：${resumeCondition}`,
				answeredBy: "系统（超时默认）",
				viaTimeout: true,
				now,
			},
			context,
		);
		if (result.ok) applied += 1;
	}
	return applied;
}

/**
 * 提醒「暂搁」到期：恢复条件一到点，就给下达人写一条 alert（ADR-026 决策 4/5）。
 *
 * 为什么必须做：决策 4 的原话是「没有恢复条件的暂搁不是暂停，是让工作无声烂掉」。
 * 恢复条件的语义就是「到这个时刻提醒下达人」——只把条件存进库、到点不提醒，
 * 等于根本没有恢复条件，暂搁的工作照样会无声烂掉。
 *
 * 由巡检驱动（不是定时器）：定时器绑定进程实例，重启就丢；挂在已有的巡检上，
 * 重启后自然恢复（与 applyDueDispositionDefaults 同一取舍）。
 *
 * 幂等：提醒成功才写 `resumeRemindedAt`，下一轮不再提醒；写失败不推进标记，
 * 下一轮重试（会话可能刚被删掉）。
 *
 * 条目直接用 `app.alert`（与 watchdog 的 `ALERT_ENTRY_KIND` 同一个字符串）：
 * 不从 watchdog 导入，是为了避免 `watchdog → disposition → watchdog` 的运行时环。
 *
 * @returns 本轮发出提醒的条数
 */
export async function applyDueResumeReminders(
	runtime: CompanyRuntime,
	now: number = Date.now(),
	context: Context = BACKGROUND_CONTEXT,
): Promise<number> {
	const state = await runtime.harness.snapshot(PendingDoc, context);
	const due = (state?.items ?? []).filter((item) => {
		const payload = item.disposition;
		if (payload === undefined) return false;
		if (payload.disposition !== "shelve") return false;
		if (payload.resumeAt === undefined) return false;
		if (payload.resumeRemindedAt !== undefined) return false;
		return now >= payload.resumeAt;
	});
	if (due.length === 0) return 0;

	let reminded = 0;
	for (const item of due) {
		const payload = item.disposition;
		if (payload === undefined) continue;
		const work = payload.work;
		const text = [
			`恢复条件到点：${work.project ?? "（未记录项目）"} / ${work.taskKind}#${work.taskId}`,
			`当时按「暂搁」处理（${payload.resumeCondition ?? payload.resumeNote}）。`,
			`要继续就让 ${work.assignedBy ?? "原执行人"} 接着做；要改处置，重新回答这条待办 ${item.key}（「暂搁：<条件>」或「永久放弃」）。`,
		].join("\n");
		try {
			await runtime.harness.commit(async (tx) => {
				await tx.appendEntry(item.fromConversationId as never, {
					kind: "app.alert",
					data: { text, from: "系统", action: "resume", reason: "resume-reminder", at: now },
				});
				const pending = await tx.doc(PendingDoc);
				const index = pending.items.findIndex((entry) => entry.key === item.key);
				const stored = index < 0 ? undefined : pending.items[index];
				if (index >= 0 && stored !== undefined && stored.disposition !== undefined) {
					pending.items[index] = {
						...stored,
						disposition: { ...stored.disposition, resumeRemindedAt: now },
					};
				}
			}, context);
			reminded += 1;
		} catch {
			// 提醒失败不推进标记：下一轮巡检再试
		}
	}
	return reminded;
}

// ── 从运行时采集（唯一带副作用的部分，但仍是只读）────────────────────────

/**
 * 采集某会话中「正在跑、即将被打断」的工作快照。
 *
 * 全部字段机械推导，不调模型、不花 token：
 * - 任务：`harness.inspect()` 里该会话的非终态普通任务
 * - 进度：会话条目里 pi.assistant(toolCall) 与 pi.tool-result 的配对
 * - token：UsageDoc 的累计 totalTokens
 * - 下达人/项目：最近一条 app.delegate
 *
 * @returns 没有正在跑的任务时返回 undefined（没什么可处置的）。
 */
export async function captureInterruptedWork(
	runtime: CompanyRuntime,
	conversationId: number,
	context: Context = BACKGROUND_CONTEXT,
): Promise<InterruptedWork | undefined> {
	const inspection = await runtime.harness.inspect(context);
	const task = inspection.tasks.find((entry) => {
		const record = entry.record as { conversationId?: unknown; background?: unknown };
		if (Number(record.conversationId) !== conversationId) return false;
		if (record.background === true) return false;
		// 只关心还会继续推进的状态；terminal/completing 的没什么可"放下"
		return entry.state.kind === "running" || entry.state.kind === "ready";
	});
	if (task === undefined) return undefined;

	const record = task.record as {
		id: unknown;
		kind?: unknown;
		startedAt?: unknown;
	};

	// 条目：进度与下达人
	let entries: readonly { kind: string; model?: readonly unknown[]; data?: unknown }[] = [];
	try {
		const conversation = await runtime.harness.conversation(conversationId as never, context);
		if (conversation !== undefined) {
			const page = await conversation.entries({ order: "ascending" }, 400, undefined, context);
			entries = page.items as never;
		}
	} catch {
		// 读不到条目就退化成「无进度」，不阻断处置流程
	}

	const toolCalls = countToolCalls(entries);
	const tokensUsed = await readTokens(runtime, conversationId, context);
	const assignment = findAssignment(entries);

	return {
		taskId: String(record.id),
		taskKind: typeof record.kind === "string" ? record.kind : "?",
		conversationId,
		startedAt: typeof record.startedAt === "number" ? record.startedAt : null,
		project: assignment.project,
		assignedBy: assignment.from,
		// 把下达人标签解析成会话 id：决定这条处置待办投给谁。
		// 解析不到就保持 null，由 createDispositionPending 回落到当前会话——
		// 宁可投到眼前这个会话，也不要因为「找不到人」让处置问题消失。
		assignedByConversationId:
			assignment.from === null ? null : await resolveConversationId(runtime, assignment.from, context),
		progress: deriveProgress(toolCalls, tokensUsed),
	};
}

/**
 * 读会话累计 token。读不到就返回 0（宁可少报，不假报）。
 *
 * 走 `cost.ts` 的 `conversationUsage`（ADR-003 规定的唯一用量入口），
 * 不再手抄 `Object.values(models).reduce(...)`——那是本仓第三份同样的实现
 * （审计 D-04），且静态导入替代了原来的动态导入（D-05）。
 */
async function readTokens(
	runtime: CompanyRuntime,
	conversationId: number,
	context: Context,
): Promise<number> {
	try {
		const usage = await conversationUsage(runtime, conversationId, context);
		return usage.totalTokens;
	} catch {
		return 0;
	}
}

/**
 * 把「下达人标签」解析成会话 id。
 *
 * 标签来自 `app.delegate.from`，形如「老板」「CEO」「许砚舟」。
 * 依次尝试：管理层岗位 → 项目负责人 → 员工名。
 * 解析不到返回 null（调用方回落），绝不猜一个 id 出来。
 */
async function resolveConversationId(
	runtime: CompanyRuntime,
	label: string,
	context: Context,
): Promise<number | null> {
	try {
		const company = await runtime.harness.snapshot(CompanyDoc, context);
		if (company === undefined) return null;

		// 管理层岗位：标签恰好是中文岗位名
		for (const [role, conversationId] of Object.entries(company.roles)) {
			if (ROLE_LABELS[role as keyof typeof ROLE_LABELS] === label) return Number(conversationId);
		}

		// 项目负责人：按 leaderName 匹配
		for (const project of Object.values(company.projects)) {
			if (project.leaderName === label && project.leader !== undefined) return Number(project.leader);
		}

		// 员工名
		for (const staff of Object.values(company.staff)) {
			if (staff.name === label) return Number(staff.conversationId);
		}
	} catch {
		// 解析失败就回落，不影响打断
	}
	return null;
}
