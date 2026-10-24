/**
 * 会话流：把已提交的会话状态转成界面能直接渲染的条目。
 *
 * 这是 Web UI 的唯一数据源。设计原则：
 * - 只读已提交状态（符合底层「只有已提交状态可观察」的保证）
 * - 每条条目自带类型与时间，界面不需要理解底层结构
 * - 思考、工具调用、工具输出分开呈现，让老板看得见「它在干什么」
 * - **每条消息都能回答「这是谁说的」**（契约第 3 节）：
 *   user 条目带 `from`，assistant/thinking/tool 的发言人由 `Feed.actor` 统一给出。
 */
import {
	BACKGROUND_CONTEXT,
	inspectLiveness,
	isConversationBusy,
	type CompanyRuntime,
	type Context,
} from "../runtime/index.ts";
import { CompanyDoc, ROLE_LABELS, type CompanyState, type ManagementRole } from "../company/docs.ts";
import { listPending } from "../company/escalation.ts";
import { ROLE_DEFINITIONS } from "../company/roles.ts";
import { actorRefOf, OWNER_REF, refOfLabel, type ActorRef } from "./actors.ts";

/** 一个发言人（契约第 3 节）。 */
export type { ActorRef } from "./actors.ts";

/** 流里的一条内容。 */
export type FeedItem =
	/** 老板或别的 agent 说的话。`from` 说明是谁说的。 */
	| {
			readonly id: number;
			readonly kind: "user";
			readonly text: string;
			readonly at: number;
			/** 谁说的：老板自己 → {label:"老板",kind:"owner"}；派活 → 派活方。 */
			readonly from: ActorRef;
	  }
	/** 角色的回复正文。发言人见 {@link Feed.actor}。 */
	| { readonly id: number; readonly kind: "assistant"; readonly text: string; readonly at: number }
	/** 思考过程（模型有 reasoning 能力时才有）。发言人见 {@link Feed.actor}。 */
	| { readonly id: number; readonly kind: "thinking"; readonly text: string; readonly at: number }
	/** 工具调用与它的结果。发言人见 {@link Feed.actor}。 */
	| {
			readonly id: number;
			readonly kind: "tool";
			readonly name: string;
			/** 参数摘要，一行。 */
			readonly args: string;
			/** 结果正文；未完成时为空。 */
			readonly output: string;
			/** running：正在执行；interrupted：中断后再也没拿到结果。 */
			readonly state: "running" | "ok" | "error" | "interrupted";
			/** 输出过长时折叠。 */
			readonly collapsible: boolean;
			/** 底层工具调用 ID，用于和实时状态对齐。 */
			readonly callId?: string;
			readonly at: number;
	  }
	/** 系统留痕（派活、回报、升级等）。`from`/`to` 说明谁对谁做。 */
	| {
			readonly id: number;
			readonly kind: "note";
			readonly text: string;
			readonly at: number;
			readonly from?: ActorRef;
			readonly to?: ActorRef;
	  }
	/** 一次运行失败或被截断。 */
	| {
			readonly id: number;
			readonly kind: "alert";
			readonly text: string;
			readonly at: number;
			/** 谁报的警（看门狗等）；没有就是系统。 */
			readonly from?: ActorRef;
	  };

/** 会话流的完整视图。 */
export type Feed = {
	readonly conversationId: number;
	readonly title: string;
	readonly role: string;
	/**
	 * 这个会话的主人：assistant / thinking / tool 的发言人。
	 *
	 * 老板通道里它是 CEO，员工会话里是那位员工——界面不用再猜。
	 */
	readonly actor: ActorRef;
	/** 已提交的条目，按时间正序。 */
	readonly items: readonly FeedItem[];
	/** 正在生成的内容（未提交的部分）。 */
	readonly streaming?: string;
	/** 正在思考的内容。 */
	readonly thinking?: string;
	/** 正在运行的工具。 */
	readonly running: readonly { readonly name: string; readonly args: string }[];
	/** 是否正在忙。 */
	readonly busy: boolean;
	/** 已提交但还在排队、尚未进入对话的消息。 */
	readonly queued: readonly {
		readonly id: number;
		readonly text: string;
		readonly mode: "steer" | "followUp";
		/** owner：老板自己发的；agent：别的 agent 派来的任务。 */
		readonly origin: "owner" | "agent";
		/** agent 来源时，是谁派来的。 */
		readonly from?: string;
	}[];
	/** 该会话的用量。 */
	readonly tokens: number;
	/** 会话种类：老板通道 / 管理层 / 项目 / 员工。 */
	readonly kind: "owner" | "role" | "project" | "staff" | "branch";
	/** 是否在等老板拍板。 */
	readonly awaitingOwner: boolean;
};

/** 读取一条会话的完整流。 */
export async function readFeed(
	runtime: CompanyRuntime,
	conversationId: number,
	options: { readonly limit?: number; readonly state?: CompanyState } = {},
	context: Context = BACKGROUND_CONTEXT,
): Promise<Feed | undefined> {
	const conversation = await runtime.harness.conversation(conversationId as never, context);
	if (conversation === undefined) return undefined;

	// 组织索引：用来把「派活方」「留痕双方」解析成人，一次读，feed 与档案共用
	const state = options.state ?? (await runtime.harness.snapshot(CompanyDoc, context));

	const limit = options.limit ?? 400;
	const page = await conversation.entries({ order: "ascending" }, limit, undefined, context);

	// 已提交的工具调用：用来给实时卡片补参数、判断哪些调用真的拿到了结果
	const committed = collectCommittedTools(page.items);
	const items = buildItems(page.items, state);

	// 实时状态：正在生成、正在思考、正在跑的工具
	const view = await conversation.watch(context);
	const live = view.value.docs["pi.live"] as LiveShape | undefined;
	await view.stop();

	const streaming = collectLiveText(live, "text");
	const thinking = collectLiveText(live, "thinking");

	// pi.live 只存 callId / name / taskId / status，不存参数。
	// 已经提交过的调用交给 buildItems 的卡片展示，避免同一调用出现两张卡片；
	// 其余实时调用从已提交的 assistant 工具参数里回填，不再显示「（无参数）」。
	// pi.live 的 tools 以内部键索引，优先用值里的 callId 对齐已提交调用
	const liveEntries = Object.entries(live?.tools ?? {}).map(
		([key, tool]) => [tool.callId ?? key, tool] as const,
	);
	const liveCallIds = new Set(liveEntries.map(([callId]) => callId));
	const running = liveEntries
		.filter(([callId]) => !committed.has(callId))
		.map(([callId, tool]) => ({
			name: tool.name ?? callId,
			args: summarize(tool.args ?? tool.details ?? committed.get(callId)?.arguments ?? ""),
		}));

	// 是否真的在忙：不能只看有没有流式文本——模型思考阶段没有正文，
	// 但确实在跑。以存活判定为准（僵住的 waiting 不算忙，见契约 §5.3），
	// 再用流式内容兜底。
	const liveness = await inspectLiveness(runtime, {}, context);
	const hasLiveTask = isConversationBusy(liveness, conversationId);

	// 中断过的工具调用：assistant 里提交了 toolCall，但永远没有 tool-result，
	// 也没有实时工具在跑。以前它会永远显示「运行中 / 等待输出…」。
	if (!hasLiveTask && running.length === 0) {
		for (let index = 0; index < items.length; index += 1) {
			const item = items[index];
			if (item?.kind !== "tool" || item.state !== "running" || item.callId === undefined) continue;
			if (liveCallIds.has(item.callId)) continue;
			if (committed.get(item.callId)?.hasResult === true) continue;
			items[index] = {
				...item,
				state: "interrupted",
				output: "（已中断：这次工具调用没有返回结果）",
			};
		}
	}

	// 排队的消息：已经提交但还没进入对话。
	// 不显示的话，老板会以为「消息没发出去」——它其实在等当前这轮结束。
	const inbox = await runtime.harness.snapshot(await inboxToken(), conversationId as never, context);
	const queued = (inbox?.items ?? []).flatMap((item) => {
		if (item.mode === "write") return [];
		const text = inboxText(item.content);
		if (text === "") return [];
		// 别的 agent 派来的任务会带 app.delegate 标记；老板自己发的没有 entry。
		// 不区分的话，员工会话里的派活会显示成「你的排队消息 / 立即处理」。
		const entry = item.entry as
			| { readonly kind?: string; readonly data?: { readonly from?: string } }
			| undefined;
		const delegated = entry?.kind === "app.delegate";
		return [
			{
				id: Number(item.id),
				text,
				mode: item.mode,
				origin: delegated ? ("agent" as const) : ("owner" as const),
				...(delegated ? { from: entry?.data?.from ?? "协作方" } : {}),
			},
		];
	});

	const usage = await runtime.harness.snapshot(await usageToken(), conversationId as never, context);
	const tokens = Object.values((usage as { models?: Record<string, { totalTokens?: number }> } | undefined)?.models ?? {}).reduce(
		(total, model) => total + (model.totalTokens ?? 0),
		0,
	);

	return {
		conversationId,
		title: "",
		role: "",
		// 先按组织索引给一个发言人；decorateFeed 会按会话种类再校正一次
		actor: actorRefOf(state, conversationId) ?? { label: "", kind: "system" },
		items,
		...(streaming === "" ? {} : { streaming }),
		...(thinking === "" ? {} : { thinking }),
		running,
		queued,
		busy: hasLiveTask || streaming !== "" || thinking !== "" || running.length > 0,
		tokens,
		kind: "branch",
		awaitingOwner: false,
	};
}

/**
 * 给 feed 补上标题、角色、种类、发言人、待拍板状态。
 *
 * 从 http.ts 移到 feed.ts：发言人（`actor`）与条目里的 `from`/`to` 必须用
 * 同一套口径解析，分在两个文件里早晚会不一致。
 */
export async function decorateFeed(
	runtime: CompanyRuntime,
	feed: Feed,
	context: Context = BACKGROUND_CONTEXT,
): Promise<Feed> {
	const state = await runtime.harness.snapshot(CompanyDoc, context);
	const pending = await listPending(runtime, context);
	// 只有 owner 级的问题才是「等老板拍板」；CEO 自己队列里的问题不算。
	const awaitingOwner = pending.some(
		(item) => item.level === "owner" && item.fromConversationId === feed.conversationId,
	);

	let title = "会话";
	let kind: Feed["kind"] = "branch";
	let role = "";
	let actor: ActorRef = { label: "", kind: "system" };

	const roleEntry = Object.entries(state?.roles ?? {}).find(([, id]) => id === feed.conversationId);
	if (roleEntry !== undefined) {
		const roleKey = roleEntry[0] as ManagementRole;
		title = ROLE_LABELS[roleKey] ?? roleKey.toUpperCase();
		kind = roleKey === "ceo" ? "owner" : "role";
		role =
			roleKey === "ceo"
				? "唯一真人 · 直接向你汇报"
				: `${ROLE_DEFINITIONS[roleKey]?.summary ?? ""} · 向 CEO 汇报`;
		// CEO 通道的助手是 CEO；其他岗位就是它自己
		actor = { conversationId: feed.conversationId, label: title, kind: roleKey === "ceo" ? "owner" : "role" };
	}

	for (const project of Object.values(state?.projects ?? {})) {
		if (project.leader === feed.conversationId) {
			title = project.name;
			kind = "project";
			role = "项目负责人";
			actor = {
				conversationId: feed.conversationId,
				label: project.leaderName ?? project.name,
				kind: "project",
			};
		}
	}
	for (const staff of Object.values(state?.staff ?? {})) {
		if (staff.conversationId === feed.conversationId) {
			title = staff.name;
			kind = "staff";
			role = `${staff.role} · ${staff.project} 项目 · 向 ${ROLE_LABELS[staff.manager]} 汇报`;
			actor = { conversationId: feed.conversationId, label: staff.name, kind: "staff" };
		}
	}

	return { ...feed, title, kind, role, actor, awaitingOwner };
}

/** 底层 pi.live 的结构（只声明用到的字段）。 */
type LiveShape = {
	readonly generation?: {
		readonly partial?: { readonly content?: readonly { readonly type: string; readonly text?: string; readonly thinking?: string }[] };
	};
	readonly tools?: Record<
		string,
		{
			readonly name?: string;
			readonly callId?: string;
			readonly status?: string;
			readonly args?: unknown;
			readonly details?: unknown;
		}
	>;
};

/** 已提交的工具调用：参数 + 是否已有结果。 */
type CommittedTool = {
	readonly arguments: unknown;
	readonly hasResult: boolean;
};

/** 扫描已提交条目，整理出 callId → 工具调用信息。 */
function collectCommittedTools(
	entries: readonly {
		readonly kind: string;
		readonly model?: readonly unknown[];
	}[],
): Map<string, CommittedTool> {
	const calls = new Map<string, { arguments: unknown; hasResult: boolean }>();

	for (const entry of entries) {
		if (entry.kind === "pi.assistant") {
			const message = entry.model?.[0] as
				| { readonly content?: readonly { readonly type: string; readonly id?: string; readonly arguments?: unknown }[] }
				| undefined;
			for (const part of message?.content ?? []) {
				if (part.type !== "toolCall" || part.id === undefined) continue;
				calls.set(part.id, { arguments: part.arguments, hasResult: false });
			}
		} else if (entry.kind === "pi.tool-result") {
			const message = entry.model?.[0] as { readonly toolCallId?: string } | undefined;
			const existing = message?.toolCallId === undefined ? undefined : calls.get(message.toolCallId);
			if (existing !== undefined) existing.hasResult = true;
		}
	}

	return calls;
}

/** 从实时生成里取某类文本。 */
function collectLiveText(live: LiveShape | undefined, type: "text" | "thinking"): string {
	const parts = live?.generation?.partial?.content ?? [];
	return parts
		.flatMap((part) => {
			if (part.type !== type) return [];
			const value = type === "text" ? part.text : part.thinking;
			return value === undefined ? [] : [value];
		})
		.join("");
}

/** 把底层条目转成界面条目。 */
function buildItems(
	entries: readonly {
		readonly id: number;
		readonly kind: string;
		readonly model?: readonly unknown[];
		readonly data?: unknown;
	}[],
	state: CompanyState | undefined,
): FeedItem[] {
	const items: FeedItem[] = [];
	// 工具调用先记下来，等它的结果到了再合并成一条
	const pendingTools = new Map<string, number>();

	for (const entry of entries) {
		switch (entry.kind) {
			case "pi.user": {
				const message = entry.model?.[0] as { content?: unknown; timestamp?: number } | undefined;
				const text = typeof message?.content === "string" ? message.content : extractText(message?.content);
				// pi.user 没有来源标记：走 HTTP 进来的只有老板（agent 派活会写成 app.delegate 条目）
				items.push({ id: entry.id, kind: "user", text, at: message?.timestamp ?? 0, from: OWNER_REF });
				break;
			}
			case "pi.assistant": {
				const message = entry.model?.[0] as
					| {
							readonly content?: readonly {
								readonly type: string;
								readonly text?: string;
								readonly thinking?: string;
								readonly name?: string;
								readonly id?: string;
								readonly arguments?: unknown;
							}[];
							readonly timestamp?: number;
							readonly stopReason?: string;
					  }
					| undefined;
				const at = message?.timestamp ?? 0;

				for (const part of message?.content ?? []) {
					if (part.type === "thinking" && part.thinking !== undefined && part.thinking !== "") {
						items.push({ id: entry.id, kind: "thinking", text: part.thinking, at });
					} else if (part.type === "text" && part.text !== undefined && part.text !== "") {
						items.push({ id: entry.id, kind: "assistant", text: part.text, at });
					} else if (part.type === "toolCall" && part.name !== undefined) {
						const index = items.length;
						items.push({
							id: entry.id,
							kind: "tool",
							name: part.name,
							args: summarize(part.arguments),
							output: "",
							state: "running",
							collapsible: false,
							...(part.id === undefined ? {} : { callId: part.id }),
							at,
						});
						if (part.id !== undefined) pendingTools.set(part.id, index);
					}
				}

				// 输出被截断或出错时给出显式提示，避免「看起来做完了其实没有」
				if (message?.stopReason === "length") {
					items.push({ id: entry.id, kind: "alert", text: "输出达到长度上限被截断，这一轮可能没做完", at });
				} else if (message?.stopReason === "error") {
					items.push({ id: entry.id, kind: "alert", text: "模型调用出错", at });
				} else if (message?.stopReason === "aborted") {
					items.push({ id: entry.id, kind: "alert", text: "已停止", at });
				}
				break;
			}
			case "pi.tool-result": {
				const message = entry.model?.[0] as
					| {
							readonly content?: unknown;
							readonly toolName?: string;
							readonly toolCallId?: string;
							readonly isError?: boolean;
							readonly timestamp?: number;
					  }
					| undefined;
				const text = extractText(message?.content);
				const index = message?.toolCallId === undefined ? undefined : pendingTools.get(message.toolCallId);
				const target = index === undefined ? undefined : items[index];

				if (target !== undefined && target.kind === "tool") {
					// 合并到已有的工具条目上
					items[index as number] = {
						...target,
						output: text,
						state: message?.isError === true ? "error" : "ok",
						collapsible: text.length > 240 || text.split("\n").length > 6,
					};
				} else {
					items.push({
						id: entry.id,
						kind: "tool",
						name: message?.toolName ?? "工具",
						args: "",
						output: text,
						state: message?.isError === true ? "error" : "ok",
						collapsible: text.length > 240,
						at: message?.timestamp ?? 0,
					});
				}
				break;
			}
			case "pi.reset":
				items.push({ id: entry.id, kind: "note", text: "对话上下文已重置", at: 0 });
				break;
			case "pi.compaction":
				items.push({ id: entry.id, kind: "note", text: "较早的对话已被压缩以节省上下文", at: 0 });
				break;
			// 看门狗写的告警（backend-core）：会话内 app.alert 条目
			case "app.alert": {
				const data = entry.data as
					| { readonly text?: string; readonly message?: string; readonly from?: string }
					| undefined;
				const body = (data?.text ?? data?.message ?? "").trim();
				if (body === "") break;
				items.push({
					id: entry.id,
					kind: "alert",
					text: data?.from === undefined ? body : `${data.from}：${body}`,
					at: 0,
					...(data?.from === undefined ? {} : { from: refOfLabel(state, data.from) }),
				});
				break;
			}
			default: {
				// 自定义条目：沟通留痕（派活 / 回报 / 升级 / 决定）
				const data = entry.data as
					| { readonly from?: string; readonly to?: string; readonly kind?: string; readonly text?: string }
					| undefined;
				if (data !== undefined && typeof data === "object" && data.from !== undefined) {
					const verb = verbOf(entry.kind, data.kind);
					const from = refOfLabel(state, data.from);
					const to = data.to === undefined ? undefined : refOfLabel(state, data.to);
					// from/to 已经由界面渲染成 chip，正文里不再重复「谁 → 谁」
					const body = data.text ?? "";
					items.push({
						id: entry.id,
						kind: "note",
						text: body === "" ? verb : verb === "" ? body : `${verb}：${body}`,
						at: 0,
						from,
						...(to === undefined ? {} : { to }),
					});
				}
				break;
			}
		}
	}

	return items;
}

/** 留痕动词：条目种类优先，其次是 data.kind。 */
function verbOf(entryKind: string, dataKind: string | undefined): string {
	const kind = dataKind ?? entryKind;
	if (kind === "app.delegate" || kind === "delegate") return "派活";
	if (kind === "report") return "回报";
	if (kind === "escalate") return "升级";
	if (kind === "decide") return "决定";
	if (kind === "hire") return "招聘";
	if (kind === "archive") return "归档";
	return "";
}

/** 从内容块抽文本。 */
function extractText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.flatMap((part) => {
			if (typeof part !== "object" || part === null) return [];
			const record = part as { readonly type?: string; readonly text?: string };
			return record.type === "text" && record.text !== undefined ? [record.text] : [];
		})
		.join("");
}

/** 把参数压成一行摘要。 */
function summarize(value: unknown): string {
	if (value === undefined || value === null) return "";
	if (typeof value === "string") return value.replace(/\s+/g, " ").slice(0, 160);

	try {
		const json = JSON.stringify(value);
		if (json === undefined) return "";
		return json.replace(/\s+/g, " ").slice(0, 160);
	} catch {
		return String(value).slice(0, 160);
	}
}

/** 从排队项的内容里取文本。 */
function inboxText(content: unknown): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.flatMap((part) => {
				if (typeof part === "string") return [part];
				if (typeof part !== "object" || part === null) return [];
				const record = part as { readonly type?: string; readonly text?: string };
				return record.type === "text" && record.text !== undefined ? [record.text] : [];
			})
			.join("");
	}
	if (typeof content === "object" && content !== null) {
		const record = content as { readonly text?: string };
		return record.text ?? "";
	}
	return "";
}

/** 延迟取队列文档 token，避免顶层循环依赖。 */
async function inboxToken() {
	const { InboxDoc } = await import("../runtime/inbox.ts");
	return InboxDoc;
}

/** 延迟取用量文档 token，避免顶层循环依赖。 */
async function usageToken() {
	const { UsageDoc } = await import("../runtime/usage.ts");
	return UsageDoc;
}
