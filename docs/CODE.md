# 代码地图

这份文档回答：**要改某个东西，该动哪个文件。**
系统行为的解释在 [SYSTEM](SYSTEM.md)。

---

## 1. 全局：规模、分层、边界

```
src/domain/   1753 行   纯数据 + 纯函数。无 IO、无依赖、可在没有数据库时单测
src/runtime/  2103 行   防腐层。唯一允许 import @earendil-works/* 的地方
src/company/ 12565 行   业务：装配、工具、频道、任务、升级链、看门狗
src/server/   5006 行   HTTP + SSE + 设置 + 附件
src/tui/      1267 行   终端界面
scripts/                边界检查、截图、UI 检查
test/                   unit(20) / contract(1) / e2e(28)，共约 770 个 case
ui/                     原生 JS，25 个文件，13351 行
```

**分层是被强制的**，不是约定：

`scripts/check-boundaries.mjs` 检查 `src/domain`、`src/company`、`src/tui`、`src/server`
不得 import `@earendil-works/pi-durable` / `pi-ai` / `chord`
（例外：`pi-tui` 是渲染库，界面层可直接用）。`npm run check` 会跑它。

```
入口 → src/runtime/index.ts → pi-durable
         ↑
     src/company/*  src/server/*  src/tui/*
         ↑
     src/domain/*（最底层，谁都能用，它不 import 任何人）
```

依赖方向：**domain ← company ← server/tui**，company 内部也分层（见 §4）。

---

## 2. 启动：从命令到能干活

两条入口，流程几乎相同：

```
src/server/main.ts   （网页，默认 7788）
src/tui/main.ts      （终端）
```

`src/server/main.ts` 的启动顺序（**顺序本身是契约**）：

```
1. acquireInstanceLock(db)          ← 单进程单库，第二个实例直接被拒
2. setupModels(env, {workspace})    ← 读 workspace/settings.json 的自定义模型
3. createRegistry()                 ← 能力包注册表（内存态！）
4. openCompany({databasePath, models, registry, onReport}, ctx)
5. recover(runtime, ctx)            ← 巡检。规格要求「恢复前不执行任何处理器」
6. registry.install(COMPANY_TASKS_EXTENSION)          ← app.anchor
7. registry.install({name:"escalation", tasks:[...]}) ← app.escalation
8. bootstrapCompany(runtime, {...}, ctx)              ← 幂等早退
9. ensureAllChannels(runtime, ctx)                    ← 频道自愈
10. serve({...}) / TUI                                ← 起服务，这里才启动看门狗
```

对应文件：
- `src/runtime/open.ts:123` `openCompany()` — 唯一打开数据库的地方
- `src/runtime/recover.ts` — `recover` / `inspectLiveness` / `retryParked` / `watchForFailure`
- `src/company/org.ts:220` `bootstrapCompany()` — 建组织（幂等）
- `src/company/channels.ts:453` `ensureAllChannels()` — 补齐频道（幂等）

### 三个「必须按这个顺序」的坑

1. **registry 是内存态，不持久化**。必须在 `bootstrapCompany` 早退**之前**注册完，
   否则重启后旧库上的所有角色失去工具（表现为「职责在、工具空」）。见 `src/company/org.ts:643` 附近。
2. **看门狗不在 `bootstrapCompany` 里开**。它是装配函数，被三种入口 + 测试共用；
   偷偷起后台循环会让调用方无法掌控调度。由 `serve()` / TUI 显式打开。
3. **`recover()` 必须在任何处理器执行前**。

---

## 3. 运行时防腐层 `src/runtime/`（82 行出口，14 个文件）

`src/runtime/index.ts` 是唯一出口，全部是转发。逐个文件：

| 文件 | 提供什么 |
|---|---|
| `index.ts` | 全部 re-export（业务层只 import 这个） |
| `open.ts` | `openCompany()`：`openNodeSqliteStorage` + `DurableHarness.open`，把 6 种底层报告收敛成 5 类 `RuntimeReport` |
| `registry.ts` | `createRegistry`、`defineDoc/defineExtension/defineTool/defineTask/hook/section`、`configure`、`Type`、`BACKGROUND_CONTEXT` |
| `env.ts` | `createEnvironmentRegistry`、`NodeExecutionEnv` 包装 + `normalizeCwd()` |
| `recover.ts` | 存活巡检：`inspect`、`inspectLiveness`、`isConversationBusy`、`recover`、`retryParked`、`watchForFailure` |
| `run-failure.ts` | 扫 `TaskDoc` 找 `outcome.status === "failed"`（**这条不触发 onReport**），补 `[任务出错]` |
| `wal.ts` | 启动时 WAL TRUNCATE checkpoint（常驻进程永远等不到 close） |
| `usage.ts` | 转发底层 `UsageDoc`（成本只从它取，ADR-003） |
| `inbox.ts` | 转发底层 `InboxDoc`（队列，界面显示「已排队」用） |
| `capabilities.ts` | 转发底层的 `CodingTools` / `createBashTool` / `createReadTool` / `createEditTool` / `createWriteTool` |
| `models.ts` | `setupModels()`：内置目录 + settings 自定义 + 本地网关探测 |
| `ids.ts` | 标识生成：`delegationRequestId` / `escalationId` / `messageRequestId` / `ownerDecisionRequestId` / `projectSlug` / `reportRequestId` |
| `signals.ts` | `setupSignalHandlers` / `onShutdown` |
| `instance-lock.ts` | 单进程独占锁 |

**要升级 pi-durable**：只改这个目录。`test/contract/runtime.test.ts` 会告诉你底层行为有没有变。

---

## 4. 业务层 `src/company/`（按文件大小排序，前 10 个就是主战场）

| 文件 | 行数 | 职责 |
|---|---|---|
| `org.ts` | 2392 | **装配 + 组织生命周期**（见 §4.1） |
| `escalation.ts` | 1300 | **升级链状态机**（见 §4.4） |
| `roundtable.ts` | 1128 | 圆桌讨论（多阶段 durable task） |
| `disposition.ts` | 857 | 待办处置（暂搁/放弃/恢复条件/超时默认） |
| `watchdog.ts` | 790 | 看门狗（见 §4.5） |
| `management-tools.ts` | 772 | 管理层工具集（`org_tree` / `my_capabilities` / `decide` / `staff_*` / `budget_check` …） |
| `tools/universal.ts` | 601 | 通用工具（`whoami`/`say`/`ask`/`read_channel`/`inbox`/`task_*`） |
| `channels.ts` | 586 | 频道 IO + 投递 + 已读（纯逻辑在 `src/domain/channels.ts`） |
| `delegation.ts` | 533 | 同步转交（老路径，仍在用） |
| `tools.ts` | 416 | **能力包工厂**（见 §4.2） |
| `roles.ts` | 348 | 7 个岗位的定义与职责提示词 |
| `tools/dispatch.ts` | 346 | 派活工具（`assign_task` / `ask_role` / `project_create`） |
| `tasks.ts` | 326 | 任务 IO（纯状态机在 `src/domain/tasks.ts`） |
| `trail.ts` | 314 | 沟通图 / 组织图数据 |
| `cost.ts` | 277 | 成本汇总 |
| `tools/tool-search.ts` | 219 | 自研 `tool_search`（见 §4.3） |
| `org-model.ts` | 157 | `CompanyState` → `Org`（纯映射）。`buildOrg()` 到处用 |
| `capabilities.ts` | 157 | **能力目录**（声明式：谁能用什么、哪些延迟加载） |
| `deliver.ts` | 199 | **唯一的跨 agent 投递原语** |
| `prompts.ts` | 107 | **职责描述/立项文档的唯一生成入口**（纯文案，`org.ts` re-export） |
| `wait.ts` | 42 | `waitOrTimeout()` —— 圆桌等发言、HTTP 等 abort 共用 |
| `decision-routing.ts` | 17 | re-export（真身在 `src/domain/routing.ts`） |
| `delegation-guard.ts` | 165 | 同步等待的环检测 + 超时 |
| `decision-delivery.ts` | 142 | 把决定投回发起方 |
| `staff-tools.ts` | 348 | **员工原子工具表 + 授予粒度**（`write:src/` 的路径隔离，见 §4.6） |
| `watchdog.ts` / `channels-doc.ts` / `docs.ts` / `roundtable-tools.ts` | 各自 | |

### 4.1 `src/company/org.ts` — 装配与生命周期

```ts
bootstrapCompany(runtime, options, context)     // :220  幂等建组织
startCompanyWatchdog(getRuntimeOrRuntime, opts) // :776  工厂，必须传 getter
createProject(runtime, options, ctx)            // :829  建目录 + 写 PROJECT.md + 建负责人会话 + 项目群
repairLeaderAgents(runtime, opts, ctx)          // :931  给老项目补装负责人能力包
migrateWorkspacePaths(...)                      // :985  修相对路径事故
hireStaff(runtime, options, ctx)                // :1059 建锚点任务 + 员工会话 + 名册（一次提交）
archiveStaff / reassignStaff / renameStaff      // :1192 / :1223 / :1304
setProjectStatus(...)                           // :1414
migrateStaffManagers(...)                       // :1490
syncStaffInstructions(...)                      // :1542
terminateProject(runtime, input, ctx)           // :1615 先停活 → 改状态 → 归档 → 留痕（一次提交）
deleteProject(...)                              // :1751 必须已 terminated
listStaff / listAllStaff / readCompany / listModels / setDefaultModel
staffCharterOf(...)                             // :2196 员工实际收到的职责描述
escalateUp(runtime, input, task, ctx)           // :2376 上报的唯一入口
```

内部还有：`AnchorTask`（`:2153`，`app.anchor`）、`COMPANY_TASKS_EXTENSION`（`:2177`）、
`ensureRoleAgents` / `ensureStaffAgents`（修旧库能力包选择）、`STAFF_ROLE_TEMPLATES`。

### 4.2 能力包 = pi-durable 的 `Extension`

**这是本项目最重要的一层抽象**。四个工厂，全在 `src/company/tools.ts`：

```ts
createRoleExtension(role)                          // roles.ts:336   只有 sections（纯提示词）
createRoleExtensionWithTools(role, tools)          // tools.ts:298   sections + tools
createProjectLeaderReadOnlyExtension(tools)        // tools.ts:351   终止后的只读包
createEmployeeExtension(employeeId, tools, univ)   // tools.ts:382   名字 role-employee:<id>
```

`Extension` = `defineExtension({ name, sections, tools, hooks, wraps, tasks })`，
写进会话的 agent 配置并**持久化**——这是「能力包」与「pi CLI 扩展」的根本区别。

四条硬约束：

1. **`sections` 必须是纯函数**（ADR-007）。返回常量字符串，否则每轮追加 system delta，
   彻底破坏 prompt cache。`src/company/roles.ts:306` 的 `COMMON_GUIDE` 就是为此写成常量数组。
2. **名字必须唯一**（ADR-014）。底层按名字存「会话选了哪些包」，员工共名会互相覆盖，
   表现为「某些员工莫名没有任何工具」。
3. **新建会话必须显式指定 `extensions`**（ADR-009）。不指定默认选全部——CEO 会拿到 CHRO 的招聘工具。
   `runtime.harness.root({agent:{extensions:[...]}})`、`createConversation({agent:{extensions:[...]}})`。
4. **注册表是内存态**。见 §2。

改「某岗位能用哪些工具」→ `src/company/roles.ts` 每个 role 的 `capabilityNames` 数组。
改「某员工能用哪些工具」→ 招聘时的 `tools`（名册里的 `StaffEntry.tools`），
可带目录范围如 `write:src/`，范围包装在 `staff-tools.ts` 的 `scopedTools()`（见 §4.10）。
改「某工具是否默认给模型」→ `src/company/capabilities.ts:51` 的 `CAPABILITIES` 的 `core` 字段。

### 4.3 工具：声明式能力目录 + 延迟加载（ADR-032）

```
src/company/capabilities.ts    CAPABILITIES: 36 条，14 条 core，22 条 deferred
                               layers: universal / exec / staff / leader / management / ceo
src/company/tools.ts:29        deferNonCore(): 给非 core 的打 deferred:true，并补 tool_search
src/company/tools/tool-search.ts:155  createToolSearchTool(): BM25 检索 → control.addTools
```

`control.addTools` 写进会话的 `modelTools.add`，**跨压缩保留**，且**按名字解析、不看 registry**——
所以工具「暂时没注册，等它注册上就自动可用」。

**为什么自研 tool_search 而不是用底层的**：底层 BM25 分词器是 `.split(/[^a-z0-9]+/)`，
对中文返回空数组 → 中文用户等于能力被删。自研版做 ASCII 词 + 中文 bigram
（「推进项目状态」→ 推进/进项/项目/目状/状态）。

**不给模型「动态创建工具」的边界**，写在 `src/company/capabilities.ts:19-22`：

> 工具是 TypeScript 函数，注册即任意代码执行。能力目录是静态代码（受 review），
> 装配是动态的。这条边界不能破。

### 4.4 通信：`deliver.ts` 是唯一原语（ADR-028）

```
src/company/channels.ts:171   postToChannel()  写频道 + 调 deliver
src/company/deliver.ts        deliver()        投进目标会话队列（whenBusy:"steer"，不等待）
src/company/deliver.ts        notify()         不经频道，直接往会话流写（wake:false 只记录不上屏）
src/domain/channels.ts:379    recipientsOf()   纯函数：谁被唤醒
src/domain/channels.ts:423    digestFor()      纯函数：未读摘要
```

`deliver()` 的三条硬约束写在文件头：不等待回复 / 投递失败不能让消息丢失 / 每条投递带未读摘要。
逐条 `try/catch`——一条失败不影响其余（教训：原实现 `for...await submit` 让第 k 条抛错时 k+1..n 永久丢失）。

请求标识 `requestId = "ch:{channelId}:{seq}:{target}"`：同一条消息重复投递会被去重
（崩溃恢复是至少一次语义，ADR-006）。

### 4.5 升级链 `src/company/escalation.ts`（1300 行，最复杂的业务）

```ts
createEscalationTask(runtime)      // :266  工厂函数（要闭包 CompanyRuntime）
PendingDoc                         // :213  app.pending
EscalationState 三个阶段：          // :76-90
  { phase: "ask-manager", level, askedAt, path }
  { phase: "ask-ceo",     askedAt, path, review? }
  { phase: "ask-owner",   askedAt, path }
```

每级跃迁提交检查点 → 崩溃重开从当前级继续，不重复询问。
「问询」不是同步阻塞：写 `PendingDoc` 然后休眠；答复后任务醒来读答复推进。

配套：
```
src/domain/routing.ts:81        decideOwner()      纯函数，只按 topic + 汇报线判定
src/company/disposition.ts      settleDisposition() 暂搁/放弃/恢复条件/超时默认值
src/company/decision-delivery.ts deliverDecision() 把决定投回发起方
src/domain/membership.ts:283    nextLevelUp()      沿 manager 链算上一级
src/domain/membership.ts:345    escalationPath()   完整上报路径（界面展示用）
```

### 4.6 任务

```
src/domain/tasks.ts  纯状态机：TASK_STATUSES(todo/doing/blocked/review/done/cancelled)
                     transitionTask() 校验合法性；needsReport() 判定哪些状态必须上报
src/company/tasks.ts TaskDoc(app.tasks) + 读写 + 状态变化后写频道
```

**状态变化由系统写，不经模型**（ADR-031）：模型调 `task_update` 只改状态机，
写进频道的那条报告由 `src/company/tasks.ts` 生成。所以不存在「模型忘了汇报」的路径。

`task_update` 报 `done` 必须带 `evidence`，否则拒绝（`src/company/tools/universal.ts:460`）。

任务进 `done` 时还会顺带做两件事：结算 token/成本（`usageAtStart` → `usage` 差额），
并给它投一条 `app.memory-hint`（`wake: true`，进上下文并唤醒）提醒写一条经验。

> 这条提醒曾经是 `wake: false`：`submit({type:"write"})` 没有 `model`，底层
> `isDisplayOnly` 判定它只进会话流，`contribute()` 取 `entry.model ?? []` 得到空——
> 提示**永远不进模型上下文**。实测生产库 `app.memory-hint` 0 条、`memory_write` 0 次。

### 4.7 记忆 `src/domain/memory.ts` + `src/company/memory.ts`（#12）

```
src/domain/memory.ts  纯逻辑：appendMemory（正文限长 + 同任务覆盖）
                      compactMemory（超限：只折同一 depth 层的 20 条成阶段总结，
                                     depth 上限 MAX_DEPTH=3，到顶后丢最老原始条目）
                      rankMemory（标题 +3 / 标签 +2 / 正文 +1，无向量）
                      renderMemoryBrief（最近 3 条 + 相关 2 条）
src/company/memory.ts MemoryDoc(app.memory) + memory_write / memory_search 两个工具（都是核心能力）
                      memoryActorOf()：按角色决定写哪一层（模型不能声明归属）
```

三层容量：staff 50 / project 100 / company 200。**读侧只有 `deliver()` 一个注入点**，
项目层与公司层不进提示词，只在显式 `memory_search` 时读。

### 4.8 看门狗 `src/company/watchdog.ts`

```ts
startCompanyWatchdog(source, options)        // org.ts:776
WatchdogOptions                              // :81
默认：intervalMs 30_000 / generationOverdueMs 600_000 / toolOverdueMs 300_000
      maxAttempts 2 / drainInbox true / immediate true
WatchdogAction = abort|retry|drain|report|escalate-question|nudge-task|resurface   // :30
```

六件事：判定 / 收尾 / 排空队列 / 升级没回音的问题 / 提醒卡住的任务 / 老板消息没人理。
判定逻辑**复用** `src/runtime/recover.ts`（不重复实现，避免界面/派活/看门狗三处口径不一致）。

每次动手写一条 `app.alert` 进会话流（`ALERT_ENTRY_KIND`）。

### 4.9 决策路由的迁出

`src/company/decision-routing.ts` 只有 7 行 re-export。真身在 `src/domain/routing.ts`——
它是纯函数，本就不该和 IO 混在一起（2026-10-26 迁移，逻辑一行未改）。

### 4.10 员工能力粒度 `src/company/staff-tools.ts`（ADR-035）

```ts
STAFF_ATOMIC_TOOLS          read / write / edit / bash 四个原子工具 → 工厂
toolsForNames(names)        工具名 → 能力包里的工具（名字可带目录范围）
scopedTools(tool, options)  给 read/write/edit 套上「只能动这个目录」的包装
assertGrantable(name)       层级 + 存在性 + 范围语法校验
assertToolsRequested(names) 招聘入口的显式性检查（空就报错，绝不兜底）
```

**工具名带一段可选的目录范围**：`"write"` = 整个工作空间（老语义），
`"write:src/"` = 只允许写工作空间里的 `src/`。`read` / `edit` 同理。

三条要点：

1. **对模型暴露的 `name` 仍是基名**（`write`），范围只体现在 description 与拦截面。
   能力包里的工具名必须唯一（ADR-014），否则模型看到两个同名不同义的工具。
   同一原子工具被声明多次时只留一个：有 `write` 优先 `write`（打 warning 说冗余）。
2. **校验走 `env.absolutePath()` + `env.canonicalPath()`**，前缀边界必须是分隔符
   (`.../src` 不匹配 `.../src-evil`)。底层内建工具不接受 root/scope，所以约束
   只能在业务层包一层（`src/runtime/capabilities.ts` 转发 `ExecutionEnv` 类型）。
3. **`bash` 不参与 scope**（`bash:src/` 直接报错）。命令里的路径只是文本，
   前缀检查拦不住 `cd ..`——**有 bash 就等于有全盘写权限**。真正的文件级隔离
   只有一种写法：不给 bash，只给 `write:<目录>/` / `edit:<目录>/`。

`CompanyDoc` 是 version 3，但 v2 → v3 **不动 `tools`**：迁移不是收权的时机
（收紧权限会让已派出的任务突然失败）。

---

## 5. 数据文档一览

```ts
src/company/docs.ts:56        CompanyDoc   app.company    scope:"session"  checkpointWhen:()=>false
src/company/docs.ts:90        ProfileDoc   app.profile
src/company/docs.ts:134       AuditDoc     app.audit      每 512 条压一次基线
src/company/docs.ts:154       BudgetDoc    app.budget
src/company/docs.ts:198       TrailDoc     app.trail
src/company/channels-doc.ts:11 ChannelDoc  app.channels   deltasSinceBase >= 64
src/company/escalation.ts:213  PendingDoc  app.pending
src/company/roundtable.ts:121  RoundtableDoc app.roundtable
src/company/tasks.ts:50        TaskDoc     app.tasks      deltasSinceBase >= 64
src/company/memory.ts:34       MemoryDoc   app.memory     deltasSinceBase >= 64
```

`src/company/docs.ts` 头注释讲了压基策略：**只增不改的文档按条目数判基（每 512 条），
不按写入次数判基**——频道文档单条 delta 有几十 KB，按次数压基等于每 64 次写就重写整份。
纯类型与纯函数拆在 `src/domain/org-types.ts`，`docs.ts` re-export（调用方 import 路径不变）。

底层还自带 `UsageDoc`（成本）与 `InboxDoc`（队列），经 `src/runtime/` 转发。

**会话流里出现的 entry kind**（`app.*`）：
`app.channel` `app.delegate` `app.task` `app.tasks` `app.task-report` `app.decision` `app.question`
`app.receipt` `app.ack` `app.alert` `app.log` `app.trail` `app.message` `app.stop`
`app.company` `app.profile` `app.channels` `app.pending` `app.audit` `app.budget` `app.anchor` `app.roundtable`
`app.memory` `app.memory-hint`

`app.ack` 的 `data` 是 `{ text, channelId, messageSeq, busy, busyWith, plan, at }`。
`messageSeq` 是**这条回执指向频道里的哪条消息**——`src/server/channels-view.ts` 的
`ackIndex()` 靠它把回执接回消息（`MessageView.acks`）。写回执的是 `src/server/http.ts`
的 `writeAck()`：落库必须在消息写入频道**之后**（那时才知道 `messageSeq`），但「对方忙不忙」
要在投递**之前**采样（投递后对方立即开工，`busy` 会恒为真）——所以拆成
`snapshotAcks()`（投递前采样）+ `writeAck()`（投递后落库）两步。

---

## 6. 界面层

### 6.1 网页 `src/server/`

```
http.ts        1923 行  路由 handler + SSE + 静态文件
routes.ts       122 行  **路由表**（表驱动，见 §6.2），新增接口先动这里
feed.ts         785 行  readFeed() 把会话已提交状态转成可渲染条目（Web UI 唯一数据源）
settings.ts     477 行  settings.json 读写（模型、网络、IM）
org-view.ts     425 行  buildOrgView() 组织快照（SSE 推给前端）
channels-view.ts 565 行  频道视图（含 `MessageView.acks`：把会话流里的 `app.ack` 接回频道消息）
board.ts        260 行  看板（只读 TaskDoc）
main.ts         240 行  入口
event-log.ts    168 行  describeReport() 报告 → 日志行
im.ts           168 行  外部 IM 接入
profile.ts      156 行  员工档案（如实展示真实提示词）
uploads.ts      152 行  附件
actors.ts                发言人解析（「这是谁说的」）
avatars.ts               DiceBear 头像（按名字稳定生成）
network.ts               局域网地址枚举
```

### 6.2 路由是表，不是 if 链

`src/server/routes.ts` 只做一件事：`matchRoute(routes, method, path)`。语义是
「按 `/` 分段、`:name` 捕获一段、`*name` 吃剩余全部、表序即优先级」。
`src/server/http.ts` 的 `handle()` 现在只有三步：取 path → 查表 → 调 handler，
**没有分支**。新增接口 = 往 `routes` 加一行 + 写 handler，不用改调度逻辑。

排布有唯一一条纪律：**具体写在通配前**。例如 `/api/channels/:id/mentionable`
必须排在 `/api/channels/:id` 前面，`*rest`（静态资源兜底）永远最后。

API 路由一览（声明在 `src/server/routes.ts` 的 `routes` 数组，handler 在 `src/server/http.ts`）：

```
GET    /api/org                    组织快照
GET    /api/pending                待决问题
GET    /api/feed/:conversationId   会话流
GET    /api/profile/:conversationId 员工档案
GET    /api/stream/org              SSE 组织
GET    /api/stream/feed/:id         SSE 会话流
POST   /api/message                老板发言（带附件、忙时排队）
POST   /api/answer                 回答待决问题
POST   /api/pending/dispose        处置待办
POST   /api/pending/take-over      CEO 接管老板级待办
POST   /api/interrupt              「立即处理」
GET/PATCH /api/settings
POST/DELETE /api/models
POST   /api/upload   GET /uploads/*
GET    /api/avatar/:seed
GET    /api/channels   GET /api/channels/:id   POST .../messages   POST .../read
GET    /api/board                  看板
POST   /api/im/inbound             外部 IM 入站
```

**契约在 `docs/WEB-API.md`**。改接口先改它。

### 6.2 终端 `src/tui/`

```
state.ts   423 行  状态 → 视图模型（纯数据，可单测）
app.ts     355 行
render.ts  256 行  自定义整屏组件（ADR-018）
main.ts    187 行
```

### 6.3 前端 `ui/`（原生 JS，无框架）

```
index.html      216 行
js/app.js  board.js  channels.js  org.js  profile.js  settings.js
   pending.js  markdown.js  feed-render.js  toast.js  icons.js  format.js
   edges.js  starfield.js  dev-fixtures.js  dom-utils.js
css/tokens.css shell.css graph.css profile.css markdown.css trace.css
   settings.css board.css channels.css pending.css motion.css
```

数据只走一个流接口（ADR-021）：`/api/stream/org`（SSE，不是 WebSocket，ADR-019）。
频道消息走 `/api/channels*` 轮询 + org 事件触发刷新。

**右侧对话面板已删除**（`ui/js/chat.js` / `ui/js/ask.js` / `ui/css/chat.css` 已移除）：
聊天入口只有频道视图的私聊，待办卡片内联在消息流里（`ui/js/pending.js`）。
拆分出来的三个样式文件是从 chat.css 里救活的公共部分：`profile.css`（角色档案浮层 +
`#ch-dock` 侧边面板 + `chat-spinner`）、`markdown.css`（`.md*` 全套 + 代码块复制按钮）、
`trace.css`（`.think` / `.tool` / `.pane-*`，即 `ui/js/feed-render.js` 产出的思考与工具流水）。
**漏搬 `trace.css` 的后果**是将私聊流水退化成裸 `<details>` + 不换行的一长串等宽文字。

### 6.4 可选的打包层（`ui/dist/`）

`ui/` 源码保持「无构建」：25 个文件直接可读可改，改完刷新即生效。
但首屏要发 12 个请求，走 Cloudflare 隧道时成本远超字节成本（详见 `docs/TUNNEL.md`），
所以提供**一层可选产物**：

```bash
npm run ui:build     # → ui/dist/{index.html, app.css, app.js, .stamp}
```

| 文件 | 作用 |
|---|---|
| `scripts/build-ui.mjs` | 读 `ui/index.html` 里的 `<link>`/`<script>` 顺序，拼 CSS、esbuild 打包 JS |
| `src/server/static-root.ts` | `resolveStaticRoot(uiDir)` 决定服务 `ui/dist/` 还是 `ui/` |
| `ui/dist/.stamp` | 构建时写入的「源码最新 mtime」，服务端据此判断产物是否过期 |

**三条不能破的约束**（都有测试钉住，`test/unit/static-root.test.ts`）：

1. 没有 `ui/dist/` → 回退源码。`git clone` 完 `npm start` 直接能用，不要求先装 esbuild；
2. 源码比产物新 → 回退源码。改了 `ui/js/*.js` 忘了构建，刷新生效的仍是源码，
   不会出现「改了没反应」的静默失效；
3. `ui/dist/` 自身不参与新旧比较 —— 否则构建产物的 mtime 永远比 `.stamp` 新，判过期死循环。

esbuild 用 `external: ["../vendor/three.module.js"]`：three.js 691 KB 不内联，
否则主包变 713 KB（比不打包还差）。因此 `serveStatic` 收的是**目录列表**，
`/vendor/three.module.js` 在 `ui/dist/` 里找不到时会回退到 `ui/`。

另：`ui/js/app.js` 把星海改成 `requestIdleCallback` 后才能 `import("./starfield.js")`，
首屏不再为背景付这 158 KB（br）。

---

## 7. 领域纯函数 `src/domain/`

```
org-types.ts   224   组织类型 + ROLE_LABELS + MANAGER 引用解析（ManagerRef = role | "leader:<slug>"）
membership.ts  357   人/组织查询：personOf labelOf canView canMention mentionable
                     canAssign canEscalate nextLevelUp levelOfPerson escalationPath buildOrg 的输入
channels.ts    497   频道纯逻辑：createChannel appendMessage recipientsOf digestFor
                     advanceRead markMentionRead dmChannelId parseChannelId
tasks.ts       434   任务状态机：transitionTask canTransition needsReport tasksOf*
routing.ts     241   决策路由：decideOwner routeUpLine levelOfTarget conversationOfTarget canReachOwner
```

**这一层不 import 任何运行时库**，所以能在没有数据库的情况下单测。
`ManagerRef` 必须是**字符串标量**（不能是对象）：升级链把层级原样存进待决文档并用 `===` 比较，
对象经 JSON 落盘再恢复引用必然不等，会让升级任务永远等不到答复（表现为 30s 超时，不是报错）。

---

## 8. 常改的地方 → 该动哪

| 我想改… | 动这里 |
|---|---|
| 某岗位能用哪些工具 | `src/company/roles.ts` 里该 role 的 `capabilityNames` |
| 某工具是否默认给模型 | `src/company/capabilities.ts:51` `CAPABILITIES` 的 `core` |
| 工具的说明/参数 | `src/company/tools/universal.ts`、`dispatch.ts`、`management-tools.ts` |
| 角色提示词 | `src/company/roles.ts` 的 charter + `COMMON_GUIDE`（**必须是常量**） |
| 员工的职责模板 | `src/company/prompts.ts` 的 `STAFF_ROLE_TEMPLATES`（`org.ts` 已 re-export） |
| 谁能派给谁 | `src/domain/membership.ts:147` `canAssign`（**会影响 e2e/hierarchy.test.ts**） |
| 谁能看哪个频道 | `src/domain/membership.ts:84` `canView` |
| 谁被唤醒 | `src/domain/channels.ts:379` `recipientsOf`（**成本敏感**） |
| 频道成员构成 | `src/company/channels.ts:453` `ensureAllChannels` |
| 决策路由规则 | `src/domain/routing.ts:81` `decideOwner` |
| 升级链阶段 | `src/company/escalation.ts` 的 `EscalationState` + phases |
| 待办处置规则 | `src/company/disposition.ts` |
| 看门狗阈值/动作 | `src/company/watchdog.ts:81` `WatchdogOptions` |
| 任务状态机 | `src/domain/tasks.ts` `TRANSITIONS` |
| 新增一个数据文档 | `src/company/docs.ts`（用 `defineDoc`） |
| 新增一个 durable task | `src/company/*.ts` 用 `defineTask`，再 `registry.install({name, tasks})` |
| HTTP 接口 | 先加一条到 `src/server/routes.ts` 的 `routes`，handler 写 `src/server/http.ts`；再改 `docs/WEB-API.md` |
| 网页样式/交互 | `ui/` |
| 换模型 / 读用量 | `src/runtime/models.ts`、`src/runtime/usage.ts` |
| 升级 pi-durable | **只改 `src/runtime/`**，跑 `test/contract/` |

---

## 9. 测试

```
test/unit/        29 个：纯函数（domain 层）+ capabilities / staff-scope / role-charter /
                        company-migration / ids / settings / wal / routes …
test/contract/     1 个：runtime.test.ts —— 钉住底层行为，升级 pi-durable 后必跑
test/e2e/         31 个：acceptance hierarchy escalation decision-loop channels-deliver
                        channel-ack delivery-receipt delegation restart-channels terminate
                        roundtable owner-gate real-model reliability org web …
test/support.ts         共用搭建（临时库 + 假模型）
```

**跑法（ADR-036）**：`npm run verify` 才是验收标准，不是 `npm test`。它跑完写
`.taste/verify-receipt.json`，`numPendingTests > 0` 即失败——**跳过的测试等于没测**。
想跳真模型测试必须显式 `SKIP_REAL_MODEL=1`。`npm run verify:check` 校验收据是同一 commit
且 24 小时内。

**关键回归测试**（改对应代码必跑）：

| 改什么 | 跑什么 |
|---|---|
| 层级/权限 | `test/e2e/hierarchy.test.ts`、`test/unit/domain-membership.test.ts` |
| 通信/投递 | `test/e2e/channels-deliver.test.ts`、`test/unit/domain-channels.test.ts` |
| 升级链 | `test/e2e/escalation.test.ts`、`escalation-ceo-gate.test.ts`、`owner-only-from-ceo.test.ts` |
| 决策路由 | `test/e2e/decision-routing.test.ts`、`decision-loop.test.ts`、`adr-026-obedience.test.ts` |
| 能力目录 | `test/unit/capabilities.test.ts` |
| 员工能力粒度（scope） | `test/unit/staff-scope.test.ts`、`staff-capabilities.test.ts` |
| 岗位职责文案 | `test/unit/role-charter.test.ts` |
| 数据文档迁移 | `test/unit/company-migration.test.ts` |
| 投递回执 | `test/e2e/delivery-receipt.test.ts` |
| 频道回执（老板看得见的「已排队」） | `test/e2e/channel-ack.test.ts` |
| 派活去重 | `test/unit/domain-tasks.test.ts`（`describe("重复任务")`） |
| 同步等待 | `test/unit/delegation-guard.test.ts`、`test/e2e/delegation.test.ts` |
| 底层升级 | `test/contract/runtime.test.ts` |

命令：`npm run check`（tsc + 边界）→ `npm run verify`（vitest --run + 收据，跳过 0 才算过）。

---

## 10. 规格与决策记录

```
  communication-trail  company-runtime  cost-accounting  delegation  escalation
  org-structure  project-authority  project-lifecycle  project-workspace  tui-workspace
docs/DECISIONS.md        36 条 ADR（每条有背景、替代方案、为什么这么选）
docs/history/PLAN.md     技术选型 + 架构 + 附录 B「必踩的 15 个坑」（已冻结）
docs/WEB-API.md          网页 API 契约
```

**改代码之前必读的 ADR**：

```
ADR-001  底层库只能在 src/runtime 内 import
ADR-002  锁定精确版本，不用 ^
ADR-003  成本只从 UsageDoc 取，禁止按历史消息求和
ADR-004  员工能力包不含任何管理工具
ADR-005  员工的归属必须是后台任务
ADR-007  角色职责描述必须是纯函数
ADR-009  新建会话必须显式指定能力包
ADR-014  员工能力包名必须唯一
ADR-025  同步转交必须有环检测和忙碌快速失败
ADR-026  指令无条件受理，决策按汇报线路由，等待必须有默认值与期限
ADR-028  deliver() 是唯一的跨 agent 原语
ADR-029  频道集中存储，广播存储 + 定向唤醒
ADR-031  完成上报由系统写，不经模型
ADR-032  能力目录声明式 + 延迟工具 + tool_search
ADR-033  老板级待办只能由 CEO 递
ADR-034  投递回执——投递成功 ≠ 已读，unanswered 必须可见并告警
ADR-035  能力粒度——scope 写在工具名里，隔离靠工具不存在
ADR-036  验收标准是机器可读收据，不是「测试全绿」这句话
```

---

## 11. 改动前的检查清单

1. 读 `docs/DECISIONS.md`：你要动的这块碰不碰边界
2. 读相关 ADR
3. 确认改的是哪一层（domain 不许 import 运行时库）
4. `npm run check`（会跑边界检查）
5. `npm test`，至少要跑 §9 表里对应的那几个
6. 动了 `src/runtime/` 或升级了依赖 → 备份 `workspace/company.sqlite`，跑 `test/contract/`
