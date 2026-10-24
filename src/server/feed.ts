/**
 * 会话流：把已提交的会话状态转成界面能直接渲染的条目。
 *
 * 这是 Web UI 的唯一数据源。设计原则：
 * - 只读已提交状态（符合底层「只有已提交状态可观察」的保证）
 * - 每条条目自带类型与时间，界面不需要理解底层结构
 * - 思考、工具调用、工具输出分开呈现，让老板看得见「它在干什么」
 */
import { BACKGROUND_CONTEXT, type Context } from "../runtime/index.ts";
import type { CompanyRuntime } from "../runtime/index.ts";

/** 流里的一条内容。 */
export type FeedItem =
	/** 老板说的话。 */
	| { readonly id: number; readonly kind: "user"; readonly text: string; readonly at: number }
	/** 角色的回复正文。 */
	| { readonly id: number; readonly kind: "assistant"; readonly text: string; readonly at: number }
	/** 思考过程（模型有 reasoning 能力时才有）。 */
	| { readonly id: number; readonly kind: "thinking"; readonly text: string; readonly at: number }
	/** 工具调用与它的结果。 */
	| {
			readonly id: number;
			readonly kind: "tool";
			readonly name: string;
			/** 参数摘要，一行。 */
			readonly args: string;
			/** 结果正文；未完成时为空。 */
			readonly output: string;
			readonly state: "running" | "ok" | "error";
			/** 输出过长时折叠。 */
			readonly collapsible: boolean;
			readonly at: number;
	  }
	/** 系统留痕（派活、回报、升级等）。 */
	| { readonly id: number; readonly kind: "note"; readonly text: string; readonly at: number }
	/** 一次运行失败或被截断。 */
	| { readonly id: number; readonly kind: "alert"; readonly text: string; readonly at: number };

/** 会话流的完整视图。 */
export type Feed = {
	readonly conversationId: number;
	readonly title: string;
	readonly role: string;
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
	options: { readonly limit?: number } = {},
	context: Context = BACKGROUND_CONTEXT,
): Promise<Feed | undefined> {
	const conversation = await runtime.harness.conversation(conversationId as never, context);
	if (conversation === undefined) return undefined;

	const limit = options.limit ?? 400;
	const page = await conversation.entries({ order: "ascending" }, limit, undefined, context);

	const items = buildItems(page.items);

	// 实时状态：正在生成、正在思考、正在跑的工龄
	const view = await conversation.watch(context);
	const live = view.value.docs["pi.live"] as LiveShape | undefined;
	await view.stop();

	const streaming = collectLiveText(live, "text");
	const thinking = collectLiveText(live, "thinking");
	const running = Object.entries(live?.tools ?? {}).map(([name, tool]) => ({
		name: tool.name ?? name,
		args: summarize(tool.args ?? tool.details ?? ""),
	}));

	// 是否真的在忙：不能只看有没有流式文本——模型思考阶段没有正文，
	// 但确实在跑。以任务状态为准，再看流式内容兜底。
	const inspection = await runtime.harness.inspect(context);
	const hasLiveTask = inspection.tasks.some(
		(task) =>
			Number(task.record.conversationId) === conversationId &&
			(task.state.kind === "running" || task.state.kind === "ready" || task.state.kind === "waiting"),
	);

	// 排队的消息：已经提交但还没进入对话。
	// 不显示的话，老板会以为「消息没发出去」——它其实在等当前这轮结束。
	const inbox = await runtime.harness.snapshot(await inboxToken(), conversationId as never, context);
	const queued = (inbox?.items ?? []).flatMap((item) => {
		if (item.mode === "write") return [];
		const text = inboxText(item.content);
		return text === "" ? [] : [{ id: Number(item.id), text, mode: item.mode }];
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

/** 底层 pi.live 的结构（只声明用到的字段）。 */
type LiveShape = {
	readonly generation?: {
		readonly partial?: { readonly content?: readonly { readonly type: string; readonly text?: string; readonly thinking?: string }[] };
	};
	readonly tools?: Record<string, { readonly name?: string; readonly args?: unknown; readonly details?: unknown }>;
};

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
): FeedItem[] {
	const items: FeedItem[] = [];
	// 工具调用先记下来，等它的结果到了再合并成一条
	const pendingTools = new Map<string, number>();

	for (const entry of entries) {
		switch (entry.kind) {
			case "pi.user": {
				const message = entry.model?.[0] as { content?: unknown; timestamp?: number } | undefined;
				const text = typeof message?.content === "string" ? message.content : extractText(message?.content);
				items.push({ id: entry.id, kind: "user", text, at: message?.timestamp ?? 0 });
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
			default: {
				// 自定义条目：沟通留痕
				const data = entry.data as
					| { readonly from?: string; readonly to?: string; readonly kind?: string; readonly text?: string }
					| undefined;
				if (data !== undefined && typeof data === "object" && data.from !== undefined) {
					const verb = data.kind === "delegate" ? "派活" : data.kind === "report" ? "回报" : data.kind ?? "";
					items.push({
						id: entry.id,
						kind: "note",
						text: `${verb} · ${data.from} → ${data.to}${data.text === undefined ? "" : `：${data.text}`}`,
						at: 0,
					});
				}
				break;
			}
		}
	}

	return items;
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
