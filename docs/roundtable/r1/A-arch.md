# A 席（架构精简派）· 第 1 轮书面意见

> 结论先行：**这个仓库不缺功能，缺的是「一个功能只有一个实现点」。**
> `src/` 25012 行（HEAD 口径）里，真正「不做系统就不成立」的不到 23%；剩下 20% 是同一个判断被写了第二遍、第三遍。
> 老板说要「代码越少越好」，可执行的版本不是「砍功能」，而是**砍重复实现点**——
> 因为砍功能会吵架（D 席和 C 席都会反对），砍重复点不会：功能一个没少，行数少一截。

---

## 0. 五条结论

1. **本质 : 支撑 : 偶然 ≈ 23% : 56% : 20%**（5751 / 14046 / 5100 行，实测口径见 §1）。
   老板要的四件事（沟通 / 任务 / 能力 / 记忆）合计只有 **5751 行 = 22.9%**。
   其中「能力」一项占 2202 行，但它的大头是 `management-tools.ts` 777 行（管理层工具），
   能力目录本身只有 163 行——**能力系统贵不在目录，贵在目录引出的三层映射**。
2. **`STAFF_ROLE_TEMPLATES` 与 `STAFF_TOOLSETS` 是同一份「角色枚举」被抄成的两张表**，
   键完全相同（产品/设计/开发/测试/运营），而 `HireStaffOptions.role` 是自由字符串
   （`src/company/org.ts:1039`）、`staff_hire` 的 schema 只有 description 没有枚举
   （`src/company/management-tools.ts:487`）。所以任何不在那 5 个词里的角色
   都会静默退化成 `DEFAULT_TOOLSET = {read:true, write:false, bash:false}`
   （`src/company/staff-tools.ts:20-30`）。**这不是设计，是隐蔽 bug。**
3. **`src/company/delegation.ts`（533 行）+ `src/company/delegation-guard.ts`（165 行）在生产上已是尸体。**
   `delegate()`（`src/company/delegation.ts:86`）唯一的接线是 `src/company/org.ts:239`
   把它塞进 `ManagementToolset.delegate`，而 `management-tools.ts` 里 **`deps.delegate` 零读取**。
   它今天只被 7 个 test 文件 import 当测试夹具。ADR-028 已经宣布它死亡，没人收尸。
4. **升级链是全仓最贵也最该留的东西**（2547 行），但它把**同一次路由判断写了三遍**：
   `org.ts:2397 escalateUp()` 算一遍 `decideOwner` → 交给 `escalation.ts:488 startEscalation()`
   再算一遍并再判一次 `callerIsCeo`；到期规则又在 `escalation.ts:685`（读侧兜底）和
   `watchdog.ts:340`（定时扫描，`.ts:434 settleDueDispositions` 的同源实现）各有一个执行点。
   保守去重（§2.5 前三项）能到 -450 行，功能一个不丢。
5. **「动态创建能力」的最小可行形态是「能力 = 原子工具名子集 + 一段 charter 字符串」，
   不是「新建 TS 函数」。** 这不破 ADR-032 的边界（模型仍不能写代码），
   却能让 `staff-tools.ts` 整块消失、`tools.ts` 少 90 行、`roles.ts` 少 200 行。

---

## 1. 本质 / 支撑 / 偶然：分界线在哪

### 1.1 判断依据（先立尺，再量）

三个「必要性」问题，不是「引用数」问题：**Q1 删掉它老板还能跟公司说话吗**（是→本质）；
**Q2 删掉它进程崩一次还能自己爬起来吗**（是→支撑）；**Q3 删掉它有没有任何一条功能路径走不通**
（没有→偶然）。

Q3 是关键。**「偶然」不是「不重要」，是「有第二个实现点，删掉其中一个不会少任何功能」**。
这一条写在最前面，因为它是后面所有账单的合法性来源。

### 1.2 实测口径

`glob('src/**/*.ts')` 逐文件 `wc -l` 求和，按模块归组。**25126 行 = HEAD 的 25012 + 工作区未提交的
86 行（`org.ts:repairModelRefs`）+ 28 行（`runtime/models.ts`）**，另有 3 个杂项文件 229 行（`index.ts` 等）：

| 类 | 模块（行数） | 合计 | 占比 |
|---|---|---|---|
| **本质** | 沟通 channels.ts 590 + channels-doc 21 + domain/channels 542 + deliver 254 + membership 357 = **1764**<br>任务 tasks.ts 395 + domain/tasks 473 + tools/dispatch 346 = **1214**<br>能力 capabilities 163 + tools.ts 422 + tools/universal 621 + tool-search 219 + management-tools 777 = **2202**<br>记忆 memory 311 + domain/memory 260 = **571** | **5751** | **22.9%** |
| **支撑** | runtime/ 2258（持久化·恢复·WAL·实例锁·模型）<br>server/ 6258<br>tui/ 1267<br>装配 org 2478 + org-model 157 + docs 247 + cost 277 = **3159**<br>看门狗 790 + 轨迹 314 = **1104** | **14046** | **55.9%** |
| **偶然** | 升级链 escalation 1300 + disposition 857 + decision-delivery 142 + decision-routing 7 + domain/routing 241 = **2547**<br>圆桌 roundtable 1128 + roundtable-tools 152 + wait 42 = **1322**<br>同步派活 delegation 533 + delegation-guard 165 = **698**<br>角色硬编码 roles 362 + staff-tools 64 + prompts 107 = **533** | **5100** | **20.3%** |

### 1.3 两点必须澄清的口径

**（a）「支撑」的 6258 行 `server/` 是虚高的。** `http.ts` 1923 + `feed.ts` 809 里绝大多数 handler 是
「读一个文档 → 拼一个 JSON」，而 `org-view.ts`(425) `channels-view.ts`(409) `board.ts`(260) 已证明
投影函数能表驱动。这属于 D 席地盘，我只报账。

**（b）`tui/` 1267 行判「支撑」是唯一一处把功能取舍当支撑算的例外。** 它撑的是「无浏览器环境」，
老板若从不 headless 跑，这 1267 行 100% 可删；留着是因为**我不想为了账面好看把一条真功能说成重复**。
（升级链 2547 行判「偶然」，但它是全系统最不能乱动的地方——「偶然」= 有第二个实现点，不等于简单，见 §2.5。）

---

## 2. 逐机制审查

### 2.1 `STAFF_ROLE_TEMPLATES`（`src/company/prompts.ts:19`，5 条一行文案）

**结论：删除。**

- **理由**：唯一消费方是 `src/server/profile.ts:126`（档案页展示）。员工**行为**指令来自招聘时
  传的 `HireStaffOptions.instructions`（`org.ts:1039`）——模板从来不是行为来源，只是「HR 忘了写
  JD 时的一行兜底文案」，而兜底句已经存在（`prompts.ts:34` 的 `?? "你是${role}…"`）。
- **风险**：零。旧员工档案页少一句定制文案，兜底句顶上。
- **行数**：-15。

### 2.2 `STAFF_TOOLSETS`（`src/company/staff-tools.ts:20`，角色→{read,write,bash}）

**结论：删除，改成一个招聘参数。**

- **理由**：5 个键与 `STAFF_ROLE_TEMPLATES` **完全相同**，同一份枚举抄两遍。更关键的是
  `role` 是自由字符串（无枚举约束），`toolsForRole("前端")` 会落进
  `DEFAULT_TOOLSET = {read:true, write:false, bash:false}` ——招一个前端得到**只读员工**，
  连 `write` 都没有。这是「招了人但干不了活」的头号解释（`src/runtime/capabilities.ts:1-9`
  文件头：「员工干不了活往往只有一个原因：能力包里没有这些工具」）。
- **替代形态**：`staff_hire` 加 `tools: string[]` 参数（schema 一行）。招聘人本来就该知道招这个人
  来写代码还是写文档；参数从「猜角色名」变成「直接说给什么工具」，**表达能力严格变强**。
- **风险**：`test/e2e/reliability.test.ts:22,23` 要改；`org.ts:135`（`employeeToolsFor` →
  `toolsForRole`）改成读 `HireStaffOptions.tools`。
- **行数**：-64（整文件）。

### 2.3 `CAPABILITIES`（`src/company/capabilities.ts`，163 行 + core/deferred + tool_search）

**结论：保留 `capabilities.ts`，删掉它引出的三层映射和 `tool-search.ts`。**

- **保留的理由**：这 163 行是**声明式数据 + 6 个纯函数**（`capabilityOf` / `capabilitiesOfLayer` /
  `splitCore` / `auditCapabilities` / `describeCatalog`），是全仓成本最低的一个文件。
  它是「原子工具受 review 的白名单」（ADR-032），**删了它，任意代码执行的门就开了**。
- **该删的是三层映射**：
  1. `src/company/tools.ts:138 CAPABILITY_TO_TOOL: Record<string, ToolName>` —— 34 条
     「能力名 → `ManagementToolset` 字段名」映射。能力名本来就是工具名（`capabilityOf(name)`
     按 `tool.name` 索引），这层纯重复。
  2. `src/company/tools.ts:191 selectTools()` 的未命中抛错分支 —— 用名字过滤数组就不需要它。
  3. `src/company/tools.ts:280-303`（项目负责人 20 项内联名单）+ `:322-331`（只读负责人 9 项）
     —— 这是**第二份和第三份**能力名单，和 `roles.ts` 的 `capabilityNames` 平行维护。
- **`tool-search.ts`（219 行）该删或缩到 10 行**：文件头自述 tokenizer 是
  `.toLowerCase().split(/[^a-z0-9]+/)`，**中文查询 token 数恒为 0**，自研 BM25 对中文完全不可用。
  ADR-032 也写明第 3 层「deferred + tool_search **未启用**」。为一个未启用且对中文失效的机制
  养 219 行不划算：要么改回「core 全给」，要么换成 `name.includes(q) || summary.includes(q)`。
- **风险**：`test/unit/capabilities.test.ts` 14 条要改。要保留 deferred 就得先修 tokenizer，
  那不是「少写代码」而是「多写代码」——建议**追加一条 ADR 记录「不采用 deferred」**。
- **行数**：-90（tools.ts）+ -219（tool-search）= -309。

### 2.4 `src/company/roles.ts`（362 行，7 个管理层角色）

**结论：结构保留，charter 正文砍一半以上。**

- **保留的理由**：7 个 key 的 `capabilityNames`（`:53,100,138,175,216,253,289`）是 ADR-010「岗位裁剪」
  的结构基础——「权限靠工具不存在」需要一个静态岗位→工具清单，不能删。
- **该砍的是 charter 里的流程教学**。227 条文案里有大量这样的句子：
  - 「用 roundtable 开一次圆桌：让他们各自独立作答，再汇总」（`:47`）
  - 「圆桌结束后用 roundtable_minutes 回看完整纪要」（`:48`）
  - 「遇到需要多方一起定的事…用 roundtable 开会」（`:213`）
  **「怎么用工具」该写在工具的 description 里，不是系统提示词里。** 现在的写法等于每个管理层
  每轮生成都读一遍 100 字圆桌操作手册，而支撑这段手册的是 `roundtable.ts` 1128 +
  `roundtable-tools.ts` 152 行——一段文案拖着 1280 行代码，本仓最典型的「偶然」结构。
- **风险**：短期行为变差（模型少一份操作手册）。缓解：把那几句挪进 `roundtable` 工具的
  schema `description`，成本 5 行。
- **行数**：362 → ~150，-210。

### 2.5 升级链：`escalation.ts` 1300 + `disposition.ts` 857 + `decision-delivery.ts` 142 + `decision-routing.ts` 7（+ `domain/routing.ts` 241）

**结论：机制必留，实现去重。这一块是全仓风险最高、也最该动的地方。**

先说我为什么**反对**删它：这是全系统唯一在回答一个问题——「一个问题没人答，会怎样」。
ADR-026（指令无条件受理 + 按汇报线路由 + 等待有默认值与期限）和 ADR-033（老板级待办只能由 CEO 递）
不是历史包袱，是老板半夜三点不在线时公司还能往前走的全部理由。删了它，异步化（ADR-028）
就变成「消息投出去，没人兜底」。

但 2547 行里有**四处同一次判断的重复实现**：

| # | 重复点 | 证据 | 建议 |
|---|---|---|---|
| 1 | 路由算两遍 | `org.ts:2397 escalateUp()` 自己调 `decideOwner`（`domain/routing.ts`），然后把结果交给 `escalation.ts:488 startEscalation()`，后者**再算一遍** `decideOwner` 并**再判一次** `callerIsCeo = fromLevel === "ceo"` | `escalateUp` 只做「查人 + 组输入 + 落文案」，路由一律由 `startEscalation` 算一遍。ADR-033 的核心不变量「只有 CEO 能进 ask-owner」现在有**两个实现点**，这是 bug 温床 |
| 2 | 回答入口四个 | `answerPending`(`:559`) / `answerPendingAsCeo`(`:634`) / `answerPendingAtLevel`(`:1269`) / `takeOverPendingAtCeo`(`:900`) | 收敛到 `answerPendingAtLevel` 一个，其余变成 3 行的薄包装（或直接删） |
| 3 | 到期规则两个执行点 | `disposition.ts:434 settleDueDispositions` 在 `escalation.ts:685` 被**读侧兜底**（`try/catch` 吞异常），`disposition.ts:630 applyDueDispositionDefaults` 在 `watchdog.ts:340` 被**定时扫描** | 撤读侧兜底。否则「谁欠了谁一个默认值」取决于谁先读文档 |
| 4 | 三阶段 union 靠克隆 | `EscalationState`（`:75`）的 `ask-manager` / `ask-ceo` / `ask-owner` 三支本质是 `{asker, target, path, deadline, answer?}` 五元组 + 三种别名；`createEscalationTask`（`:266`）220 行里大半是每个 phase 各写一遍「读待办 → 没答就等 → 超时向上」；`ensurePending`（`:989`）104 行同构 | 抽一个 `advance(state)` 驱动，phase 只描述「该问谁」「超时去哪」两个差异点。**这一项我不建议本轮做**（见风险） |

**顺手删**：`src/company/decision-routing.ts` 只有 7 行，内容是 `export * from "../domain/routing.ts"`。
纯 re-export 文件，调用方直接 import domain 即可。-7 行，零风险。

- **风险（必须诚实说）**：`test/` 里 **23 个文件**碰 escalation，关键断言集：
  `test/e2e/escalation.test.ts` 9 条、`decision-routing.test.ts` 15 条、
  `owner-only-from-ceo.test.ts` 11 条、`decision-loop.test.ts` 2 条、`adr-026-obedience.test.ts`。
  合并回答入口时，大部分测试测的是「**哪个入口**能/不能做什么」，收敛后要重建等价断言，
  工作量不小。**另一个坑**：ADR-026 的「不占执行名额、可跨天」全靠 `pollDelay`（`escalation.ts:256`）
  的 200ms → 30s 退避。改结构时最容易被顺手「优化」成固定轮询，那会让进程永远不安静（原始注释
  `escalation.ts:228-266` 把理由写得很清楚，改动前必读）。
- **行数**：本轮的保守版（重复点 1 + 2 + 3 + decision-routing）= **-450 左右**，
  `escalation.ts` 1300 → ~950，`disposition.ts` 857 → ~700。加上第 4 项激进版能到 -800，但我不推荐本轮。

### 2.6 `roundtable.ts`（1128）+ `roundtable-tools.ts`（152）

**结论：机制保留，但从「核心」降为「可选的非核心能力」。**

- **保留的理由**：ADR-028 明确**唯一保留同步等待的场景**，原话是保留 `submission.wait()`
  「只用于圆桌这类需收齐多方意见的场景」。这是 1128 行的正当性来源。
- **该降级的理由**：①**前端一行都不展示**——`grep -r roundtable ui/` 为空，`server/http.ts` 无
  roundtable 路由，纪要存了但没人看；②`detectStance`(`:749`) `ensureRoundComplete`(`:857`)
  `roundOneDigest`(`:892`) 是「用启发式猜自然语言立场」，准确率无人测量却是最脆弱的部分；
  ③它出现在 CEO charter 必读段（`roles.ts:47-48`），**每一轮 CEO 生成都在被提醒「去开会」**。
- **建议**：`roundtable`/`roundtable_minutes` 从 `core` 降为普通能力，charter 删操作手册。想开就开。
- **风险**：`test/e2e/roundtable.test.ts` 17 条。**但这是一次功能取舍，不是架构收紧，
  应该由老板拍，不该由本席单方面执行。** 所以我把它排出「必做三件事」。

### 2.7 `watchdog.ts`（790 行）

**结论：保留，但明说它不是在「简化」范围内。**

- **理由**：它是 ADR-028 异步化的**对价**。异步派活之后「没人兜底」必须有个兜底者。790 行买的是
  「崩溃恢复后能自愈」。7 步（`watchdog.ts:187-410`）里 ①心跳 ①'`scanTaskFailures`
  ①''`checkpoint` ③`drainInbox` ⑤升级 ⑥催办 ⑦浮起 都必要。
- **表面上可砍的只有第 ② 步 retry（叶子优先/冷却期/maxAttempts）**，因为 `scanTaskFailures()` 已经
  在做同一件事；但删掉之后僵住任务只能人工 `/api/interrupt`，这是真实能力退化，不能用行数换。
  **列入「不做」清单**（§4.4）。

### 2.8 `trail.ts`（314）/ `delegation.ts`（533+165）/ `wait.ts`（42）

| 模块 | 结论 | 一句话理由 |
|---|---|---|
| `trail.ts:156 readTrail` `:200 organizationGraph` `:257 activeTasks` | **保留** | 它是「谁派的活、谁接的」唯一的图查询，`server/org-view.ts:19,293` 与 `tui/state.ts:13,164` 在用 |
| `trail.ts:trailForConversation/trailForRef` | **降为内部函数** | 只被 `test/e2e/trail.test.ts:106,132` 使用，测试专用导出。约 -60 行 |
| `delegation.ts` 533 + `delegation-guard.ts` 165 | **删除** | 生产零调用（见 §0 结论 3）。`isEmployeeBusy` / `describeStaff` 里便宜的状态查询挪进 `tasks.ts`（约 30 行） |
| `wait.ts` 42 | **保留** | `waitOrTimeout` 是圆桌收齐和 HTTP abort 共用的正确实现（注释写明了两处易犯的错：忘了清定时器、被放弃的 promise 变未处理拒绝）。42 行买这两个坑，划算 |

`delegation-guard.ts` 里的 `enterDelegation` / `DelegationCycleError` / `DelegationTimeoutError`
是 ADR-025「同步转交环检测」的实现，而 ADR-025 已经被 **ADR-028 整条替代**。
删它属于「执行一条已经通过的 ADR」，不需要新 ADR。

### 2.9 `src/domain/membership.ts`（357 行）

**结论：结构保留，删 4 个测试专用导出和 1 处硬编码。**

- **保留的部分是本质**：`canView`(23 处引用) `canMention`(8) `canAssign`(21) `canEscalate`(11)
  `ownerOfChannel`(20) `nextLevelUp`(8) 都是活的，是「频道可见性 = 组织结构」这条规则的唯一实现点。
  **不能删，删了就是权限靠提示词。**
- **该删**：`companyMembers`(`:208`)、`leadershipMembers`(`:213`)、`projectMembers`(`:227`)、
  `escalationPath`(`:345`) —— 四个导出的**全部引用都在 test 里**，约 120 行。
- **该改**：`managementRoleNameOf` 用 `byLabel` **硬编码 7 个岗位中文名**反查岗位名，
  而这是 `CompanyDoc.roles`（`docs.ts:56`）已有的数据。改成查文档，顺带修掉
  「老板把 CFO 改叫首席财务官就坏掉」。
- **风险**：`test/unit/domain-membership.test.ts` 33 条里约 12 条测的是那 4 个函数，要删。
- **行数**：-120。

---

## 3. 「动态创建能力」的最小可行形态

老板的原话是「能够为每个 agent 动态创建能力」。现在的代码明确拒绝了这件事
（`src/company/capabilities.ts:18-22`）：

> 工具是 TypeScript 函数，注册即任意代码执行。能力目录是静态代码（受 review），装配是动态的。
> 这条边界不能破。

**我完全同意这条边界，也认为它不能破。** 但老板要的东西和它**不冲突**——冲突来自实现把
「能力」定义成了三层：

```
能力名 → CAPABILITY_TO_TOOL[能力名] → ManagementToolset 字段 → TS 函数
```

三层里，**第一层（能力名列表）是动态的**（`hireStaff` 传 role → `toolsForRole`），
中间两层是写死的。所以「动态」只能落在「从 5 个预设里挑一个」。

### 3.1 推荐形态：能力 = 原子工具名子集 + 一段 charter 字符串

```
能力（Capability）= { name: string, tools: readonly ToolName[], charter: string }
```

三条关键设计：

1. **`tools` 只能从既有原子工具里选**，且必须是 `capabilities.ts` 白名单里的名字
   （当前 37 个：`say` `ask` `read_channel` `inbox` `task_create` `assign_task` `staff_hire` …）。
   **模型仍然不能写 TS 函数。ADR-032 的边界一动不动。**
2. **`charter` 是一段自然语言**，由招聘/改配的人写。这就是「个性化」的全部。
3. **能力存在 `ProfileDoc` 里**（`src/company/docs.ts:90 ProfileState` 已有 `role?: string` 字段位），
   不在代码里。改能力 = 改文档 + `registry.install()` 同名替换（ADR-032 表格第 1 条，
   **已经实现了**，`src/runtime/registry.ts`）。

装配侧只需要一个函数：`createEmployeeExtension(profile)` 按 `profile.tools` 过滤原子工具数组。
**没有第二层映射，没有 DEFAULT_TOOLSET 的静默退化。**

### 3.2 这条形态能让哪些东西消失

| 文件 | 现状 | 之后 |
|---|---|---|
| `src/company/staff-tools.ts` | 64 行（`STAFF_TOOLSETS` + `DEFAULT_TOOLSET` + `toolsForRole`） | **0** |
| `src/company/prompts.ts` | 107 行（`STAFF_ROLE_TEMPLATES` + `staffCharterOf`） | **~40**（charter 从文档读） |
| `src/company/tools.ts` | 422 行（含 `CAPABILITY_TO_TOOL` 34 条 + `selectTools` 抛错 + 三份内联名单） | **~330** |
| `src/company/roles.ts` | 362 行（`capabilityNames` 常量 7 段 + charter 流程教学 227 条） | **~150**（名单挪进 `CompanyDoc` 初始化） |
| `src/company/tools/tool-search.ts` | 219 行（中文 tokenizer 失效） | **0** 或 40 |
| `src/company/capabilities.ts` | 163 行 | **保留**（它变成「原子工具白名单 + core 标记」，更该留） |

**净减约 500–600 行，而新增的全是数据字段，不是代码。**
这不是「砍功能」，是「把写死的枚举换成数据」。

### 3.3 再往前一步（可选，我不推荐本轮做）

`my_capabilities`（`src/company/management-tools.ts:194`）已能列出 agent 现有能力（`agent.tools` +
`agent.deferred` 合并）。所以「自我扩权」**不需要任何新基础设施**：agent 用 `ask` 说「我需要 bash」
→ 上层用现有 `answer_pending` 批准 → 系统改 `ProfileDoc.tools` + `registry.install()` 同名替换
→ 下一轮生效。只需一个新管理工具 `staff_capability`（约 60 行），拍板链路白送。
**这是「进化」最便宜的一条路**，但我排在本轮之外，理由只有一个：先让能力变成数据，再谈让 agent
改自己的数据。顺序反了会得到死循环——「agent 要 bash → 上层同意 → `STAFF_TOOLSETS` 里没这名 → 静默降级」。

---

## 4. 重构账单（诚实版）

### 4.1 Tier 0：纯死代码 / 零能力退化（我保证做得到）

| 动作 | 文件 | 行数 | 失效 ADR | 测试影响 | 真实退化 |
|---|---|---|---|---|---|
| 删同步派活 | `delegation.ts` 533 + `delegation-guard.ts` 165，保留 ~30 行挪进 `tasks.ts` | **-668** | ADR-024 需重定向到 `tasks.ts`；ADR-025 正式标 superseded | 删 `test/e2e/delegation.test.ts` 12 条、`test/unit/delegation-guard.test.ts` 13 条；`hierarchy/cost/trail/tui/terminate/acceptance/reliability` 7 个文件里 `import { delegate }` 当夹具的调用点改走 `assign_task` | **零**（生产零调用） |
| 删 re-export 壳 | `decision-routing.ts` | **-7** | 无 | `decision-routing.test.ts` 15 条改 import 路径 | 零 |
| 删测试专用导出 | `membership.ts` 4 个 + `trail.ts` 2 个 | **-180** | 无 | `domain-membership.test.ts` 约 12 条、`trail.test.ts` 约 4 条 | 零 |
| 删 `tool_search` | `tools/tool-search.ts` | **-219** | ADR-032 状态需追加一条「不采用 deferred」 | `capabilities.test.ts` 部分 | 零（ADR 自己写「未启用」） |

**Tier 0 小计：-1074 行。**

### 4.2 Tier 1：结构化（中风险，功能不减，实现点减半）

| 动作 | 行数 | 失效 ADR | 测试影响 | 真实退化 |
|---|---|---|---|---|
| 能力单层化（§3） | **-370**（staff-tools 64 + prompts 15 + tools.ts 90 + roles.ts 210） | ADR-007「角色描述纯函数」需改写为「charter 是数据」；ADR-011/014 不受影响 | `capabilities.test.ts` 14 条重写；`reliability.test.ts:22` | 招聘参数变多一个 `tools`，但表达能力变强 |
| 升级链去重（§2.5 的 1+2+3 项） | **-450** | 无（ADR-026/033 语义不变，只是实现点从 2 个回到 1 个） | 23 个文件碰 escalation，`owner-only-from-ceo.test.ts` 11 条 + `adr-026-obedience.test.ts` 是最硬的门槛 | 短期可能漏掉某条边界，必须逐条对 ADR-033 的四个合法入口重测 |
| disposition 到期扫描合一（撤读侧兜底） | **-250** | 无 | `test/unit/disposition.test.ts` 36 条 + `test/e2e/disposition.test.ts` 5 条 | 读文档不再「顺手」补默认值；如果看门狗没在跑，默认值会晚到 |

**Tier 1 小计：-1070 行。**

### 4.3 Tier 2：功能取舍（要老板拍，不算「简化」）

| 动作 | 行数 | 代价 |
|---|---|---|
| 圆桌降为非核心 + charter 删操作手册 | **-680**（1128 → ~600，tools 152 保留） | 老板要接受「CEO 不会主动开会了」。前端本来就不展示 |
| 删 TUI | **-1267** | 丢掉无浏览器路径 |
| `http.ts` / `feed.ts` 投影表驱动化 | **-600**（估） | D 席地盘，我只报账 |
| watchdog 第 ② 步 retry 简化 | **-200**（估） | 僵住任务只能人工 abort。**我不推荐** |

### 4.4 合计与「不做」清单

- **Tier 0 + Tier 1 = -2144 行（25126 → ~22980，-8.5%）**，这是我能对账的部分。
- **加上 Tier 2 上限 ≈ -4900 行（-19.5%）**，但 Tier 2 是功能取舍，不该混进「精简」话术。
- **我不做**：watchdog 的 retry、escalation 三阶段 union 重构、`pollDelay` 退避策略、
  `channels.ts` / `deliver.ts`（本质沟通层，改它的风险远大于收益）。
- **账面水分**：删 `delegation.ts` 的收益不是 698 行，是「派活从此只有一个实现点」。行数是副产品。
  **一句话：这次重构的价值在「同一件事只有一个实现点」，不在行数。**

---

## 5. 只能做 3 件事

按**收益 / 风险比**排序（不是按行数）：

### 第 1 件：删 `delegation.ts` + `delegation-guard.ts`（-668）

- **为什么第一**：零真实能力退化，零 ADR 冲突（ADR-028 已宣布它死亡），
  且它是**唯一一处「同一个功能有两套实现」的干净案例**。做完这一件，
  仓库里就有了一条可复制的先例：「ADR 说替代了，代码就得真的消失」。
- **怎么验**：`grep -r "deps.delegate" src/` 为空（已经是），然后 `grep -rn "delegation.ts" test/` 为空。

### 第 2 件：能力单层化（`Capability = {name, tools[], charter}`，存进 `ProfileDoc`）（-370）

- **为什么第二**：这是**对老板诉求的直接回应**——「动态创建能力」在这里第一次变成真的，
  且顺手修掉一个隐蔽 bug（自由字符串 role 静默退化成只读员工）。
- **为什么不是第一**：它改 `HireStaffOptions` 和 `staff_hire` schema，牵到 `management-tools.ts`
  与 `roles.ts` 两处文案，比第 1 件脏。
- **怎么验**：招一个 `role:"前端"` 的员工，`my_capabilities` 里应出现 `write` 和 `bash`。
  今天它是只读的——**这条现在就能当 bug 复现**。

### 第 3 件：升级链去重（`escalateUp` 不再自己算路由；4 个 answer 入口合一）（-450）

- **为什么第三**：收益最大（-450 + 消灭 ADR-033 的第二个实现点），
  但它是唯一一处「删错了会半夜把公司卡住」的地方。
  23 个测试文件碰它，`pollDelay` 的退避一旦被顺手改掉，进程就再也安静不下来。
- **保守执行方式**：这一件**拆成三个独立 PR，每个 PR 只做一处重复点之一**，
  且每个 PR 必须重跑 `owner-only-from-ceo.test.ts` 全部 11 条 + `escalation.test.ts` 9 条。
  **不要一次重构三个入口。**

**只能做 1 件**：第 1 件（最便宜、最干净、最能立规矩）。**按「对老板诉求的回应强度」排**：
第 2 件该第一，因为它把「动态能力」从一句愿景变成一个字段。

---

## 6. 我认为最容易被其他席位反驳的三点（提前自曝）

1. **「你的本质/偶然分界是用『有没有第二个实现点』划的，不是用『重不重要』划的。」**
   完全正确，而且这是故意的。用「重不重要」划，升级链 2547 行全是本质，一行动不了；
   用「有没有第二个实现点」划，能砍掉 2000 行**而不丢任何功能**。
   我的辩护只有一句：**我砍的是重复实现，不是功能。** 如果 B/C/E 席能指出
   我砍掉的东西里有一条功能路径真的走不通了，我当场撤回。

2. **「你把 `STAFF_TOOLSETS` 说成 bug，可能是故意把设计缺陷说成隐蔽故障来加强论证。」**
   部分成立。它确实可能是有意为之的「保守默认值：没写角色就只给读权限」。
   但如果是这样，那张 5 键的表（产品/设计→write+? / 开发→write+bash / 测试→? / 运营→?）
   就没有存在价值了——**只要 `role` 是自由字符串，5 个键就覆盖不了真实招聘**。
   要么承认它是 bug（删表，改成显式 `tools` 参数），要么承认它是白名单
   （那 `staff_hire` 就必须加 enum 约束，并且 `hireStaff` 必须校验）。
   **现状（自由字符串 + 5 键表 + 静默默认值）是两种设计里最坏的那一半。** 这一点我不退。

3. **「圆桌是不是核心，该由 D 席和老板判断，不该由 A 席。」**
   对，所以我把它放在 §4.3 Tier 2 而非 §5 必做清单，并写明「应该由老板拍」。
   我只提供三条事实：`ui/` 里 grep 不到 roundtable、`server/http.ts` 无 roundtable 路由、
   而 `roles.ts:47-48,213-214` 里每个管理层每一轮都在读圆桌操作手册。**取舍不归我。**

---

## 7. 附：本席核实的事实来源（命令可复跑）

| 事实 | 核实命令 |
|---|---|
| 25126 行、三分类占比 | `glob('src/**/*.ts')` 逐文件行数求和，按 §1.2 归组 |
| `delegate()` 生产零调用 | `grep -rn "deps.delegate" src/` 空；`grep -rn "company/delegation" src/` 只有 `org.ts:66,239` |
| `tool_search` 中文失效 | `tools/tool-search.ts` 文件头自述 tokenizer `/[^a-z0-9]+/` |
| `role` 无枚举 | `management-tools.ts:487` 只有 `description`；`org.ts:1039` 是 `role: string` |
| membership 4 导出只在 test | `grep -rn "companyMembers\|leadershipMembers\|projectMembers\|escalationPath" src/` 无结果 |
| trail 2 导出只在 test | `grep -rn "trailForConversation\|trailForRef" src/` 无结果 |
| 升级链重复路由 | `org.ts:2397` 与 `escalation.ts:488` 都调 `decideOwner` |
| 到期规则两执行点 | `escalation.ts:685`（读侧）+ `watchdog.ts:340`（定时） |
| `deferred` 未启用 | ADR-032 表格第 3 行原文「未启用」 |
| `tsc` 干净 | `npx tsc -p tsconfig.json --noEmit` 无输出（含未提交的 `repairModelRefs`） |

> 本席未修改 `src/` `ui/` `test/` 下任何文件，未 commit。
