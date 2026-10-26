# 圆桌裁决书：这个系统该长成什么样

> 五席 × 两轮，共 9 份意见（`r1/{A,B,C,D,E}` + `r2/{A,B,C,D}`，2832 行）。
> 本文是**裁决**，不是汇总。每条裁决给出：结论、证据、推翻谁、以及一条能证伪它的命令。
>
> 老板的原始诉求（m00001，逐条对照）：
> 1. 各 agent 之间能相互沟通
> 2. 能为每个 agent **动态创建能力**
> 3. 有**记忆系统**
> 4. 能让各 agent **不断进化**
> 5. `STAFF_ROLE_TEMPLATES` 这种逻辑是否有必要
> 6. 代码越少越好，逻辑越简洁越清晰越好
> 7. 前端：大群 + 私聊的频道聊天、发送与回复、工作记录、任务

---

## 一、前置：圆桌自己犯的四个事实错误

在裁决前必须钉死这四条，因为它们直接决定了「该删什么」。**四个错误里三个是五席共同的**。

### 错误 1（四席同时踩）：「`tool_search` 只切 ASCII，中文搜不到」

A 席（-219 行删除的依据）、B 席（记忆失效的归因）、E 席（`test.fails` 方案）、D 席都这么写。**错的。**

证据——`src/company/tools/tool-search.ts:66` 有 `export function cjkBigrams(text)`，用 `/[\u4e00-\u9fff]+/g` 切中文，`rankTools()` 里每命中一个二元组 +4 分。我实跑：

```
记忆   → ["memory_search","memory_write"]
写记忆 → ["memory_search","memory_write"]
立项   → ["project_create"]
招聘   → ["staff_hire"]
音效 / 画图 / 跑命令 → []        ← 因为这些词不在任何工具名或描述里
```

**教训**：把一个空结果归因为"分词坏了"，而不是"这个词根本不在这份文档里"。四个 agent 同时犯，说明这是**默认推理倾向**，不是偶然。

> 影响：**A 席的「删 `tool-search.ts` -219 行」裁决不成立，撤回。** 中文检索是能用的。

### 错误 2（B 席）：「`app.memory-hint` 0 条是因为 `notify()` 的 catch 静默吞掉了」

B 席第 2 轮的报告把这写成"第 0 层故障：写入时静默失败"，并据此提出改 `notify()`。**错的。**

反例：`writeAck()`（`src/server/http.ts:1210`）走**完全相同**的 `conversation.submit({type:"write", entry:{...}})` 分支，生产库有 **47 条** `app.ack`。同一条代码路径能成功，说明 `type:"write"` 没坏。

**真正的原因（我实测的时间线）**：

| 事件 | 时刻（epoch） |
|---|---|
| 记忆功能随 `4875d7f` 引入（`git log --diff-filter=A -- src/company/memory.ts`） | `1793035577000` = 2026-10-27 **01:26** |
| 生产库最后一次有任务进 `done`（`max(ts) where app.task-report.status=done`） | `1792998267336` = 2026-10-26 **15:04** |
| 该提交之后完成的 done 报告数 | **0** |

```bash
sqlite3 workspace/company.sqlite "select count(*) from entries where json_extract(record,'\$.kind')='app.task-report' and json_extract(record,'\$.data.status')='done' and json_extract(record,'\$.model[0].timestamp') > 1793035577000;"
# → 0
```

**结论：`app.memory-hint` 是 0 条，因为记忆上线之后这家公司一次任务都没完成过。** 不是 bug，是"新功能还没被走过"。

这不是说记忆系统没问题——它有三个**真**问题（见裁决 M1/M2/M3），但**"0 条"不是其中任何一个的证据**。B 席把一个"样本量为零"观察当成了"机制坏了"。

**教训**：区分「观测到反常」与「观测到零」。零可以是故障，也可以是"还没发生"。判据是**看时间线**，不是看代码。

### 错误 3（D 席两处，已自行认错）

- 「`ui/js/board.js` 的 mock 静默显示假任务」——错。`:129` 有 `mocked:true`，`:420-422` 渲染可见 badge 并 `hidden = !mocked`，`:487-489` 还 `showError`。真问题是**同一 `catch` 里两种矛盾策略**（一处 `applyBoard(mockBoard())` 覆盖真实数据，另一处 `board.js:490` 保持上次数据）+ mock 不自动重取。
- 「`GET /api/pending` 零消费者 → 待办在界面不可见」——错。待办走 `src/server/channels-view.ts:205` 内嵌下发（`viewer===OWNER_ID ? await ownerPendingForChannel(...) : []`），`:229` 进视图；`ui/js/app.js:124` 用 `org.pending` 算 forYou。**零消费者 ≠ 功能不可见**，只说明那条独立接口是冗余的。

### 错误 4（A 席，已自行认错）

- 「`STAFF_ROLE_TEMPLATES` 唯一消费方是 `src/server/profile.ts:126`」——**错的**。它由 `staffCharterOf`（`src/company/prompts.ts:34`）消费 → `staffInstructionsFor`（`:54`）→ `org.ts:1565` `instructions: staffInstructionsFor(...)`。**它装配的是员工的真实提示词。删它改的是员工行为，不是删重复。**

---

## 二、裁决：后端

### B1. `STAFF_ROLE_TEMPLATES` —— **删，但不是删成空**

**裁定：这张表没有必要，且它今天正在制造 bug。**

三条理由：

1. **它与 `STAFF_TOOLSETS` 是同一份角色枚举抄成了两张表。** 改一张不改另一张，两边就漂移。而 `role` 是**自由字符串**：`staff_hire` 的 schema（`src/company/management-tools.ts:487`）只有 `Type.String({description:"员工角色：产品 / 设计 / 开发 / 测试 / 运营"})`，**没有 enum**；`HireStaffOptions.role` 是 `string`。

2. **它已经在产线上制造了一个静默 bug。** 我实跑 `toolNamesForRole()`（`src/company/staff-tools.ts`）：

   ```
   开发     → ["read","write","edit","bash"]
   前端     → ["read"]        ← 招一个"前端"，得到的是只读员工
   backend  → ["read"]
   Rust工程师 → ["read"]
   运营     → ["read"]
   ```

   根因：`src/company/staff-tools.ts:39` `const toolset = STAFF_TOOLSETS[role] ?? DEFAULT_TOOLSET;`，而 `DEFAULT_TOOLSET = {read:true, write:false, bash:false}`。**没有报错，没有日志，什么都没发生**——招来的员工只会读文件，然后"做不出东西"。

3. **它是"角色决定能力"这条错误方向的最后据点。** 老板要的是「**为每个 agent 动态创建能力**」。角色枚举把能力锁死在 5 个预设上；而 `role` 又是自由字符串，所以实际形态是「5 个预设 + 一个静默退化的兜底」——**两种设计里最坏的那一半**（A 席语）。

**但 `staffCharterOf` 的职责必须留下**，只是从"查模板"变成"拼装"：

```
charter = 项目上下文（你隶属于「X」项目，直属上级是 Y）
        + 职责（一段自由文本，招聘时由上级填写，可空）
        + 通用准则（COMMON_GUIDE，保留）
```

`STAFF_ROLE_TEMPLATES` 的 5 条一句话职责，降级为**招聘时的默认文案提示**（给 `staff_hire` 的 description，不是代码分支）。

**落地形态**（这是"动态创建能力"的最小可行版本，同时满足"代码更少"）：

| 删 | 增 |
|---|---|
| `STAFF_ROLE_TEMPLATES`（5 条） | `staff_hire` 增加两个显式参数：`tools: string[]`（要哪些原子工具）+ `duty: string`（职责一段话） |
| `STAFF_TOOLSETS`（5 条 + 默认值） | 校验 `tools ⊆ 该上级能授予的集合`（复用 `capabilitiesOfLayer`，ADR-004 不破） |
| `DEFAULT_TOOLSET` 的静默兜底 | 未知/空 → **抛错**，错误文案告诉上级"请显式指定 tools" |

净效果：`staff-tools.ts`（64 行）整块消失，`prompts.ts` 少约 20 行，`roles.ts` 的 `capabilityNames` 从"角色→固定列表"变成"角色→默认建议列表"。**而"动态创建能力"从不可用变成可用**——上级可以招一个"前端工程师 + read/write/bash + 只负责样式"的人，不需要改代码。

> **驳回 B 席的 `CapabilityRecipe { id, whenToUse, keywords, tools, brief, layer, origin, status, proposedBy, approvedBy, stats }` 大对象和 `app.recipes` 新 Doc。**
> 裁决理由：老板要的是"能动态创建"，不是"有一套配方元数据模型"。B 席自己的账单是净增 267 行，A 席复核后一致。**在"代码越少越好"是硬约束的前提下，先做零净增的版本；配方元数据是等真的出现"同一个岗位被反复临时拼装"之后才值得的数据结构**——而那一天需要 `tool_search` 先跑起来（全库 2 次调用），记忆先跑起来（0 次写入）。
>
> **保留 B 席的一件东西**：`validateRecipe` 的思想——`tools ⊆ universal ∪ exec ∪ staff`。这个校验直接进 `staff_hire`，不需要新 Doc 承载。

### B2. 记忆系统 —— 三条真问题，都不是"分词"

| 编号 | 问题 | 证据 | 修法 | 行数 |
|---|---|---|---|---|
| **M1** | `memory_write` 是 `core: false`，在 DEFERRED 里，只能靠 `tool_search` 加载；而 `tool_search` 全库只被调 **2 次**（2544 次调用里） | `src/company/capabilities.ts:70`；实跑 `splitCore()` → CORE 14 / DEFERRED 22 | 移入 CORE（14→15） | 1 |
| **M2** | 唯一的写入提醒走 `wake: false`，`type:"write"` 分支**不进模型上下文**（`isDisplayOnly` → `entry.model === undefined`，而 `contribute()` 取的是 `entry.model ?? []`） | `src/company/tasks.ts:311-323`；`node_modules/@earendil-works/pi-durable/dist/harness/context.js:164` | 改 `wake: true` | 1 |
| **M3** | 折叠器把已有 distill 再折一次，实测 staff 层 200 条后最深代数 153，最新 distill 前 4/5 是嵌套标题；而 `test/unit/domain-memory.test.ts:95-108` **正在钉这个 bug 的行为** | `src/domain/memory.ts:129/137` | 加 `depth` 字段 + 只折 `depth === max` 的那批；测试断言改成"代数有界" | ~35 |

**关于 M3 的测试**：`expect(summaries[0]?.folded).toBeGreaterThan(FOLD_BATCH)` 必须同时改成 `expect(maxDepth).toBeLessThanOrEqual(3)`。**只改代码不改断言 = 修完还是红的；只改断言不改代码 = 把 bug 变成契约。两件必须在同一个提交里。**

**关于"记忆是否跑得起来"**：M1+M2 是**必要条件**，不是充分条件。跑起来之后还要看模型写不写。**验收判据**：`memory_write` 调用数从 0 → >0，`app.memory` 文档从 0 → ≥1。这两条能直接从 sqlite 读，不需要跑测试。

### B3. 通信 —— 塌缩成三个原语（C 席方案，采纳方向，缩小范围）

**判定：C 席的方向对（9 套机制 → 3 个原语），但他的 8123 → 1510（-81%）数字要打折。**

C 席自己第 2 轮已认账：表头 8123、逐项合计 6634，漏列 5 个文件；同口径重算 **6634 → 1510 = -77.2%**。而且这个账里 **-2281 行（44.5%）依赖"老板接受少一个功能"**：

| 项 | 行数 | 类型 |
|---|---|---|
| `disposition` 857 → 60 | -797 | **删功能** |
| `roundtable` -728 | -728 | **删功能** |
| `watchdog` -530 | -530 | **删功能** |
| `takeOverPendingAtCeo` | -76 | **删功能** |
| `tasks` 868 → 180 | -688 | 改结构 + 部分删功能 |

**保守版（只删重复、功能零变化）= -1527 行。这个我批。** 明细：

| 动作 | 行数 | 为什么是"删重复"不是"删功能" |
|---|---|---|
| 删 `delegation.ts` + `delegation-guard.ts` | -698 | `assign_task` 的真实路径是 `tools.ts:157` → `management-tools.ts:739` → `tools/dispatch.ts`，与 `delegate()` 无关。`grep "deps\.delegate" src/` **零命中** |
| 删 `decision-delivery.ts` | -142 | 与 `deliver()` 重复：自己 submit、不算未读摘要、不带记忆简报 |
| 四个回答入口合一（`answerPending` / `answerPendingAsCeo` / `answerPendingAtLevel` / `takeOverPendingAtCeo`） | -200 | 同一件事写四遍 |
| `disposition` 两个到期执行点合一（删 `escalation.ts:685` 读侧兜底） | -250 | `watchdog.ts:340` 已覆盖 |
| `waitEscalation` 移出 `src/` | -60 | 无生产调用，只被 2 个测试用 |
| `transitionTask` 三副作用合一（现在 done 时同一事实投递两次：`postToChannel` + `notify`） | -60 | `src/company/tasks.ts:261` 与 `:279` |
| `canReachOwner` 死函数 + `decision-routing.ts` | -57 | `routing.ts:221` 零调用 |
| **合计** | **-1527** | |

**驳回的三项（需要老板点头，不批）**：`disposition` 砍到 60 行、`roundtable` 砍 728、`watchdog` 砍 530。理由：它们是**产品承诺**，不是重复实现。C 席自己的理由最有力——「`disposition` 0 条数据 + 857 行代码 + 36 条 unit test，只有两种可能：从没触发过，或者触发路径本身坏了。**不知是哪个就重写，等于把未知当安全。**」

### B4. 投递回执 —— 圆桌发现的**最严重**缺陷，必须修

**`deliver()` 把"投递成功"当成"已读"。**

- `src/company/deliver.ts:146` 只 `delivered.push(target)`，从不等 `wait`，从不看 `status`。
- `src/company/watchdog.ts:684` `if (submission.status !== "queued") continue;` —— 只扫 queued，`unanswered` 已 settled，**不在扫描集合**。
- 生产库 `submissions`：`done 402` / **`unanswered 69`**（`reason=no_model`）。按会话：89（项目负责人）**50 条**、1（CEO）11、13 6。
- 只有两个**同步**调用方检查（`delegation.ts:221`、`roundtable.ts:694`）。**异步频道投递路径一个都不检查** → 发给负责人的消息静默死亡，发现时间 = 无限。

**修法（我批）**：
1. `deliver()` 返回类型从 `number[]` 改成 `{ delivered: number[]; failed: number[]; unanswered: number[] }`（**类型层强制，不靠自觉**）。
2. `Message` 落 `deliveredTo: number[]`（submission id 数组）。
3. 看门狗每 30 秒查这些 submission 的 `status`，`unanswered` → 重投（上限 2 次，复用 `WATCHDOG_DEFAULTS.maxAttempts`）。

净增约 **+120 行**。**这是本次重构里唯一值得加的行数**——它修的是一个"消息发出去了、对方永远不会知道"的静默失败。E 席的判断对：**先让 `deliver()` 三态可表达（~10 行类型 + ~110 行重投），再谈塌缩 6634 行。顺序反了，塌缩期丢消息无法被现有测试发现——因为全绿。**

### B5. 唤醒 —— 改判据，不改存储

C 席实测：389 条消息 → 673 次唤醒，均值 1.73、最高 5。`wakeOnAll` 这一条规则（`src/domain/channels.ts:439`）制造了大部分。

改成显式 `to[]` 后 **663 → 342**，但分布是：

| 群 | 减少 | 性质 |
|---|---|---|
| 老板 | **-273** | 老板在 `proj:system` 一条消息都没发过（`from=0` 计数 0）→ 这 273 次是**投递路由的产物** |
| 负责人 | -48 | 需要感知补偿 |
| 其余 9 会话 | 0 | — |

**裁定：采纳 C 席的 5 条唤醒判据，但驳回"砍掉 141 条广播"的说法**（C 席自己重算：134/141 仍会唤醒，只省 5.4%）。**真收益是「5 分钟合并窗口」：134 次 → 17 次（-87%），一个参数级改动。**

**同时驳回 C 席对老板那 273 次的性质定性。** D 席的反驳成立：

> `from=0` 只测了**出站**，没测**入站**。老板的用途是监督，监督者天然不发言。系统自己就假设老板是消费者——`src/server/channels-view.ts:205` 专门给老板单独下发待办。按 C 席的措辞，可以顺手把老板从项目群投递名单里删掉，那是**另一种事故**。正确表述：那 273 次**不值得为它建面板**，但老板**仍应在名单里**，只是不该触发 LLM 唤醒——显式 `to[]` 恰好就是这个语义。

---

## 三、裁决：前端

### F1. 默认视图必须改

三处硬编码 `"org"`：`ui/js/app.js:363`（`let stored = "org"`）、`:365`（`?? "org"`）、`:367`（catch 里 `"org"`）。

**D 席撤回了自己首轮的让步条件，我维持他的最终结论：组织图不该当首页。** 理由不是"它缺数据"（`src/server/org-view.ts:30/32/33` 已有 `status: "busy"|"waiting"|"error"|"idle"`、`awaitingYou: number`、`activity: string`），而是**首页要回答的问题不同**：

- 组织图回答「**谁是谁的下属**」= 结构，一次学会、几乎不变。
- 频道回答「**刚才发生了什么、要不要我动手**」= 事件，每次都变。
- 老板打开界面的第一诉求是后者。而且组织图是**瞬时快照**——多数时刻大量 agent 处于 `idle`/`waiting`，此时首页是一张几乎全灰的树，信息价值 ≈ 0。

### F2. 唯一真正"白算了"的字段：`openTasks`

`src/server/channels-view.ts:46` 定义、`:155` 算好下发，**`grep -rn "openTasks" ui/` 零命中**。这比死接口更值得修：死接口没人写，这个是写了没人用。

接入成本：**约 19 行**（14 JS + 5 CSS）。

### F3. 驳回"未读面板"作为新功能

D 席自己查完后撤回了：`ui/js/channels.js` 的 `renderList()`（`:504`）**已经**有未读数徽章（`:522-525`，@ 优先）、预览（`:535` + 后端 `channels-view.ts:151` `previewLine(last.text, 80)`）、时间（`:538`）、分组（`:115-118`）、顶栏 @ 总数（`:555` + `http.ts:483` `unreadSummary`）。

**"面板"的真实工作量 ≈ 0。** D 席自己承认："我上一轮把一件已完工的事当成提案。"

### F4. `ui/js/channels.js` 1874 行的问题不是行数

D 席首轮的拆解仍然成立：1874 行 = 11 件事（频道列表 / 消息流 / 增量 patch / **私聊 activity 流水 254 行且只对 dm 生效** / 发送与回复 / @ 选择器 / 输入框自适应 / 已读上报 / 侧栏成员+任务 / 滚动粘底 3 处独立实现 / 装配 224 行挂 19 个 DOM 引用）。

**核心判断采纳：「问题不在前端写多了，而在前端在替后端猜。」**

该上移后端的（**本期只做前三条**，因为它们会导致错误而非仅仅是重复）：

| 项 | 为什么 | 本期做 |
|---|---|---|
| `extractMentions`（`ui/js/channels.js:412`） | 后端 `postChannelMessage` 已算且更正确，两边算法不同会 **@ 错人** | ✅ |
| `highlightMentions`（`:1161`） | 在 HTML 串上做替换，用 `insideSkip` 递归躲 `<code>/<pre>/<a>`；后端 `MessageView.mentions` 已有但没下发偏移 | ✅ |
| `elapsedLabel`（`:1441`） | 浏览器时钟不准会显示**负数** | ✅ |
| `viewSignature`（`:171`）/ `signatureOf`（`:1124`） | 后端下发单调 `rev` 即可，可整块删 | 下期 |
| `dayKey`/`dayLabel` | 时区必须服务端统一 | 下期 |
| `timelineOf`（`:699`） | 应给 `GET /api/channels/:id/timeline` | 下期 |

---

## 四、裁决：方法论（E 席一张反对票被采纳）

E 席的核心反对：**「整圆桌的目标函数错。四席 KPI 都是减行数，但行数不是约束。」**

**采纳，并把它变成这次重构的第一条纪律**：

> **每一次删除，必须同时说明「删完之后，哪一条命令能证明行为没变/变对了」。**
> 说不出这句话的删除，不做。

配套的三件工具：

1. **`scripts/verify-receipt.mjs`**（约 60 行）：`npm run verify` 产出机器可读收据（`vitest --reporter=json --outputFile=...`），`numPendingTests > 0` 即失败。
   **理由**：本仓库**没有 CI**（`.github/workflows` 不存在、`package.json` 无 `verify` 聚合脚本）。而 `test/e2e/real-model.test.ts` 用 `describe.skipIf(!probe.ok)`——网关不可用时**整个 e2e 静默 skip**。E 席实测该文件只有 **3** 个顶层 `test`。
   **明确驳回"加 console.log 提醒"**：不可忽略 = **机器可判定**，不是人可阅读。

2. **反转 skip 默认值**：`SKIP_REAL_MODEL=1` 才跳过；不设就探测，探测失败即红，错误文案写「若本次不打算跑真模型，必须显式设 `SKIP_REAL_MODEL=1`」。

3. **零消费者检查进 `scripts/check-boundaries.mjs`**（不是 test/）：纯静态零运行时、已挂在 `npm run check` 上、需读全仓文本。**必须读 `ui/js` 不是 `ui/dist`**（bundle 会假绿）。白名单上限 3 条，每条注释说明谁在消费。

**另外采纳 E 席的两条执行纪律**：

- **删 `delegation.ts` 的顺序不可颠倒**：①先加夹具 `seedTaskViaAssignPath()` 并迁移 8 个 import 文件（`test/unit/cost.test.ts:23`、`test/e2e/hierarchy.test.ts:36`、`test/e2e/trail.test.ts:12`、`test/e2e/tui.test.ts:15`、`test/e2e/terminate.test.ts:21`、`test/e2e/delegation.test.ts:11`、`test/e2e/acceptance.test.ts:15`、`test/e2e/reliability.test.ts:23`）→ ②跑绿 → ③再删。反过来做会产生 8 处红，会被误认为回归。
- **role bug 的证伪测试必须 accept-either**（「给 write」或「招聘入口显式报错」两种修法都合格），且必须在删 `STAFF_TOOLSETS` **之前**写。

---

## 五、裁决：老板的七条诉求，逐条回答

| # | 诉求 | 裁定 | 状态 |
|---|---|---|---|
| 1 | 各 agent 能相互沟通 | **已经能做到，且有 9 套机制在做同一件事。** 本期删掉 3 套重复（`delegation` / `decision-delivery` / 四回答入口），保留 3 个原语（Message / Item / Cursor 方向） | 部分完成 |
| 2 | **为每个 agent 动态创建能力** | **现在做不到，而且会静默失败**（招"前端"得到只读员工）。本期修：`staff_hire` 显式 `tools[]` + `duty`，未知/空则抛错 | **本期做** |
| 3 | **记忆系统** | **写好了但从没跑过**（0 条写入、0 条 hint）。三个真问题：M1 工具在 DEFERRED、M2 提示不进上下文、M3 折叠器把 distill 再折一次 | **本期做** |
| 4 | **不断进化** | **做不到，且不假装能做到。** 唯一不依赖记忆的回路是 B 席提的「从 `pi.tool-result` 按任务聚合工具序列，发现反复临时加载的组合 → 提案固化」（约 40-60 行）。但它**依赖 `tool_search` 先跑起来**（全库 2 次）。**本期不做，等 2/3 跑通再看** | 明确推迟 |
| 5 | `STAFF_ROLE_TEMPLATES` 有必要吗 | **没有。删。** 它今天在制造 bug（B1） | **本期做** |
| 6 | 代码越少越好 | **净减约 -1400 行**（-1527 删除 + 132 新增 + role/memory/前端小项）。**但不是以行数为目标**——E 席的目标函数纠正被采纳 | **本期做** |
| 7 | 前端：频道聊天 / 发送回复 / 工作记录 / 任务 | 默认视图改频道、消费 `openTasks`、3 处上移后端。未读面板**不做**（已有） | **本期做** |

---

## 六、执行计划（分支 `feat/slim-and-chat`）

### 阶段 0：安全网（必须先做，否则后面每步都无法证明"没坏"）

- `scripts/verify-receipt.mjs` + 反转 `SKIP_REAL_MODEL` 默认值
- `check-boundaries.mjs` 加零消费者检查
- role bug 的 accept-either 测试（**在删 `STAFF_TOOLSETS` 之前**）
- `seedTaskViaAssignPath()` 夹具 + 迁移 8 个 import 文件

### 阶段 1：纯删除（功能零变化，每步可证伪）

| 步 | 动作 | 行数 | 证伪命令 |
|---|---|---|---|
| 1 | 删 `delegation.ts` + `delegation-guard.ts` | -698 | `npm test` 全绿 + `grep -rn "delegation" src/` 只剩 dispatch |
| 2 | 删 `decision-delivery.ts` | -142 | 决策类消息仍能投递（`test/e2e/decision-loop`） |
| 3 | 四回答入口合一 | -200 | `test/e2e/escalation` + `owner-only-from-ceo` 全绿 |
| 4 | disposition 到期扫描合一 | -250 | `test/e2e/disposition` 全绿 |
| 5 | `canReachOwner` 接成唯一闸门 + 删 `decision-routing.ts` | +20/-57 | ADR-033 不变量成执行体 |

### 阶段 2：修 bug（改行为，但是修对）

| 步 | 动作 | 行数 | 验收 |
|---|---|---|---|
| 6 | `staff_hire` 显式 `tools[]` + `duty`，未知则抛错 | -64/+70 | `toolNamesForRole("前端")` 要么报错要么给 write，不再静默 read |
| 7 | `deliver()` 三态 + 看门狗重投 | +120 | `submissions` 里 `unanswered` 被重投；新增 `unanswered` 计数进 `/api/org` |
| 8 | 记忆 M1（`memory_write` 进 CORE）+ M2（`wake: true`） | +2 | `app.memory` 从 0 → ≥1，`memory_write` 调用 > 0 |
| 9 | 记忆 M3（折叠器 + 同步改断言） | +35 | `maxDepth <= 3` |

### 阶段 3：前端

| 步 | 动作 | 行数 | 验收 |
|---|---|---|---|
| 10 | 默认视图改频道（`app.js:363/365/367`） | -0/+3 | `ui-check.mjs` 通过 |
| 11 | 消费 `openTasks` | +19 | 频道行尾部显示"N 个未完成" |
| 12 | 3 处上移后端（mentions 偏移 / elapsedLabel / 时钟） | ±40 | `ui-check.mjs` 63 项 |

### 验收：小恐龙游戏（`test/e2e/acceptance-dino.test.ts` + 真跑一次）

六步，每步的观察手段见 E 席 §5.1：

1. **立项** → `GET /api/channels` 出现 `kind:"project"`
2. **配人** → `members[]` 里有员工（**B1 的 role bug 在此爆发**）
3. **派活** → 任务 `status=doing` **且** `submissions` 有一条 status 不是 `unanswered`（**B4 在此最容易死**）
4. **改需求「加音效」** → 预测**必卡**：`TaskEntry.dependsOn`（`src/domain/tasks.ts:63`）存在但 `task_update`（`src/company/tools/universal.ts:457`）不接受 → 只能 cancel+新建 → 记录断裂。**"取消重建"判为不合格**，因为无法回答"音效是第几次改动加的"
5. **验收** → `kind==="report" && refs.taskId===<id>` + `rollupAll()` totalTokens 严格增长 + `workspace/projects/<slug>` 有可运行 index.html
6. **成本** → 每个员工 `usage.totalTokens > 0`（有 0 即有员工从未被唤醒）

**第 4 步的预测如果成真，它就是本次验收最有价值的产出**——它证明系统能做出东西，但不能接住需求变更。

---

## 七、没做的事（明确记录，不假装做了）

1. **`CapabilityRecipe` 大对象 + `app.recipes` 新 Doc** —— 驳回。净增 267 行与"越少越好"冲突，且依赖两个前置（记忆能跑、`tool_search` 能跑）都不成立。
2. **9 套通信机制塌缩成 3 个原语的完整版** —— 只做了"删重复"那 -1527 行。完整塌缩（含 `disposition` 857→60、`roundtable` -728、`watchdog` -530）需要老板点头，因为那是删功能。
3. **`wakeOnAll` 彻底删除** —— 只做显式 `to[]` + 5 分钟合并窗口。删 `wakeOnAll` 会让负责人"变聋"，D 席的未读面板又不需要新建（已有），所以"感知损失"这个账我没算清，不动。
4. **`ui/js/channels.js` 1874 → 1100 的重构** —— 只做 3 处上移后端。整块重写风险大于收益（D 席自己承认"没有任何测试断言 UI 行为"）。
5. **删 TUI（1267 行）** —— A 席排 Tier 2，我维持。TUI 是独立入口，不占高频路径。
6. **任务状态机 `open→doing→closed` 简化（删 `review`）** —— C 席提议，我**不批**。生产库 `review` 出现过 14 次（`app.task-report status=review`），不是死状态。C 席的数据是"`tasks` 表里 0 个处在 review"，但那是**当前快照**，不是历史。

---

## 八、给老板的三行结论

1. **`STAFF_ROLE_TEMPLATES` 该删**——它和 `STAFF_TOOLSETS` 是同一份枚举抄两遍，而且已经在产线上把"前端"招成了只读员工（我实跑确认）。
2. **记忆系统从没跑过，但原因不是坏了**——它 2026-10-27 01:26 才上线，而你有 1.5 小时没让公司完成过任务。真问题是工具藏在 `tool_search` 后面、提示用 `wake:false` 不进上下文。
3. **值得花的唯一新增行数是 +120**——修"消息发出去了对方永远不会知道"（生产库 69 条 `unanswered`，50 条发给了项目负责人）。其余都是删。
