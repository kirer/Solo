/**
 * 工具在轨迹里长什么样：**谁注册工具，谁登记它这一行**。
 *
 * 投影层（`app/trace.ts`）只按名字查这张表，不认识任何具体工具 —— 加一个工具、改一个
 * 工具的展示，都只动注册处那一行。插件工具没登记就退回「原名 + 通用行」，核心加多少
 * 工具都不会漏画。
 *
 * 这里的句子是**界面文案**，不是模型看得见的文案：它不进提示词，也不进工具描述，
 * 所以住在代码里而不是 `seed/text/`。
 */
/**
 * 轨迹步骤的种类。**必须能赋给** `view/dto.ts` 的 `ViewStep["kind"]` ——
 * 领域不能 import 契约层（边界规则），所以由 `app/trace.ts` 的赋值处替这条兜底：
 * 这里多出一种界面不认识的东西，那边就编不过。
 */
export type TraceKind =
	| "think"
	| "run"
	| "file-read"
	| "file-write"
	| "chats"
	| "history"
	| "remember"
	| "hire"
	| "tool";

export type ToolTrace = (args: Readonly<Record<string, unknown>>) => {
	/** 这一步画成什么。`undefined` = 不进过程（说话就是消息本身）。 */
	readonly kind: TraceKind | undefined;
	/** 一行人话。 */
	readonly title: string;
};

const traces = new WeakMap<object, ToolTrace>();

/** 注册工具时顺手登记它的轨迹行。返回原对象，注册表拿到的还是同一个工具。 */
export function traced<T extends object>(tool: T, trace: ToolTrace): T {
	traces.set(tool, trace);
	return tool;
}

export function traceOf(tool: unknown): ToolTrace | undefined {
	return typeof tool === "object" && tool !== null ? traces.get(tool) : undefined;
}

/** 一批工具 → 名字到轨迹行的表。没登记的跳过，投影层会退回原名。 */
export function tracesOf(tools: readonly unknown[]): ReadonlyMap<string, ToolTrace> {
	const map = new Map<string, ToolTrace>();
	for (const tool of tools) {
		const name = (tool as { readonly name?: unknown }).name;
		const trace = traceOf(tool);
		if (typeof name === "string" && name !== "" && trace !== undefined) map.set(name, trace);
	}
	return map;
}

function asString(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

/** `file` 的默认动作和工具本身一致：给了正文就是写（模型常漏 action）。 */
function fileAction(args: Readonly<Record<string, unknown>>): "read" | "write" {
	const action = asString(args["action"]) ?? (args["content"] === undefined ? "read" : "write");
	return action === "write" ? "write" : "read";
}

/** `say` 落成频道里的消息：说话不进过程。 */
export const traceSay: ToolTrace = () => ({ kind: undefined, title: "" });

export const traceChats: ToolTrace = () => ({ kind: "chats", title: "翻了频道记录" });

export const traceHistory: ToolTrace = () => ({ kind: "history", title: "读了更早的消息" });

export const traceRemember: ToolTrace = () => ({ kind: "remember", title: "记了一条" });

export const traceRun: ToolTrace = (args) => ({
	kind: "run",
	title: `运行 ${asString(args["command"]) ?? ""}`,
});

export const traceFile: ToolTrace = (args) => {
	const path = asString(args["path"]) ?? "";
	return fileAction(args) === "write" ? { kind: "file-write", title: `写了 ${path}` } : { kind: "file-read", title: `读了 ${path}` };
};

export const traceHire: ToolTrace = (args) => {
	const action = asString(args["action"]) ?? "create";
	if (action === "models") return { kind: "hire", title: "看了可用模型" };
	const who = asString(args["name"]) ?? asString(args["slug"]) ?? "一个人";
	return { kind: "hire", title: action === "fire" ? `开除了 ${who}` : `招了 ${who}` };
};

/** `route` 没有专门的画法：它是一条后台转交，落在通用行里。 */
export const traceRoute: ToolTrace = () => ({ kind: "tool", title: "route" });
