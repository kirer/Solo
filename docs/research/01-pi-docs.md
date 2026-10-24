# Pi 官方文档深度调研（面向技术选型 + 实现计划）

> 调研对象：https://pi.dev/docs/latest 及其站内全部子页面。
> 正文源自仓库 `packages/coding-agent/docs/*.md`（pi.dev 每页 "Edit on GitHub" 直指该文件）；关键结论另做本地实测（`pi` 1.4.0 / Node v26.12.0 / macOS）。调研时间 2026-10。

---

## 结论摘要（给决策者）

1. **Pi 是「可扩展的终端 coding agent」**，产品形态是 CLI + TUI。SDK / JSON / RPC 是它的被嵌入形态，不是主产品；**没有服务端形态**。([index](https://pi.dev/docs/latest))
2. **二次开发是它最大的差异化，也是选型关键**：扩展就是**一个 TypeScript 文件**，`export default (pi: ExtensionAPI) => {...}`，用 `jiti` 直接加载，**无需编译、无需 npm 包、无需构建**。`pi -e ./hello.ts` 即生效。（已实测）
3. **扩展点覆盖度极高**：工具、斜杠命令、快捷键、CLI flag、provider、虚拟模型路由、MCP server、消息渲染器、状态栏/编辑器/头尾 UI，以及约 **40 个生命周期事件**（含 `tool_call` 拦截、`context` 改写、`agent_before_settle` 续跑）。([types.ts](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/core/extensions/types.ts))
4. **可编程嵌入三条路**：in-process SDK（`createAgentSession()`）、子进程 `RpcClient`、跨语言 RPC（JSONL over stdio），另有 `-p` / `--mode json`。**三条路均已本地实测可用**。
5. **Pi 本体没有 subagent**。官方只给了一个**示例扩展** `examples/extensions/subagent/`（1036 行），做法是 **spawn 子 `pi` 进程 + `--mode json -p --no-session`**，支持单发/并行（8 任务、4 并发）/链式。→ **多 agent 在 Pi 上是用户态实现，不是内核能力。**
6. **要做真正的多 agent 编排，官方答案是 `@earendil-works/pi-durable`**（1.4.0，已上 npm）：持久化 conversation + task + checkpoint 崩溃恢复 + fork + 后台任务 + 所有权树 + 多客户端。**但官方首行即标注 Experimental，API 会不兼容变更。**
7. **没有内置沙箱**。工具与扩展以 Pi 进程 OS 权限运行；project trust 只管「加载哪些项目资源」，**不限制工具能访问什么**。隔离只能靠容器/VM。([security](https://pi.dev/docs/latest/security))
8. **没有 shell hooks 概念**（不是 Claude Code 那种），对应物是 `pi.on(event, handler)`。**没有内置 plan mode**，plan mode 是示例扩展（提供 `/plan`）。
9. **硬约束**：Node **>= 22.19.0**（npm `engines` 实测），也支持 Bun；TS 扩展走 jiti 无需 `tsc`；macOS / Linux / Windows(Git Bash 或 WSL) / Termux。
10. **结论**：做「一人公司多 agent 组织」，**用 Pi 当交互内核 + 能力层，编排层自己写**是可行的；若产品本身就是「agent 组织」且要长跑/崩溃恢复/多人协同，应基于 **pi-durable**（接受 experimental 风险，并加 adapter 层隔离）。

---

## 1. Pi 是什么

> "Pi is an extensible AI agent that works from your terminal. Give it a goal and a working folder, and it can inspect files, run commands, edit content, and work through multi-step tasks."
> — https://pi.dev/docs/latest

适用面不止写代码：软件开发、调研笔记、写作、数据文件。哲学主张是 **malleable**——连官方自己的 codemode / tool_search / MCP 都用扩展机制实现（builtin extensions，见 §4.6）。OG 图 alt 是 "There are many agent harnesses, but this one is yours."

### 1.1 形态矩阵

- **CLI + TUI**（主形态）— `pi` 进全屏终端 UI（fullscreen 默认，可 `--tui-mode regular`）· [usage](https://pi.dev/docs/latest/usage)
- **Print** — `pi -p "..."` 跑一次、输出最终文本、退出 · [cli](https://pi.dev/docs/latest/cli)
- **JSON 事件流** — `--mode json`，stdout 输出 JSONL · [json](https://pi.dev/docs/latest/json)
- **RPC** — `--mode rpc`，stdin/stdout JSONL 双向长连接 · [rpc](https://pi.dev/docs/latest/rpc)
- **SDK（库）** — `@earendil-works/pi-coding-agent` 在 Node/Bun 进程内嵌 · [sdk](https://pi.dev/docs/latest/sdk)
- **服务端** — **没有**；服务端/多客户端能力在 `pi-durable` · [Pi Durable](https://earendil.com/posts/pi-durable/)

### 1.2 包结构（monorepo `earendil-works/pi`，同版本 1.4.0）

- `pi-coding-agent` — CLI + SDK 主包（`bin: pi`）
- `pi-ai` — 统一 LLM API + 模型目录 + provider 实现
- `pi-agent-core` — 通用 agent 内核（transport 抽象、状态管理）
- `pi-tui` — 终端 UI 组件库（diff 渲染）
- `pi-mcp` — 独立 MCP 客户端
- `pi-codemode` — QuickJS 沙箱（唯一能力是调注入的 tool）
- `pi-durable` — 持久化 harness（experimental）
- `chord` — 插件宿主运行时、文档状态、JSON link RPC

---

## 2. 安装与使用

### 2.1 安装

```bash
curl -fsSL https://pi.dev/install.sh | sh                      # 推荐：pin 全部依赖，用 pi update 更新
npm install -g --ignore-scripts @earendil-works/pi-coding-agent # 需 Node >= 22.19，不 pin 传递依赖
nix profile add github:earendil-works/pi/stable                # 源码构建
```

> npm 上有 `legacy-node20` dist-tag（0.74.2）——0.74.x 是最后支持 Node 20 的线。

### 2.2 启动

```bash
cd /path/to/folder && pi          # 交互式 TUI
pi -p "Summarize this repo"       # 一次性
git diff | pi -p "Review this"    # stdin 管道
pi --mode json "Inspect repo" > events.jsonl
pi --continue                     # 续上一个 session
pi @file.md @img.png "问题"        # @ 引文件
```

cwd 同时决定：项目配置发现、资源发现、**session 分组**。

### 2.3 配置目录

用户级 `~/.pi/agent`（`PI_CODING_AGENT_DIR` / SDK `agentDir` 可覆盖）；项目级 `<cwd>/.pi`。

- `settings.json` — 用户设置（偏好、默认值、资源路径、package 声明）
- `keybindings.json` / `mcp.json` / `models.json` — 键位 / 全局 MCP / 兼容 endpoint 与模型 override
- `auth.json` — **保存的 API key 与 OAuth 凭据（敏感）**
- `AGENTS.md` / `CLAUDE.md` / `AGENTS.override.md` — 跨目录指令
- `SYSTEM.md` / `APPEND_SYSTEM.md` — 替换 / 追加系统提示
- `extensions/` `skills/` `prompts/` `themes/` — 用户级资源；`trust.json` — 项目信任决策
- 项目级 `.pi/`：`settings.json`、`mcp.json`、`extensions|skills|prompts|themes`、`SYSTEM.md` — **均需 project trust**

`settings.json` 可加 `"$schema": "https://pi.dev/schemas/settings.schema.json"`。项目设置**覆盖**用户设置，但**资源列表是合并**的。来源：https://pi.dev/docs/latest/configuration

### 2.4 模型与 provider

三条路径，复杂度递增：

1. `/login`（OAuth 或存 key 到 `auth.json`）→ `/model` 选模型 → `/thinking` 选思考级别
2. 环境变量：`ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `DEEPSEEK_API_KEY` / `GEMINI_API_KEY` / `OPENROUTER_API_KEY` …（约 40 个 provider）
3. `models.json`（Ollama / LM Studio / vLLM / SGLang 等兼容 endpoint）：

```json
{ "$schema": "https://pi.dev/schemas/models.schema.json",
  "providers": { "ollama": { "baseUrl": "http://localhost:11434/v1",
    "api": "openai-completions", "apiKey": "ollama",
    "models": [{ "id": "qwen2.5-coder:7b" }] } } }
```

凭据优先级：`--api-key` > `auth.json` > `models.json` 的 `apiKey` > provider 环境变量 / 云 ambient 凭据。
`apiKey` 支持 `$NAME` / `${NAME}` 插值、`!command` 取命令输出、`$$` 转义。
来源：https://pi.dev/docs/latest/models 、https://pi.dev/docs/latest/providers

### 2.5 会话持久化

```
~/.pi/agent/sessions/--<path>--/<timestamp>_<session-id>.jsonl
```

`<path>` = cwd 去前导 `/` 并把 `/ \ :` 换成 `-`。JSONL，每行一个 entry，**树结构**（`id`/`parentId`），当前 entry = active branch。
版本 v1 线性（自动迁移）→ v2 树 → **v3**（`hookMessage` role 改名 `custom`）。
覆盖优先级：`--session-dir` > `PI_CODING_AGENT_SESSION_DIR` > `sessionDir`。`--no-session` 为内存态。
来源：https://pi.dev/docs/latest/session-format

### 2.6 Slash 命令

- 模型/设置：`/settings` `/model` `/thinking` `/scoped-models` `/login` `/logout` `/llama`
- 会话：`/new` `/resume` `/name` `/session` `/tree` `/fork` `/clone` `/compact` `/import`
- 导出：`/copy` `/export` `/share` `/bug`
- 运行时/项目：`/trust` `/mcp` `/reload` `/hotkeys` `/changelog` `/quit`

扩展、prompt template、skill 都能加命令（skill 是 `/skill:name`）。来源：https://pi.dev/docs/latest/slash-commands

### 2.7 TUI 交互要点

- `Enter` 发送 / `Shift+Enter` 换行 / `Ctrl+G` 外部编辑器；`@` 搜文件、`Tab` 补全、图片可粘贴拖入
- `Ctrl+O` 折叠工具输出；`Ctrl+T` 显隐 thinking
- **运行中可继续输入**：`Enter` = steer（本轮工具调用后插入）；`Alt+Enter` = follow-up（本轮全部结束后）；`Alt+Up` 退回排队消息；`Esc` 中断
- `!cmd` 执行并把输出给模型；`!!cmd` 执行但不给模型
- footer：cwd / session / model / context 用量 / 累计 usage + cost

来源：https://pi.dev/docs/latest/usage

---

## 3. 能力清单

### 3.1 工具

默认启用 `read` `bash` `edit` `write`；可选 `grep` `find` `ls` `powershell`(Windows)。

- `read` — 读文本/图片，截断 2000 行或 50KB
- `bash` — 跑 shell，输出截断最后 2000 行/50KB，完整版落临时文件
- `edit` — 精确替换，**一次调用可含多个 disjoint edits**（`edits[]`）
- `write` — 创建/覆盖

两个 builtin extension 工具（默认关）：`codemode`（写 JS 批量调工具，QuickJS 沙箱，只有脚本输出进模型）、`tool_search`（搜索未声明工具并声明给下一次调用）。来源：https://pi.dev/docs/latest/cli#tools

### 3.2 其余能力一览

- **子 agent** ❌ 非内置（仅示例扩展，§6.1）
- **hooks** ❌ 无 shell hook 机制，用 `pi.on(event, handler)` 替代（§4.4）
- **extensions** ✅ 核心，见 §4
- **MCP** ✅ 原生；stdio + streamable HTTP（**不支持 SSE**）；工具名 `mcp__<server>__<tool>`；支持 OAuth；`direct`/`codemode`/`deferred` exposure 控制上下文占用
- **skills** ✅ Agent Skills 规范；`SKILL.md` + frontmatter；启动只注入 name/description/path，正文按需读；含 `~/.agents/skills/`、`.agents/skills/`
- **AGENTS.md** ✅ 从 agent dir + cwd + **所有父目录**加载；`AGENTS.override.md` 仅同目录替换；**不需要 trust 就加载**（危险点）；`-nc` 可关
- **plan mode** ❌ 示例扩展；`/plan` `/todos` `Ctrl+Alt+P`，禁用 edit/write、bash 只读白名单、`[DONE:n]` 跟踪
- **compaction** ✅ `contextTokens > contextWindow - reserveTokens`(16384) 或 `/compact`；`keepRecentTokens` 20000；原始 entry 永不删
- **cost/usage** ✅ footer 实时、`/session`、每条 message 带 `usage{input,output,cacheRead,cacheWrite,cost}`、RPC `get_session_stats`
- **权限/沙箱** ❌ 无沙箱，仅 project trust + 外部容器

来源：mcp / skills / configuration#context-files / compaction / rpc-commands 各页

### 3.3 codemode（值得单列）

模型写 JS 在 QuickJS 沙箱跑（无 Node API/文件/网络/timer），通过 `tools.<name>(args)` 调工具，**只有脚本输出进上下文**。
价值：并行（`Promise.allSettled`）、大结果先在脚本里过滤、`models.classify()`、`models.generateImages()`。
限制：`max_output_tokens` 默认 10000；单进程 worker 默认 2（`PI_CODEMODE_MAX_WORKERS`）；每 worker 256MB。来源：https://pi.dev/docs/latest/codemode

### 3.4 安全模型（选型必读）

> "Pi's tools and extensions run with the permissions of the Pi process. Project trust controls which project resources Pi loads, but it does not sandbox tool calls."

- **project trust 只决定加载哪些项目资源**，不是启动边界（`sessionDir` 在 trust 之前就被读了）
- 信任决策优先级：`--approve`/`--no-approve` > 扩展的 `project_trust` 事件 > `~/.pi/agent/trust.json` > `defaultProjectTrust`(默认 `ask`)
- **print / JSON / RPC 模式无法弹信任提示**：`ask`/`never` 等于直接跳过受保护资源
- 隔离手段全在外部：Docker、Docker Sandboxes、OpenShell、Gondolin 扩展（micro-VM 只隔离内置工具）

来源：https://pi.dev/docs/latest/security 、https://pi.dev/docs/latest/containerization

---

## 4. 二次开发流程（重点）

### 4.1 心智模型

扩展 = 一个模块，`export default` 工厂函数，收到 `ExtensionAPI`，在工厂里**注册**能力。

```ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.registerCommand("hello", {
    description: "Show a greeting",
    handler: async (name, ctx) => {
      ctx.ui.notify(`Hello, ${name || "world"}!`, "info");
    },
  });
}
```

**关键：Pi 用 `jiti`，本地 TS 扩展不需要编译。** 无需 `package.json`、无需 `tsc`、无需 publish。
（实测：含 `defineTool` + `registerCommand` 的单个 `.ts` 文件，`pi -e ./hello.ts -p "..."` 直接跑通，模型成功调用了自定义工具。）

### 4.2 放哪里 / 怎么加载

- `<agent-dir>/extensions/` — 用户级，**默认发现**
- `.pi/extensions/` — 项目级，**需 trust**
- `settings.json` 的 `extensions: string[]` — 显式路径（支持 `!pattern` / `+path` / `-path`）
- `pi -e <path>` / `--extension` — 单次运行，可重复，也接受 `builtin:mcp`
- **Pi package** — npm / git / 本地目录（§4.7）

发现规则：**直接 `.ts`/`.js` 文件**，或**含 `index.ts`/`index.js` 的子目录**。多文件扩展放子目录，依赖放附近 `package.json`。

### 4.3 自定义工具（最小可运行）

```ts
// ~/.pi/agent/extensions/hello.ts
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

const helloTool = defineTool({
  name: "hello",
  label: "Hello",
  description: "A simple greeting tool",
  parameters: Type.Object({ name: Type.String({ description: "Name to greet" }) }),
  async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
    return {
      content: [{ type: "text", text: `Hello, ${params.name}!` }],
      details: { greeted: params.name },   // details 供渲染/状态重建，不进模型上下文
    };
  },
});

export default function (pi: ExtensionAPI) {
  pi.registerTool(helloTool);
}
```

`ToolDefinition` 关键字段：

- 必填：`name` / `label` / `description` / `parameters`(TypeBox schema)
- `promptSnippet` — 系统提示 "Available tools" 段的一行说明；**不填则自定义工具不出现在该段**
- `promptGuidelines` — 追加到系统提示 Guidelines
- `execute(id, params, signal, onUpdate, ctx)` — 抛异常 = 失败结果；返回对象 ≠ 错误
- `outputSchema` + `structuredContent` — 给 codemode 脚本用的结构化输出
- `exposure` — `direct`(默认) / `model-only` / `codemode` / `deferred` / `hidden`
- `namespace` — 工具分组（MCP 风格）；`annotations` — `readOnlyHint`/`destructiveHint`/`idempotentHint`/`openWorldHint`
- `defaultActive` / `reachesTools` / `renderCall` / `renderResult` — 激活控制 / 可触达工具声明 / 自定义渲染

要点：文件改写必须用 `withFileMutationQueue()` 包住整个 read-modify-write；共享可变状态用顺序执行；大结果截断并告诉模型去哪读完整版；工具内可 `ctx.executeTool(name, args, {signal, onUpdate})` 嵌套调其他工具（走同样校验与 hook，事件带 `parentToolCallId`，不进 transcript）。
来源：https://pi.dev/docs/latest/extensions#tools 、types.ts

### 4.4 事件（≈ hooks）全清单

`pi.on(event, handler)` 返回 unsubscribe；handler 按**扩展加载顺序**执行。

**事件按域分组**（共约 40 个）：

- 输入准备：`input`、`before_agent_start`
- Agent 运行：`agent_start`、`agent_end`、`agent_before_settle`、`agent_settled`
- 模型轮次：`turn_start`、`context`、`context_with_system`、`turn_end`
- Provider：`before_provider_headers`、`before_provider_request`、`after_provider_response`、`provider_stream_event`
- 消息：`message_start`、`message_update`、`message_end`
- 工具：`tool_execution_start`、`tool_call`、`tool_execution_update`、`tool_result`、`tool_execution_end`
- 会话：`project_trust`、`resources_discover`、`session_start`、`session_info_changed`、`session_before_switch`、`session_before_fork`、`session_before_compact`、`session_compact`、`session_compact_failed`、`session_before_tree`、`session_tree`、`session_shutdown`
- 其他：`mcp_servers_change`、`model_select`、`thinking_level_select`、`user_bash`、`cache_warming_decision`、`ui_prompt_start`、`ui_prompt_end`

组合语义（决定 handler 怎么写）：

- **通知** — 返回值被忽略
- **原地修改** — 后续 handler 能看到对 `before_provider_headers.headers`、`before_agent_start.systemPromptOptions`、`tool_call.input` 的修改
- **链式转换** — `input`/`context`/`context_with_system`/`message_end`/`tool_result`/`before_provider_request` 的返回值传给下一个
- **闸门** — 被 handle 的 input、被 block 的 tool call、被 cancel 的 session 操作**终止正常回退路径**
- **可行动边界** — `turn_end` / `agent_before_settle` 能看到「已提议的 entries 和 continue 决策」

权限拦截最小示例（官方 `permission-gate.ts`）：

```ts
export default function (pi: ExtensionAPI) {
  const dangerous = [/\brm\s+(-rf?|--recursive)/i, /\bsudo\b/i, /\b(chmod|chown)\b.*777/i];

  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName !== "bash") return undefined;
    const command = event.input.command as string;
    if (!dangerous.some((p) => p.test(command))) return undefined;

    if (!ctx.hasUI) {
      return { block: true, reason: "Dangerous command blocked (no UI for confirmation)" };
    }
    const choice = await ctx.ui.select(`⚠️ ${command}\n\nAllow?`, ["Yes", "No"]);
    if (choice !== "Yes") return { block: true, reason: "Blocked by user" };
    return undefined;
  });
}
```

**`tool_call` handler 抛异常 = block（fail closed）**——安全上的正确默认。来源：https://pi.dev/docs/latest/extensions#events

### 4.5 自定义 provider

```ts
// A. 只改 endpoint / header（保留内置模型目录、鉴权、API 实现）
pi.registerProvider("anthropic", {
  baseUrl: "https://gateway.example.com/anthropic",
  headers: { "X-Gateway-Key": "$GATEWAY_API_KEY" },
});

// B. 注册全新兼容 endpoint
pi.registerProvider("acme", {
  name: "Acme AI", baseUrl: "https://api.acme.example/v1",
  apiKey: "$ACME_API_KEY", api: "openai-completions",
  models: [{ type: "chat", id: "acme-chat", name: "Acme Chat", reasoning: false,
             input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
             contextWindow: 128000, maxTokens: 8192 }],
});
```

决策树：只加模型/改 endpoint → **用 `models.json`，别写扩展**；要动态发现 → `refreshModels`；要 `/login` OAuth → `oauth`；非标准协议 → `streamSimple`（**最后手段**，先读 `packages/ai/src/api` 现有实现）。
可复用实现：Anthropic Messages、OpenAI Chat Completions / Responses、Google Generative AI / Vertex、Azure OpenAI Responses、Mistral Conversations、Bedrock Converse。

**虚拟模型**（`registerVirtualModel`）：对外一个模型名，每次请求按任务/成本/状态路由到真实模型。来源：custom-provider / virtual-models 页

### 4.6 内置扩展 = 同一套 API

`codemode`、`tool_search`、MCP、llama.cpp 都是 **builtin extensions**（`builtin:codemode` / `builtin:tool-search` / `builtin:mcp` / `builtin:llama.cpp`）。可用 `-builtin:mcp` 关闭，`pi config` 可视化开关，**且可被用户扩展替换**——`codemode` 只用了 `exposure`、`reachesTools`、`ctx.executeTool()`、`prepareLoadout()` 四个公开能力。→ **做编排层不需要 fork Pi。**

### 4.7 打包分发（Pi package）

```
my-pi-package/
├── package.json
├── extensions/  skills/  prompts/  themes/
```

需要时显式声明：

```json
{
  "name": "my-pi-package",
  "keywords": ["pi-package"],
  "pi": {
    "extensions": ["./src/extension.ts"],
    "skills": ["./resources/skills"],
    "prompts": ["./resources/prompts/*.md"],
    "themes": ["./resources/themes/*.json"]
  }
}
```

```bash
pi install npm:@example/pi-tools@1.0.0
pi install git:github.com/example/pi-tools@v1
pi -e npm:@example/pi-tools        # 试装不写 settings
```

**依赖铁律**：宿主提供的包（`pi-ai`、`pi-agent-core`、`pi-coding-agent`、`pi-tui`、`typebox`）必须放 `peerDependencies: "*"`，**绝不能放 `dependencies`**——物理副本会绕过 Pi 的模块映射，造成重复 class / registry / 初始化，Pi 会警告。已安装包各有独立 module root，别指望共享依赖实例。来源：https://pi.dev/docs/latest/packages

### 4.8 生命周期陷阱（文档明说）

- **别在工厂里起进程/socket/watcher/timer**——有些调用会加载扩展但不启动 session。长生命周期资源放 `session_start` 或真正需要它的命令/工具里
- `session_shutdown` 的清理要**幂等**（cancel / reload / session 替换 / 进程退出都会走到）
- `await ctx.reload()` 之后的代码仍属**旧 runtime**，不能复用旧 session 绑定状态
- 命令 handler 独有能力（等 idle、reload、tree 导航、session 替换）**不能**在生命周期 handler 里调，会死锁
- 一个 assistant message 的多个 tool call **可能并行**，不要假设兄弟 call/result 存在

来源：https://pi.dev/docs/latest/extensions#understand-the-lifecycle

---

## 5. 可编程嵌入

### 5.1 SDK（in-process）

```ts
import { createAgentSession, SessionManager } from "@earendil-works/pi-coding-agent";

const { session } = await createAgentSession({
  cwd: "/path/to/project",
  tools: ["read", "grep", "find", "ls"],       // 只读
  sessionManager: SessionManager.inMemory(),   // 不落盘
});

const unsub = session.subscribe((event) => {
  if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
    process.stdout.write(event.assistantMessageEvent.delta);
  }
});

try {
  await session.prompt("Explain this repository");
  console.log(session.getLastAssistantText());
} finally {
  unsub();
  session.dispose();
}
```

**已本地实测通过**（直接 import `dist/index.js`，Node v26 下正常流式输出 + `getLastAssistantText()`）。

`CreateAgentSessionOptions`：`cwd`、`agentDir`、`modelRuntime`、`model`、`thinkingLevel`、`scopedModels`、`noTools`(`"all"|"builtin"`)、`tools`、`excludeTools`、`customTools`、`resourceLoader`、`sessionManager`、`settingsManager`、`sessionStartEvent`。
会话控制：`prompt()` / `steer()` / `followUp()` / `abort()` / `waitForIdle()` / `dispose()`；`AgentSessionRuntime` 另有 `newSession()` / `switchSession()` / `fork()` / `importFromJsonl()`，**每次替换 active session，旧订阅必须重绑**。
⚠️ `session.agent.state.messages = ...` **不会**替换持久化上下文，`SessionManager` 才是 model context 唯一权威。

来源：https://pi.dev/docs/latest/sdk

### 5.2 print / json

```bash
pi -p "..."                       # 只输出最终文本；错误走 stderr
pi --mode json "..." > ev.jsonl   # JSONL 事件流
```

`--mode json` 实测序列：`session` → `agent_start` → `turn_start` → `message_start` → `message_update`(delta) → `message_end` → `turn_end` → `agent_end` → `agent_settled`。

**关键语义：`agent_end` ≠ 结束**（后面还可能有 retry / overflow recovery / compaction retry / steering / follow-up）；**`agent_settled` 才是「不会自动继续」**。
print 退出码：`error`/`aborted` → 非零；`length`（撞输出上限）→ 仍打印部分文本 + stderr 警告 + 非零。
JSON 模式：失败/中止的 response **不**自动导致非零退出码，必须自己看事件。

来源：https://pi.dev/docs/latest/json 、https://pi.dev/docs/latest/cli-integration

### 5.3 RPC

```bash
pi --mode rpc --no-session
```

stdin 写 JSON 命令（一行一个），stdout 读 `response` + session events，LF 严格分帧。
命令带 `id` 关联；**处理是异步的，必须按 id 关联，不能按顺序**。
命令集：`prompt` `steer` `follow_up` `abort` `clear_queue` `new_session` `get_state` `get_messages` `set_model` `cycle_model` `get_available_models` `set_thinking_level` `set_steering_mode` `set_follow_up_mode` `compact` `set_auto_compaction` `set_auto_retry` `abort_retry` `bash` `abort_bash` `get_session_stats` `export_html` `switch_session` `fork` `clone` `get_fork_messages` `get_entries` `get_tree` `get_last_assistant_text` `set_session_name` `get_commands`。

**已本地实测**：管道喂 `get_state` + `get_session_stats`，两条 response 正常返回（含 model 元信息、contextUsage）。
⚠️ Node `readline` 会在 `U+2028`/`U+2029` 断行（JSON 字符串里合法）——**必须用字节流按 `\n` 切**。
⚠️ `prompt` 成功响应只代表「接受/排队/已处理」，不代表跑完。
Node 侧可直接用 `RpcClient`（起子进程、关联请求、投递事件），`promptAndWait()` 内部先装监听再发 prompt 避免竞态。

### 5.4 三条路怎么选

- **SDK** — 同进程，直接 TS 方法 + 事件；适合 Node/Bun 宿主要完整 API
- **RPC** — 子进程，JSONL 命令/响应/事件；适合其他语言、进程隔离、IDE、自定义客户端
- **CLI (print/json)** — 子进程一次性，参数进、文本/事件出；适合脚本、CI、一次性任务

---

## 6. 多 agent / 编排

### 6.1 官方示例扩展 subagent（用户态实现）

`examples/extensions/subagent/`（`index.ts` 1036 行 + `agents.ts` + `agents/*.md` + `prompts/*.md`）

核心实现（`index.ts` 1036 行）：`spawn("pi", ["--mode","json","-p","--no-session", "--model", …, "--tools", …, "--append-system-prompt", <tmpfile>, "Task: …"])`，逐行解析 stdout 的 JSONL 事件取 `message_end` 与 `turn_end.message.usage`。

- **Single** `{ agent, task }` — 一个 agent 一个任务
- **Parallel** `{ tasks: [...] }` — **最多 8 任务、4 并发**，每任务模型可见输出上限 50KB
- **Chain** `{ chain: [...] }` — 顺序，`{previous}` 占位传上一步输出

Agent 定义（markdown + YAML frontmatter）：

```markdown
---
name: scout
description: Fast codebase recon, returns compressed context
tools: read, grep, find, ls, bash
model: claude-haiku-4-5
---
You are a fast recon agent. Return compressed context, not raw files.
```

位置：`~/.pi/agent/agents/*.md`（总是加载）、`.pi/agents/*.md`（**只有 `agentScope: "project"|"both"` 才加载**，非信任项目还会二次确认）。model 省略则继承调度方。

**限制**：崩溃不可恢复（`--no-session`，子进程死即丢）；无跨 agent 共享状态（只能靠 prompt 传）；折叠视图只显示最后 10 条。

### 6.2 coding-agent 本体的编排基础件

- 持久化会话 ✅ JSONL 树，`--continue` / `--session` / `/resume`
- fork / 分支 ✅ `/fork`（从某条 user message 派生）、`/clone`、`--fork`、`/tree`（原分支不删）
- 并发 ⚠️ 单 session 内串行；多 agent 靠多进程
- 后台任务 ❌ 无原生概念（仅 MCP 连接、模型目录刷新在后台）
- 编排 DSL ❌ 无；子 agent ❌ 非内置；跨 session 成本归集 ❌ 每 session 独立统计

### 6.3 pi-durable：官方给「多 agent 组织」的答案

> "Pi the coding agent is built to run on your (remote) machine, inside a terminal, driven by one person... Pi Durable is that harness."

- **Harness** — 打开一个 storage backend，跑 N 个 conversation
- **Conversation** — 不可变 entry 的 transcript，可 fork，自带 agent 配置（model/thinking/extensions/tools/cwd）
- **Task** — 每个 model request、tool call、compaction 都是 task，**每步前存 checkpoint**
- **Extension** — `defineExtension({ name, sections, tools, hooks, tasks, wraps })`
- **Hook** — `hook(ToolTask, {beforeTool, afterTool})`、`hook(GenerationTask, {beforeRequest, afterResponse, onYield, afterTools})`
- **Document** — 类型化 JSON 状态，与 transcript 同一次原子 commit 提交

杀手级能力：**崩溃恢复**（`harness.resume()` 从 checkpoint 续跑；`replay: "safe"` 才重跑，否则告诉模型被打断）、**exactly-once**（`requestId`）、**并发多 conversation**、**后台任务**（`{background:true}` 活过本轮）、**所有权树**（abort 自底向上清理）、**subagent = 几行代码**、**多人多客户端**（`viewState()` 拿当前视图后只收增量）、**热更新**（同名 `registry.install()` 替换，运行中用旧代码跑完）。
Storage：Memory / SQLite / JSONL / IndexedDB / Cloudflare Durable Object。

⚠️ **README 首行：Experimental，API 会不兼容变更。**

```typescript
const Subagent = defineExtension({
  name: "subagent",
  tools: [defineTool({
    name: "subagent", description: "Delegate a task to a subagent",
    parameters: Type.Object({ task: Type.String() }),
    replay: "safe",
    execute: async (args, api, context) => {
      const child = await api.commit(async (tx) => {
        const existing = (await tx.scanConversations({ ownerTaskId: api.taskId }, 1)).items[0];
        if (existing) return existing.id;
        const created = await tx.createConversation({ ownership: { kind: "task", taskId: api.taskId } });
        await configure(tx, created.id, { model: haiku, extensions: { remove: [Subagent] } });
        return created.id;
      }, context);
      const request = { type: "input", content: args.task, requestId: `subagent:${api.taskId}` } as const;
      const settled = await (await (await api.conversation(child, context))!.submit(request, context)).wait(context);
      return { output: [{ type: "text", text: settled.status }] };
    },
  })],
});
```

来源：https://github.com/earendil-works/pi/blob/main/packages/durable/README.md 、https://earendil.com/posts/pi-durable/

---

## 7. 坑与限制

### 7.1 experimental 标记

- `pi-durable` 整包 — **Experimental，API 不兼容变更**
- `allowed-tools`（skill frontmatter）— Experimental
- 分类模型的图片输入（TypeSafe 自家 API）— Experimental
- durable 的 agent events — Experimental（章节标题自带）

### 7.2 版本 / 运行时

- **Node >= 22.19.0**（1.x 线）；0.74.2 是 `legacy-node20` 末班车
- npm 安装**不 pin 传递依赖**（官方建议用 installer）
- `pi update` **无法**更新 Nix 安装的 Pi
- 卸载（npm / installer / Nix）**都不清理** `~/.pi/agent/` 的配置、凭据、session、packages

### 7.3 平台

- Windows：原生走 Git Bash（`bash` 工具 + `!` 命令），可选 `powershell` 工具；或 WSL
- Windows Terminal 会抢占部分 Alt 快捷键（含 `Alt+Enter`）
- SSH 下 `PI_TUI_ESC_TIMEOUT` 默认 100ms，Alt 键可能被误判成 Esc
- 终端能力（鼠标、inline image、快捷键）差异大

### 7.4 安全

- **无内置沙箱**，工具与扩展 = Pi 进程权限
- project trust **不是**启动边界（`sessionDir` 在 trust 前读取）
- **AGENTS.md / CLAUDE.md 无论 trust 与否都加载**——prompt injection 入口
- print / JSON / RPC 模式**无法交互确认 trust**，`ask` 等于跳过受保护资源
- 扩展能看 prompt、tool call、文件、**凭据**、session 历史

### 7.5 协议 / API 坑

- **`agent_end` 不是终态**，必须等 `agent_settled`
- RPC 分帧**不要用 `readline`**（`U+2028`/`U+2029`）
- RPC 模式**拒绝 `@file` 参数**，prompt 只能走 `prompt` 命令
- JSON / RPC 的 **stdout 专供协议**，日志必须走 stderr
- `prompt()` 在已流式输出时**必须**指定 steer 还是 followUp，否则 reject
- `--fork` 不能与 `--session`/`--continue`/`--resume`/`--no-session` 组合；`--session-id` 不能与 `--session`/`--continue`/`--resume` 组合
- MCP **不支持 SSE**；工具名非 `[A-Za-z0-9_]` 字符替换成 `_`，冲突加 hash
- `--tools` 用普通名字会**替换整个选择**（不是追加）；`+name`/`-name` 才是增量，两者不能混用
- 扩展包把宿主包放 `dependencies` 会造成重复 class/registry
- `ctx.mode` 只有 `"tui"` 有完整 UI；RPC 能转发对话框；JSON/print **完全没有 UI**——行为必须与渲染解耦
- `session.agent.state.messages = ...` 不替换持久化上下文（SDK）
- `AgentSessionRuntime` 替换 session 后**旧订阅失效**

### 7.6 功能缺口

内置 subagent / 编排 DSL / 后台任务 / plan mode / shell hooks / 跨 session 成本汇总 / 服务端多租户 —— **全都没有**。并发：单 session 串行，多 agent 必须多进程或多 conversation（durable）。

---

## 8. 对「一人公司多 agent 组织」这类应用的可行性判断

### 8.1 结论：可行，但要认清「哪一层用 Pi」

- **交互层**（TUI、会话管理、模型切换、成本可见）— ✅ **极强**，开箱即用，TUI 质量高于自研
- **能力层**（工具、MCP、skills、权限、provider）— ✅ **极强**，扩展点覆盖度罕见
- **编排层**（角色、任务分派、并发、状态、恢复、审计）— ⚠️ coding-agent 里基本没有；pi-durable 有但 experimental

→ 推荐架构：**Pi coding-agent 当「一个员工的工作台」，编排层自己写（或用 pi-durable）**。

### 8.2 三条可选路线

**路线 A：扩展式编排（最快落地，风险最低）**
在 Pi 内写 `orchestrator` 扩展：`registerTool("delegate")` 内部 `spawn("pi", ["--mode","json","-p","--no-session",...])` 解析 JSONL 拿 usage 与最终文本；角色定义放 `.pi/agents/*.md`（复用官方 frontmatter）；`tool_call` handler 做**按角色的权限闸门**；`pi.appendEntry()` 存编排状态、`session_start` 时用 `ctx.sessionManager.getBranch()` 重建；并发用 `Promise.allSettled` + 自建信号量。
✅ 一天能跑通；完全复用 Pi 的 TUI/模型/成本显示；不碰 experimental API。
❌ 子 agent 崩溃即丢；无跨 agent 事务；状态一致性自理；成本汇总要自己写。
**适用**：1 个老板 agent + 3-5 个职能 agent 的规模。

**路线 B：SDK 宿主（最灵活，工程量中等）**
自己的 Node 服务里 `createAgentSession()` 起 N 个 session（每角色一个 `SessionManager`），统一调度/计费/审计。
✅ 完全掌控，可做真正的并发、队列、重试、持久化编排。
❌ TUI 要自己写；要处理 `dispose()`、订阅重绑等生命周期细节。
**适用**：Web 界面 / 多用户 / 嵌进现有业务系统。

**路线 C：基于 pi-durable（能力最全，风险最高）**
`Harness.open(sqliteStorage)`，用 conversation + task + ownership 树建模组织：每职能一个 conversation，`ownership: {kind:"task", taskId}` 挂在调度它的 tool call 下；`harness.resume()` 崩溃续跑；`{background:true}` 做活过本轮的 agent；`viewState()` + `watch()` 支撑多端观察。
✅ 官方唯一为「多 agent + 长跑 + 多人」设计的抽象。
❌ **API 会不兼容变更**；资料少；TUI 要自己实现（可借 `pi-tui`）。
**适用**：产品形态就是「agent 组织」，能跟着上游改 API。

### 8.3 建议分阶段

1. **P0（1-2 周）** 路线 A 验证：`delegate` 扩展 + 3 个角色 md + `tool_call` 权限闸门。验证「角色 prompt + 工具白名单」产出质量与单次分派成本。
2. **P1（2-4 周）** 补编排基础设施：任务队列、并发上限、失败重试、成本归集（解析子进程 `turn_end.message.usage.cost`）、审计落盘（`pi.appendEntry` 或外部 SQLite）。
3. **P2（视产品形态）** 要 Web/多用户 → 路线 B；要长跑/崩溃恢复/多人协同 → 路线 C，并**把 durable API 用法隔离在 adapter 层**。
4. **贯穿** 权限/沙箱从一开始就设计成外部边界（容器 / 独立 OS 用户 / Gondolin），**不要拿 project trust 当安全边界**。

### 8.4 风险清单

- **pi-durable API 变更** → 路线 C 返工 · 缓解：adapter 层隔离，P0/P1 不依赖它
- **无内置沙箱** → 越权/注入 · 缓解：容器化；`tool_call` 闸门 + `annotations` 判定
- **子 agent 无状态恢复（A）** → 长任务丢失 · 缓解：只把短任务给子 agent；长任务走 C 或自建 checkpoint
- **成本不可控** → 多 agent 并发烧钱 · 缓解：`--model` 给便宜角色降级；`get_session_stats` 监控；调 compaction 参数
- **Node 22.19 硬门槛** → 部署环境受限 · 缓解：确认 CI/生产 Node 版本；或走 installer
- **扩展能读凭据** → 供应链风险 · 缓解：只装自研/审计过的扩展；`-ne` 白名单模式
- **单 session 串行** → 并发上不去 · 缓解：多进程（RPC/SDK），不是多线程

### 8.5 一句话建议

> **用 Pi 做「员工工作台」，不要用 Pi 做「组织架构」。**
> 交互层与能力层直接吃 Pi 的红利（TUI + 40 个事件 + 工具/MCP/skills），编排层自己写（先 A，规模化后迁 B/C）。
> 若最终产品本身就是「多 agent 组织」，pi-durable 是目前最贴近的官方抽象——接受 experimental 代价，预留 adapter。

---

## 附录：关键 URL

- 文档站：https://pi.dev/docs/latest （子页 `/{quickstart,how-pi-works,usage,cli,settings,configuration,extensions,custom-provider,virtual-models,sdk,cli-integration,json,rpc,rpc-commands,mcp,skills,packages,prompt-templates,sessions,session-format,compaction,security,containerization,codemode,environment-variables,tui}`）
- 权威类型定义：https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/core/extensions/types.ts
- 示例：`examples/extensions/subagent/`、`examples/extensions/plan-mode/`、`examples/sdk/`
- Pi Durable：https://earendil.com/posts/pi-durable/ 、https://github.com/earendil-works/pi/blob/main/packages/durable/README.md
- 仓库 / npm：https://github.com/earendil-works/pi 、https://www.npmjs.com/package/@earendil-works/pi-coding-agent
