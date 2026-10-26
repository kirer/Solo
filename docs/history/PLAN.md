# 【已归档 · 不再维护】

> 这份文档写于某个时间点，记录**当时**的设计推理与施工过程，**内容已冻结**。
> 现状一律以 `docs/SYSTEM.md`、`docs/CODE.md`、`docs/DECISIONS.md`、`openspec/specs/` 为准。
> 保留它只是为了回答「当初为什么这么决定」。里面的行号、文件路径、数量、截图链接都可能已失效。

---

# 技术选型与架构

> 结论一句话：**能实现。地基选 `@earendil-works/pi-durable@1.4.0`，外壳自己写。**
> 实现已完成，代码在 `src/`。本文保留「为什么这么选 + 架构怎么定」的部分；
> 当时的逐阶段实施计划已作废，实际落地情况见 [`HANDOFF.md`](HANDOFF.md)。
> 所有关键机制都在本机实测跑通，脚本在 `archive/spikes/`（`npm run all` 可复现，无需 API key）。

---

## 0. 先读这一页（决策摘要）

### 0.1 三个方案对比

| 方案 | 是什么 | 能否满足需求 | 结论 |
|---|---|---|---|
| **A. 用 Pi 扩展做编排** | 写一个 Pi extension，用 `pi.on` 事件 + spawn 子 `pi` 进程当员工 | 部分能。但**没有持久化**：进程一退，所有员工会话、正在跑的活全丢；`fork`/`watch`/成本分账全靠自己拼文件 | ❌ 不适合做「公司」，适合做「一个人的工具」 |
| **B. Pi SDK 嵌入** | `createAgentSession()` 在 Node 里跑多个会话 | 能跑多会话，但 SessionManager 是**单会话 JSONL 树**，多角色并发、崩溃恢复、任务状态机都要自己写 | ❌ 省不了最难的活 |
| **C. pi-durable 做地基 + 自写 TUI** | `Harness` + `Conversation` + `Task` + `Document` 当运行时，TUI 用 `pi-tui` 画 | **全部满足**。角色/项目/员工/开会/升级链/看板/分叉/成本都有直接对应的原语 | ✅ **推荐** |

**为什么不是 A 或 B**：你的需求里「员工长期在岗、跨天等老板拍板、进程重启不丢工作、按项目/角色分账」这四条，本质是 **durable execution**（持久化执行）问题，不是 prompt 问题。Pi 本体是「一个人的终端 agent」，pi-durable 是官方为此专门做的库（Pi 1.0 自己内部也用它重写了一个 coding agent）。

### 0.2 实测结论速览（全部本机跑通）

| 需求 | 机制 | 实测证据 |
|---|---|---|
| 多角色（CEO/CTO/CFO/…） | 角色 = `defineExtension`（人格+工具）+ 一个 `conversation` | `archive/spikes/01` 跑通 CEO + CTO 两个角色会话 |
| 项目 = 工作空间文件夹 | `AgentState.cwd` + `HarnessOptions.env` 按会话返回不同 `NodeExecutionEnv` | `archive/spikes/03` 员工在 `/projects/alpha/` 里真实写出 `README.md` |
| 项目内员工 | task-owned conversation（anchor task 作为 ownership 边界） | `archive/spikes/02` 招聘出 `conversation 15`，独立记账 53 tokens |
| 员工只对接管理层 | `configure({ extensions:[仅员工角色] })` + 后台锚点隔离 | `archive/spikes/02` 老板 `abort()` CEO 后，员工仍正常答完；`archive/spikes/06` 员工可见工具 `[]`，管理层可见 `["hire"]` |
| 升级链（员工→管理层→CEO→老板） | 自定义 `Task`，每级一个 `phase`，checkpoint 记住走到哪级 | `archive/spikes/01` `manager→ceo→owner` 三级走通 |
| 分阶段开会 | 会议 `Task` + 并行子 `Task` + `waiting` + `allSettled` | `archive/spikes/05` CTO/CFO/CPO 三份意见并行收集后汇总进纪要 |
| 等老板拍板（可能跨天） | `runtime.sleepUntil()` —— 睡眠期不占进程、跨重启有效 | `archive/spikes/05` 状态为 `sleeping`，时钟推进后自动续跑 |
| 老板实时查看 | `conversation.watch()` 拿结构化视图 + 精确 ops；`watchTaskGraph()` 看全员 | `archive/spikes/04` watch 收到 4 帧，含 live 生成态变化 |
| 老板与任何员工分叉沟通 | `conversation.fork(entryId)`，独立分支不影响主线 | `archive/spikes/04` 分叉后主线 entries 数量不变（3 vs 3） |
| 成本核算（CFO） | 每会话 `pi.usage` 文档 + `harness.usage()` 汇总 | `archive/spikes/02` CEO 986 tokens / 员工 53 tokens 分账清晰 |
| 成本软预算 | `hook(GenerationTask,{beforeRequest})` 改写 messages | `archive/spikes/06` 超预算时模型只回 `BUDGET EXCEEDED` |
| 会话/名册变化实时订阅 | `harness.watchDoc()` | `archive/spikes/06` 写入 0.5 后 watch 立即更新 |
| 崩溃恢复 | 每步 checkpoint + `resume()` + `requestId` 幂等 | `archive/spikes/02` 工具跑到一半 close，重开后同 `requestId` 拿回**同一个 submission** 并跑完 |

### 0.3 老板已确认的三个决定

| 事项 | 决定 |
|---|---|
| 模型与预算 | **默认统一一种模型**，但 CHRO 在创建项目/招聘员工时可给员工**单独分配模型**（`configure({ model })`，实测可行，见 `archive/spikes/07`） |
| TUI 形态 | **三栏常驻**：组织树 / 会话流 / 输入框 |
| 第一个真实项目 | **网页坦克大战**（HTML5 Canvas 像素风，单人+双人，含关卡/道具/碰撞） |

### 0.4 必须接受的三个代价

1. **pi-durable 是 experimental**。README 第一行就写了 API 会不兼容变更，`1.1→1.4` 每个 minor 都带 Breaking Changes。→ 对策：**锁死 `1.4.0`（不用 `^`）+ 全部调用收进一层 `CompanyRuntime` 防腐层 + 契约测试**。
2. **没有 UI、没有认证、没有多租户、没有 cron、没有会话删除**。→ 这些都是我们要写的，工作量已在 §5 拆好。
3. **单进程独占 storage**（无跨进程锁）。→ 一台机器一个进程，横向扩展要每进程一份数据；对你的一人公司完全够用。

---

## 1. 需求 → 机制映射（逐条对账）

你的 6 条需求逐条落到具体 API：

### 需求 1：老板直连 CEO，下设 CTO/CFO/CPO/COO/CMO/CHRO

```
CEO   = conversation（root 会话）+ role-ceo extension
CTO   = conversation + role-cto extension
CFO   = conversation + role-cfo extension
...
```

每个角色是一个 `defineExtension`，里面放三样东西：
- `sections`：人格与职责（系统提示片段，**必须是纯函数**，否则破坏 prompt cache 会让成本翻倍）
- `tools`：这个角色能干的事（CFO 有 `check_budget`/`approve_spend`；CTO 有 `review_architecture`；员工没有管理工具）
- `hooks`：角色的行为循环（比如 CFO 每次回答前先查预算）

不同角色可以用不同模型和 thinking level：CFO 用便宜模型、CEO/CTO 用强模型，这是 `configure({ model })` 一行配置的事。

**已确认策略**：全公司默认统一模型（`app.settings.defaultModel`），但 **CHRO 招聘员工时可以单独指定模型**：

```ts
// CHRO 的 staff_hire 工具
parameters: Type.Object({
  name: Type.String(),
  role: Type.String(),
  model: Type.Optional(Type.String({ description: "不传则用公司默认模型" })),
})
// 内部：configure(tx, child.id, { model: resolveModel(args.model) })
```

`实测`：`archive/spikes/07` 给两个员工分别分配 `cheap-1` / `strong-1`，`agent(ctx).model` 读回完全正确。`modelCatalog` 里要带价格，否则 CHRO 无法做「测试员工用便宜模型」的判断。

### 需求 2：CPO 细化需求并立项（创建工作空间文件夹）；CHRO 为项目配员工

CPO 的角色工具里给三个：

```ts
project_create({ name, brief })   // 建 /projects/<slug>/ 目录 + 写 PROJECT.md + 建项目 conversation
project_list()                    // 看现有项目
project_plan({ slug, milestones })// 写 PLAN.md（需求细化与立项文档）
```

CHRO 的角色工具：

```ts
staff_project({ slug, roles: ["产品","设计","开发","测试"] })  // 按角色模板批量招聘
staff_list({ slug })
staff_fire({ slug, name })        // 软删：document 标记，durable 没有删除 API
```

招聘的实质就是 `archive/spikes/02` 里的 `hire` 工具：在同一个 commit 里 ①建 anchor task（ownership 边界）②建子 conversation ③`configure` 它的 cwd / 人格 / 工具 ④写进 `app.org` 名册。

### 需求 3：员工只对接管理层；管理层能拍板就拍板，否则往上转

**「只对接管理层」用四层保障**（缺一层就能被绕过）：

1. **工具层**：管理类工具（`escalate`、`hire`、`assign`）只装在管理层 extension 里，员工的 `configure` 里 `extensions: [仅员工角色]`，员工物理上没有这些工具。
2. **会话层**：员工没有创建会话的能力，无法自己去找老板。
3. **输入层**：老板硬要直连员工时用 `submit({ whenBusy: "reject" })`，拿到 `ConversationBusy` 后按组织关系决定放行/记越级/转直属上级。
4. **报告通道**：员工只能通过 reporter task 往上报，且 `requestId` 去重 → 天然「只对接管理层」。

**升级链**用自定义 Task 的多 phase 表达（`archive/spikes/01` 已跑通）：

```ts
type EscalationState =
  | { phase: "manager" }   // 管理层自己判断：能拍板就 terminal 结束
  | { phase: "ceo" }       // 拍不了，转 CEO
  | { phase: "owner" };    // CEO 也拍不了，转老板（用 sleepUntil 等，可能跨天）
```

关键点：**每级一个 phase，checkpoint 记住走到哪级**。这样进程崩了重开，从当前级继续，不会把已经问过的人再问一遍。

### 需求 4：员工定期/分阶段互相开会

会议 = 一个 `Task`，phase 就是议程阶段（`archive/spikes/05` 已跑通）：

```
collect（并行收集各高管意见）→ decide（CEO 汇总决策）→ minutes（写纪要）
```

`collect` 阶段用「创建一批子 task + `waiting` + `allSettled`」，`decide` 阶段用 `runtime.outcomes(ids)` 一次拿到所有意见。**会议进度条天然就是 `harness.watchTaskGraph()`**——它返回的树形结构直接能渲染成看板。

「定期」：durable 没有 cron，用 `sleepUntil(now + interval)` 结束 phase，下次醒来再排下一次。`archive/spikes/05` 验证了睡眠期间任务状态是 `sleeping`，**不占进程、不占 invocation、跨重启有效**。

### 需求 5：老板实时查看任何管理层/员工的工作记录，并能与任何人分叉沟通

| 想看什么 | 用什么 |
|---|---|
| 某个会话的完整状态（对话+正在生成+工具输出+排队+成本） | `conversation.watch()` → `{conversation, entries, docs["pi.live"/"pi.inbox"/"pi.usage"]}` |
| 全公司在跑什么（谁在等谁） | `harness.watchTaskGraph()` |
| 某个项目/名册的变化 | `harness.watchDoc(AppOrg, ctx)` |
| 历史记录 | `conversation.entries()` 分页（**默认降序，要正序传 `order:"ascending"`**） |

**分叉沟通**：`conversation.fork(entryId, { ownership: {kind:"ownerless"} })`。新分支看到父到该点的全部历史、继承当时的 agent 配置、拿到新的 provider sessionId（不污染父的 prompt cache），父会话完全不受影响。`archive/spikes/04` 实测：分叉后主线 entries 数量不变。

### 需求 6：除了老板和管理层，一切以项目为单位，每个项目有项目 leader

```
Session（= 一家公司，一个 SQLite）
├── app.org           （session 级 document：角色名册、项目索引、员工名册、升级记录）
├── conversation: board        ← 老板 ↔ CEO
├── conversation: role:ceo / role:cto / role:cfo / ...   ← 每个高管一个长期会话
├── conversation: project:alpha        ← 项目 leader 会话（cwd = /projects/alpha）
│    └── conversation: project:alpha:dev-1 / :design-1 / :qa-1   ← 项目员工
├── Task: app.meeting（会议）  app.escalation（升级链）  app.ledger（成本汇总）  app.scheduler（定期会议）
```

项目 leader 不是特殊物种，就是**项目会话自己的人格 + 一组管理工具**：它能给自己项目的员工派活、能发起会议、能向上汇报。项目本身是一个 conversation，`cwd` 指向 `/projects/<slug>/`，所以项目里所有员工的文件操作天然落在项目文件夹里（`archive/spikes/03` 实测）。

---

## 2. 架构设计

### 2.1 分层

```
┌─────────────────────────────────────────────────────┐
│ apps/tui        TUI 外壳（pi-tui）                    │
│                 组织树 / 会话流 / 输入框 / 成本条        │
├─────────────────────────────────────────────────────┤
│ src/company     业务层：只 import ./runtime           │
│                 roles.ts projects.ts staff.ts         │
│                 meeting.ts escalation.ts ledger.ts    │
├─────────────────────────────────────────────────────┤
│ src/runtime     防腐层：唯一 import pi-durable 的地方  │
│                 open.ts registry.ts env.ts recover.ts │
├─────────────────────────────────────────────────────┤
│ pi-durable@1.4.0 + pi-ai + chord                     │
└─────────────────────────────────────────────────────┘
```

**防腐层是硬要求**，理由：pi-durable 每个 minor 都有 Breaking Changes。业务代码不直接 import 它，将来升级只改 `src/runtime/`。

### 2.2 核心数据模型

```ts
// session 级单例：全公司总表
const AppOrg = defineDoc<{
  company: { name: string; createdAt: number };
  roles: Record<RoleName, ConversationId>;          // "ceo" -> conv 1
  projects: Record<slug, {
    name: string;
    workspace: string;                               // /projects/alpha
    leader: ConversationId;
    status: "planning" | "active" | "paused" | "done";
    brief: string;
  }>;
  staff: Record<`${slug}/${name}`, {
    conversationId: ConversationId;
    role: string;                                    // 产品/设计/开发/测试
    manager: RoleName;                               // 向谁汇报
    hiredAt: number;
  }>;
  archived: ConversationId[];                        // 软删（durable 无删除 API）
}>({
  kind: "app.org", version: 1, scope: "session",
  history: "latest", fork: "initial",
  initial: () => ({ company: {name:"", createdAt:0}, roles:{}, projects:{}, staff:{}, archived:[] }),
  checkpointWhen: () => false,                       // 组织总表靠 replay，不需 checkpoint
});

// 会话级：员工/项目的上下文小档案
const AppProfile = defineDoc<{ title: string; kind: "role"|"project"|"staff"; parent?: ConversationId }>({
  kind: "app.profile", version: 1, scope: "conversation",
  history: "latest", fork: "asOf",                   // fork 时继承分叉那一刻的档案
  initial: () => ({ title: "", kind: "staff" }),
  checkpointWhen: () => false,
});

// 会话级：升级/审批记录（要可回溯 → rewindable）
const AppAudit = defineDoc<{ events: Array<{ at:number; type:string; from?:string; to?:string; note?:string }> }>({
  kind: "app.audit", version: 1, scope: "conversation",
  history: "rewindable", fork: "initial",
  initial: () => ({ events: [] }),
  checkpointWhen: () => false,
});

// 会话级：成本账本（每会话自己的预算与已花）
const AppBudget = defineDoc<{ limitUsd: number; spentUsd: number; model?: ModelRef }>({
  kind: "app.budget", version: 1, scope: "conversation",
  history: "latest", fork: "initial",
  initial: () => ({ limitUsd: 0, spentUsd: 0 }),
  checkpointWhen: () => false,
});
```

### 2.3 任务清单

| Task | phases | 用途 |
|---|---|---|
| `app.anchor` | `done` | 后台员工的 ownership 边界（让员工不被上级 Esc 打断） |
| `app.reporter` | `deliver` → `report` | 把员工/子会话的答案回报给上级，`requestId` 去重 |
| `app.escalation` | `manager` → `ceo` → `owner` | 升级链 |
| `app.meeting` | `agenda` → `collect` → `decide` → `minutes` | 分阶段开会 |
| `app.opinion` | `think` | 单个高管/员工的会议意见（会议的子任务） |
| `app.ask_boss` | `wait` → `collect` | 等老板拍板（`sleepUntil`，跨天） |
| `app.scheduler` | `wait` → `fire` | 定期会议/定期汇报（无 cron，自己排下一次） |
| `app.ledger` | `scan` → `rollup` | 定期把所有会话 `pi.usage` 汇总进成本账本 |

### 2.4 工具清单（按角色分配）

| 工具 | 谁能用 | 作用 |
|---|---|---|
| `project_create` / `project_plan` / `project_list` | CPO | 立项、写需求文档、创建工作空间目录 |
| `staff_hire` / `staff_list` / `staff_fire` | CHRO | 按角色配员工 |
| `staff_assign` | 项目 leader、管理层 | 给员工派活并等答复 |
| `staff_message` | 项目 leader、管理层 | 给员工发消息（steer/followUp），不等答复 |
| `staff_stop` | 项目 leader、管理层 | 叫停员工当前工作 |
| `escalate` | 所有管理层 + 项目 leader | 向上转一个问题 |
| `decide` | 管理层 | 自己拍板，写进审计 |
| `meeting_call` | CEO、项目 leader | 发起一次会议 |
| `budget_check` / `budget_set` | CFO | 查/设预算 |
| `ledger_report` | CFO | 按项目/角色汇总成本 |
| `org_tree` | CEO、老板 | 看组织架构与谁在忙 |

**关键约束**：员工 extension 里一个管理工具都不装 → 物理上无法越级。

---

## 3. 关键技术决策与理由

| 决策 | 选择 | 理由 |
|---|---|---|
| 运行时 | **pi-durable 1.4.0** | 唯一提供「持久化会话+任务+文档」三件套且被官方产品验证过的方案 |
| 存储 | **SQLite**（`openNodeSqliteStorage`） | 进程崩溃安全；JSONL 会把全部历史放内存，长跑必爆 |
| TUI | **pi-tui 1.4.0** | 差分渲染、已有 Editor/Markdown/ScrollView/SelectList，和 Pi 视觉一致；实测可用 |
| 项目隔离 | `AgentState.cwd` + `HarnessOptions.env` | durable 没有「项目」概念，这是官方推荐的隔离方式；不采用「一个项目一个 storage」（单进程单 storage） |
| 员工常驻 | anchor task + background | 员工必须活得比上级的 run 长，`background:true` 是唯一正确的 ownership 边界 |
| 成本硬预算 | **业务层不派单 + `beforeTool` block** | `beforeRequest` 抛异常**不能**阻断请求（实测只报 `extension_error` 后继续跑），所以硬预算必须在上层做 |
| 成本软提醒 | `hook(GenerationTask, { beforeRequest })` 改写 messages | 实测可行，但会多花一次极小请求 |
| 事件流 | `conversation.watch()` + `watchTaskGraph()` | `watchEvents()` 是 experimental，不押注 |
| 升级链 | 自定义 Task 多 phase | 串行、要跨天等待、要恢复——正是 Task 的强项 |
| 分叉沟通 | `fork(entryId, {ownership:{kind:"ownerless"}})` | 不污染主线，独立记账 |

---

## 4. 目录结构（实际落地）

```
ai-company/
├── README.md                入口
├── package.json             依赖与脚本
├── tsconfig.json / vitest.config.ts
├── src/
│   ├── runtime/             防腐层：唯一 import pi-durable / pi-ai / chord 的地方
│   │   ├── open.ts          Harness.open 的唯一入口
│   │   ├── registry.ts      能力包集中注册 + 构造器转发
│   │   ├── env.ts           每会话一个 NodeExecutionEnv（缓存 + cleanup）
│   │   ├── recover.ts       resume + 巡检 + 启动自愈
│   │   ├── ids.ts           语义化请求标识（幂等关键）
│   │   ├── models.ts        provider 装配（本地网关 / 官方）
│   │   ├── capabilities.ts  执行类工具转发
│   │   ├── usage.ts         用量文档转发
│   │   ├── inbox.ts         队列文档转发
│   │   └── signals.ts       终端信号与退出恢复
│   ├── company/             业务层
│   │   ├── docs.ts          所有 defineDoc（公司索引 / 档案 / 审计 / 预算 / 时间线）
│   │   ├── roles.ts         七个岗位的职责与能力声明
│   │   ├── tools.ts         岗位 → 工具集合的映射
│   │   ├── management-tools.ts  管理层工具实现
│   │   ├── staff-tools.ts   员工按角色的工具集
│   │   ├── org.ts           初始化 / 立项 / 招聘 / 终止 / 删除
│   │   ├── delegation.ts    派活与回报
│   │   ├── escalation.ts    升级链（多阶段任务）
│   │   ├── cost.ts          成本记账与聚合
│   │   └── trail.ts         沟通留痕与关系图
│   ├── server/              网页服务
│   │   ├── main.ts          入口
│   │   ├── http.ts          HTTP + SSE
│   │   ├── org-view.ts      组织快照
│   │   └── feed.ts          会话流（思考 / 工具 / 输出）
│   └── tui/                 终端界面
│       ├── main.ts / app.ts
│       ├── state.ts / render.ts / screen.ts
├── ui/                      网页界面（纯静态，无构建）
│   ├── index.html  app.css  app.js
├── test/
│   ├── contract/            防腐层契约测试（升级 pi-durable 时跑）
│   ├── unit/
│   ├── e2e/
│   └── support.ts           测试基建（faux provider + 临时目录）
├── scripts/
│   ├── seed-demo.ts         生成演示数据
│   └── check-boundaries.mjs 边界检查（业务层不得直接 import 底层库）
├── docs/                    文档
├── openspec/                规格库（必须在根目录，否则 CLI 找不到）
│   ├── specs/               当时规划的 9 个能力、54 条需求
│   └── changes/archive/     两次变更的提案原文
└── archive/                 归档：不参与运行，但要留作证据
    ├── spikes/              9 个可行性验证脚本
    ├── reference/pi/        Pi 官方源码
    └── examples/            系统产出的坦克大战
```

---

## 5. 实施情况

当时计划的六个阶段已全部完成，实际落地与计划的差异如下（计划是纸面的，落地才是真的）：

| 阶段 | 计划 | 实际 |
|---|---|---|
| M0 地基 | 防腐层 + 崩溃恢复 | ✅ 完成。额外加了边界检查脚本，业务层物理上无法 import 底层库 |
| M1 组织与角色 | 七个岗位 + 项目 + 员工 | ✅ 完成。补了「按角色分配执行工具」——计划里漏了，导致员工干不了活 |
| M2 界面 | 三栏 TUI | ✅ 完成 TUI，**另加了一套网页界面**（老板确认要网页） |
| M3 汇报与升级链 | 派活 + 升级 + 拍板 | ✅ 完成。补了「终止 / 删除项目」两步流程 |
| M4 会议与定期汇报 | 会议 task + 调度 | ❌ **未做**，留在后续 |
| M5 成本与治理 | 账本 + 预算硬控 | 🔶 成本聚合完成；**预算硬控未做**（底层无法拒绝请求） |
| M6 打磨与交付 | 归档 / 导出 / 文档 | 🔶 终止与删除完成；导出未做 |

未完成的两项不是遗漏，是优先级判断：会议机制在「老板只跟 CEO 对话」的模式下收益不明显；预算硬控受底层限制，只能做在派活层，等工作流编排一起做更合适。

---

## 6. 风险与对策

| 风险 | 等级 | 对策 |
|---|---|---|
| pi-durable API 破坏性变更 | **高** | 锁 `1.4.0`；防腐层隔离；`test/contract/` 契约测试；升级前备份 SQLite 并演练（1.4.0 的 schema 迁移**不可回退**） |
| `restartLimit`（默认 5）把任务 park 后静默卡死 | 高 | 启动巡检 `inspect()`，对 `blocked: restart_limit` 告警 + `retryTask()`；TUI 上红色标记 |
| Storage 错误是致命的（一次失败整个 Harness 死） | 高 | `harness.closed.then(end => end.reason==="failed" && reopen())` + `requestId` 幂等重放 |
| 成本账全是 0 | 中 | 自建 provider 必须填 `cost` 字段；或事后用 `calculateCost()` 补算 |
| prompt cache 被打爆导致成本翻倍 | 中 | `section()` 必须是纯函数（不能带时间戳）；不要在会话中途改扩展选择；监控 `cacheRead` 占比 |
| 员工无限递归开子 agent | 中 | 员工 extension 里不装 spawn 类工具；`configure` 时 `extensions` 用显式数组 |
| 会话删不掉（无 API） | 低 | `AppOrg.archived` 软删 + TUI 过滤 |
| 单进程独占 storage | 低 | 一人公司场景够用；将来要横向扩展，每进程一份数据 |
| 长事务阻塞（commit 里 await 外部 IO 会卡死整条提交线） | 中 | 代码规范：commit 回调只做 `tx.*` 操作；加 lint 规则 |
| commit 回调里读 Session API 间歇死锁 | 中 | 同上；契约测试覆盖 |

---

## 7. 当时需要拍板的三件事（已定）

| 事项 | 结论 |
|---|---|
| 模型与预算 | 默认统一模型；CHRO 招聘时可按员工单独分配 |
| 界面形态 | 网页界面（主视图组织架构 + 右侧聊天面板），另保留终端版 |
| 第一个真实项目 | 网页坦克大战 —— 已由系统自己完成（`archive/examples/tank-battle/`） |

---

## 附录 A：已完成的调研与验证

| 产物 | 说明 |
|---|---|
| `docs/research/01-pi-docs.md` | Pi 官方文档全量调研（643 行）：形态、配置、扩展开发、~40 个事件、SDK/RPC 嵌入、坑 |
| `docs/research/02-pi-durable.md` | pi-durable 深度调研（597 行）：定位、架构、二次开发、多 agent 编排、成本、风险（含 11 个实测脚本） |
| `docs/research/03-pi-source-durable.md` | 本地源码研读（800 行）：真实签名、31 个示例逐个解读、12 个可复用模式、能做/要做/做不了三档判断 |
| `archive/spikes/01-org-and-escalation.mjs` | 角色 + 项目 + 员工 + 升级链 + 分叉 + 成本 |
| `archive/spikes/02-cost-abort-recovery.mjs` | 成本分账 + 老板 Esc 不影响员工 + SQLite 崩溃恢复 |
| `archive/spikes/03-project-workspace.mjs` | 项目 = 工作空间文件夹（员工真实写文件） |
| `archive/spikes/04-watch-fork.mjs` | watch 实时视图 + 分叉沟通 + task graph + 软删 |
| `archive/spikes/05-meeting-and-sleep.mjs` | 会议并行子任务 + `sleepUntil` 等老板拍板 |
| `archive/spikes/06-isolation-and-budget-guard.mjs` | 工具级权限隔离 + `watchDoc` + 预算软拦截 |
| `archive/spikes/07-model-assign-and-message-trail.mjs` | 按员工分配模型 + 跨会话沟通留痕 + 逐条 token |
| `archive/spikes/08-three-conversation-forms.mjs` | 三种对话形态（直接插话/fork/独立会话） |
| `archive/spikes/09-usage-accounting.mjs` | fork 会话重复计账的坑与正确取数 |

复现：`cd archive/spikes && npm install && npm run all`

## 附录 B：必踩的坑（写代码前先记住）

前九条是调研阶段发现的，后六条是实现阶段真实踩到的（都记在 [`DECISIONS.md`](../DECISIONS.md)）：

1. `entries()` **默认降序**（新→旧），要正序传 `{ order: "ascending" }`。
2. **commit 回调里不能 await 任何 Session API**（`snapshot`/`getTask`/嵌套 commit）——会死锁，而且是间歇性的。只读 `tx`。
3. 用 faux provider 写测试时，**tool call 消息必须带 `stopReason: "toolUse"`**，否则工具根本不执行（这个坑我踩了）。
4. **新会话必须显式给 `model`**，否则提交后返回 `status: "unanswered"`、`reason: "no_model"`（不是报错，是静默失败）。
5. **只有 `tx.doc()` 会创建文档**：`snapshot()` / `watchDoc()` 对不存在的文档返回 `undefined`，且 `watch.value` 在 `start()` 之前冻结在获取时那一版。
6. `harness.snapshot(SessionDoc, ctx)` 只有 2 个参数；会话级文档是 `snapshot(Token, conversationId, ctx)`——签名不同，容易写错。
7. **fork 会话的 `entries()` 含父历史**，按 entry 求和 token 会重复计账（实测虚高 26 vs 真实 19）。汇总成本只能读 `pi.usage` 文档。
8. **durable 没有 skill / MCP 的内置概念**——skill 对应 `PromptSection`，MCP 要靠 `pi-mcp` 包装成 tool 并设 `deferred: true`。
9. **只靠 prompt 说「你要上报」不可靠**，管理层没有决策权要靠工具层隔离（不给 `decide` 工具）。
10. **新建会话必须显式给 `extensions`**。底层默认选中全部已注册能力包——员工会因此拿到 `staff_hire` 这类管理工具，等于可以自己招人越级（ADR-009）。
11. **能力包名必须唯一**。所有员工共用 `role-employee` 一个名字时，后招的会覆盖前面的定义，部分员工莫名其妙没有任何工具（ADR-014）。
12. **标识生成要支持 Unicode**。员工叫「林越」完全合法，只允许 ASCII 会让派活直接报错（ADR-015）。
13. **测试模型不能进生产清单**。CHRO 会因为它「零成本」优先选中，员工拿到假模型后报 `no_model`（ADR-016）。
14. **registry 是内存态，不持久化**。初始化逻辑里的幂等早退必须放在注册之后，否则重启后所有角色失去工具（ADR-014 同源）。
15. **`maxTokens` 别填太小**。填 16k 时思考链会吃光预算，工具参数根本来不及生成，而模型仍会说「已完成」（ADR-017 的排查过程）。

## 附录 C：这份文档的定位

本文是实现**之前**做的技术选型与架构决策，写作时一行代码都还没有。现在实现已完成，前四章（选型对比、需求映射、架构、决策理由）仍然有效且是理解代码的入口；第五、七章已改写为实际落地情况。

如果你只想快速上手，不必读本文——直接看 [`README.md`](../../README.md)。
