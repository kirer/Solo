/**
 * 派活与回报。
 *
 * 一个派活 = 向员工会话投递一条输入 + 等它答完 + 把结果记回派活方。
 *
 * 关键约束：
 * - 请求标识由业务语义推导（ADR-006），崩溃重开后重复投递被去重，员工不会重复干活。
 * - 派活方必须是管理层或项目负责人；员工没有这个工具（ADR-004）。
 * - 员工的工作归属后台任务，所以派活方被打断不会波及员工（ADR-005）。
 */
import {
	BACKGROUND_CONTEXT,
	type Context,
	delegationRequestId,
	inspectLivenessFrom,
	isConversationBusy,
	reportRequestId,
	type CompanyRuntime,
} from "../runtime/index.ts";
import { AuditDoc, CompanyDoc, ROLE_LABELS, type StaffEntry } from "./docs.ts";
import { beginLiveTrail, recordMessage } from "./trail.ts";
import {
	DEFAULT_DELEGATION_TIMEOUT_MS,
	DelegationCycleError,
	DelegationTimeoutError,
	enterDelegation,
	waitWithTimeout,
} from "./delegation-guard.ts";

/** 派活选项。 */
export type DelegateOptions = {
	/** 项目 slug。 */
	readonly project: string;
	/** 员工名。 */
	readonly employee: string;
	/** 任务内容。 */
	readonly task: string;
	/** 发起派活的会话标识（用于回报与留痕）。 */
	readonly fromConversationId: number;
	/** 发起方显示名。 */
	readonly from: string;
	/**
	 * 派活标识，用于生成稳定的请求标识（ADR-006）。
	 *
	 * **必须由调用方提供且每次派活唯一**——通常用升级/派活任务的任务标识。
	 * 若两次派活用同一个标识，第二次会返回第一次的提交（底层幂等去重），
	 * 这是崩溃恢复要的行为，但不是「派第二件事」要的行为。
	 *
	 * 不传时退化为 `${project}/${employee}/${序号}`，其中序号由公司索引里的
	 * 派活计数推导，保证同一员工连续派活不会互相吞掉。
	 */
	readonly delegationId?: string;
	/**
	 * 忙碌时的策略：
	 * - `followUp`（默认）：排队，等员工手头的活干完再处理
	 * - `steer`：插到当前工具轮次之后，并入正在跑的工作
	 * - `reject`：直接拒绝并抛错
	 */
	readonly whenBusy?: "followUp" | "steer" | "reject";
	/**
	 * 同步等待的硬上限（毫秒），默认 {@link DEFAULT_DELEGATION_TIMEOUT_MS}（180 秒）。
	 *
	 * 没有上限就是这次事故的成因：员工那轮工具报错后 `pi.generation` 停在
	 * `waiting`，`submission.wait()` 永不返回，派活方的工具任务永远 `running`，
	 * 会话永远「正在忙」，后续派活全部排队。超时后返回
	 * `{ ok:false, reason:"timeout" }` 并释放等待图，让模型能换条路走。
	 *
	 * 传 `0` 或 `Infinity` 表示不设上限（只建议测试用）。
	 */
	readonly timeoutMs?: number;
};

/** 派活结果。 */
export type DelegateResult = {
	readonly ok: boolean;
	/** 员工答复文本；失败时是失败原因。 */
	readonly text: string;
	/** 失败原因分类。 */
	readonly reason?: "no-employee" | "archived" | "busy" | "failed" | "cross-project" | "cycle" | "timeout";
	readonly conversationId?: number;
};

/**
 * 向项目员工派活并等待答复。
 */
export async function delegate(
	runtime: CompanyRuntime,
	options: DelegateOptions,
	context: Context = BACKGROUND_CONTEXT,
): Promise<DelegateResult> {
	const key = `${options.project}/${options.employee}`;
	const state = await runtime.harness.snapshot(CompanyDoc, context);
	const staff = state?.staff[key];

	// 前置校验：员工不存在或已归档，返回明确失败且不创建任何会话
	if (staff === undefined) {
		return { ok: false, text: `项目 ${options.project} 里没有名为 ${options.employee} 的员工。`, reason: "no-employee" };
	}
	if (staff.archived) {
		return { ok: false, text: `员工 ${options.employee} 已归档，不能派活。`, reason: "archived" };
	}

	// 越级校验：项目负责人只能给本项目员工派活。
	// 组织规则是「员工只对项目负责人负责」，负责人跨项目指挥会让汇报线彻底失效。
	const denied = await checkLeaderScope(runtime, options, state, context);
	if (denied !== undefined) return denied;

	const employee = await runtime.harness.conversation(staff.conversationId as never, context);
	if (employee === undefined) {
		return { ok: false, text: `员工 ${options.employee} 的会话不存在。`, reason: "no-employee" };
	}

	// 环检测：派活也是同步等待，同样会形成 A→B→A 的闭环。
	// 以前只有 delegate_to_role / delegate_to_leader 走了这道防线，员工这条路径漏了。
	let releaseGuard: () => void;
	try {
		releaseGuard = enterDelegation(options.fromConversationId, staff.conversationId);
	} catch (error) {
		if (error instanceof DelegationCycleError) {
			return {
				ok: false,
				text: [
					`不能派活给 ${options.employee}：${error.message}。`,
					"对方正在直接或间接等你这一侧的结果，派过去会互相卡死。",
					"请先处理完手上的结论并回复它，或改用 escalate。",
				].join(""),
				reason: "cycle",
				conversationId: staff.conversationId,
			};
		}
		throw error;
	}

	try {
		// 未给派活标识时，按该员工已发生的派活次数推导，保证连续派活各自独立。
		const delegationId = options.delegationId ?? (await nextDelegationId(runtime, key, context));
		const requestId = delegationRequestId(delegationId, options.employee);

		// 投递。whenBusy: "reject" 时忙碌会抛 ConversationBusy，转成明确的失败结果。
		let submission: Awaited<ReturnType<typeof employee.submit>>;
		try {
			submission = await employee.submit(
				{
					type: "input",
					content: options.task,
					requestId,
					// 标记来源：员工会话里这条消息不是老板发的，界面要能区分，
					// 排队时也不能显示成「你需要处理」。
					entry: {
						kind: "app.delegate",
						data: {
							from: options.from,
							to: options.employee,
							project: options.project,
							text: options.task.slice(0, 280),
						},
					},
					...(options.whenBusy === undefined ? {} : { whenBusy: options.whenBusy }),
				},
				context,
			);
		} catch {
			return {
				ok: false,
				text: `员工 ${options.employee} 正在忙碌，已拒绝本次派活。`,
				reason: "busy",
				conversationId: staff.conversationId,
			};
		}

		// 实时连线：派活在等待期间就挂一条临时边，界面能立刻看到「谁在跟谁说话」。
		const releaseLive = beginLiveTrail({
			kind: "delegate",
			from: options.from,
			to: options.employee,
			fromConversation: options.fromConversationId,
			toConversation: staff.conversationId,
			project: options.project,
		});
		let settled: Awaited<ReturnType<typeof submission.wait>>;
		try {
			settled = await waitWithTimeout(
				submission.wait(context),
				options.timeoutMs ?? DEFAULT_DELEGATION_TIMEOUT_MS,
				context.abortSignal === undefined ? {} : { signal: context.abortSignal },
			);
		} catch (error) {
			if (error instanceof DelegationTimeoutError) {
				// 超时不撤销已经投出去的工作（ADR-005）：员工照旧会做完，
				// 只是这一侧不再等它。留一条痕，让「它后来做完了」可追溯。
				await recordMessage(
					runtime,
					{
						kind: "report",
						from: options.employee,
						to: options.from,
						fromConversationId: staff.conversationId,
						toConversationId: options.fromConversationId,
						ref: reportRequestId(delegationId, options.employee),
						project: options.project,
						text: `派活等待超时（${Math.round((options.timeoutMs ?? DEFAULT_DELEGATION_TIMEOUT_MS) / 1000)} 秒），员工仍在后台继续；结果不会再回到本次调用。`,
					},
					context,
				);
				return {
					ok: false,
					text: [
						`等待员工 ${options.employee} 超过 ${Math.round((options.timeoutMs ?? DEFAULT_DELEGATION_TIMEOUT_MS) / 1000)} 秒，本次派活不再等待。`,
						"它可能仍在后台干活，也可能卡住了。",
						"不要反复重派同一件事：先做你能做的部分，或把这件事上报（escalate）让上层协调。",
					].join(""),
					reason: "timeout",
					conversationId: staff.conversationId,
				};
			}
			throw error;
		} finally {
			releaseLive();
		}

		if (settled.status === "unanswered") {
			const reason = `未能回答（${settled.reason}）`;
			await recordMessage(runtime, {
				kind: "report",
				from: options.employee,
				to: options.from,
				fromConversationId: staff.conversationId,
				toConversationId: options.fromConversationId,
				ref: reportRequestId(delegationId, options.employee),
				project: options.project,
				text: `派活失败：${reason}`,
			}, context);
			return {
				ok: false,
				text: `员工 ${options.employee} 未能完成：${reason}`,
				reason: "failed",
				conversationId: staff.conversationId,
			};
		}

		const answer = await readAnswer(runtime, settled.answer, context);

		// 员工跑完了，但工具失败意味着「活没干成」。
		// 这种情况不能当作成功答复回报——否则派活方会以为任务完成了。
		const toolFailure = await detectRunFailure(runtime, staff.conversationId, context);
		if (toolFailure !== undefined) {
			await recordMessage(runtime, {
				kind: "report",
				from: options.employee,
				to: options.from,
				fromConversationId: staff.conversationId,
				toConversationId: options.fromConversationId,
				ref: reportRequestId(delegationId, options.employee),
				project: options.project,
				text: `工具失败：${toolFailure}`,
			}, context);
			return {
				ok: false,
				text: `员工 ${options.employee} 执行失败：${toolFailure}`,
				reason: "failed",
				conversationId: staff.conversationId,
			};
		}

		// 双向留痕：派活方一条「我派给谁」，员工一条「谁派给我」
		await recordMessage(runtime, {
			kind: "delegate",
			from: options.from,
			to: options.employee,
			fromConversationId: options.fromConversationId,
			toConversationId: staff.conversationId,
			ref: requestId,
			project: options.project,
			text: options.task,
		}, context);
		await recordMessage(runtime, {
			kind: "report",
			from: options.employee,
			to: options.from,
			fromConversationId: staff.conversationId,
			toConversationId: options.fromConversationId,
			ref: reportRequestId(delegationId, options.employee),
			project: options.project,
			text: answer,
		}, context);

		// 审计
		await appendAudit(runtime, options.fromConversationId, {
			at: Date.now(),
			type: "delegate",
			from: options.from,
			to: options.employee,
			note: options.task.slice(0, 200),
			ref: delegationId,
		}, context);

		return { ok: true, text: answer, conversationId: staff.conversationId };
	} finally {
		releaseGuard();
	}
}

/**
 * 越级校验：发起派活的会话是不是「别的项目」的项目负责人。
 *
 * 规则只有一条：项目负责人只能指挥自己项目的人。
 * 管理层（CEO/CTO/CHRO…）不受限——他们的会话不在项目索引里。
 * 员工没有派活工具，走不到这里。
 *
 * 注意：真实事故里 CTO 直接给项目员工派活、项目负责人全程 0 token，
 * 提示词里写「让项目负责人去派」挡不住模型，所以要在这里硬拦。
 */
async function checkLeaderScope(
	runtime: CompanyRuntime,
	options: DelegateOptions,
	state: { readonly projects: Record<string, { readonly slug: string; readonly leader: number }> } | undefined,
	context: Context,
): Promise<DelegateResult | undefined> {
	if (state === undefined) return undefined;

	// 发起方是否某个项目的负责人？
	let leaderOf: string | undefined;
	for (const project of Object.values(state.projects)) {
		if (project.leader === options.fromConversationId) {
			leaderOf = project.slug;
			break;
		}
	}
	if (leaderOf === undefined || leaderOf === options.project) return undefined;

	const owner = Object.values(state.projects).find((project) => project.slug === options.project);
	return {
		ok: false,
		text: [
			`不能跨项目派活：你是项目「${leaderOf}」的负责人，${options.employee} 属于项目「${options.project}」`,
			owner === undefined ? "" : `（该项目负责人会话 ${owner.leader}）`,
			"要跨项目调配人手，请找 CHRO：delegate_to_role(chro)。",
		]
			.filter((line) => line !== "")
			.join(""),
		reason: "cross-project",
	};
}

/**
 * 推导下一次派活的标识。
 *
 * 依据：该员工会话里已投递的用户输入条数。用它做序号，
 * 使「同一员工的第 n 次派活」有稳定且唯一的标识。
 */
async function nextDelegationId(runtime: CompanyRuntime, key: string, context: Context): Promise<string> {
	const state = await runtime.harness.snapshot(CompanyDoc, context);
	const staff = state?.staff[key];
	if (staff === undefined) return `${key}/0`;

	const conversation = await runtime.harness.conversation(staff.conversationId as never, context);
	const entries = await conversation?.entries({ order: "ascending" }, 1000, undefined, context);
	// 派活现在写成 app.delegate 条目而不是 pi.user；两种都要算，否则序号不变，
	// 同一员工的第二次派活会被请求标识去重成第一次的提交。
	const delivered =
		entries?.items.filter((entry) => entry.kind === "pi.user" || entry.kind === "app.delegate").length ?? 0;
	return `${key}/${delivered}`;
}

/**
 * 检查这次派活的失败信号。
 *
 * 三种情况都算「活没干成」，不能当作成功答复回报：
 * 1. 最近一条工具结果是错误
 * 2. 这次 run 里有工具报「参数无效」（模型想调但参数没生成出来）
 * 3. 这次 run 的助手消息以 `length` 结束（输出被截断，任务没做完）
 */
async function detectRunFailure(
	runtime: CompanyRuntime,
	conversationId: number,
	context: Context,
): Promise<string | undefined> {
	// ① 截断：输出到上限被切断，模型的话和工具参数都可能不完整
	const truncated = await detectTruncation(runtime, conversationId, context);
	if (truncated !== undefined) return truncated;

	// ② 参数无效：模型调了工具但参数不合法，工具实际没执行
	const invalidCall = await detectInvalidCall(runtime, conversationId, context);
	if (invalidCall !== undefined) return invalidCall;

	// ③ 工具报错
	return detectToolFailure(runtime, conversationId, context);
}

/**
 * 检查最近一条工具结果是否失败。
 *
 * 只看最近一条：如果员工先失败又自己修好了，那是成功。
 */
async function detectToolFailure(
	runtime: CompanyRuntime,
	conversationId: number,
	context: Context,
): Promise<string | undefined> {
	const conversation = await runtime.harness.conversation(conversationId as never, context);
	const page = await conversation?.entries({ order: "descending" }, 20, undefined, context);
	const last = page?.items.find((entry) => entry.kind === "pi.tool-result");
	if (last === undefined) return undefined;

	const message = last.model?.[0] as { isError?: boolean; content?: unknown } | undefined;
	if (message?.isError !== true) return undefined;

	const text = Array.isArray(message.content)
		? message.content
				.flatMap((part) => {
					const record = part as { type?: string; text?: string };
					return record.type === "text" && record.text !== undefined ? [record.text] : [];
				})
				.join("")
		: "";
	return text.replace(/<\/?harness>/g, "").trim().slice(0, 200);
}

/** 检查最近一条助手消息是否因长度被截断。 */
async function detectTruncation(
	runtime: CompanyRuntime,
	conversationId: number,
	context: Context,
): Promise<string | undefined> {
	const conversation = await runtime.harness.conversation(conversationId as never, context);
	const page = await conversation?.entries({ order: "descending" }, 10, undefined, context);
	const lastAssistant = page?.items.find((entry) => entry.kind === "pi.assistant");
	const message = lastAssistant?.model?.[0] as { stopReason?: string } | undefined;
	if (message?.stopReason !== "length") return undefined;
	return "输出达到长度上限被截断，任务可能没做完";
}

/** 检查最近一条工具结果是否是「参数无效」。 */
async function detectInvalidCall(
	runtime: CompanyRuntime,
	conversationId: number,
	context: Context,
): Promise<string | undefined> {
	const conversation = await runtime.harness.conversation(conversationId as never, context);
	const page = await conversation?.entries({ order: "descending" }, 10, undefined, context);
	const last = page?.items.find((entry) => entry.kind === "pi.tool-result");
	if (last === undefined) return undefined;

	const message = last.model?.[0] as { content?: unknown } | undefined;
	const text = Array.isArray(message?.content)
		? message.content
				.flatMap((part) => {
					const record = part as { type?: string; text?: string };
					return record.type === "text" && record.text !== undefined ? [record.text] : [];
				})
				.join("")
		: "";
	if (/invalid|参数|required|must have/i.test(text) && /tool/i.test(text)) {
		return "模型调用了工具但参数不合法，工具没有真正执行";
	}
	return undefined;
}

/**
async function detectToolFailure(
	runtime: CompanyRuntime,
	conversationId: number,
	context: Context = BACKGROUND_CONTEXT,
): Promise<string | undefined> {
	const conversation = await runtime.harness.conversation(conversationId as never, context);
	const page = await conversation?.entries({ order: "descending" }, 20, undefined, context);
	const last = page?.items.find((entry) => entry.kind === "pi.tool-result");
	if (last === undefined) return undefined;

	const message = last.model?.[0] as { isError?: boolean; content?: unknown } | undefined;
	if (message?.isError !== true) return undefined;

	const text = Array.isArray(message.content)
		? message.content.flatMap((part) => {
				const record = part as { type?: string; text?: string };
				return record.type === "text" && record.text !== undefined ? [record.text] : [];
			}).join("")
		: "";
	// 去掉 harness 包装，留可读内容
	return text.replace(/<\/?harness>/g, "").trim().slice(0, 200);
}

/**
 * 员工当前是否忙碌。
 *
 * 注意：这里**不再**把「waiting」一律算作忙。真实事故里，员工那轮的工具报错后
 * `pi.generation` 停在 `waiting(on:[已结束的 toolId])`，于是这个函数永远返回 true，
 * 后续派活全部被判定「员工在忙」而排队，界面也永远显示「正在忙」。
 *
 * 现在走统一的存活判定（`inspectLivenessFrom`）：等的东西已经全部结束的 waiting
 * 是**僵住**，不算忙；它由看门狗负责收尾。
 */
export async function isEmployeeBusy(
	runtime: CompanyRuntime,
	staff: StaffEntry,
	context: Context = BACKGROUND_CONTEXT,
): Promise<boolean> {
	const inspection = await runtime.harness.inspect(context);
	return isConversationBusy(inspectLivenessFrom(inspection), staff.conversationId);
}

/** 列出项目员工及其忙碌状态。 */
export async function describeStaff(
	runtime: CompanyRuntime,
	staff: readonly StaffEntry[],
	context: Context = BACKGROUND_CONTEXT,
): Promise<Array<StaffEntry & { readonly busy: boolean; readonly managerLabel: string }>> {
	const result = [];
	for (const person of staff) {
		result.push({
			...person,
			busy: await isEmployeeBusy(runtime, person, context),
			managerLabel: ROLE_LABELS[person.manager],
		});
	}
	return result;
}

// ── 内部 ────────────────────────────────────────────────────────────────────

/** 从提交的答复里读出助手文本。 */
async function readAnswer(
	runtime: CompanyRuntime,
	answerEntryId: unknown,
	context: Context = BACKGROUND_CONTEXT,
): Promise<string> {
	if (answerEntryId === undefined) return "（员工未给出内容）";
	const entry = await runtime.harness.commit(
		(tx) => tx.entry({ kind: "pi.assistant", is: () => true } as never, answerEntryId as never),
		context,
	);
	const message = (entry as { model?: readonly { content?: readonly { type: string; text?: string }[] }[] })?.model?.[0];
	const text = message?.content?.flatMap((part) => (part.type === "text" && part.text !== undefined ? [part.text] : [])).join("");
	return text !== undefined && text !== "" ? text : "（员工未给出文本内容）";
}

/** 追加一条审计事件到指定会话。 */
async function appendAudit(
	runtime: CompanyRuntime,
	conversationId: number,
	event: {
		at: number;
		type: "delegate";
		from: string;
		to: string;
		note: string;
		ref: string;
	},
	context: Context = BACKGROUND_CONTEXT,
): Promise<void> {
	await runtime.harness.commit(async (tx) => {
		const audit = await tx.doc(AuditDoc, conversationId as never);
		audit.events.push(event);
	}, context);
}
