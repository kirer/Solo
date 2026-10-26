# 【已归档 · 不再维护】

> 这份文档写于某个时间点，记录**当时**的设计推理与施工过程，**内容已冻结**。
> 现状一律以 `docs/SYSTEM.md`、`docs/CODE.md`、`docs/DECISIONS.md`、`openspec/specs/` 为准。
> 保留它只是为了回答「当初为什么这么决定」。里面的行号、文件路径、数量、截图链接都可能已失效。

---

# 七个问题的明确回答

> 回答日期：2026-10-24
> 每条都标注了**证据**：`实测` = 本机跑过（脚本在 `archive/spikes/`），`源码` = 读了 `archive/reference/pi` 的实现，`文档` = 官方文档明确写的。
>
> **这些答案已经在代码里落地了。** 本文保留了「为什么这样设计」的推理过程；
> 想知道实际怎么用，看 [`README.md`](../../README.md)；想知道实现细节，看 `src/`。

---

## 先说结论（一句话版）

| # | 问题 | 一句话回答 |
|---|---|---|
| 1 | 老板/CEO/管理层/项目/员工底层是什么？ | **全部是同一种东西：`Conversation`（会话）**。区别只在三样：`agent` 配置（模型/工具/人格）、`cwd`（工作目录）、`ownership`（归属关系）。不是 agent vs subagent 的物种差异，是**配置与归属的差异**。 |
| 2 | 创建项目会建文件夹吗？ | **会，但要我们自己建**——durable 不自动建目录，我们在 `project_create` 工具里 `mkdir` + 写 `PROJECT.md` + 把 `cwd` 指过去。实测员工真的在那里写出了文件。 |
| 3 | 员工的角色提示词/skill/MCP 谁给？ | **提示词由 CHRO 招聘时预设**（写进 `instructions`）；**skill 和 MCP 不是 durable 的内置概念**，要我们自己实现成工具。能力上完全做得到，但这是要写的代码，不是开箱功能。 |
| 4 | 管理层有决策权吗？ | **由你定，而且可以分级配置**。技术上两种都支持：要么给管理层 `decide` 工具让它自己拍，要么只给它 `escalate` 工具强制上转。建议按金额/风险分级。 |
| 5 | 能直接和任何人对话吗？分支对话两种形式怎么选？ | **能，三种形态**：①直接插话（进主线）②`fork` 到某条消息开分支（不污染主线）③新开独立会话（完全隔离）。**推荐默认用 fork**。 |
| 6 | token 能分别统计吗？ | **能，而且是最细的粒度**。会话级 / 项目级 / 角色级 / 单条消息级都有。**但有个致命坑**：fork 会话按 entries 求和会重复计账（实测虚高 26 vs 真实 19），必须读 `pi.usage` 文档。 |
| 7 | 员工/领导层之间的交流能追踪吗？ | **能，用自定义 entry 落库**。实测跨会话追溯成功。这是为将来 GUI 打的地基。 |

---

## 问题 1：各层的底层形态是什么？

### 1.1 核心答案：没有「物种」差异，只有「配置 + 归属」差异

pi-durable 里只有四个概念：`Harness`、`Conversation`、`Task`、`Document`。**你、CEO、CTO、项目、员工，全都是 `Conversation`**。

```
你（老板）
 └── 不是一个 conversation，你是「人」——通过 TUI 给任意 conversation 发消息

CEO        = Conversation #1        (agent: 强模型 + 管理工具 + CEO 人格)
CTO        = Conversation #2        (agent: 强模型 + 技术工具 + CTO 人格)
CFO        = Conversation #3        (agent: 便宜模型 + 财务工具 + CFO 人格)
CPO        = Conversation #4
CHRO       = Conversation #5
项目 alpha  = Conversation #6        (agent: 项目 leader 人格 + cwd=/projects/alpha)
  员工 dev-1 = Conversation #7      (agent: 开发人格 + cwd=/projects/alpha + ownership: task)
  员工 qa-1  = Conversation #8
```

`实测`：`archive/spikes/02` 里 CEO 是 conversation 1，员工是 conversation 15，两者都是 `Conversation` 类型，API 完全一样（都能 `submit`/`watch`/`fork`/`entries`）。

### 1.2 「subagent」是什么？为什么容易误解

pi-durable **没有内置 subagent**（官方原文："Pi Durable has no built-in subagents, but they take a few lines of code to build"）。所谓的 subagent 是一种**模式**，不是一个类型：

> 一个 tool 在自己的 `execute()` 里创建并驱动一个**子 conversation**，等它答完，把答案返回给调用者。

所以「是不是 subagent」取决于**它是怎么被创建和使用的**，而不是它是什么：

| 形态 | 怎么来的 | 特点 | 我们的用途 |
|---|---|---|---|
| **前台子会话** | tool 里 `tx.createConversation({ ownership: {kind:"task", taskId} })`，然后 `submit` + `wait` | 父等子答完才能继续；父被 Esc 时子也被取消 | 「CEO 派一个明确任务给某高管，要答案才能继续」 |
| **后台常驻子会话** | 同上，但 ownership 挂在一个 `background: true` 的 anchor task 上 | 子活得比父的 run 长；父 Esc 打不断它 | **员工**——必须长期在岗 |
| **独立会话** | `harness.createConversation({ ownership: {kind:"ownerless"} })` | 谁也不拥有它，独立存在 | **CEO/管理层**——它们是公司的常设岗位，不该被谁「拥有」 |

**所以正确的对应关系是**：

| 组织角色 | 底层 | ownership | 为什么 |
|---|---|---|---|
| 你（老板） | 不是 conversation | — | 你是人，通过 TUI 操作 |
| CEO | Conversation | `ownerless` | 常设岗位，不隶属于任何会话 |
| CTO/CFO/CPO/COO/CMO/CHRO | Conversation | `ownerless` | 同上 |
| 项目 leader | Conversation | `ownerless` | 项目是独立实体，不隶属于某个高管 |
| 项目员工 | Conversation | `task`（挂在 background anchor 上） | 隶属于项目，但不能被上级 Esc 打断 |

`实测`：`archive/spikes/02` 验证了「老板 `abort()` CEO 后员工仍完成」——这正是 `background: true` 锚点的作用。`archive/spikes/06` 验证了员工可见工具是 `[]`、管理层是 `["hire"]`。

### 1.3 一个必须澄清的点：谁是「agent」

在 pi-durable 里 **`agent` 不是实体，是一个配置对象**。每个 conversation 有一个 `pi.agent` 文档，存的是：

```ts
{
  model: { provider, modelId },      // 用什么模型
  thinkingLevel: "low"|"medium"|"high",
  extensions: [...],                 // 装哪些能力包
  tools: [...],                      // 具体给哪些工具
  instructions: "...",               // 人格与职责（也就是角色提示词）
  cwd: "/projects/alpha",            // 在哪个目录工作
}
```

`conversation.agent(ctx)` 读它，`conversation.configure(change, ctx)` 改它。**改配置就是改角色**——这就是为什么 CHRO 给员工分配模型只是一行 `configure({ model })`。

---

## 问题 2：创建项目会创建文件夹吗？

### 2.1 答案：会，但要我们自己实现

durable **不会**自动建目录。它的文件操作全在 `NodeExecutionEnv({ cwd })` 里，而 `cwd` 是我们通过 `HarnessOptions.env` 按 conversation 指定的。

### 2.2 实现方式

```ts
// CPO 的 project_create 工具
execute: async (args, api, ctx) => {
  const slug = args.name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  const dir = join(WORKSPACE_ROOT, "projects", slug);

  await mkdir(join(dir, "docs"), { recursive: true });        // ← 我们自己建
  await writeFile(join(dir, "PROJECT.md"), renderBrief(args)); // 立项文档

  const projectId = await api.commit(async (tx) => {
    const conv = await tx.createConversation({ ownership: { kind: "ownerless" } });
    await configure(tx, conv.id, {
      instructions: `你是 ${args.name} 项目的 leader...`,
      cwd: dir,                                               // ← 指向这个目录
    });
    const org = await tx.doc(AppOrg);
    org.projects[slug] = { name: args.name, workspace: dir, leader: conv.id, status: "planning" };
    return conv.id;
  }, ctx);

  return { output: [{ type: "text", text: `项目已立项：${dir}` }] };
}
```

`实测`：`archive/spikes/03` 用同样方式让员工在 `/projects/alpha/` 里真实写出了 `README.md`，内容是 `"# Alpha 项目\n由员工写的。\n"`。

### 2.3 环境构建（这是关键）

```ts
const harness = await Harness.open(storage, {
  models, registry,
  env: async ({ conversationId, cwd, read }, ctx) => {
    // 方式一：直接用 conversation 的 cwd
    if (cwd !== undefined) return new NodeExecutionEnv({ cwd });
    // 方式二：从文档里查（更灵活，支持运行中改）
    const profile = await read.snapshot(AppProfile, conversationId, ctx);
    return profile?.workspace ? new NodeExecutionEnv({ cwd: profile.workspace }) : undefined;
  },
}, ctx);
```

`源码`：`test/examples/28-sandbox-per-conversation.ts:49-52` 就是这个模式。**没有 `env` 的话内置工具会直接报错**（README 明确写了）。

### 2.4 项目文件夹里放什么

```
/projects/tank-battle/
├── PROJECT.md          # 立项书：需求、目标、验收标准（CPO 写）
├── PLAN.md             # 里程碑与分工（项目 leader 写）
├── MEETING-001.md      # 会议纪要（会议 task 写）
├── docs/               # 设计文档（产品/设计员工写）
├── src/                # 代码（开发员工写）
└── test/               # 测试（测试员工写）
```

---

## 问题 3：员工的能力（提示词 / skill / MCP）谁给？

### 3.1 角色提示词：CHRO 招聘时预设（推荐做法）

`instructions` 是 `agent` 配置的一部分，**招聘时一次性写死**：

```ts
// CHRO 的 staff_hire 工具
const ROLE_PRESETS = {
  "产品": { instructions: "你是产品经理。负责需求分析、PRD 撰写、验收标准。不要写代码。", tools: ["read","write","edit","project_docs"] },
  "设计": { instructions: "你是 UI/UX 设计师。负责交互与视觉方案。输出设计文档与原型说明。", tools: ["read","write","edit"] },
  "开发": { instructions: "你是开发工程师。负责编码实现、单元测试。遇到技术选型问题上报 CTO。", tools: ["read","write","edit","bash","grep","glob"] },
  "测试": { instructions: "你是测试工程师。负责用例设计、缺陷报告。不要改产品代码。", tools: ["read","bash","grep","glob","write"] },
};

await configure(tx, child.id, {
  model: args.model ?? DEFAULT_MODEL,          // ← CHRO 分配的模型
  instructions: ROLE_PRESETS[args.role].instructions,
  tools: ROLE_PRESETS[args.role].tools,        // ← 能力边界
  cwd: projectDir,
});
```

`实测`：`archive/spikes/07` 验证了 CHRO 给两个员工分别分配 `cheap-1` 和 `strong-1` 模型，`agent(ctx).model` 读回来完全正确。

**所以：预设是推荐做法，而且技术上完全支持。** 但注意——预设的是**基础模板**，员工在项目里可以有自己的个性（`AppProfile` 文档里存额外指令，`instructions` 渲染时合并）。

### 3.2 Skill：durable 里**没有这个概念**，要自己实现

`源码`：我在 `packages/durable/src/` 全量搜过 `skill`，只有一处无关命中（`testing/env-conformance.ts`）。**skill 是 `pi-coding-agent`（CLI）的概念，不是 durable 的**。

durable 里对应的机制是 **`PromptSection`**——一个在每次请求前渲染的文本片段：

```ts
// 一个"技能"= 一个 section + 可选配套工具
const TDD = defineExtension({
  name: "skill-tdd",
  sections: [
    section("skill_tdd", () => `
## 技能：测试驱动开发
1. 先写失败测试
2. 写最小实现让测试通过
3. 重构
不要在没有测试的情况下提交代码。`),
  ],
  tools: [runTests],
});
```

**三种给 skill 的方式，按需选**：

| 方式 | 谁给 | 实现 | 适用 |
|---|---|---|---|
| **CHRO 预设** | CHRO 招聘时 | `configure({ extensions: [基础技能, 项目技能] })` | 岗位固定技能（如开发都要 TDD） |
| **项目 leader 加载** | 项目 leader | `configure({ extensions: { add: [新技能] } })` | 项目阶段需要（如「性能优化阶段」） |
| **员工自己找** | 员工 | 给它一个 `load_skill` 工具，内部 `configure` 自己 | 员工遇到问题自己补能力 |

**推荐组合**：CHRO 预设基础技能 + 项目 leader 能加项目技能 + 员工**只能申请不能自己加**（用 `request_skill` 工具向 leader 申请，leader 审批后 `configure`）。这样既有弹性，又不会失控。

### 3.3 MCP：durable 也没有内置，但 `pi-mcp` 可以接

`源码`：`packages/mcp`（`@earendil-works/pi-mcp@1.4.0`）是一个**独立的 MCP 客户端库**，有 `McpClient` 类。durable 的 `registry` 里**没有** MCP 集成——但可以把 MCP 工具包装成 durable tool：

```ts
import { McpClient } from "@earendil-works/pi-mcp";

const client = await McpClient.connect({ transport: { type: "stdio", command: "npx", args: ["-y", "@modelcontextprotocol/server-github"] } });
const mcpTools = (await client.listTools()).tools.map(t => defineTool({
  name: `mcp__github__${t.name}`,
  description: t.description ?? "",
  parameters: t.inputSchema,
  deferred: true,                    // ← 关键：默认不给模型看，用 tool_search 按需加载
  execute: async (args) => ({ output: toLlmContent(await client.callTool(t.name, args)) }),
}));
registry.install(defineExtension({ name: "mcp-github", tools: mcpTools }));
```

**`deferred: true` 很重要**（`源码` `harness/types.ts:326-328`）：MCP 工具可能几十上百个，全塞进上下文会烧钱。`deferred` 让它们不占上下文，配 `tool_search`（`@earendil-works/pi-durable/tool-search`）按需加载——这正是 `tool_search` 的设计目的。

### 3.4 谁来决定员工能用哪些 MCP

**建议：CHRO 在招聘时按岗位配 MCP server，员工不能自己装**。理由：MCP 是外部系统访问权限（GitHub、数据库、支付），员工自己装等于自己给自己发权限，审计上不可接受。

实现：`staff_hire` 时 `extensions: [基础技能, ...mcpExtensionsFor(role)]`。

---

## 问题 4：CEO 和管理层有决策权吗？

### 4.1 技术上：两种都支持，这是**配置选择**不是能力限制

决策权 = **它有没有 `decide` 这个工具**。

```ts
// 有决策权：给它 decide 工具
const CTO = defineExtension({
  name: "role-cto",
  sections: [section("role", () => "你是 CTO。技术问题你自己拍板，拍不了才上报 CEO。")],
  tools: [decide, escalate, ...],
});

// 没决策权：只给 escalate
const CTO_NO_AUTH = defineExtension({
  name: "role-cto",
  sections: [section("role", () => "你是 CTO。你只做分析建议，所有决定必须上报 CEO。")],
  tools: [analyze, escalate],   // ← 没有 decide
});
```

**注意**：只靠 prompt 说「你要上报」是不可靠的（模型可能自己编决定）。**可靠做法是工具层隔离**——不给 `decide` 工具，它想拍板也拍不了，只能 `escalate`。

### 4.2 建议：按「金额 / 风险 / 影响面」分级授权

这是真实公司的做法，也最适合你「一人公司但要管得过来」的诉求：

| 决策类型 | 谁拍板 | 实现 |
|---|---|---|
| 技术实现细节（用什么库、怎么分层） | **CTO 直接拍** | CTO 有 `decide`，且 `decide` 里判断 `impact === "local"` 就直接 terminal |
| 技术架构选型（换框架、换数据库） | CTO 建议 → **你拍板** | CTO 的 `decide` 工具里：`impact === "architectural"` 时 `throw`，强制走 `escalate` |
| 预算内采购（< 阈值） | **CFO 直接拍** | CFO 有 `decide`，`amount < limit` 直接批 |
| 超预算采购（≥ 阈值） | CFO 建议 → CEO → **你拍板** | 升级链 |
| 需求优先级 | **CPO 直接拍** | CPO 有 `decide` |
| 立项 / 砍项目 | CPO 建议 → CEO → **你拍板** | 升级链 |
| 招聘/开除员工 | **CHRO 直接拍**（预算内） | CHRO 有 `decide` |
| 战略方向 / 对外承诺 | **只有你** | 只有你有对应工具，其他人只有 `escalate` |

### 4.3 升级链的完整实现（`实测` `archive/spikes/01` 跑通）

```ts
const Escalation = defineTask({
  name: "app.escalation", version: 1,
  initial: () => ({ phase: "manager" }),
  phases: {
    manager: async (task, runtime, ctx) => {
      // 问直属管理层：能拍板吗？
      const verdict = await askRole(runtime, task.input.manager, task.input.question, ctx);
      if (verdict.canDecide) {
        await runtime.commit(() => ({ status: "terminal",
          outcome: { status: "completed", result: verdict.answer } }), ctx);
        return;
      }
      await runtime.commit(() => ({ status: "running", checkpoint: { phase: "ceo" } }), ctx);
    },
    ceo: async (task, runtime, ctx) => {
      const verdict = await askRole(runtime, "ceo", task.input.question, ctx);
      if (verdict.canDecide) { /* terminal */ return; }
      await runtime.commit(() => ({ status: "running", checkpoint: { phase: "owner" } }), ctx);
    },
    owner: async (task, runtime, ctx) => {
      // 等你拍板 —— 可能跨天，用 sleepUntil 不占进程
      await runtime.sleepUntil(runtime.now() + 60_000, { phase: "awaiting_owner" }, ctx);
    },
    awaiting_owner: async (task, runtime, ctx) => {
      const answer = await readOwnerAnswer(task.id, ctx);   // 读你在 TUI 里的回复
      if (answer === undefined) {
        await runtime.sleepUntil(runtime.now() + 60_000, { phase: "awaiting_owner" }, ctx);
        return;
      }
      await runtime.commit(() => ({ status: "terminal",
        outcome: { status: "completed", result: answer } }), ctx);
    },
  },
  abort: async (_t, runtime, ctx) =>
    runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), ctx),
});
```

**关键点**：每级一个 phase，checkpoint 记住走到哪级 → 进程崩了重开从当前级继续，不会把问过的人再问一遍。`实测` `archive/spikes/05` 验证了 `sleepUntil` 期间状态是 `sleeping`（不占进程），时钟推进后自动续跑。

### 4.4 你在 TUI 上看到什么

升级到你这级时，TUI 组织树上对应项目/高管会高亮，任务面板显示 `等待老板拍板 · 已等 2 小时`，你按 Enter 进去看到完整的问题上下文（谁问的、为什么管理层拍不了、CEO 的建议是什么），直接回复即可。

---

## 问题 5：能与任何人对话吗？分支对话怎么选？

### 5.1 能。三种形态（全部 `实测` `archive/spikes/08`）

| 形态 | API | 效果 | 实测结果 |
|---|---|---|---|
| **A. 直接插话** | `conv.submit({ type:"input", content })` | 消息进**主线**，成为对话历史的一部分 | 主线从 3 条变 5 条 |
| **B. 分叉（fork）** | `conv.fork(entryId, { ownership:{kind:"ownerless"} })` | 新分支看到父到该点的历史，**父完全不受影响** | 主线仍是 5 条；分支独立 5 条 |
| **C. 独立会话** | `harness.createConversation({ agent })` | 完全隔离，只带你给的上下文 | 独立 3 条 |

### 5.2 你记的「两种分支对话」大概是 Pi CLI 的 `/fork` 和 `/clone`

`文档` `packages/coding-agent/docs/sessions.md:27-28`：

| 命令 | 做什么 | 什么时候用 |
|---|---|---|
| `/fork` | 从**更早的某条用户消息**创建新会话 | 想让另一种方案成为独立工作 |
| `/clone` | 把**当前活动分支**复制成新会话 | 想要当前状态的独立副本 |

durable 里对应的是：
- `/fork` → `conv.fork(entryId)`（**指定分叉点**）
- `/clone` → `conv.fork(最新 entryId)`（**从当前点分叉**，等价于复制当前状态）

**所以本质是同一个 API，只是分叉点不同。** 这比 Pi CLI 的两个命令更灵活——你可以从任意 entry 分叉，包括某条工具调用的结果之后。

### 5.3 怎么选？决策树

```
你想跟某人说句话，问自己：这句话该不该成为它工作历史的一部分？

├── 该。这就是它的正常工作沟通
│    → 形态 A：直接 submit（进主线）
│    例：「dev-1，登录模块进度如何？」
│
├── 不该。我只是想问个假设性问题 / 探索另一种可能
│    → 形态 B：fork
│    例：「如果当初不用 React 会怎样？」
│    好处：不影响它主线，你可以随时丢弃这个分支
│
└── 完全无关。我想找个地方自己想想
     → 形态 C：独立会话
     例：「帮我梳理一下这个项目现在的问题」
```

### 5.4 推荐默认：**fork**

理由：
1. **不污染主线**——员工的工作历史保持干净，将来复盘时不会被你的一堆试探性问题淹没
2. **成本独立**——fork 的 `pi.usage` 从 0 开始（`实测` `archive/spikes/09`：父 24，分支 19，相加 43 = 全公司总额），你的探索性提问不会算在员工账上
3. **可丢弃**——看完就扔，主线毫无痕迹

**TUI 交互设计**：

| 操作 | 行为 |
|---|---|
| 直接输入 | 形态 A（进主线） |
| `f` 键 | 在当前选中的消息处 fork，进入分支视图（顶部显示 `⎇ 分支 from #42`） |
| `Ctrl+F` | 从最新消息 fork（= clone 当前状态） |
| `Esc` 退出分支 | 分支保留但不再显示（可在分支列表里找回） |
| `D` 丢弃分支 | 标记归档（durable 无删除 API，用 `AppOrg.archived` 软删） |

### 5.5 一个技术细节：分叉点选在哪

```ts
const page = await conv.entries({ order: "ascending" }, 100, undefined, ctx);
const target = page.items.find(e => e.kind === "pi.assistant" && e.id === selectedId);
const branch = await conv.fork(target.id, { ownership: { kind: "ownerless" } }, ctx);
```

**分叉点必须是 entry id**。可以选任何 entry：用户消息之后（重问）、助手回答之后（追问）、工具结果之后（深挖某个结果）。

`实测` `archive/spikes/08`：fork 后 `branch.entries()` 返回 5 条（含继承的父历史），主线仍是 5 条——**父完全不受影响**。

---

## 问题 6：token 能分别统计吗？

### 6.1 能，四个粒度全都有

| 粒度 | 怎么取 | 精度 |
|---|---|---|
| **单条消息** | `entry.model[0].usage` （`pi.assistant` entry 自带） | 每条 assistant 回答的 input/output/cacheRead/cacheWrite/totalTokens/cost |
| **单会话（= 单角色/单项目/单员工）** | `harness.snapshot(UsageDoc, convId, ctx)` | 按 `provider/model` 和 tool 名分桶累计 |
| **全公司** | `harness.usage(ctx)` | 所有会话求和 |
| **按项目 / 按角色聚合** | `scanConversations` + 按 `AppOrg` 归属分组求和 | 要自己写约 100 行 |

`实测` `archive/spikes/07`：两个员工分别用 `cheap-1` 和 `strong-1` 模型，逐条 usage 能精确到每条消息、每个模型：

```json
dev-1 逐条 usage: [
  {"in":102,"out":10,"cacheRead":0,"total":214,"model":"cheap-1"},
  {"in":17,"out":1,"cacheRead":102,"total":138,"model":"cheap-1"}
] 合计 352
```

### 6.2 ⚠️ 致命坑：fork 会话按 entries 求和会重复计账

这是我实测发现的，**不读文档一定会踩**：

```
实测 archive/spikes/09：
  父会话 UsageDoc: 24        ← 真实
  分支会话 UsageDoc: 19      ← 真实，从 0 开始
  两者相加: 43 = harness.usage() 全公司: 43   ✅ 正确

  反例：按 entries 求和
  父: 24
  分支: 26   ← 虚高！因为分支的 entries 里含父的 2 条 entry（24 - 父第1答... ）
  相加会虚高
```

**原因**：`fork` 的会话在 `entries()` 里能看到父到分叉点的历史（这是设计如此——它需要这些历史作为上下文）。但 `pi.usage` 文档是按 `fork: "initial"` 从 0 开始计的。

**规则**：
- ✅ **要汇总成本，永远读 `pi.usage` 文档**（`snapshot(UsageDoc, convId, ctx)` 或 `harness.usage()`）
- ✅ **要逐条明细，读 entry 的 usage**（但只用于「这条消息花了多少」的展示，不要跨会话相加）
- ❌ **绝不** `entries().filter(kind==="pi.assistant").sum(usage)`

### 6.3 其他记账规则（`源码` spec §8.6）

- 每次 compaction 摘要尝试**都计费**，即使摘要最终 stale / 失败
- **失败和中止的尝试也计费**
- 工具结果如果带 usage，按工具名分桶
- 子会话的 usage **不能**在父工具结果里再报一遍（否则双计）——`spec.md §12`「Double-counted subagent spend」

### 6.4 cost 可能全是 0（`实测` `archive/spikes/02`）

`cost` 由 pi-ai 在**每个 provider 实现内部**调 `calculateCost()` 填充。用 faux provider 或自建 provider 不填 `cost` 字段 → **token 数准确，但 cost 全是 0**。

```json
{"faux/faux-1":{"input":182,"output":29,"cacheRead":138,"cacheWrite":182,
  "totalTokens":531,"cost":{"input":0,"output":0,...,"total":0}}}
```

**对策**：
1. 用官方 provider（Anthropic/OpenAI/DeepSeek 等）→ cost 自动有值
2. 自建 provider 必须填 `cost: { input, output, cacheRead, cacheWrite }`（美元/百万 token）
3. 历史数据可用 `calculateCost(model, usage)` 事后补算（token 数是准的）

### 6.5 成本没有硬预算（重要限制）

`实测`：`beforeRequest` 抛异常**不能阻断请求**，只报 `extension_error` 然后继续跑（对应未合并 issue #11055）。

**所以硬预算必须做在业务层**：

```ts
// 方案 A（推荐）：派活前检查
const Assign = defineTool({
  execute: async (args, api, ctx) => {
    const budget = await api.snapshot(AppBudget, projectId, ctx);
    const spent = await projectSpend(projectId, ctx);
    if (spent + estimateCost(args.task) > budget.limitUsd) {
      return { output: [{ type: "text", text: `项目预算不足（已花 $${spent}，上限 $${budget.limitUsd}），已拒绝派活。请 CFO 审批追加预算。` }] };
    }
    // ... 正常派活
  },
});

// 方案 B：工具层拦截
hook(ToolTask, { beforeTool: (call) => overBudget() ? { block: "预算超支" } : undefined });

// 方案 C：软提醒（实测有效，archive/spikes/06）
hook(GenerationTask, { beforeRequest: async (_req, api, ctx) => {
  if (!overBudget()) return undefined;
  return { messages: [{ role: "user", content: "[budget guard] 超预算，只回复 BUDGET EXCEEDED。", timestamp: Date.now() }] };
}});
```

### 6.6 成本会不会因为 prompt cache 被打爆

**会，而且这是最大的隐性成本风险**（`文档` + `实测`）：

- `section()` 渲染结果**每次都变**（比如嵌入当前时间）→ 每次追加 `pi.system` delta → **彻底破坏 provider prompt cache**
- cacheRead 便宜 10 倍，cacheWrite 贵 1.25 倍 → 角色人格 section 稳定 = 直接省钱
- **所以 7 个角色的 section 必须是纯函数，不能带时间戳**

`实测` `archive/spikes/07` 里 `cacheRead: 102` 就是第二次请求命中了缓存——这是好现象。

---

## 问题 7：员工/领导层之间的交流能追踪吗？

### 7.1 能，用自定义 entry（这是为 GUI 打的地基）

pi-durable 的 entry 是**不可变、永不删除**的记录。我们可以 `defineEntry` 自定义类型，把所有「谁对谁说了什么」都落成 entry。

```ts
// 定义一种自定义 entry
const MessageEntry = defineEntry<{
  at: number;
  from: string;        // "CEO" / "dev-1" / "CHRO"
  to: string;
  type: "tell" | "assign" | "report" | "escalate" | "decide" | "hire";
  text?: string;
  refs?: { taskId?: string; entryId?: string; project?: string };
}>("app.message");
```

### 7.2 关键设计：双向留痕

一条消息要在**双方会话各写一条** entry，这样：
- 在发送方的历史里能看到「我说了什么」
- 在接收方的历史里能看到「谁对我说了什么」
- 从任何一端都能追溯完整对话

```ts
// 员工 A 对员工 B 说话
execute: async (args, api, ctx) => {
  const targetConvId = org.staff[args.to];
  await api.commit(async (tx) => {
    // 发送方留痕
    await tx.appendEntry(api.conversationId, {
      kind: "app.message",
      data: { at: Date.now(), from: "self", to: args.to, type: "tell", text: args.text },
    });
    // 接收方留痕
    await tx.appendEntry(targetConvId, {
      kind: "app.message",
      data: { at: Date.now(), from: "peer", to: args.to, type: "tell", text: args.text },
    });
  }, ctx);
}
```

`实测` `archive/spikes/07`：两个员工互发一条消息，跨会话追溯拿到 4 条记录（2 条招聘 + 2 条消息，发送方和接收方各一条）：

```json
{"conv":1,  "from":"CHRO", "to":"dev-1", "type":"hire", "model":"cheap-1"}
{"conv":1,  "from":"CHRO", "to":"dev-2", "type":"hire", "model":"strong-1"}
{"conv":15, "from":"self", "to":"dev-2", "type":"tell", "text":"登录接口我写好了"}
{"conv":27, "from":"peer", "to":"dev-2", "type":"tell", "text":"登录接口我写好了"}
```

### 7.3 跨会话追溯的查询方式

```ts
// 扫所有会话的所有 message entry
const convs = await tx.scanConversations({}, 1000);
const trail = [];
for (const rec of convs.items) {
  const page = await tx.scanEntries({ conversationId: rec.id, order: "ascending" }, 500);
  for (const e of page.items) {
    if (e.kind === "app.message") trail.push({ conv: rec.id, ...e.data });
  }
}
// 按时间排序 → 得到全公司的沟通时间线
```

**性能注意**：会话多的时候全量扫会慢。**优化方案**：维护一个 `app.trail` session 级 document，每次写 message entry 时同步 append 到 trail（一条记录只存指针，不存全文），GUI 读 trail 就够。

```ts
const AppTrail = defineDoc<{
  edges: Array<{ at:number; from:string; to:string; type:string; fromConv:number; toConv:number; entryId:number }>;
}>({
  kind: "app.trail", version: 1, scope: "session",
  history: "latest", fork: "initial",
  initial: () => ({ edges: [] }),
  checkpointWhen: () => false,   // 靠 replay，不 checkpoint
});
```

### 7.4 为 GUI 准备的数据形态

将来做 GUI 时，你要画的是**组织内的消息网络图**。数据已经齐了：

```ts
// 节点 = 会话（角色/项目/员工）
const nodes = [
  { id: 1,  label: "CEO",   kind: "role" },
  { id: 6,  label: "alpha", kind: "project" },
  { id: 15, label: "dev-1", kind: "staff", parent: 6 },
];

// 边 = app.message entry
const edges = trail.map(t => ({
  from: t.fromConv, to: t.toConv,
  type: t.type,          // tell/assign/report/escalate/decide
  at: t.at,
  text: t.text,
}));
```

**额外的好处**：`type` 字段让你能画不同类型的边——实线是 `tell`，虚线是 `escalate`，粗线是 `assign`。升级链的走向一目了然。

### 7.5 还有一层天然追踪：task graph

`harness.watchTaskGraph()` 返回**所有活着的任务**及其 owner 关系：

```ts
const graph = await harness.watchTaskGraph(ctx);
for (const node of Object.values(graph.value.tasks)) {
  console.log(node.id, node.kind, node.state.status, node.owner ?? `conversation ${node.conversationId}`);
}
```

这给你的是**「谁在等谁」的实时结构**——比消息更动态。GUI 上可以做成力导向图：节点是任务，边是 owner 关系，颜色是状态（running/waiting/sleeping）。

**两层结合**：
- `app.message` entry = **历史沟通记录**（谁说过什么，不可变）
- `watchTaskGraph()` = **当前协作结构**（谁在等谁，实时）

---

## 补充：你新提的三个决定，已并入计划

### 模型与预算：默认统一 + CHRO 按需分配

`实测` `archive/spikes/07` 验证通过。实现：

```ts
const CompanySettings = defineDoc<{
  defaultModel: ModelRef;                    // 全公司默认
  roleModels: Record<RoleName, ModelRef>;    // 各管理层可覆盖
  modelCatalog: Array<{ id: string; label: string; costPerMTok: number }>;  // CHRO 可选的模型清单
}>({ kind: "app.settings", version: 1, scope: "session", ... });
```

CHRO 的 `staff_hire` 工具参数里加 `model?: string`，不传就用 `defaultModel`。**关键**：`modelCatalog` 里要带价格，否则 CHRO 无法做「给测试员工用便宜模型」的判断。

### TUI：三栏常驻

已写进 `docs/PLAN.md` M2。布局：

```
┌─ 组织树 (24 列) ─┬─ 会话流 (自适应) ─────────────┬─ 侧栏 (30 列) ─┐
│ ▾ CEO           │ dev-1 · alpha 项目            │ 任务面板        │
│   ▾ CTO         │ ─────────────────────────     │ ● 会议进行中    │
│   ▸ CFO         │ [你] 登录模块进度如何？        │ ◐ 等老板拍板(2) │
│ ▾ 项目          │ [dev-1] 已完成 80%，缺测试     │ ○ 空闲          │
│   ▾ alpha       │   ⚙ bash(npm test) 12s ✓      │                 │
│     ● dev-1     │ [你] 测试谁补？                │ 成本            │
│     ○ qa-1      │                               │ 本会话 12.4k    │
│   ▸ beta        │ ┌─ 输入 ────────────────────┐ │ 本项目 89.1k    │
│                 │ │ > _                       │ │ 全公司 1.2M     │
└─────────────────┴───────────────────────────────┴─────────────────┘
```

### 第一个真实项目：网页坦克大战

这个项目选得很好，因为它**天然需要多个角色**，能真正压测组织机制：

| 角色 | 任务 | 验证什么 |
|---|---|---|
| CPO | 细化需求：单人/双人、关卡数、道具、碰撞规则、胜负条件 | 立项流程、`PROJECT.md` |
| 设计 | 像素风美术方向、UI 布局、操作说明 | 设计文档产出 |
| 开发 | Canvas 渲染、游戏循环、碰撞检测、地图数据、敌人 AI | 代码产出、`cwd` 隔离 |
| 测试 | 边界用例：墙体碰撞、子弹穿透、双人按键冲突、帧率 | 测试报告 |
| CTO | 技术选型：Canvas 2D vs WebGL vs 游戏引擎 | **升级链**（选型问题会上升） |
| CFO | 成本控制：这个项目预算多少 token | **成本统计** |
| 项目 leader | 排期、开会、协调 | **会议机制** |

**M1 验收用例**（写进 PLAN）：

> 老板说：「立项一个网页坦克大战游戏项目，配齐产品/设计/开发/测试。」
> 期望：CPO 立项并写出 `PROJECT.md`；CHRO 招 4 个员工并分配模型；项目 leader 排出 `PLAN.md`；开发员工在 `/projects/tank-battle/` 里创建 `index.html`。

---

## 附录：本文档对应的验证脚本

| 脚本 | 验证内容 |
|---|---|
| `archive/spikes/01-org-and-escalation.mjs` | 角色 + 项目 + 员工 + 升级链 + 分叉 + 成本 |
| `archive/spikes/02-cost-abort-recovery.mjs` | 成本分账 · 老板 Esc 不影响员工 · SQLite 崩溃恢复 |
| `archive/spikes/03-project-workspace.mjs` | **问题 2**：项目 = 工作空间文件夹，员工真实写文件 |
| `archive/spikes/04-watch-fork.mjs` | 实时视图 · 分叉沟通 · task graph · 软删 |
| `archive/spikes/05-meeting-and-sleep.mjs` | 会议并行子任务 · `sleepUntil` 等老板拍板 |
| `archive/spikes/06-isolation-and-budget-guard.mjs` | **问题 1/4**：工具级权限隔离 · `watchDoc` · 预算软拦截 |
| `archive/spikes/07-model-assign-and-message-trail.mjs` | **问题 3/6/7**：模型分配 · 沟通留痕 · 逐条 token |
| `archive/spikes/08-three-conversation-forms.mjs` | **问题 5**：三种对话形态 · 按会话拆 token |
| `archive/spikes/09-usage-accounting.mjs` | **问题 6**：fork 重复计账的坑与正确取数 |

复现：`cd spikes && npm install && npm run all`
