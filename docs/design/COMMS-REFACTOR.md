# 通信重构：从「同步调用」到「消息总线」

**状态**：生效中（落地进行时）
**日期**：2026-10-26
**替代**：ADR-025（同步转交）全部；`TrailDoc` 与 `delegation.ts` 的职责

---

## 0. 一页纸

### 0.1 问题

当前架构把「通信」实现成了「同步函数调用」：

```
CEO 调 delegate_to_role("cto", ...)
  └─ cto.submit(...)
  └─ await submission.wait(180s)   ← 卡在这里等 CTO 整轮跑完
  └─ readAssistantText(cto)        ← 从对方会话里「捞」回复文本
```

这一行 `await` 同时造成五个症状：

| 症状 | 原因 |
|---|---|
| CEO 派活后阻塞 | 同步等待，硬上限 180s。派 3 个活卡 9 分钟 |
| 做完不上报 | 上报是 `delegate()` 内部顺带写的。只在「同步等待成功返回」这条路径上发生。超时/abort → 上报根本不会写 |
| 员工不问上级 | `escalate` 描述是「超出授权范围才用」，模型理解为「只有大事」。且问一次要等对方整轮，成本高 → 倾向自己猜 |
| 员工之间无法通信 | 「通信」绑在 `delegate`（派活）上，而派活有层级校验。开发想找测试问一句，物理上做不到 |
| 没有真正的「任务」 | 看板从「谁在忙」推导卡片，那是运行时状态，不是任务 |

### 0.2 解法

**通信与工作分离**，两者都变成「消息」：

```
Channel（频道）── 通信容器：公司群 / 领导层群 / 项目群 / 私聊 / 个人记录
   └ Message（消息）── 通信事实：谁在哪个频道说了什么、@了谁、谁已读

Task（任务）────── 工作容器：必须有验收标准，才有资格上看板
   └ TaskEntry ────── 状态机：todo → doing → review → done
```

**唯一的跨 agent 原语是 `deliver()`：投递后立刻返回，不等待回复。** 回复通过频道异步回来。

### 0.3 收益

| 指标 | 现在 | 目标 |
|---|---|---|
| CEO 连发 3 条指令 | 9 分钟 | < 3 秒 |
| 「做完没上报」 | 结构上可能 | 结构上不可能（系统写） |
| 员工提问 | 只能走 escalate（重） | `ask`（轻）+ 10 分钟未回自动升级 |
| 员工互通 | 不可能 | 项目群 @ 即可 |

---

## 1. 老板拍板的五条（2026-10-26）

1. **公司大群包含所有员工**（老板 + CEO + 6 管理层 + 全部负责人 + 全部员工）。
2. **「真任务」必须带验收标准**。下达任务时就要留意这点——`task_create` 强制校验 `acceptance` 非空，空的不是任务。
3. **项目负责人只负责收消息、分析判断、整理信息、拍板**，不做长时间阻塞的工作，因此不应长时间不回复。仍然保留超时升级作为兜底。
4. **老板可以在任何地方发起任务**：任何群、任何私聊，可以 @ 任何人派任务或询问信息。
5. **旧数据可以删除**（`TrailDoc` 不迁移）。
6. **老板级待办只能由 CEO 递给老板**（2026-10-26 追加，硬规则）：

   > 需要我（老板）拍板确认的事情，只能 CEO 给我。其他问题，他们自己找上级决定，
   > 如果上级决定不了，上级再交给他的上级。直到我。

   两层含义：
   - **逐级上升，不许跳级**：员工 → 项目负责人 → 对应管理层 → CEO → 老板。
   - **只有 CEO 能进老板层**：非 CEO 无论声明什么 topic、escalate 多少次，
     都进不了 `ask-owner`。

   实现：`domain/membership.ts` 的 `nextLevelUp()`（逐级上升）+
   `domain/routing.ts` 的 `canReachOwner()`（唯一入口判定）。
   测试：`test/e2e/owner-only-from-ceo.test.ts`（11 条）。

---

## 2. 领域模型

### 2.1 ChannelDoc（session 级，一个文档）

```ts
type ChannelState = {
  channels: Record<string, Channel>;
  /** 全局单调序号，跨频道排序与游标用 */
  nextSeq: number;
};

type Channel = {
  id: string;              // "company" | "leadership" | "proj:slug" | "dm:191" | "log:191"
  kind: "company" | "leadership" | "project" | "dm" | "log";
  title: string;
  project?: string;
  /** key = String(conversationId)；老板是 "0" */
  members: Record<string, Member>;
  createdAt: number;
  archived?: boolean;
  /** 只保留最近 MAX_MESSAGES_PER_CHANNEL 条（800） */
  messages: ChannelMessage[];
  lastSeq: number;
};

type Member = {
  conversationId: number;  // 0 = 老板
  role: "owner" | "ceo" | "management" | "leader" | "staff";
  joinedAt: number;
  /** 读到第几条。未读数由它推导，不单独存 */
  lastReadSeq: number;
  /** 群里不 @ 他的消息是否也唤醒他（默认 false，老板恒 true） */
  wakeOnAll?: boolean;
};

type ChannelMessage = {
  seq: number;
  at: number;
  from: number;            // 0 = 老板
  fromLabel: string;
  kind: "chat" | "task" | "report" | "question" | "decision" | "system" | "ack";
  text: string;
  mentions: number[];
  /** 被 @ 的人里谁已经读过 —— 灰点/绿点靠它 */
  readBy: number[];
  refs?: { taskId?: string; pendingKey?: string; projectSlug?: string };
};
```

**为什么集中存而不是散在各自会话里**：

1. 公司群 15 人，一条消息存 15 份 = 15× 存储
2. 已读状态天然是 `(频道, 成员)` 维度，只有集中存才成立
3. 上下文控制：群消息不该全进每个人 context（会爆），集中存 + 按需读

### 2.2 TaskDoc（session 级，一个文档）

```ts
type TaskState = {
  tasks: Record<string, TaskEntry>;
  nextId: number;
};

type TaskEntry = {
  id: string;              // "T-7"
  project: string;
  channelId: string;
  title: string;
  brief: string;
  /** 验收标准。**必填**，空的不是任务 */
  acceptance: string;
  assignee: number;        // 唯一负责人
  assignedBy: number;      // 0 = 老板
  status: "todo" | "doing" | "blocked" | "review" | "done" | "cancelled";
  priority: "low" | "normal" | "high";
  createdAt: number;
  startedAt?: number;
  doneAt?: number;
  /** 完成证据：文件路径 / 测试输出 / 提交号 */
  evidence?: string;
  blockedReason?: string;
  dependsOn: string[];
  progress: { at: number; text: string }[];
};
```

**「真算得上任务」的判据**（`task_create` 强制校验）：

1. `acceptance` 非空
2. `assignee` 是唯一一个人
3. `project` 非空

不满足就报错并提示「这是聊天，用 `say` 或 `ask`」。**看板只读 TaskDoc**。

### 2.3 五类频道

| 频道 | id | 成员 | 用途 |
|---|---|---|---|
| 公司大群 | `company` | 老板 + CEO + 6 管理层 + 全部负责人 + 全部员工 | 公告、跨项目协调 |
| 领导层 | `leadership` | 老板 + CEO + 6 管理层 | 战略、预算、人事 |
| 项目群 | `proj:<slug>` | 老板 + 项目负责人 + 该项目员工 | 日常沟通主战场 |
| 私聊 | `dm:<id>` | 老板 + 某个人 | 老板私聊（只有老板能发起） |
| 个人记录 | `log:<id>` | 只有本人（老板可读） | 个人工作记录 = 现在的会话流 |

### 2.4 现有文档的处置

| 文档 | 处置 |
|---|---|
| `CompanyDoc` | 保留。**不加字段**（避免升版本要写 migrate） |
| `ProfileDoc` | 保留 |
| `AuditDoc` | 保留（审计是审计，聊天是聊天） |
| `PendingDoc` | 保留，加可选 `channelSeq?` |
| `TrailDoc` | **删除**。沟通事实由 ChannelDoc 承担 |
| `BudgetDoc` | 保留 |
| `RoundtableDoc` | 保留，发言改频道消息 |

---

## 3. 投递策略（整套设计的关键）

群是**广播存储**，投递是**定向唤醒**。否则 15 人公司群每条消息唤醒 15 个 agent，成本爆炸。

| 触发 | 谁被唤醒 |
|---|---|
| 消息里有 @ | 被 @ 的人（立即） |
| 老板发言，无 @ | 该频道的 owner（`company`/`leadership` → CEO；`proj:x` → 该项目负责人） |
| agent 发言，无 @ | **不唤醒任何人**，只进频道 |
| `task_create` | assignee（立即） |
| `task_update` 到 done/blocked/review | assignedBy（系统自动） |
| 老板 DM | 对方（立即） |
| 老板在任何频道 @ 任何人 | 被 @ 的人（立即，最高优先级） |

**没被唤醒的人**：下次因任何原因醒来时，输入前缀自动带未读摘要：

```
【你有 7 条未读】
- 公司群：CEO 宣布 Q4 目标（3 条）
- 项目群：林越 @你 问接口字段（1 条，未回复）
- 私聊：老板问你进度（1 条）
```

### 3.1 消息怎么进 agent 的上下文

**不整条塞进去**。投递给 agent 的是一条紧凑消息：

```
【项目群 ops-defect-loop · 林越 @你】
T-3 的登录接口，token 过期后返回 401 还是 403？
（频道消息 #47，用 read_channel 看上下文）
```

完整历史在频道里，需要时用工具拉。上下文可控，因果关系可追（seq 号）。

### 3.2 已读 / 未读

```
消息发出 → mentions = [191, 205]
              ├─ 191 未读 → ● 灰
              └─ 205 已读 → ● 绿
```

「已读」置位三个时机：

1. **立即**：投递时对方会话空闲 → 投递后标记
2. **显式**：agent 调 `read_channel` 或在该频道 `say`/`ask` → 标记
3. **兜底扫描**：看门狗每 30 秒扫一遍，成员会话在投递后产生了新条目 → 标记

第 3 条必须存在（前两条会漏）。

---

## 4. 能力目录

### 4.1 动态能力的三层机制

| 层 | 机制 | 现状 |
|---|---|---|
| 1 | `registry.install()` 同名替换 = 热更新 | 已用 |
| 2 | `conversation.configure({ extensions })` 会话级重配 | 已用 |
| 3 | `deferred: true` + `tool_search`（BM25 检索后 `control.addTools` 加载） | **未用，本次启用** |

**不能做**：让模型自己写工具。工具是 TypeScript 函数，注册即任意代码执行。能力目录是静态代码（受 review），装配是动态的。

### 4.2 全量能力清单

**通用（所有 agent，直接给）**

| 工具 | 作用 |
|---|---|
| `whoami` | 我是谁：名字、角色、直属上级、下属、频道、任务数 |
| `my_capabilities` | 当前真实可用工具清单（已有） |
| `say` | 当前频道发言（不 @） |
| `ask` | 当前频道发言 + @ 某人（触发投递） |
| `read_channel` | 读频道历史（since / cursor） |
| `inbox` | 我未读的 @ 和任务变更 |
| `task_list` | 我的任务 |
| `task_update` | 报进度 / 阻塞 / 完成（完成必须带 evidence） |
| `tool_search` | 搜能力 |

**执行（按角色）**

| 工具 | 产品 | 设计 | 开发 | 测试 | 运营 |
|---|---|---|---|---|---|
| `read` | ✓ | ✓ | ✓ | ✓ | ✓ |
| `write` / `edit` | ✓ | ✓ | ✓ | ✓ | ✗ |
| `bash` | ✗ | ✗ | ✓ | ✓ | ✗ |

**员工专属**：`escalate`（正式上报，进 PendingDoc）

**项目负责人**：`task_create`、`task_reassign`、`answer_question`、`decide`、`project_status`、`project_plan`、`staff_list`、`org_tree`

**管理层（按岗位裁剪）**

| 通用 | 工具 |
|---|---|
| 所有管理层 | `task_create`、`answer_question`、`decide`、`delegate_to_role` |
| CTO | `review_architecture` |
| CFO | `budget_check`、`cost_report` |
| CPO | `project_create`、`project_plan` |
| CHRO | `staff_hire`、`staff_rename`、`staff_reassign`、`staff_archive` |
| COO | `roundtable`、`roundtable_minutes`、`project_list` |

**CEO**：`task_create`、`answer_question`、`take_over_pending`、`project_terminate`、`project_delete`、`roundtable`、`roundtable_minutes`、`company_overview`

**老板（不是 agent，走 HTTP）**：任意频道发言、任意 DM、回答/驳回 owner 级待办、**直接给任何人建任务**、终止/删除项目

### 4.3 能力目录的数据结构

```ts
// src/company/capabilities.ts
type Capability = {
  readonly name: string;
  readonly tool: ToolRegistration;
  /** 默认直接给谁；不在列表里的靠 tool_search 找 */
  readonly core: readonly RoleKey[];
  readonly layer: "universal" | "exec" | "staff" | "leader" | "management" | "ceo";
};
```

---

## 5. 六条核心流程

### 5.1 任务下达（替代同步派活）

```
CEO 调 task_create({ project, title, acceptance, assignee })
  ↓
1. 校验：acceptance 非空、assignee 属于该项目、调用方有权下达
2. 写 TaskDoc（status=todo）
3. 写频道消息（kind=task, mentions=[assignee]）
4. deliver(assignee, 紧凑消息)     ← 不 await
5. 立即返回："已创建 T-7，已通知负责人"

总耗时 ~20ms（现在 180s 起）
```

### 5.2 完成上报（系统保证，不靠模型）

```ts
// 唯一的状态迁移入口
async function transitionTask(taskId, to, patch) {
  validateTransition(task.status, to);
  await commit(tx => { /* 改状态 */ });
  if (to === "done" || to === "blocked" || to === "review") {
    await postToChannel(task.channelId, { kind: "report", mentions: [task.assignedBy], refs: { taskId }, ... });
    await deliver(task.assignedBy, compactReport(task, to));  // 不 await
  }
}
```

三个入口都必须走它：模型调 `task_update`、看门狗判定超期、项目终止。
→ 「做完不上报」在结构上不可能发生。

### 5.3 员工提问

```
员工调 ask({ text, mention: "leader" })
  ↓
1. 写频道消息（kind=question, mentions=[leader]）
2. deliver(leader, 紧凑消息)
3. 立即返回："已问负责人，等回复"

10 分钟未回复 → 看门狗升级给上一级 + 频道告警
```

### 5.4 拍板：逐级上升，只有 CEO 能进老板层

`escalation.ts` 的多阶段任务机保留（ADR-013/026），但**上升路径改了**。

#### 上升路径

```
员工 ──escalate──▶ 项目负责人
                      │ 拍不了
                      ▼
                   对应管理层（CTO/CFO/…）
                      │ 拍不了
                      ▼
                     CEO
                      │ 拍不了（且确认只有老板能定）
                      ▼
                     老板
```

**旧实现的 bug**：`ask-manager` 阶段的 `escalate` 直接跳 `ask-ceo`，
跳过了中间层。后果是一个项目负责人能定的排期问题被一路推到 CEO，
CEO 再推给老板——「老板待办堆满别人的活」的成因之一。

**现在的实现**：

```ts
// escalation.ts, ask-manager 阶段
if (outcome.escalate) {
  const up = nextLevelUp(org, level);   // 纯函数，沿 manager 链找上一级
  if (up === "owner")  → ask-owner      // 只有 CEO 这一层会走到这里
  if (up === "ceo")    → ask-ceo
  else                 → 仍留 ask-manager，level 换成上一级
}
```

#### 唯一入口判定

`domain/routing.ts` 的 `canReachOwner()` 是「谁能产生老板级待办」的唯一真相源：

| 入口 | 条件 |
|---|---|
| `initial()` 的 `startAtOwner: true` | 发起人**必须是 CEO**（`callerLevel === "ceo"`） |
| `ask-ceo` 阶段的 `escalate: true` | CEO 复核后明确决定递上去 |

非 CEO 声明 `company-level` 也不会直达老板：先落 `ask-ceo` 让 CEO 复核
（`review: true`），CEO 确认后才转老板。

#### 其他改动

1. `ensurePending` 时同时写频道消息（kind=question, mentions=[decisionOwner]）
2. `deliverDecision` 时写频道消息（kind=decision），并 `deliver` 给提问方
3. `path` 不再出现两个连续的 `ceo`（旧代码在「直接进 CEO 阶段」时多写了一次）

### 5.5 老板指令（必回）

```
老板 POST /api/channels/:id/messages { text }
  ↓
1. 写频道消息
2. 立即写 app.ack：{ received, busyWith, plan, at }
3. deliver(目标, 消息)     ← 不 await
4. 返回 200 + ack
```

`app.ack` 进会话流，界面显示「收到 · 正在写文件，约 30 秒后处理」。
看门狗扫「老板消息 5 分钟内无 assistant/alert 响应」→ 写 alert 并重投。

### 5.6 项目负责人：项目经理角色

```
职责（写进 leader charter）：
1. 接收上级指令 → 拆成任务（task_create）
2. 项目群里 @ 你的问题 → 必须回（answer_question 或 escalate）
3. 汇总：每轮醒来先看项目群未读，重复问题合并成一条上报
4. 拍板：项目内排期/分工/验收标准，自己定，用 decide 留痕
5. 验收：员工报 done 必须有 evidence，看不到证据退回（task_update → review）
6. 进度：每天至少一次 project_status 更新
```

机制保证：
- 项目群里 @ 负责人的 question 10 分钟未回 → 升级给 CTO 并告警
- 项目有 `blocked` 任务超 1 小时 → 提醒负责人
- 负责人 24 小时没在项目群发言 → 告警给 CEO

---

## 6. 模块结构

### 6.1 新增

```
src/domain/                     纯数据 + 纯函数（无 IO，可单测）
  channels.ts                   ChannelState 类型 + 追加消息/读位置/未读推导
  tasks.ts                      TaskState 类型 + 状态机 + 合法性校验
  membership.ts                 谁能看哪个频道 / 谁能 @ 谁 / 谁能给谁派任务
  routing.ts                    从 company/decision-routing.ts 移入（逻辑不动）

src/company/
  channels.ts                   IO：postToChannel / markRead / readChannel
  deliver.ts                    唯一投递原语（fire-and-forget + 摘要前缀）
  tasks.ts                      IO：createTask / transitionTask / listTasks
  capabilities.ts               能力目录（声明式）
  tools/
    universal.ts                whoami/say/ask/read_channel/inbox/task_list/task_update
    exec.ts                     沿用 staff-tools.ts
    leader.ts                   task_create/answer_question/decide/project_*
    management.ts               task_create/answer_question/delegate_to_role/领域工具
    ceo.ts                      task_create/take_over_pending/project_terminate/roundtable

src/server/
  channels-view.ts              频道列表 + 消息 + 已读状态
  board.ts                      重写：只读 TaskDoc，按 project 过滤
```

### 6.2 大幅改写

| 文件 | 改动 |
|---|---|
| `company/delegation.ts` | **删除**。拆到 `tasks.ts` + `deliver.ts` |
| `company/trail.ts` | **删除**。`recordMessage` → `postToChannel`；`beginLiveTrail` 保留 |
| `company/management-tools.ts` | 拆到 `tools/*` |
| `company/tools.ts` | 只保留装配函数，能力清单移到 `capabilities.ts` |
| `company/roles.ts` | charter 重写，`capabilityNames` 从能力目录推导 |
| `company/org.ts` | 2358 行拆成 `bootstrap.ts` + `projects.ts` + `staff.ts` + `repair.ts` |
| `server/feed.ts` | 保留为「个人工作记录」视图 |
| `server/org-view.ts` | 加频道成员、未读数、任务数 |
| `company/watchdog.ts` | 加三个检查：未读扫描、未回复 question、任务超期 |
| `company/escalation.ts` | 只改 `ensurePending` / `deliverDecision` |
| `company/disposition.ts` | 输出改频道消息，逻辑不动 |
| `ui/js/*` | 重做：左侧频道列表 + 中间消息流 + 右侧详情 |

### 6.3 保留不动

`src/runtime/*`、`company/docs.ts`（删 `TrailDoc`）、`company/cost.ts`、`company/roundtable.ts`（只改发言方式）、`decision-routing.ts` → `domain/routing.ts`、`decision-delivery.ts`（改调 `postToChannel`）、`instance-lock` / `wal` / `run-failure` / `models` / `env`

---

## 7. 前端

### 7.1 布局

```
┌──────────┬────────────────────────────────┬─────────────┐
│ 频道列表  │  消息流                         │  右侧详情    │
│ 公司群    │  CEO  10:23                    │  频道成员    │
│ 领导层    │  本周目标：把坦克大战上线        │  ● 老板      │
│ ─────    │  林越 @许砚舟  10:25            │  ● CEO      │
│ 项目      │  登录接口 token 过期返回 401？    │  本频道任务  │
│  坦克大战 │  ● 绿（许砚舟已读）              │  T-3 doing  │
│  运维     │  许砚舟 @林越  10:31            │  T-4 todo   │
│ ─────    │  返回 401，带 WWW-Authenticate  │             │
│ 私聊      │  ● 灰（林越未读）                │             │
│  林越     │  [输入框] @某人                 │             │
│ 工作记录  │                                │             │
└──────────┴────────────────────────────────┴─────────────┘
```

### 7.2 头像（真实插画，不用首字母）

**问题**：初版用首字母方块（`林`、`许`）。中文名的第一个字区分度极低（「林越」
「林墨」都是「林」），扫视一列人时完全认不出谁是谁，也没有「这是个人」的直觉。

**做法**：`GET /api/avatar/:name?size=96` 在**服务端**用 DiceBear 生成 SVG。

- 风格全公司统一 `micah`（真实肤色 + 明确发型 + 平涂配色，深色背景上有分量）。
  对比过 `notionists`（纯线稿，深色下糊）、`lorelei`（灰白，区分度低）、
  `avataaars`（卡通感过强）。**混搭多种画风**看起来像从几个网站抠来的图标，
  不是一个团队——所以只用一套，区分度靠 seed。
- `seed = 人名`：同一个人永远同一张脸（重启、换设备都不变）。
- 响应头 `cache-control: immutable` + `ETag`：客户端零成本，服务端只在首次生成。
- 老板也走同一个接口（seed = "老板"），不特殊化。

前端 `<img class="ch-av" src="/api/avatar/...">`，尺寸 32（列表/消息）、22（成员栏）、
18（@ 候选）。工作记录这类非人频道给文档图标，不占人脸。

### 7.3 消息流的三个细节

1. **日期分隔线**：「今天 / 昨天 / 8 月 3 日」把长历史切开，滚动时有位置感。
2. **连续同人折叠头像**：同一人 5 分钟内连发多条时隐藏头像（`visibility: hidden`，
   **不能用 `display: none`**——grid 自动排布会把正文挤进 32px 的头像列，变成一行一个字）。
3. **长消息折叠**：正文超过 28 行或 1600 字就收成 26em 高 + 渐隐 + 「展开全文（N 行）」。
   agent 一次输出几百行的报告在聊天流里会把别的消息全挤出屏幕。

### 7.4 频道列表

- 每行都有头像（认人靠脸）。
- **排序按频道类型的固定次序**：公司 → 领导层 → 项目 → 私聊 → 记录；
  同类型内「有 @ 的在前，再按最后消息时间倒序」。固定类型次序很重要——
  用户找「公司大群」永远在最上面，不会因为别人说了句话就跳走。
- 预览文本先剥掉 Markdown 记号（`**粗体**`、`### 标题`、`- 列表`）再截断 80 字。

### 7.5 手机

单列 + 两屏（列表页 / 会话页），靠 `.ch-layout[data-pane]` 切换，
会话页左上角有「‹ 频道」返回。默认停在列表页，不把用户直接推进某个会话。

### 7.6 已读点渲染

```
message.mentions.map(id => ({ label: nameOf(id), read: message.readBy.includes(id) }))
● 灰 = 未读    ● 绿 = 已读
无 @ 的消息：显示「已读 N/M」
DM：只显示对方一个点
```

---

## 8. 分阶段计划

| 阶段 | 内容 | 工期 | 验证 |
|---|---|---|---|
| **0** | 修 3 个已知 bug（`escalationSeq` 跨重启冲突、`dispose_pending` 未接线、`delegation.ts` 死代码）+ 补重启测试 | 0.5d | `npm test` 全绿 |
| **1** | `src/domain/` 落地：channels/tasks/membership 纯函数 + 单测 | 3d | 纯函数测试通过 |
| **2** | `deliver.ts` + `tasks.ts`：异步派活替代同步等待 | 3d | CEO 连发 3 条 < 3 秒；每条完成必有 report |
| **3** | `channels.ts` + 能力目录 + 工具重组 | 4d | 员工能在项目群 @ 负责人提问并收到回复 |
| **4** | 前端重做：频道列表 + 群聊 + 已读点 + 项目看板 | 5d | 界面能跑完整流程 |
| **5** | 旧路径下线（删 `delegation.ts` / `trail.ts`）+ 迁移收尾 | 2d | 全测试 + ui:check |
| | | **约 17.5d** | |

**阶段 2 是分水岭**：单独就能解决「阻塞」和「不上报」。

---

## 9. 迁移

| 现有 | 迁移 |
|---|---|
| `CompanyDoc` | 不动 |
| `TrailDoc` | **删除**（老板已确认旧数据可删） |
| `PendingDoc` | 不动，加可选 `channelSeq` |
| `AuditDoc` | 不动 |
| 旧会话 | 不动，每个会话自动对应 `log:<id>` 频道 |
| 现有项目 | 启动时自动建 `proj:<slug>`，成员从 `staff` 名册推导 |

### 9.1 启动自愈

`bootstrapCompany` 的幂等分支加 `ensureChannels()`：

1. `company` / `leadership` 不存在就建，成员从 `roles` + `projects` 推导
2. 每个项目建 `proj:<slug>`，成员 = 老板 + leader + 该项目 staff
3. 每个会话建 `log:<id>`
4. 补齐缺失成员（新招员工、新立项）

幂等，每次启动跑一遍。

---

## 10. 风险

| 风险 | 缓解 |
|---|---|
| 公司群 15 人，成本 | 定向唤醒（§3）。老板在大群发言时，若 CEO 已醒着，合并进同一轮（`whenBusy: "steer"`） |
| 上下文爆炸 | 紧凑投递 + `read_channel` 按需读。charter 里写明「看到 `#47` 引用先 read_channel」 |
| 已读状态不准 | 三层标记（立即/显式/扫描）。灰点误报比漏报好，语义上告知用户 |
| 异步后没人兜底 | 看门狗三个新检查（未回复 question / 任务超期 / 老板消息无响应） |

---

## 11. 决策记录（追加到 DECISIONS.md）

- **ADR-028**：通信与工作分离，`deliver()` 是唯一跨 agent 原语，投递不等待回复
- **ADR-029**：频道集中存储，消息广播存储 + 定向唤醒
- **ADR-030**：任务必须有验收标准，看板只读 TaskDoc
- **ADR-031**：完成上报由系统写，不经模型
- **ADR-032**：能力目录声明式 + `deferred` + `tool_search`
