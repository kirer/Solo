/**
 * 三栏布局的渲染。
 *
 * 三栏：组织树 | 会话流 | 任务与成本面板，底部输入框。
 *
 * 这一层只做「把 UiState 画成字符串行」，不碰终端，所以可以单测。
 * 真正的终端交互在 app.ts。
 */
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { CostBar, OrgNode, StreamMessage, TaskPanelItem, UiState } from "./state.ts";

/** 布局尺寸。 */
export type Layout = {
	readonly totalWidth: number;
	readonly totalHeight: number;
	readonly treeWidth: number;
	readonly panelWidth: number;
	readonly streamWidth: number;
	/** 极窄窗口时折叠侧栏。 */
	readonly collapsed: boolean;
};

/** 计算布局。 */
export function computeLayout(width: number, height: number): Layout {
	// 极窄窗口：折叠两侧，只留会话流
	if (width < 60) {
		return {
			totalWidth: width,
			totalHeight: height,
			treeWidth: 0,
			panelWidth: 0,
			streamWidth: width,
			collapsed: true,
		};
	}

	const treeWidth = Math.min(26, Math.max(18, Math.floor(width * 0.22)));
	const panelWidth = Math.min(34, Math.max(24, Math.floor(width * 0.26)));
	// 两个竖向分隔符各占 1 列
	const streamWidth = Math.max(20, width - treeWidth - panelWidth - 2);

	return { totalWidth: width, totalHeight: height, treeWidth, panelWidth, streamWidth, collapsed: false };
}

/** 状态标记。 */
const STATUS_MARK: Record<OrgNode["status"], string> = {
	busy: "●",
	pending: "◐",
	idle: "○",
};

/** 渲染组织树。 */
export function renderOrgTree(nodes: readonly OrgNode[], width: number, selectedId: number): string[] {
	const lines: string[] = ["组织", "─".repeat(Math.max(0, width))];

	for (const node of nodes) {
		const indent = "  ".repeat(node.depth);
		const mark = STATUS_MARK[node.status];
		const cursor = node.conversationId === selectedId ? "›" : " ";
		const line = `${cursor}${indent}${mark} ${node.label}`;
		lines.push(truncateToWidth(line, width));
	}

	if (nodes.length === 0) lines.push("（尚未初始化）");
	return lines;
}

/** 渲染任务与成本面板。 */
export function renderPanel(
	tasks: readonly TaskPanelItem[],
	cost: CostBar,
	pendingCount: number,
	width: number,
	pendingQuestions: readonly { readonly question: string; readonly level: string; readonly from: string }[] = [],
): string[] {
	const lines: string[] = ["任务", "─".repeat(Math.max(0, width))];

	if (pendingCount > 0) {
		lines.push(`◐ 待你拍板：${pendingCount}`);
		// 显示问题本身：老板要能看见「在决定什么」才能回话
		for (const pending of pendingQuestions.slice(0, 3)) {
			const who = pending.level === "owner" ? "等你" : pending.level;
			lines.push(truncateToWidth(`  ${who}：${firstLine(pending.question)}`, width));
		}
		if (pendingQuestions.length > 3) {
			lines.push(truncateToWidth(`  …还有 ${pendingQuestions.length - 3} 条`, width));
		}
	}

	if (tasks.length === 0) {
		lines.push("○ 全部空闲");
	} else {
		for (const task of tasks) {
			const mark = task.status === "running" ? "●" : task.status === "waiting" ? "◐" : task.status === "sleeping" ? "◌" : "○";
			lines.push(truncateToWidth(`${mark} ${task.label}`, width));
			if (task.detail !== undefined) lines.push(truncateToWidth(`  ${task.detail}`, width));
		}
	}

	lines.push("", "成本", "─".repeat(Math.max(0, width)));
	lines.push(truncateToWidth(`本会话 ${formatTokens(cost.conversationTokens)}`, width));
	lines.push(truncateToWidth(`本项目 ${formatTokens(cost.projectTokens)}`, width));
	lines.push(truncateToWidth(`全公司 ${formatTokens(cost.companyTokens)}`, width));

	if (cost.companyCostUsd > 0) {
		lines.push(truncateToWidth(`花费 $${cost.companyCostUsd.toFixed(4)}`, width));
	}

	return lines;
}

/** 渲染选项。 */
export type RenderOptions = {
	/** 展开工具输出（不再折叠）。 */
	readonly expanded?: boolean;
	/** 从末尾往上滚动的行数；0 表示贴底。 */
	readonly scrollBack?: number;
};

/** 渲染会话流。 */
export function renderStream(
	state: UiState,
	width: number,
	height: number,
	options: RenderOptions = {},
): string[] {
	const lines: string[] = [];

	// 标题行：会话名 + 分支来源
	let header = state.stream.title;
	if (state.branchFrom !== undefined) {
		header = `⎇ 分支 from #${state.branchFrom.entryId} · ${state.branchFrom.label}`;
	}
	lines.push(truncateToWidth(header, width), "─".repeat(Math.max(0, width)));

	// 消息
	for (const message of state.stream.messages) {
		lines.push(...renderMessage(message, width, options.expanded === true));
	}

	// 流式生成
	if (state.stream.streaming !== undefined) {
		lines.push(...prefixLines(state.stream.streaming, "│ ", width));
	}

	// 运行中的工具
	for (const tool of state.stream.runningTools) {
		lines.push(truncateToWidth(`  ⚙ ${tool.name} 运行中…`, width));
	}

	// 自动滚动：默认贴底；用户上滚时固定位置
	const visible = Math.max(3, height - 4);
	if (lines.length <= visible) return lines;

	const scrollBack = Math.max(0, Math.min(options.scrollBack ?? 0, lines.length - visible));
	const end = lines.length - scrollBack;
	return lines.slice(Math.max(0, end - visible), end);
}

/** 渲染单条消息。 */
function renderMessage(message: StreamMessage, width: number, expanded: boolean): string[] {
	switch (message.role) {
		case "user":
			return prefixLines(message.text, "[你] ", width);
		case "assistant":
			return prefixLines(message.text, "", width);
		case "tool": {
			const mark = message.toolState === "ok" ? "✓" : message.toolState === "error" ? "✗" : "…";
			const name = message.toolName ?? "工具";
			const firstLine = `  ⚙ ${name} ${mark}`;
			if (message.collapsible === true && !expanded) {
				const summary = message.text.split("\n")[0] ?? "";
				return [truncateToWidth(`${firstLine} ${summary}`, width), truncateToWidth("    （已折叠，按 o 展开）", width)];
			}
			return [truncateToWidth(firstLine, width), ...prefixLines(message.text, "    ", width)];
		}
		case "note":
			return prefixLines(message.text, "※ ", width);
		default:
			return prefixLines(message.text, "", width);
	}
}

/** 给多行文本加前缀并按宽度换行。 */
function prefixLines(text: string, prefix: string, width: number): string[] {
	const available = Math.max(4, width - visibleWidth(prefix));
	const result: string[] = [];
	for (const rawLine of text.split("\n")) {
		const wrapped = wrapTextWithAnsi(rawLine, available);
		for (const line of wrapped.length === 0 ? [""] : wrapped) {
			result.push(truncateToWidth(`${prefix}${line}`, width));
		}
	}
	return result;
}

/**
 * 把三栏拼成完整画面。
 *
 * 每行形如：`组织树 │ 会话流 │ 面板`
 */
export function renderLayout(state: UiState, layout: Layout, options: RenderOptions = {}): string[] {
	const height = layout.totalHeight;

	if (layout.collapsed) {
		return renderStream(state, layout.streamWidth, height, options);
	}

	const tree = renderOrgTree(state.org, layout.treeWidth, state.selectedConversationId);
	const stream = renderStream(state, layout.streamWidth, height, options);
	const panel = renderPanel(
		state.tasks,
		state.cost,
		state.pendingCount,
		layout.panelWidth,
		state.pendingQuestions,
	);

	const lines: string[] = [];
	const rows = Math.max(tree.length, stream.length, panel.length, height - 2);

	for (let index = 0; index < rows; index += 1) {
		const left = padRight(tree[index] ?? "", layout.treeWidth);
		const middle = padRight(stream[index] ?? "", layout.streamWidth);
		const right = padRight(panel[index] ?? "", layout.panelWidth);
		lines.push(`${left}│${middle}│${right}`);
	}

	return lines;
}

/** 渲染底部输入区。 */
export function renderInput(input: string, hint: string, width: number): string[] {
	const border = "─".repeat(Math.max(0, width));
	return [border, truncateToWidth(`> ${input}`, width), truncateToWidth(hint, width)];
}

/** 取第一行并截断，用于面板里的单行摘要。 */
function firstLine(text: string): string {
	const line = text.split("\n")[0] ?? "";
	return line.length > 40 ? `${line.slice(0, 39)}…` : line;
}

/** 按显示宽度右侧补空格。 */
function padRight(text: string, width: number): string {
	const current = visibleWidth(text);
	if (current >= width) return truncateToWidth(text, width);
	return text + " ".repeat(width - current);
}

/** token 数的紧凑显示。 */
export function formatTokens(tokens: number): string {
	if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(2)}M`;
	if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}k`;
	return String(tokens);
}
