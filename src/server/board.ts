/**
 * 任务看板：把「谁在干什么」整理成三列。
 *
 * 数据全部从现有运行时推导，不建新表（任务看板是视图，不是新状态）：
 * - doing：忙碌会话 + 它最近在做的一句话（activity）
 * - todo：待决项（等拍板）+ 已提交但还在排队的消息
 * - done：最近 24 小时内完成的一轮助手回复
 *
 * 前端按 conversationId 跳转，`href` 只是顺手给出的 hash 路由
 * （`#/c/<conversationId>`），不参与数据判断。
 */
import {
	BACKGROUND_CONTEXT,
	InboxDoc,
	type CompanyRuntime,
	type Context,
} from "../runtime/index.ts";
import { listPending } from "../company/escalation.ts";
import { buildOrgView, type ActorView } from "./org-view.ts";

/** 看板列标识（前端按这个顺序渲染）。 */
export type BoardColumnId = "doing" | "todo" | "done";

/** 一条看板卡片的状态。 */
export type BoardItemStatus = "busy" | "waiting" | "queued" | "idle" | "done";

/** 看板卡片。 */
export type BoardItem = {
	readonly id: string;
	readonly title: string;
	readonly project?: string;
	readonly projectName?: string;
	/** 负责人会话标识；前端以它为准。 */
	readonly owner?: number;
	readonly ownerLabel: string;
	readonly status: BoardItemStatus;
	readonly conversationId: number;
	/** hash 路由（`#/c/<id>`），纯便利字段。 */
	readonly href?: string;
	readonly at?: number;
};

/** 一列。 */
export type BoardColumn = {
	readonly id: BoardColumnId;
	readonly title: string;
	readonly items: readonly BoardItem[];
};

/** 看板视图。 */
export type BoardView = {
	readonly generatedAt: number;
	readonly columns: readonly BoardColumn[];
};

/** done 列最多几张卡（避免把历史全铺开）。 */
const DONE_LIMIT = 8;
/** 卡片标题上限：待决问题可能很长，看板只显示一行摘要。 */
const TITLE_LIMIT = 200;
/** done 只收最近 24 小时的完成项。 */
const DONE_WINDOW_MS = 24 * 60 * 60 * 1000;

/** 构建看板视图。 */
export async function buildBoardView(
	runtime: CompanyRuntime,
	context: Context = BACKGROUND_CONTEXT,
): Promise<BoardView> {
	const org = await buildOrgView(runtime, context);
	const pending = await listPending(runtime, context);

	const nodes: ActorView[] = [
		org.ceo,
		...org.roles,
		...org.projects.flatMap((project) => [project.lead, ...project.staff]),
	];
	const nodeByConversation = new Map(nodes.map((node) => [node.conversationId, node]));
	const projectNames = new Map(org.projects.map((project) => [project.slug, project.name]));

	const hrefOf = (conversationId: number): string => `#/c/${conversationId}`;

	/** 组一张卡：项目名能补就补，可选字段缺省就不写。 */
	const card = (input: {
		readonly id: string;
		readonly title: string;
		readonly project?: string;
		readonly owner?: number;
		readonly ownerLabel: string;
		readonly status: BoardItemStatus;
		readonly conversationId: number;
		readonly at?: number;
	}): BoardItem => {
		const projectName = input.project === undefined ? undefined : projectNames.get(input.project);
		return {
			id: input.id,
			title: input.title,
			...(input.project === undefined ? {} : { project: input.project }),
			...(projectName === undefined ? {} : { projectName }),
			...(input.owner === undefined ? {} : { owner: input.owner }),
			ownerLabel: input.ownerLabel,
			status: input.status,
			conversationId: input.conversationId,
			href: hrefOf(input.conversationId),
			...(input.at === undefined ? {} : { at: input.at }),
		};
	};

	// ── doing：正在忙的人 ──
	const doing: BoardItem[] = nodes
		.filter((node) => node.status === "busy")
		.map((node) =>
			card({
				id: `doing-${node.conversationId}`,
				title: node.activity === "" ? "正在处理任务" : node.activity,
				...(node.project === undefined ? {} : { project: node.project }),
				owner: node.conversationId,
				ownerLabel: node.label,
				status: "busy",
				conversationId: node.conversationId,
			}),
		);

	// ── todo（一）：等拍板的待决项 ──
	const todo: BoardItem[] = pending.map((item) => {
		const node = nodeByConversation.get(item.fromConversationId);
		const project = item.project ?? node?.project;
		return card({
			id: `pending-${item.key}`,
			title: truncate(item.question),
			...(project === undefined ? {} : { project }),
			owner: item.fromConversationId,
			// 待决项的 from 是「谁在等」，比组织索引更准
			ownerLabel: item.from === "" ? (node?.label ?? "系统") : item.from,
			status: "waiting",
			conversationId: item.fromConversationId,
			at: item.askedAt,
		});
	});

	// ── todo（二）：已经提交、还在排队的消息 ──
	//
	// 一次 `Promise.all` 取完，不再在 for 里逐个 await：
	// 看板每次刷新都要遍历全部会话，串行快照的耗时是 O(人数) 次往返。
	const inboxes = await Promise.all(
		nodes.map(
			async (node) =>
				[
					node,
					(await runtime.harness.snapshot(InboxDoc, node.conversationId as never, context)) as
						| { items?: readonly { id: unknown; mode: string; content: unknown }[] }
						| undefined,
				] as const,
		),
	);
	for (const [node, inbox] of inboxes) {
		for (const item of inbox?.items ?? []) {
			if (item.mode === "write") continue;
			const text = queueText(item.content);
			if (text === "") continue;
			todo.push(
				card({
					id: `queued-${node.conversationId}-${String(item.id)}`,
					title: truncate(text),
					...(node.project === undefined ? {} : { project: node.project }),
					owner: node.conversationId,
					ownerLabel: node.label,
					status: "queued",
					conversationId: node.conversationId,
				}),
			);
		}
	}

	// ── done：最近完成的一轮回复 ──
	const now = Date.now();
	const done: BoardItem[] = [];
	for (const node of nodes) {
		if (node.status === "busy") continue;
		const recent = await lastAssistantReply(runtime, node.conversationId, context);
		if (recent === undefined) continue;
		if (recent.at !== undefined && now - recent.at > DONE_WINDOW_MS) continue;
		done.push(
			card({
				id: `done-${node.conversationId}`,
				title: recent.text,
				...(node.project === undefined ? {} : { project: node.project }),
				owner: node.conversationId,
				ownerLabel: node.label,
				status: "done",
				conversationId: node.conversationId,
				...(recent.at === undefined ? {} : { at: recent.at }),
			}),
		);
	}
	done.sort((left, right) => (right.at ?? 0) - (left.at ?? 0));

	return {
		generatedAt: now,
		columns: [
			{ id: "doing", title: "进行中", items: doing },
			{ id: "todo", title: "待办", items: todo },
			{ id: "done", title: "最近完成", items: done.slice(0, DONE_LIMIT) },
		],
	};
}

/** 某会话最近一条有正文的助手回复（含时间戳）。 */
async function lastAssistantReply(
	runtime: CompanyRuntime,
	conversationId: number,
	context: Context,
): Promise<{ readonly text: string; readonly at?: number } | undefined> {
	const conversation = await runtime.harness.conversation(conversationId as never, context);
	const page = await conversation?.entries({ order: "descending" }, 20, undefined, context);
	for (const entry of page?.items ?? []) {
		if (entry.kind !== "pi.assistant") continue;
		const message = entry.model?.[0] as
			| { readonly content?: readonly { readonly type?: string; readonly text?: string }[]; readonly timestamp?: number }
			| undefined;
		const text = (message?.content ?? [])
			.flatMap((part) => (part.type === "text" && part.text !== undefined && part.text !== "" ? [part.text] : []))
			.join("")
			.trim();
		if (text === "") continue;
		const firstLine = text.split("\n").find((line) => line.trim() !== "") ?? "";
		return {
			text: firstLine.replace(/^#+\s*/, "").slice(0, 80),
			...(message?.timestamp === undefined ? {} : { at: message.timestamp }),
		};
	}
	return undefined;
}

/** 标题截断：只留第一行，超长加省略号。 */
function truncate(value: string): string {
	const firstLine = value.split("\n").find((line) => line.trim() !== "") ?? value;
	const text = firstLine.trim();
	return text.length > TITLE_LIMIT ? `${text.slice(0, TITLE_LIMIT)}…` : text;
}

/** 从排队项内容里取文本（与 feed 的 queued 展示保持一致）。 */
function queueText(content: unknown): string {
	if (typeof content === "string") return content.trim();
	if (Array.isArray(content)) {
		return content
			.flatMap((part) => {
				if (typeof part === "string") return [part];
				if (typeof part !== "object" || part === null) return [];
				const record = part as { readonly type?: string; readonly text?: string };
				return record.type === "text" && record.text !== undefined ? [record.text] : [];
			})
			.join("")
			.trim();
	}
	if (typeof content === "object" && content !== null) {
		const record = content as { readonly text?: string; readonly content?: unknown };
		if (record.text !== undefined) return record.text.trim();
		if (record.content !== undefined) return queueText(record.content);
	}
	return "";
}
