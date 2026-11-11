/**
 * 插件能对后端做的六件事：加一个工具、追加一段提示词、加一条 HTTP 路由、听消息、
 * 注册一条分发 / 收尾策略、**请宿主替它做一个系统动作**（`system.act`）。
 *
 * 第六件是唯一一件「会伸到应用外面」的：所以它不叫 `exec`、不收路径、默认关着 ——
 * 插件只能说出「动作名 + 当前频道 + 工作区里的相对路径」，绝对路径与执行都由内核包办
 * （见 `permissions.ts` 与 `system.ts`）。
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

/** 一个工具的形状。与核心那九个工具用的是同一个 `defineTool`。 */
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

/**
 * 插件能请宿主做的系统动作。**动作名是固定的三个**，参数只有频道与相对路径。
 *
 * 为什么不是 `exec(command)`：`run` 工具已经让模型能执行命令，那条路有审批与审计；
 * 给插件一个没审批的 exec，等于让每个插件都变成 `run`。这里给的是**分类好的动词**，
 * 每个动词的作用域内建 —— 插件表达不出「任意路径」，也表达不出「任意命令」。
 */
export type PluginSystem = {
	/**
	 * 做一个系统动作。**要在 `plugin.md` 的 `permissions:` 里声明、并且被人批准过**，
	 * 否则抛错（不静默降级）。
	 *
	 * - `system.copyText`：`{ channelId, text }`；
	 * - `system.reveal` / `system.open`：`{ channelId, path }`，`path` 是**工作区相对路径**。
	 *
	 * 抛错 = 没做成（没权限 / 越界 / 软链接 / 目录 / 这个宿主做不到），错误消息里写了原因。
	 */
	act(input: PluginSystemAct): Promise<void>;
};

/** `api.system.act` 的入参形状。 */
export type PluginSystemAct = {
	readonly action: "system.reveal" | "system.copyText" | "system.open";
	/** 哪个频道的工作区。全员频道没有工作区 → 直接拒。 */
	readonly channelId: string;
	/** 工作区**相对**路径（`copyText` 不用）。 */
	readonly path?: string;
	/** `copyText` 的正文。 */
	readonly text?: string;
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
	/**
	 * 请宿主替它做一个系统动作。没声明 / 没批准就抛错。
	 *
	 * 这是唯一一个会伸到应用外面的能力，所以清单要写、人要批、每次落审计。
	 */
	readonly system: PluginSystem;
	/** 这个频道的工作区；没有（全员频道）或查无此频道 → `undefined`。 */
	scope(channelId: string): Promise<PluginScope | undefined>;
	/** 全部没归档的频道，按 id 排。只读事实，不含消息。 */
	channels(): Promise<readonly PluginChannel[]>;
	/**
	 * 以**我的**身份在一个频道里说一句（和界面里打字走同一条路：同一套 @ 解析、
	 * 同一套投递与唤醒）。插件不能冒充别人 —— 发件人固定是我。
	 *
	 * 抛错 = 没发出去（频道不存在、正文为空……）。调用方自己决定要不要重试。
	 *
	 * `replyTo` 与 `speak` / `postAs` 同义同形：引用**同一个频道里已有的某条消息**。
	 * 只认这个频道里真实存在的 seq —— 跨频道或不存在的 id 一律抛错，不让它变成
	 * 往别处投递的后门。
	 */
	post(input: {
		readonly channelId: string;
		readonly text: string;
		readonly replyTo?: number;
	}): Promise<void>;
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
	readonly post?: (input: {
		readonly channelId: string;
		readonly text: string;
		readonly replyTo?: number;
	}) => Promise<void>;
	/**
	 * 系统动作的执行器（`plugin/system.ts` 造的）。不给 = 这个插件一个动作都做不了，
	 * `act` 一律抛错 —— 网页版后端没有 Electron 的 shell，就是这一种。
	 */
	readonly system?: (input: PluginSystemAct) => Promise<void>;
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
		system: {
			act:
				options.system ??
				(async (input) => {
					throw new Error(`这个宿主不支持系统动作 ${String(input.action)}`);
				}),
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
