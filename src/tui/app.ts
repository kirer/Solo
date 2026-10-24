/**
 * 终端应用：订阅驱动 + 键盘交互。
 *
 * 交互约定：
 * - 方向键：在组织树里移动
 * - Enter：进入选中会话；在输入框里发送
 * - Tab：在组织树与输入框之间切换焦点
 * - Esc：中断当前会话的工作
 * - f：在当前选中的消息处开分支
 * - o：展开/折叠工具输出
 * - q / Ctrl+C：退出
 *
 * 订阅策略（ADR-008）：附着到会话时先取当前状态，此后由变更订阅推送；
 * 切换会话必须停止旧订阅。
 */
import { matchesKey, ProcessTerminal, TuiMainScreen, type TUI } from "@earendil-works/pi-tui";
import { Screen } from "./screen.ts";
import { BACKGROUND_CONTEXT } from "../runtime/index.ts";
import type { CompanyRuntime } from "../runtime/index.ts";
import { answerPending, listPending } from "../company/escalation.ts";
import { retryParked } from "../runtime/index.ts";
import { buildUiState, type UiState } from "./state.ts";
import { computeLayout, formatTokens, renderInput, renderLayout } from "./render.ts";

/** 应用选项。 */
export type AppOptions = {
	readonly runtime: CompanyRuntime;
	/** 初始选中的会话；不传则用 CEO。 */
	readonly initialConversationId?: number;
	/** 启动时检测到的受阻任务标识。 */
	readonly parkedTaskIds?: readonly string[];
};

/** 应用句柄。 */
export type App = {
	/** 启动终端界面。 */
	start(): void;
	/** 停止并清理。 */
	stop(): Promise<void>;
	/** 当前状态（供测试）。 */
	state(): UiState | undefined;
	/** 手动刷新（供测试与订阅回调）。 */
	refresh(): Promise<void>;
};

/**
 * 创建终端应用。
 */
export async function createApp(options: AppOptions): Promise<App> {
	const { runtime } = options;
	const terminal = new ProcessTerminal();
	const tui: TUI = new TuiMainScreen(terminal);

	const root = new Screen(0);
	tui.addChild(root);
	tui.setFocus(root);

	let selectedConversationId = options.initialConversationId ?? 1;
	let input = "";
	let focus: "tree" | "input" = "input";
	let currentState: UiState | undefined;
	let stopped = false;
	let unsubscribe: (() => void) | undefined;
	let expanded = false;
	let scrollBack = 0;
	/** 正在答复的待决问题（非空时输入框提交的是答复而非消息）。 */
	let parkedTaskIds = [...(options.parkedTaskIds ?? [])];
	let answering: { readonly key: string; readonly question: string } | undefined;

	/** 重新构建状态并重绘。 */
	const refresh = async (): Promise<void> => {
		if (stopped) return;
		currentState = await buildUiState(runtime, { selectedConversationId });
		// 终端尺寸可能未就绪或为 0：夹到合理范围，避免布局炸掉
		const columns = Math.max(40, terminal.columns || 80);
		const rows = Math.max(10, terminal.rows || 24);
		const layout = computeLayout(columns, rows);
		const lines = renderLayout(currentState, layout, { expanded, scrollBack });

		// 受阻任务：显著提示，避免「静默卡死」
		if (parkedTaskIds.length > 0) {
			lines.push(
				`⚠ ${parkedTaskIds.length} 个任务受阻（连续崩溃）：${parkedTaskIds.join(", ")} · 按 R 重试`,
			);
		}
		const hint =
			answering === undefined
				? hintText(focus, currentState)
				: `[拍板] 答复：${answering.question.split("\n")[0]?.slice(0, 50) ?? ""} · Enter 提交 · Tab 取消`;
		lines.push(...renderInput(answering === undefined ? input : input, hint, layout.totalWidth));
		root.setLines(lines);
		tui.requestRender();
	};

	/** 附着到会话的订阅。 */
	const attach = async (conversationId: number): Promise<void> => {
		unsubscribe?.();
		unsubscribe = undefined;

		const conversation = await runtime.harness.conversation(conversationId as never, BACKGROUND_CONTEXT);
		if (conversation === undefined) return;

		const watch = await conversation.watch(BACKGROUND_CONTEXT);
		watch.start(async () => {
			await refresh();
		});
		unsubscribe = () => {
			void watch.stop();
		};
	};

	/** 键盘处理：解析意图后分发。 */
	const onInput = (data: string): { consume: boolean } | undefined => {
		if (stopped) return { consume: true };

		const intent = interpretKey(data, focus);

		switch (intent.kind) {
			case "quit":
				void stop();
				return { consume: true };
			case "toggle-focus":
				// 拍板模式下 Tab 取消拍板，避免误把答复发给别的会话
				if (answering !== undefined) {
					answering = undefined;
					input = "";
					void refresh();
					return { consume: true };
				}
				focus = focus === "tree" ? "input" : "tree";
				void refresh();
				return { consume: true };
			case "move":
				moveSelection(intent.delta);
				return { consume: true };
			case "enter":
				void attach(selectedConversationId).then(refresh);
				return { consume: true };
			case "toggle-expand":
				expanded = !expanded;
				void refresh();
				return { consume: true };
			case "scroll":
				scrollBack = Math.max(0, scrollBack + intent.delta);
				void refresh();
				return { consume: true };
			case "fork":
				void forkAtLatest();
				return { consume: true };
			case "answer":
				void startAnswering();
				return { consume: true };
			case "retry":
				void retryAllParked();
				return { consume: true };
			case "send":
				void send();
				return { consume: true };
			case "abort":
				void abortCurrent();
				return { consume: true };
			case "backspace":
				input = input.slice(0, -1);
				void refresh();
				return { consume: true };
			case "type":
				input += intent.text;
				void refresh();
				return { consume: true };
			default:
				return undefined;
		}
	};

	/** 在组织树里移动选中项。 */
	const moveSelection = (delta: number): void => {
		if (currentState === undefined) return;
		const nodes = currentState.org;
		const index = nodes.findIndex((node) => node.conversationId === selectedConversationId);
		const next = Math.max(0, Math.min(nodes.length - 1, index + delta));
		const node = nodes[next];
		if (node === undefined) return;
		selectedConversationId = node.conversationId;
		void attach(selectedConversationId).then(refresh);
	};

	/** 发送输入。 */
	const send = async (): Promise<void> => {
		const content = input.trim();
		if (content === "") return;
		input = "";
		scrollBack = 0;
		await refresh();

		// 拍板模式：提交的是对上一条待决问题的答复
		if (answering !== undefined) {
			await answerPending(
				runtime,
				{ key: answering.key, answer: content, answeredBy: "owner" },
				BACKGROUND_CONTEXT,
			);
			answering = undefined;
			await refresh();
			return;
		}

		const conversation = await runtime.harness.conversation(selectedConversationId as never, BACKGROUND_CONTEXT);
		await conversation?.submit({ type: "input", content }, BACKGROUND_CONTEXT);
		await refresh();
	};

	/** 重试全部受阻任务。 */
	const retryAllParked = async (): Promise<void> => {
		const remaining: string[] = [];
		for (const taskId of parkedTaskIds) {
			try {
				await retryParked(runtime, taskId, BACKGROUND_CONTEXT);
			} catch {
				remaining.push(taskId);
			}
		}
		parkedTaskIds = remaining;
		await refresh();
	};

	/** 进入拍板模式：只答「CEO 报上来、等老板决」的问题。 */
	const startAnswering = async (): Promise<void> => {
		const pending = await listPending(runtime, BACKGROUND_CONTEXT);
		// 只有 owner 级才是等老板的。CEO 队列里的问题由 CEO 自己答，
		// 老板不该被拉到别人的授权范围里做决定。
		const target = pending.find((item) => item.level === "owner");
		if (target === undefined) return;

		answering = { key: target.key, question: target.question };
		focus = "input";
		await refresh();
	};

	/** 中断当前会话。 */
	const abortCurrent = async (): Promise<void> => {
		const conversation = await runtime.harness.conversation(selectedConversationId as never, BACKGROUND_CONTEXT);
		await conversation?.abort(BACKGROUND_CONTEXT);
		await refresh();
	};

	/** 在最新消息处开分支。 */
	const forkAtLatest = async (): Promise<void> => {
		const conversation = await runtime.harness.conversation(selectedConversationId as never, BACKGROUND_CONTEXT);
		if (conversation === undefined) return;

		const page = await conversation.entries({ order: "ascending" }, 200, undefined, BACKGROUND_CONTEXT);
		const target = page.items.filter((entry) => entry.kind === "pi.assistant").at(-1);
		if (target === undefined) return;

		const branch = await conversation.fork(target.id, { ownership: { kind: "ownerless" } }, BACKGROUND_CONTEXT);
		selectedConversationId = Number(branch.id);
		await attach(selectedConversationId);
		await refresh();
	};

	/** 停止。 */
	const stop = async (): Promise<void> => {
		if (stopped) return;
		stopped = true;
		unsubscribe?.();
		tui.stop();
		// 未完成的工作保留至下次打开
		await runtime.close(BACKGROUND_CONTEXT);
	};

	// 初次附着与渲染
	await attach(selectedConversationId);
	await refresh();

	tui.addInputListener(onInput);
	tui.start();

	return {
		start() {
			// tui.start() 已在创建时调用
		},
		stop,
		state: () => currentState,
		refresh,
	};
}

/**
 * 按键意图：把原始按键数据解析成动作，不碰终端。
 *
 * 抽成纯函数是为了让键盘行为可以被测试驱动——
 * 终端本身没有可编程替身，但意图解析可以精确断言。
 */
export type KeyIntent =
	| { readonly kind: "quit" }
	| { readonly kind: "toggle-focus" }
	| { readonly kind: "move"; readonly delta: number }
	| { readonly kind: "enter" }
	| { readonly kind: "toggle-expand" }
	| { readonly kind: "scroll"; readonly delta: number }
	| { readonly kind: "fork" }
	| { readonly kind: "answer" }
	| { readonly kind: "retry" }
	| { readonly kind: "send" }
	| { readonly kind: "abort" }
	| { readonly kind: "backspace" }
	| { readonly kind: "type"; readonly text: string }
	| { readonly kind: "none" };

/** 解析按键。 */
export function interpretKey(data: string, focus: "tree" | "input"): KeyIntent {
	if (matchesKey(data, "ctrl+c")) return { kind: "quit" };
	if (matchesKey(data, "tab")) return { kind: "toggle-focus" };

	if (focus === "tree") {
		if (data === "q") return { kind: "quit" };
		if (matchesKey(data, "up")) return { kind: "move", delta: -1 };
		if (matchesKey(data, "down")) return { kind: "move", delta: 1 };
		if (matchesKey(data, "return") || matchesKey(data, "enter")) return { kind: "enter" };
		if (matchesKey(data, "pageUp")) return { kind: "scroll", delta: 10 };
		if (matchesKey(data, "pageDown")) return { kind: "scroll", delta: -10 };
		if (data === "o") return { kind: "toggle-expand" };
		if (data === "f") return { kind: "fork" };
		if (data === "a") return { kind: "answer" };
		if (data === "R") return { kind: "retry" };
		return { kind: "none" };
	}

	// 翻页：输入框里也能看历史，不打断正在输入的内容
	if (matchesKey(data, "pageUp")) return { kind: "scroll", delta: 10 };
	if (matchesKey(data, "pageDown")) return { kind: "scroll", delta: -10 };

	if (matchesKey(data, "return") || matchesKey(data, "enter")) return { kind: "send" };
	if (matchesKey(data, "escape")) return { kind: "abort" };
	if (matchesKey(data, "backspace")) return { kind: "backspace" };
	if (data.length === 1 && data >= " ") return { kind: "type", text: data };
	return { kind: "none" };
}

/** 输入区提示。 */
function hintText(focus: "tree" | "input", state: UiState | undefined): string {
	const cost = state?.cost;
	const costText =
		cost === undefined
			? ""
			: ` · 本会话 ${formatTokens(cost.conversationTokens)} / 全公司 ${formatTokens(cost.companyTokens)}`;

	if (focus === "tree") {
		return `[组织树] ↑↓ 选择 · Enter 进入 · Tab 到输入 · f 分支 · a 拍板 · q 退出${costText}`;
	}
	return `[输入] Enter 发送 · Esc 中断 · Tab 到组织树 · PgUp/PgDn 翻页${costText}`;
}
