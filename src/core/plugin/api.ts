/**
 * 插件能对后端做的五件事：加一个工具、追加一段提示词、加一条 HTTP 路由、听消息、
 * 注册一条分发 / 收尾策略。
 *
 * 为什么只有五件：插件是「给组织加能力」，不是「重新实现运行时」。dsh 那边一个插件能
 * 摸到 `ctx.tools` / `ctx.llm` / `ctx.sessions` 全部服务，代价是插件必须懂 Cordis 的
 * 服务定位器和瀑布事件；Solo 的形态是「语义写在文档里，代码只做机械的事」，所以给的是
 * **五个动作**，每个动作只落一个数组，没有服务查找、没有事件总线。
 *
 * 每个动作都只有「加进去」一种语义，没有对应的「删掉」—— 热插拔是**整份重装**：
 * 丢掉这个对象、重新唱一遍 `apply`（ADR-026）。策略是活引用，重装后下一次发布生效。
 */
import { defineTool, Type, type ToolRegistration } from "../runtime/index.ts";
import type { JsonValue } from "../runtime/index.ts";
import type { FlowPolicy, Message } from "../channel/types.ts";

/** 一个工具的形状。与核心那八个工具用的是同一个 `defineTool`。 */
export type PluginToolSpec = {
	readonly name: string;
	readonly description: string;
	/** 参数 schema，用 `api.Type` 造（插件不需要 import 任何东西）。 */
	readonly parameters: unknown;
	readonly execute: (...args: readonly never[]) => unknown;
};

/** 插件路由收到的请求。**只有 JSON**：不发文件、不设 header、不读原始 body。 */
export type PluginRequest = {
	readonly method: "GET" | "POST";
	/** 路径参数（`/api/p/:id` 里的 `id`）。 */
	readonly params: Readonly<Record<string, string>>;
	/** 查询串。 */
	readonly query: Readonly<Record<string, string>>;
	/** POST 的 JSON body；没有 body 就是 `undefined`。 */
	readonly body?: JsonValue;
};

export type PluginRouteSpec = {
	readonly method: "GET" | "POST";
	/** 路径模板，规则同 `interface/http/route-match.ts`（`:name` 捕获一段）。 */
	readonly pattern: string;
	handle(request: PluginRequest): Promise<JsonValue>;
};

export type PluginListener = (message: Message, channelId: string) => void | Promise<void>;

/**
 * 一个频道对应的**工作区**。
 *
 * 私聊 → 那个人的 `workspace/`；团队频道 → 团队的 `workspace/`；全员频道 → 没有
 * （它不是谁的工作区）。插件拿到的只是**根目录这一个字符串**：路径守卫、深度上限、
 * 什么能预览，全在插件里做 —— 内核只负责说清「这个频道的工作区在哪」。
 */
export type PluginScope = {
	readonly kind: "dm" | "group";
	readonly title: string;
	/** 绝对路径。 */
	readonly root: string;
	/** 给人看的名字：私聊是那个人的名字，团队频道是团队名。 */
	readonly label: string;
};

/**
 * 插件看得见的一个频道。
 *
 * 只给「认出它」要用的四个字段：id / 标题 / 私聊还是群聊 / 成员 slug。没有消息、
 * 没有工作区、没有内部字段 —— 插件要读消息内容走 `on("message")`，要工作区走 `scope`。
 * 给这份清单是为了让「把外面的话带进来」的插件能找到自己的目标频道（比如助理私聊），
 * 而不是在插件里复述 `dm:owner-<slug>` 这种 id 拼法。
 */
export type PluginChannel = {
	readonly id: string;
	readonly title: string;
	readonly kind: "dm" | "group";
	readonly members: readonly string[];
};

/** 插件拿到的那一个对象。插件源码里不 import 任何东西，全靠它。 */
export type PluginApi = {
	readonly slug: string;
	/** 应用私有的绝对路径（`appRoot`；字段名沿用旧称）。插件读写自己的数据时用它（自担越界风险，见 ADR-036）。 */
	readonly workspace: string;
	/**
	 * 日志目录的绝对路径（`<userRoot>/logs`）。审计（`tools.jsonl`）在这里，插件要按
	 * token / 成本 / 耗时算账就读它；路径守卫与解析同样在插件里（ADR-036 的同一个口径）。
	 */
	readonly logsRoot: string;
	/** 工具参数 schema 的构造器。 */
	readonly Type: typeof Type;
	/** 工具的返回值：**一段自然语言**，不是结构化数据（工具输出是给模型读的）。 */
	readonly text: (value: string) => { readonly output: readonly { readonly type: "text"; readonly text: string }[] };
	tool(spec: PluginToolSpec): void;
	/** 追加一截全员提示词。空串忽略。 */
	prompt(text: string): void;
	route(spec: PluginRouteSpec): void;
	on(event: "message", listener: PluginListener): void;
	/**
	 * 注册一条分发 / 收尾策略。只拿只读事实，只能**提议**：
	 * 写盘、入队、成员校验与判重由 core 做。抛错只跳过这一条。
	 */
	flow(policy: FlowPolicy): void;
	/** 这个频道的工作区；没有（全员频道）或查无此频道 → `undefined`。 */
	scope(channelId: string): Promise<PluginScope | undefined>;
	/** 全部没归档的频道，按 id 排。只读事实，不含消息。 */
	channels(): Promise<readonly PluginChannel[]>;
	/**
	 * 以**我的**身份在一个频道里说一句（和界面里打字走同一条路：同一套 @ 解析、
	 * 同一套投递与唤醒）。插件不能冒充别人 —— 发件人固定是我。
	 *
	 * 抛错 = 没发出去（频道不存在、正文为空……）。调用方自己决定要不要重试。
	 */
	post(input: { readonly channelId: string; readonly text: string }): Promise<void>;
	log(line: string): void;
};

/** 注册落到哪里。加载器建一份，一个插件往里写，`PluginHost` 再收走。 */
export type PluginSinks = {
	readonly tools: ToolRegistration[];
	readonly prompt: string[];
	readonly routes: PluginRouteSpec[];
	readonly messages: PluginListener[];
	readonly flow: FlowPolicy[];
	readonly logs: string[];
};

export function emptySinks(): PluginSinks {
	return { tools: [], prompt: [], routes: [], messages: [], flow: [], logs: [] };
}

/** 造一个插件用的 `api`。所有注册只是 push —— 没有副作用，也没有失败路径。 */
export function createPluginApi(options: {
	readonly slug: string;
	readonly workspace: string;
	readonly logsRoot: string;
	readonly sinks: PluginSinks;
	readonly scope?: (channelId: string) => Promise<PluginScope | undefined>;
	readonly channels?: () => Promise<readonly PluginChannel[]>;
	readonly post?: (input: { readonly channelId: string; readonly text: string }) => Promise<void>;
}): PluginApi {
	const { slug, workspace, logsRoot, sinks } = options;
	return {
		slug,
		workspace,
		logsRoot,
		Type,
		text: (value: string) => ({ output: [{ type: "text" as const, text: value }] }),
		tool(spec) {
			sinks.tools.push(defineTool(spec as never) as ToolRegistration);
		},
		prompt(text) {
			const trimmed = text.trim();
			if (trimmed !== "") sinks.prompt.push(trimmed);
		},
		route(spec) {
			sinks.routes.push(spec);
		},
		on(event, listener) {
			if (event === "message") sinks.messages.push(listener);
		},
		flow(policy) {
			sinks.flow.push(policy);
		},
		scope: options.scope ?? (async () => undefined),
		channels: options.channels ?? (async () => []),
		post:
			options.post ??
			(async () => {
				throw new Error("这个宿主不让插件发言");
			}),
		log(line) {
			sinks.logs.push(line);
		},
	};
}
