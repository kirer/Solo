# 【已归档 · 不再维护】

> 这份文档写于某个时间点，记录**当时**的设计推理与施工过程，**内容已冻结**。
> 现状一律以 `docs/SYSTEM.md`、`docs/CODE.md`、`docs/DECISIONS.md`、`openspec/specs/` 为准。
> 保留它只是为了回答「当初为什么这么决定」。里面的行号、文件路径、数量、截图链接都可能已失效。

---

# 项目负责人权限改造：规格裁定与可转交版 v2

- 日期：2026-10-25
- 对象：`ops-defect-loop`（项目负责人 许砚舟，会话 73）
- 用途：给改造方的转交说明。第 3 节可以直接当规格用；第 1、2 节是「为什么不能照原样做」。

## 0. 结论

1. **不照原样转交。** 原规格六条里：一条要换实现形状（数据模型）、一条要大幅收窄（权限模型）、一条与现有状态枚举冲突（状态流转）、一条要收窄到两个写操作（接口）、两条要补口径与断言（迁移、验收）。按第 3 节的 v2 转交。
2. **ops-defect-loop 不停工**，继续按现有人工负责人通道推进。但「现有负责人通道」目前不是系统能力，是人 + 台账的约定（见 §6）。
3. 认同 CTO 划的边界：不做细粒度权限矩阵。v2 不需要矩阵——本系统的权限本来就等于「工具在不在」（ADR-004 / ADR-010），改造只是换能力包和放宽一个引用字段。

## 1. 三条会立刻踩坑的事实

### 1.1 把负责人做成对象再塞进升级状态机，会静默死锁

- `src/company/escalation.ts:145` 把 `manager` 原样存进 `level`；`:408` 与 `:452` 用 `===` 比较层级。
- 文档值经 JSON 落盘 / `recover` 重放后，对象引用必然不相等 → 升级任务永远匹配不到答复。表现是 **30s 超时**，不是报错，最难查。
- 同一个对象进到 8 处 `ROLE_LABELS[person.manager]` 会得到 `undefined`（模板里显示 "undefined"、`/api/org` 直接丢掉 `parent`）；进到 6 处 `ROLE_LABELS[x] ?? x.toUpperCase()` 会 TypeError。
- 而真实数据里 `projects["ops-defect-loop"].leader = 73`、`leaderName = "许砚舟"` —— **「唯一 ID + 姓名」已经有了**。缺的只是「员工能不能引用它」，所以该做的是放宽引用形状，不是新建实体。

### 1.2 「全部资源面」有一半在本仓库不存在，项目目录还落在主仓 worktree 里

- 本系统没有：代码仓库对象、CI/构建、部署与回滚、监控数据源、凭据库。
- `workspace/projects/ops-defect-loop` 在主仓 git worktree 内（`git rev-parse --is-inside-work-tree` = true）。
- `bash` 工具没有沙箱（`src/runtime/env.ts` 只设 `cwd`）。只把 `bash` 加给负责人 = **给整仓写权限**，这不叫「该项目全部权限」。
- 照抄这一条，改造方只能去发明不存在的资源模型——正好是 CTO 划掉的范围。

### 1.3 迁移与验收现在无法执行

- 单进程单库（`docs/RUNBOOK.md`）：迁移只能在 `openAndBoot()` 内、`serve()` 之前发生，字面上的「不停服」做不到。
- 验收只有「证明」两个字，没有命令，也没有否定断言（非负责人被拒、终止后回收、迁移幂等全缺）。

## 2. 逐条裁定

| 原条目 | 裁定 | 一句话理由 |
|---|---|---|
| 一 数据模型 | **收窄 + 换形状** | 不新建实体；用 `leader:<slug>` 字符串引用；顺手删掉第二真相源 |
| 二 权限模型 | **收窄 + 加否定边界** | 只给真实存在的 4 个资源面；能力=工具存在，不建矩阵 |
| 三 状态流转 | **改写** | 现有枚举 6 态，补成状态机；3 态会和枚举打架 |
| 四 接口清单 | **收窄** | 2 个写接口 + 复用现有读接口；HTTP 仍保持只读 |
| 五 迁移 | **补口径** | 一次有界重启 + 原子 + 可回滚；不承诺零停机 |
| 六 验收 | **补断言** | 三层覆盖 + 正负断言 + 幂等 + 离线门禁 |

## 3. v2（可直接转交）

### 3.1 数据模型

**不新建「项目负责人」实体。** 身份继续用 `projects[slug].leader`（会话 ID）+ `leaderName`。

`employee.manager` 的取值域放宽为**带命名空间的字符串标量**：

```ts
/** 直属上级：管理层岗位，或本项目负责人。持久化始终是 string。 */
type ManagerRef = ManagementRole | `leader:${string}`;
```

- `leader:<slug>` 经 `projects[slug].leader` 解析，**负责人换人时自动跟随**，不需要迁移员工记录。
- 解析失败（项目已删）→ 回落到 CEO 并写一条告警，不抛异常。
- 只允许两种取值：`MANAGEMENT_ROLES` 里的岗位名，或**本项目**的 `leader:<own-slug>`。跨项目负责人一律拒绝（`E_INVALID_MANAGER`）。

必须同时提供两个唯一解析入口，所有展示/提示词/路由都走它们，禁止再直接 `ROLE_LABELS[person.manager]`：

```ts
function managerLabelOf(state: CompanyState, ref: ManagerRef): string;
function managerConversationOf(state: CompanyState, ref: ManagerRef): number | undefined;
```

**为什么是字符串而不是 `{kind, ...}` 对象**：`escalation` 的 `level`、`PendingItem.level`、`AuditEvent.from` 全按标量存与比较；改成对象要动状态机、要做序列化规范化，且任何人把对象塞进 `level` 就触发 §1.1 的死锁。字符串方案改动点最少，且**不需要升 `CompanyDoc` 版本**。

**顺手处理双真相源**：`ProfileDoc.parent` 至今只写不读（`src/company/org.ts:955` 写入，全仓无读取）。v2 要求停止写入并退役该字段，`project.leader` 是唯一真相源；否则改完会出现第三个「上级」来源。

**支持事后变更上级**：新增写路径 `staff_reassign`（见 3.4）。注意它不只是改一个字段——员工的 `instructions` 里写着「直属上级是 XXX」（`src/company/org.ts:1615`），改字段不改提示词，员工照样以为在向 COO 汇报。

**新招员工默认上级 = 项目负责人**：现在 `staff_hire` 不传 manager 时默认 `"cto"`（`src/company/management-tools.ts:380`）。不改这一行，迁移完下一次招聘又挂回 CTO。

### 3.2 项目权限

按本系统**真实存在**的资源面收窄为四项：

| 资源面 | 实现方式 | 边界 |
|---|---|---|
| 项目 workspace 文件读写 | 能力包加 `read` / `write` / `edit` | 仅项目目录 |
| 项目内命令执行 | 能力包加 `bash`，`cwd` = 项目目录 | 需路径约束，见下 |
| 项目日志与运行数据读取 | 同上（`read` + `bash`） | 只读连接，不改库 |
| 模型凭据 | 全局继承，**不是项目级权限** | 不额外授予 |

**删掉原规格里不存在的资源面**：代码仓库、CI/构建、部署与回滚、监控数据源、运行凭据。这些在本仓库没有对象，写进规格只会让改造方去造模型。

**实现方式**：改 `createProjectLeaderExtension`（`src/company/tools.ts:154`）的 `capabilityNames`，一个能力包、随会话身份自动生效，不需要逐项授权、不需要权限矩阵——这就是 CTO 要的「不做矩阵」。

**必须同步改 `PROJECT_LEADER_CHARTER`**（`src/company/tools.ts:130`）：现在明写「不越级」「立项/终止/招人都不在你手上」。只加工具不改职责描述，模型会自我设限，或者行为与提示词互相矛盾。

**必须写进规格的否定清单**（照抄原规格「全部权限」最容易在这里出事）：

- 负责人**不得**获得 `staff_hire`、`staff_archive`、`project_create`、`project_terminate`、`project_delete`、`roundtable`、`budget_check`、`cost_report`。
- 负责人**不得**写项目目录之外的文件、不得 `cd` 逃出项目目录、不得改 `src/` 与主仓其他项目。
- 负责人**不得**改别的项目的状态、不能回答 `ceo` / `owner` 级待决问题。

**边界风险（必须决定）**：项目目录在主仓 worktree 内，`bash` 无沙箱。二选一：
- A（推荐，小）：给 `bash` 加 `cwd` 越界检查（`env.ts` 层面拒绝 `..` 与绝对路径出界），并在验收里加逃逸测试；
- B（大）：把项目 workspace 移出主仓 worktree（独立目录 + 独立 git）。
不决定这一条，「全部权限」就没有可验收的边界。

**负责人要能接员工上报**才能叫「负责人」：补 `pending_list` / `answer_pending` 到负责人能力包，并给 `answer_pending` 加「只有对应层级能答」的守卫（现在只有 `answerPendingAsCeo`，`src/company/escalation.ts:358`）。这一条与 3.4 的 `escalate` 接线是一对，见 §4 加项 6。

### 3.3 状态流转

保留现有枚举，**不是三态**：`planning | active | paused | done | terminated | archived`。
（真实数据：`ops-defect-loop` 从立项到现在 `status` 一直是 `planning`——`createProject` 是唯一写 `planning` 的地方，`active` 在 `src/`、`scripts/` 里零写入。）

允许的边：

```
planning → active
active   → paused | done | terminated（terminated 经现有 terminateProject）
paused   → active | terminated
done     → ⊗（终态；重开另立项）
terminated → ⊗（终态；只能 deleteProject）
archived → 本期不写，保留字段
```

- 幂等：目标状态与当前相同 → 返回成功，不写事件。
- 非法边 → `E_INVALID_TRANSITION`，不改任何状态。
- 终态复活 → `E_TERMINAL`。
- `terminated` 的副作用沿用现有实现（中断负责人与员工、归档员工、关闭待办、记终止人/原因），**并追加一条**：负责人能力包降级为只读（去掉 `bash`/`write`/`edit`/`staff_assign`），否则「权限随身份生效」只有正向没有回收。
- 调用方：负责人只能操作本项目 `planning→active`、`active↔paused`、`active→done`；CEO 可操作全部合法边；终止仍走 `terminateProject`（保持现有两步确认与老板确认）。老板不直接调。
- 审计：每次状态变更写 `AuditDoc`（谁、从什么、到什么、原因）。

**不要在 v2 里让权限依赖 `status === "active"`**：线上项目现在就是 `planning`，一旦权限依赖 active，改造当天负责人会静默失去权限，且很难归因。只让 `terminated` 触发回收。

### 3.4 接口清单（最小集）

本系统的「接口」是 agent 工具 + 内部函数，不是 REST。HTTP 目前全是只读（`src/server/http.ts`：`/api/org`、`/api/profile/:id`、`/api/feed/:id`、message/answer/interrupt），**本期不加 HTTP 写接口**；老板要在网页上操作，等有了稳定工具再包一层。

| # | 名称 | 入参 | 出参 | 调用方 | 幂等 | 失败/回滚 |
|---|---|---|---|---|---|---|
| 1 | `staff_reassign`（管理工具） | `project`, `name`, `manager: ManagerRef` | 成功文案 / `{ok:false, error:"E_INVALID_MANAGER"\|"E_NOT_FOUND"\|"E_ARCHIVED"}` | CHRO、CEO（**不含负责人**） | 同值重复调用 → 成功、不写审计 | `CompanyDoc` 单事务原子；提示词重渲染是第二段，失败下次启动收敛修复 |
| 2 | `project_status_set`（管理工具） | `project`, `to` | 成功文案 / `{ok:false, error:"E_INVALID_TRANSITION"\|"E_TERMINAL"\|"E_FORBIDDEN"}` | 负责人（本项目有限边）、CEO（全部合法边） | 同状态重复调用 → 成功、不写事件 | 状态与审计同一次提交；失败不改任何状态 |
| 3 | `resolveStaffManager`（内部只读） | `staffKey` | `{kind:"role"\|"leader", conversationId?, label}` | 展示层、提示词、路由 | 纯读 | — |
| 4 | `scripts/migrate-staff-manager.ts` | `--db --dry-run --check --fail-after=N` | 迁移条数 | 运维 / 启动钩子 | 幂等（第二次 `migrated=0`） | 单事务，0 或 2，绝不留 1 |

鉴权：**工具存在即权限**（ADR-010），不引入 ACL/矩阵。员工侧不发 `staff_reassign`；负责人侧不发 `staff_hire`/`project_create`。

上报链路的接线（属于加项，见 §4-6）：
- `escalate` 工具**必须把 `person.manager` 传进 `startEscalation`**——现在 `src/company/org.ts:203-216` 根本没传，所以所有升级都从 CEO 开始。
- `PendingItem.level` 存 `ManagerRef` 字符串；`answerPending` 的守卫从「只有 CEO」扩为「层级对应的负责人或 CEO」。

### 3.5 迁移方案

实际工作量：**两条记录**。

| 员工 | 现在 | 迁移后 |
|---|---|---|
| `ops-defect-loop/log-ops` | `manager: "coo"` | `manager: "leader:ops-defect-loop"` |
| `ops-defect-loop/backend-fix` | `manager: "cto"` | `manager: "leader:ops-defect-loop"` |

要求：

1. **不升 `CompanyDoc` 版本**。形状仍是 string；升版本必须同时写 `migrate`，否则 `pi-durable` 的 `checkRecordVersion` 会在启动时抛「requires migration from version 1」直接起不来。
2. 迁移在 `openAndBoot()` 内、`serve()` 之前执行；**单事务**，故障注入后库里只能是 0 人或 2 人，不允许 1 人。
3. `--dry-run` 不写库；重复执行 `migrated=0`；迁移不碰 `.md` / `out/` / `logs/`，用文件 hash diff 证明。
4. 旧值继续合法：`"coo"` / `"cto"` 仍是合法 `ManagerRole`，不需要强制一次性改完，可以先改代码再改数据。
5. 备份：停写后 `cp workspace/company.sqlite`，并对项目目录打一次 tar。
6. **「不断服」改成「一次有界重启」**：单进程单库下做不到零停机。可承诺的是：停机窗口 ≤ 30s（迁移在启动时）、在跑任务不丢（`pi-durable` 恢复）、可回滚。
7. 回滚：形状仍是 string，旧代码能启动（只是把 `leader:...` 显示成 `undefined`，不崩）→ **回滚只需回代码**；数据回滚用备份，用于彻底复原。
8. **数据迁移与能力包扩容分成两个提交**：回滚粒度不同，混在一起会互相牵连。

### 3.6 验收标准（可直接执行）

**门槛**

```bash
cd /Users/kirer/projects/ai-company
npm run check
npm test -- --exclude 'test/e2e/real-model.test.ts'   # 265 passed 基线；real-model 顶层会真发网关请求，必须排除
```

**改造前基线（现在就能跑，只读）**

```bash
# 数据层：两人 manager 仍是岗位枚举，项目仍是 planning
sqlite3 "file:workspace/company.sqlite?mode=ro" \
  "select content from document_revisions
    where document_id=(select id from documents where kind='\"app.company\"')
      and content like '%ops-defect-loop/log-ops%';"

# 展示层：现在显示 COO / CTO
for id in 110 118; do
  curl -sS "http://127.0.0.1:7788/api/profile/$id" | python3 -c '
import json,sys; p=json.load(sys.stdin)
print(p["label"], "-> parent:", p["parent"], "| charter 含许砚舟:", "许砚舟" in p["charter"])'
done

# 能力面：负责人现在没有执行工具
curl -sS http://127.0.0.1:7788/api/profile/73 | python3 -c '
import json,sys; n={t["name"] for t in json.load(sys.stdin)["tools"]}
print(sorted(n)); print("有执行工具?", bool(n & {"read","write","edit","bash"}))'
```

**改造后必须全部成立的断言**（建议固化成 `scripts/acceptance/reorg-probe.mjs` + `test/e2e/reorg-acceptance.test.ts`）

| # | 断言 | 层级 |
|---|---|---|
| A1 | `staff.manager` 两条都解析到会话 73、显示名「许砚舟」 | 数据 |
| A2 | `/api/org` 里两名员工的 `parent` 都是「许砚舟」，且等于 `lead.label` | 展示 |
| A3 | `/api/profile/110`、`/api/profile/118` 的 `parent` 与 `charter` 都写「许砚舟」 | 展示 |
| A4 | `staff_list` 文案显示「上级：许砚舟」（模型据此决定找谁） | 展示/提示词 |
| A5 | 负责人能力包含 `read/write/edit/bash`，`cwd` = 项目目录 | 正 |
| A6 | 负责人能力包不含 `staff_hire/project_create/project_terminate/staff_archive/roundtable` | 负 |
| A7 | 负责人写项目目录外文件、`cd` 逃逸被拒 | 负（需 3.2 边界方案） |
| A8 | 负责人不能改别的项目状态（`E_FORBIDDEN`） | 负 |
| A9 | `planning→active` 成功且落库；重复调用幂等；`planning→done` 返回 `E_INVALID_TRANSITION` | 状态 |
| A10 | `terminated` 后负责人能力包里不再有 `bash/write/edit`（权限回收） | 状态 |
| A11 | 新招员工不传 manager 时，默认上级 = 项目负责人 | 加项 |
| A12 | 迁移：`--dry-run` 不写；跑两次第二次 `migrated=0`；故障注入后 0/2 无中间态；文件 hash 不变 | 迁移 |
| A13 | 迁移后旧值仍可读、旧代码能启动（不崩） | 兼容 |
| A14 | 原 265 条测试全绿（改造前锁死「上级=CTO」的断言同步更新） | 回归 |

**不要写进验收的**：CI、部署、回滚、运行凭据——本仓库没有这些对象，写了也验不了（标 N/A 或等有了对象再补）。

## 4. 加项（原规格没写，缺了会「改完等于没改」）

| # | 加项 | 为什么必须 |
|---|---|---|
| 1 | **回收语义**：终止后负责人降级只读；换负责人自动跟随（`leader:<slug>` 天然支持）；旧负责人失权 | 原规格只有「自动生效」，没有「自动失效」 |
| 2 | **审计**：`staff-manager-change`（from/to/by/reason/ref）与状态变更事件 | 迁移和事后追责都要用；也是验收证据 |
| 3 | **兼容与回滚**：旧字符串仍合法、不升版本、dry-run、幂等、备份、文件零副作用 | 否则一次迁移失败就起不来 |
| 4 | **否定边界**：公司级工具禁止清单 + 项目目录边界 | 否则「全部权限」= 整仓写权限 + 可自招人 |
| 5 | **单一真相源**：退役 `ProfileDoc.parent`；`managerLabelOf`/`managerConversationOf` | 现在 `/api/org` 用 manager、`ProfileDoc` 写 parent，四处可能各说各的 |
| 6 | **上报链路**：员工可 `escalate`；负责人可 `pending_list`/`answer_pending`；`escalate` 传 manager；ADR-004 措辞同步（员工不得决定/招人/立项，但可上报直属上级） | 不改，「上级」仍然只是文案，功能上不存在 |
| 7 | **新招默认上级 = 负责人** | 否则迁移完下次招聘又挂回 CTO |
| 8 | **流程**：走 `openspec/changes/` 提案（proposal/design/specs delta/tasks）；`openspec/specs/org-structure/spec.md` 现在写的是「直属上级角色」，必须改成「岗位或本项目负责人」 | 规格库是这套代码的行为契约，不更新就会再次脱节 |

加项 6 是唯一会碰架构不变量的：ADR-004 说「员工能力包为零管理工具」。建议改成「员工不得有 `decide`/`staff_hire`/`project_create` 等决定类工具，但可以有 `escalate` 指向直属上级」。这是措辞澄清，不是放开越级。若本次不想承担这个风险，就把它拆成第二期，**但验收里不能声称「上报已落到许砚舟」**。

## 5. 与原规格的差异清单（给改造方一眼看）

- **删**：新建负责人实体、`{kind,...}` 联合对象、代码仓库/CI/部署/凭据权限、「三态」状态机、新增 REST 写接口。
- **改**：`leader:<slug>` 字符串引用、六态状态机（显式允许边）、两个写工具、启动期迁移、能力包而非权限矩阵。
- **增**：审计、否定边界、权限回收、默认上级、单一解析入口、离线验收门禁、OpenSpec delta。

## 6. ops-defect-loop 改造前是否继续

**继续，不停工。**

理由：

1. 改造范围是「两条记录 + 一个能力包 + 两个写工具」，不碰任务格式、会话格式、文档版本；在跑任务由 `pi-durable` 恢复，迁移只是一次短重启。
2. 项目当前的真实阻塞是**负责人决策**，不是权限——`DEFECT-LEDGER.md` 里 `OPS-20261025-01`、`-04` 都写着「需负责人协调」。
3. 这个 loop 正在产出改造后的验收语料（真实数据、台账、巡检输出），停工反而丢证据。

必须先纠正一个前提：**现在系统里没有「负责人通道」这条强制链路。**

- `escalate` 工具没有把 `manager` 传进 `startEscalation`（`src/company/org.ts:203-216`），所以所有上报实际都从 CEO 开始；
- 员工能力包里没有 `escalate`（只有 `read/write/edit/bash`，按角色裁剪）；
- 负责人能力包里没有 `pending_list` / `answer_pending`。

员工提示词里那句「向 COO/CTO 汇报」目前只是**文案**。所以「按现有负责人通道推进」的真实含义是：**你 + 许砚舟 + 台账文件**的人工约定。继续推进没问题，但不要拿它当「权限已验证」的证据；功能层验收要等 §4-6 落地后再补。

边界：

- 数据迁移排一次重启窗口（≤30s），窗口前后各记一条台账说明；不要在巡检跑到一半时重启。
- 能力包扩容与数据迁移分成两个提交，回滚粒度不同。
- 台账登记权仍归负责人；`OPS-20261025-01/04` 的协调结论照常由许砚舟拍，不受改造影响。
- 真实模型请求不在验收门禁里（`real-model.test.ts` 必须 `--exclude`），别让验收跑出费用。

## 附：证据索引

- 真实数据：`workspace/company.sqlite` → `projects["ops-defect-loop"] = {leader:73, leaderName:"许砚舟", status:"planning"}`；`staff["ops-defect-loop/log-ops"].manager="coo"`；`staff["ops-defect-loop/backend-fix"].manager="cto"`；两条 `ProfileDoc.parent=73`。
- 调用点：`src/company/docs.ts:43`（6 态）、`:77`（manager 类型）、`src/company/org.ts:730`（唯一写 planning）、`:1071`（写 terminated）、`:1615`（提示词写上级）、`:955`（写 `ProfileDoc.parent`）、`src/company/tools.ts:130/154`（租约与能力包）、`src/company/management-tools.ts:380`（默认 manager=cto）。
- 升级状态机：`src/company/escalation.ts:145/408/452/358`。
- 展示出口：`src/server/org-view.ts:241`、`src/server/profile.ts:121/127`、`src/server/feed.ts:281`、`src/company/delegation.ts:513`、`src/company/management-tools.ts:402/422`。
- 底层约束：`@earendil-works/pi-durable` `checkRecordVersion`（版本升级必须写 migrate）；`docs/RUNBOOK.md`（单进程单库）。
- 现状实测：负责人 `/api/profile/73` 工具为 9 个管理工具、无执行工具；`/api/org` 员工 `parent` = COO / CTO；`npm test` = 265 passed / 3 skipped（`real-model.test.ts`）。

## 7. 落地状态（2026-10-25）

按 v2 实施完成，对应 OpenSpec 变更 `openspec/changes/project-owner-authority/`。

- 数据模型：`ManagerRef = ManagementRole | leader:<slug>`，招聘默认本项目负责人，新增 `staff_reassign`，退役 `ProfileDoc.parent`（只写不读的死字段）。
- 权限：负责人能力包 + `read/write/edit/bash` + `pending_list`/`answer_pending`/`project_status`；员工能力包 + `escalate`；终止后负责人换 `role-leader-readonly`，重启仍只读。
- 状态：`setProjectStatus` 显式边 + 幂等 + 权限校验 + 审计；终止仍走 `terminateProject`。
- 升级链：`EscalationInput.manager` 支持负责人引用，待决项层级落 `leader:<slug>`；`pending_list`/`answer_pending` 按「是不是到我这一级」判断。
- 迁移：`scripts/migrate-staff-manager.ts`（dry-run / 幂等）+ `scripts/acceptance/reorg-probe.mjs`（只读探针）+ RUNBOOK 步骤。
- 验收：`test/e2e/reorg-acceptance.test.ts`。

**与 memo 的差异**：§3.2 的「bash 边界方案 A」未实施。原因是项目目录在主仓 worktree 内，而运维项目需要跨目录只读 `workspace/company.sqlite`；做路径围栏会破坏现有用法。已作为已知残留写进 ADR-027 与 design.md，留待单独设计。

**上线后补强（同日）**：负责人曾在被问「能否改代码」时凭旧记忆答「不能」，实测后自我更正（见 ADR-027 补充）。已加 `my_capabilities` 工具、在组织/名册里显示工具名，并把「能力问题必须自查或实测」写进通用准则与负责人职责。验收测试补了对应断言（`test/e2e/reorg-acceptance.test.ts` 第 11 项）。
