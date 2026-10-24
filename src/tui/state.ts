/**
 * 界面状态：把已提交状态映射成可渲染的视图模型。
 *
 * 这一层不依赖终端，纯数据，所以可以单测。
 * 渲染层（components.ts）只负责把这里的数据画成行。
 *
 * 关键设计（ADR-008）：
 * - 订阅驱动，不轮询
 * - 切换会话必须停止旧订阅
 * - 慢消费者会丢中间帧，所以只假设「收到最新状态」
 */
import type { CompanyRuntime } from "../runtime/index.ts";
import { activeTasks, type ActiveTask } from "../company/trail.ts";
import { conversationUsage } from "../company/cost.ts";
import { listPending } from "../company/escalation.ts";
import { readCompany } from "../company/org.ts";
import { BACKGROUND_CONTEXT } from "../runtime/index.ts";

/** 组织树节点。 */
export type OrgNode = {
	readonly conversationId: number;
	readonly label: string;
	readonly kind: "owner" | "role" | "project" | "staff";
	readonly depth: number;
	/** 状态标记：忙碌 / 待决 / 空闲。 */
	readonly status: "busy" | "pending" | "idle";
	readonly project?: string;
	readonly parentId?: number;
};

/** 会话流里的一条消息。 */
export type StreamMessage = {
	readonly entryId: number;
	readonly role: "user" | "assistant" | "tool" | "system" | "note";
	readonly text: string;
	readonly at: number;
	/** 工具调用的名称与状态。 */
	readonly toolName?: string;
	readonly toolState?: "running" | "ok" | "error";
	/** 是否可折叠（大输出）。 */
	readonly collapsible?: boolean;
};

/** 会话流视图。 */
export type ConversationStream = {
	readonly conversationId: number;
	readonly title: string;
	readonly messages: readonly StreamMessage[];
	/** 正在生成的部分回答。 */
	readonly streaming?: string;
	/** 正在运行的工具。 */
	readonly runningTools: readonly { readonly name: string; readonly startedAt: number }[];
};

/** 任务面板项。 */
export type TaskPanelItem = {
	readonly label: string;
	readonly status: ActiveTask["status"];
	readonly detail?: string;
};

/** 成本条。 */
export type CostBar = {
	readonly conversationTokens: number;
	readonly projectTokens: number;
	readonly companyTokens: number;
	readonly conversationCostUsd: number;
	readonly projectCostUsd: number;
	readonly companyCostUsd: number;
};

/** 完整界面状态。 */
export type UiState = {
	readonly org: readonly OrgNode[];
	readonly selectedConversationId: number;
	readonly stream: ConversationStream;
	readonly tasks: readonly TaskPanelItem[];
	readonly pendingCount: number;
	/** 等待老板拍板的问题（只含该由老板决的）。 */
	readonly pendingQuestions: readonly {
		readonly key: string;
		readonly question: string;
		readonly level: string;
		readonly from: string;
		readonly askedAt: number;
	}[];
	readonly cost: CostBar;
	/** 分支视图的来源（若当前在分支里）。 */
	readonly branchFrom?: { readonly entryId: number; readonly label: string };
};

/**
 * 构建组织树。
 *
 * 层级：CEO（owner）→ 其他管理层（role）→ 项目（project）→ 员工（staff）
 */
export async function buildOrgTree(
	runtime: CompanyRuntime,
	input: { readonly selectedConversationId: number; readonly busyIds: ReadonlySet<number>; readonly pendingIds: ReadonlySet<number> },
): Promise<OrgNode[]> {
	const state = await readCompany(runtime);
	const nodes: OrgNode[] = [];
	if (state === undefined) return nodes;

	const statusOf = (conversationId: number): OrgNode["status"] => {
		if (input.pendingIds.has(conversationId)) return "pending";
		if (input.busyIds.has(conversationId)) return "busy";
		return "idle";
	};

	// 管理层：CEO 在最上
	const ceoId = state.roles.ceo;
	if (ceoId !== undefined) {
		nodes.push({
			conversationId: ceoId,
			label: "CEO",
			kind: "owner",
			depth: 0,
			status: statusOf(ceoId),
		});
	}

	for (const [role, conversationId] of Object.entries(state.roles)) {
		if (role === "ceo") continue;
		nodes.push({
			conversationId,
			label: role.toUpperCase(),
			kind: "role",
			depth: 1,
			status: statusOf(conversationId),
		});
	}

	// 项目与项目员工
	for (const project of Object.values(state.projects)) {
		nodes.push({
			conversationId: project.leader,
			label: project.name,
			kind: "project",
			depth: 1,
			status: statusOf(project.leader),
			project: project.slug,
		});

		for (const staff of Object.values(state.staff)) {
			if (staff.project !== project.slug || staff.archived) continue;
			nodes.push({
				conversationId: staff.conversationId,
				label: staff.name,
				kind: "staff",
				depth: 2,
				status: statusOf(staff.conversationId),
				project: project.slug,
				parentId: project.leader,
			});
		}
	}

	return nodes;
}

/** 构建任务面板。 */
export async function buildTaskPanel(runtime: CompanyRuntime): Promise<TaskPanelItem[]> {
	const tasks = await activeTasks(runtime);
	return tasks.map((task) => {
		const item: TaskPanelItem = {
			label: taskLabel(task),
			status: task.status,
		};
		if (task.waitingOn !== undefined && task.waitingOn.length > 0) {
			return { ...item, detail: `等待 ${task.waitingOn.join(", ")}` };
		}
		if (task.blockedReason !== undefined) {
			return { ...item, detail: `受阻：${task.blockedReason}` };
		}
		return item;
	});
}

/** 构建成本条。 */
export async function buildCostBar(
	runtime: CompanyRuntime,
	input: { readonly conversationId: number; readonly project?: string },
): Promise<CostBar> {
	const conversation = await conversationUsage(runtime, input.conversationId);

	let projectTokens = 0;
	let projectCostUsd = 0;
	if (input.project !== undefined) {
		const { rollupProject } = await import("../company/cost.ts");
		const rollup = await rollupProject(runtime, input.project);
		projectTokens = rollup.totalTokens;
		projectCostUsd = rollup.costUsd;
	}

	const { rollupAll } = await import("../company/cost.ts");
	const all = await rollupAll(runtime);

	return {
		conversationTokens: conversation.totalTokens,
		projectTokens,
		companyTokens: all.totalTokens,
		conversationCostUsd: conversation.costUsd,
		projectCostUsd,
		companyCostUsd: all.costUsd,
	};
}

/**
 * 构建完整界面状态。
 */
export async function buildUiState(
	runtime: CompanyRuntime,
	input: { readonly selectedConversationId: number; readonly branchFrom?: { entryId: number; label: string } },
): Promise<UiState> {
	const tasks = await buildTaskPanel(runtime);
	const pending = await listPending(runtime);

	// 忙碌的会话：有活跃任务的会话
	const inspection = await runtime.harness.inspect(BACKGROUND_CONTEXT);
	const busyIds = new Set(
		inspection.tasks
			.filter((task) => task.state.kind === "running" || task.state.kind === "ready")
			.map((task) => Number(task.record.conversationId)),
	);

	// 待决的会话：有待决问题的会话
	const pendingIds = new Set(pending.map((item) => item.fromConversationId));

	const org = await buildOrgTree(runtime, {
		selectedConversationId: input.selectedConversationId,
		busyIds,
		pendingIds,
	});

	const state = await readCompany(runtime);
	const selected = org.find((node) => node.conversationId === input.selectedConversationId);
	const project = selected?.project ?? findProjectOf(state, input.selectedConversationId);

	const stream = await buildStream(runtime, input.selectedConversationId, selected?.label ?? "会话");
	const cost = await buildCostBar(runtime, {
		conversationId: input.selectedConversationId,
		...(project === undefined ? {} : { project }),
	});

	const base = {
		org,
		selectedConversationId: input.selectedConversationId,
		stream,
		tasks,
		pendingCount: pending.length,
		pendingQuestions: pending.map((item) => ({
			key: item.key,
			question: item.question,
			level: item.level,
			from: item.from,
			askedAt: item.askedAt,
		})),
		cost,
	};

	return input.branchFrom === undefined ? base : { ...base, branchFrom: input.branchFrom };
}

/** 构建会话流。 */
export async function buildStream(
	runtime: CompanyRuntime,
	conversationId: number,
	title: string,
): Promise<ConversationStream> {
	const conversation = await runtime.harness.conversation(conversationId as never, BACKGROUND_CONTEXT);
	if (conversation === undefined) {
		return { conversationId, title, messages: [], runningTools: [] };
	}

	const page = await conversation.entries({ order: "ascending" }, 200, undefined, BACKGROUND_CONTEXT);
	const messages: StreamMessage[] = [];

	for (const entry of page.items) {
		const message = toStreamMessage(entry);
		if (message !== undefined) messages.push(message);
	}

	// 正在生成与正在运行的工具：从 pi.live 读
	const view = await conversation.watch(BACKGROUND_CONTEXT);
	const live = view.value.docs["pi.live"] as
		| {
				generation?: { partial?: { content?: readonly { type: string; text?: string }[] } };
				tools?: Record<string, { name?: string; startedAt?: number }>;
		  }
		| undefined;
	await view.stop();

	const partial = live?.generation?.partial?.content
		?.flatMap((part) => (part.type === "text" && part.text !== undefined ? [part.text] : []))
		.join("");

	const runningTools = Object.entries(live?.tools ?? {}).map(([name, tool]) => ({
		name: tool.name ?? name,
		startedAt: tool.startedAt ?? Date.now(),
	}));

	const result: ConversationStream = {
		conversationId,
		title,
		messages,
		runningTools,
	};
	return partial !== undefined && partial !== "" ? { ...result, streaming: partial } : result;
}

/** 把一个 entry 转成流里的消息。 */
function toStreamMessage(entry: {
	readonly id: number;
	readonly kind: string;
	readonly model?: readonly unknown[];
	readonly data?: unknown;
}): StreamMessage | undefined {
	const at = Date.now();
	switch (entry.kind) {
		case "pi.user": {
			const message = entry.model?.[0] as { content?: unknown; timestamp?: number } | undefined;
			const text = typeof message?.content === "string" ? message.content : extractText(message?.content);
			return { entryId: entry.id, role: "user", text, at: message?.timestamp ?? at };
		}
		case "pi.assistant": {
			const message = entry.model?.[0] as
				| {
						content?: readonly { type: string; text?: string; name?: string }[];
						timestamp?: number;
				  }
				| undefined;
			const parts = message?.content ?? [];
			const toolCall = parts.find((part) => part.type === "toolCall");
			if (toolCall !== undefined) {
				return {
					entryId: entry.id,
					role: "tool",
					text: `调用工具 ${toolCall.name ?? "?"}`,
					at: message?.timestamp ?? at,
					...(toolCall.name === undefined ? {} : { toolName: toolCall.name }),
					toolState: "running",
				};
			}
			return {
				entryId: entry.id,
				role: "assistant",
				text: extractText(parts),
				at: message?.timestamp ?? at,
			};
		}
		case "pi.tool-result": {
			const message = entry.model?.[0] as
				| { content?: unknown; toolName?: string; isError?: boolean; timestamp?: number }
				| undefined;
			const text = extractText(message?.content);
			return {
				entryId: entry.id,
				role: "tool",
				text,
				at: message?.timestamp ?? at,
				...(message?.toolName === undefined ? {} : { toolName: message.toolName }),
				toolState: message?.isError === true ? "error" : "ok",
				collapsible: text.length > 200,
			};
		}
		case "pi.system":
			return undefined;
		default: {
			// 自定义 entry（例如沟通留痕）
			const data = entry.data as { kind?: string; from?: string; to?: string; text?: string } | undefined;
			if (data !== undefined && typeof data === "object" && "from" in data) {
				return {
					entryId: entry.id,
					role: "note",
					text: `${data.from} → ${data.to}：${data.text ?? ""}`,
					at,
				};
			}
			return undefined;
		}
	}
}

/** 从内容块里抽文本。 */
function extractText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.flatMap((part) => {
			if (typeof part !== "object" || part === null) return [];
			const record = part as { type?: string; text?: string };
			return record.type === "text" && record.text !== undefined ? [record.text] : [];
		})
		.join("");
}

/** 任务显示名。 */
function taskLabel(task: ActiveTask): string {
	const labels: Record<string, string> = {
		"app.anchor": "员工在岗",
		"app.escalation": "升级流程",
		"pi.generation": "模型生成",
		"pi.tool": "工具执行",
		"pi.compaction": "上下文压缩",
	};
	return labels[task.kind] ?? task.kind;
}

/** 找一个会话所属的项目。 */
function findProjectOf(
	state: Awaited<ReturnType<typeof readCompany>>,
	conversationId: number,
): string | undefined {
	if (state === undefined) return undefined;
	for (const staff of Object.values(state.staff)) {
		if (staff.conversationId === conversationId) return staff.project;
	}
	for (const project of Object.values(state.projects)) {
		if (project.leader === conversationId) return project.slug;
	}
	return undefined;
}
