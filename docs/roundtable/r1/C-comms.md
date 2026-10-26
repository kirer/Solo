# C 席（通信与任务模型派）第 1 轮意见

> 立场：我不认为问题在「通信不够」。**这个系统的跨 agent 机制已经过剩了**——同一件
> 事有 2~4 套实现并存，而且其中两套互相不认识、会互相打架。老板说「代码越少越好」，
> 在我这一席，能砍掉的是 src/ 里 8,123 行 / 14,068 行（58%）的通信与任务代码。
>
> 全部结论基于三类证据：① 源码实测（`wc -l` + 逐函数读）② 生产库
> `workspace/company.sqlite` 的基线与 delta 实测量化 ③ 真实任务/消息内容本身。
> 数据是 2026-07 的 `app.channels` base（462KB）+ 57 条 delta、`app.tasks` base（41KB）
> + 41 条 delta、`app.pending`（1.3KB + 3 delta）、`app.trail`（166B + 3 delta）。

---

## 0. 一页纸

1. **跨 agent 通信有 9 套机制，可塌缩成 1 套「消息 + 待决项 + 读位置」。**其中
   `decision-delivery` 是 `deliver()` 的残缺特例，`notify()` 是 `deliver()` 的无频道退化，
   `escalation` 的三阶段机是「PendingItem 的轮询包装器」，`trail` 只是同步派活的副产品。
2. **升级链的核心不变量只有一条半是真的**：「owner 只能由结构（manager 链）算出，
   不能由模型声明」。ADR-026 里 company-level 自证要 CEO 复核（`review:true`）、
   `takeOverPending`、disposition 三档超时默认值，都是过度设计——**生产数据里它们是 0 次使用**。
3. **任务状态机的 review 列从建库起就是空的**（20 个任务：done 15 / todo 4 / cancelled 1，
   `review` 0 次、`blocked` 0 次、当前 `doing` 0 次）。验收真实发生在频道里，不在状态机里。
   **一个事实写三处**：`postToChannel(kind=report)` + `notify(app.task-report)` + `notify(app.memory-hint)`。
4. **最严重的缺陷不是「机制太多」，是「投递成功」被当成「已读」**。生产库里有 **67 条
   `unanswered/no_model` 提交，其中 48 条是发给项目负责人（conversation 89）的**。
   `deliver()` 返回 `delivered`，看门狗只扫 `status==="queued"`，**没有任何代码检查
   `settled.status==="unanswered"` 的异步投递**。这些消息永远不重投、不告警、无人知道。
5. **没有「谁来回答」的认领机制**。`grep -rn "claim|reserve|answering|dedupe" src/company src/domain`
   零命中。项目负责人被 **141/141 条非己消息**唤醒（`wakeOnAll:true`，`src/company/channels.ts:528-529`）。

---

## 1. 清点：跨 agent 通信到底有几套在并存

### 1.1 逐个数（行数为 `wc -l` 实测）

| # | 机制 | 文件:行数 | 载体 | 出口（怎么吵醒别人） |
|---|---|---|---|---|
| 1 | 频道消息 say/ask/read_channel/inbox | `src/domain/channels.ts` 542 + `src/company/channels.ts` 590 | `app.channels` 文档 | `postToChannel()` `src/company/channels.ts:171` |
| 2 | `deliver()` | `src/company/deliver.ts` 254（`deliver` 在 :79） | 无（只 `conversation.submit`） | `submit(requestId="ch:{ch}:{seq}:{to}")` |
| 3 | `notify()` | 同文件 `:209` | 无 | `submit`，`wake:false` 时 `type:"write"` 只记不唤醒 |
| 4 | 升级链 escalate | `src/company/escalation.ts` 1300 | `app.pending` + harness task（持久化任务机） | `ensurePending()` `:989` 写频道 + `deliverDecision()` |
| 5 | 待决项处置 disposition | `src/company/disposition.ts` 857 | **同一个** `PendingDoc`（`escalation.ts:213`），key 前缀 `disp:` | 无独立出口，靠 `settleDueDispositions` 定时结算 |
| 6 | 决策投递 decision-delivery | `src/company/decision-delivery.ts` 142 | 无 | 自己 `submit`，`requestId="decision:{key}"`（`:78`） |
| 7 | 同步派活 delegation | `src/company/delegation.ts` 533 + `delegation-guard.ts` 165 | `app.trail` | `employee.submit(...)` `:142`，**然后同步等** `wait.ts` 42 |
| 8 | 留痕 trail | `src/company/trail.ts` 314 | `app.trail` 文档 | 无（只读侧投影） |
| 9 | 圆桌 roundtable | `src/company/roundtable.ts` 1128 | 自己的文档 | `askParticipant()` `:615` → `submit` `:644`（`whenBusy:"followUp"`） |
| 10 | 看门狗 nudge/resurface | `src/company/watchdog.ts` 790 | `app.audit` + 会话内 alert | `postToChannel`（超时升级）、`submit`（`drainOne` `:709`） |
| — | 路由纯函数 | `src/domain/routing.ts` 241 | 无 | `decideOwner()` `:81` / `canReachOwner()` `:221` |
| — | 成员可见性 | `src/domain/membership.ts` 357 | 无 | `canView:84 / canMention:117 / canAssign:147 / canEscalate:181 / nextLevelUp:283` |
| — | 任务状态机 | `src/domain/tasks.ts` 473 + `src/company/tasks.ts` 395 | `app.tasks` | `transitionTask()` `src/company/tasks.ts:218` |

合计 **8,123 行**（不含 org.ts 的 2392 行名册）。`src/company` + `src/domain` 全量 14,068 行，
**通信与任务占 58%**。

### 1.2 哪些是另一套的特例

这是本席最核心的清点结论。**四组包含关系，全部可以证明**：

**（a）`decision-delivery` ⊂ `deliver()`。**
`deliverDecision()`（`decision-delivery.ts:51`）自己拼 body、自己
`conversation.submit`（`:78`）、`requestId="decision:{key}"`，**不查未读摘要、不带
记忆简报、不写 `ReplyContextDoc`**。而 `deliver()`（`deliver.ts:79`）做的是同一件事
加三样东西：`renderForModel` 正文 + `renderDigest` 未读摘要 + `renderMemoryBrief`
记忆简报（`deliver.ts:100-115`），末尾 `recordReplyContext()`（`:145`）。
→ **决策通知是「没有上下文的投递」，是 `deliver()` 的退化版，不是另一种东西。**

**（b）`notify()` ⊂ `deliver()`。**
`notify()`（`deliver.ts:209`）不经频道、不查已读、不拼摘要，直接 `submit`；
`wake:false` 时用 `type:"write"` 只记不唤醒（`:225`）。它被 `src/company/tasks.ts:279`
和 `:311` 使用，用来投 `app.task-report` / `app.memory-hint`。
→ **它就是「`targets` 只有一个人、且 `channel=null` 的 deliver」。**

**（c）升级链 ⊂ 「待决项 + 超时推进」。**
`escalation.ts` 的三个 phase（`ask-manager` / `ask-ceo` / `ask-owner`，见 `EscalationState`
与 `createEscalationTask:266`）是**同一段代码抄三遍**：

```
ensurePending()  →  readOutcome()  →  undefined ? sleepUntil(pollDelay) : (escalate ? nextLevelUp : finish)
```

`pollDelay`（`:256`）在头 60 秒是 `POLL_MS=200`（`:228`），之后 `SLOW_POLL_MS=30_000`（`:241`），
窗口 `FAST_POLL_WINDOW_MS=60_000`（`:249`）。**即：一个持久化任务机在 200ms 轮询一个
`PendingDoc` 里的普通记录。** 升级链本身没有任何新语义，它只是「谁该接这个待决项」
的推进器，而推进函数就是 `nextLevelUp()`（`membership.ts:283`，返回一行字符串）。

**（d）disposition 与 escalation 共用 `PendingDoc`，却是两套时间逻辑。**
`PendingDoc` 定义在 `escalation.ts:213`；`disposition.ts` 复用它，但自己定义
`DEFAULT_DISPOSITION="shelve"`（`disposition.ts:153`）、`DISPOSITION_DEADLINE_MS=5*60_000`（`:156`）、
`DEFAULT_RESUME_AFTER_MS=30*60_000`（`:159`），自己一套 `settleDueDispositions` /
`applyDueDispositionDefaults` / `applyDueResumeReminders`，**完全不经过 escalation 的
phase 机**（escalation 也不认识 disposition 写的 key `disp:`）。
→ **同一个文档、同一个概念「谁欠一个决定」，长了两套到期算法。**

**（e）`trail` 不是通信机制，它是同步派活的记账。**
`app.trail` 生产库里**只有 1 条边**：

```json
{"at":1792981000333,"kind":"escalate","fromConversation":89,"toConversation":1,
 "from":"负责人","to":"ceo","ref":"esc:89:1792981000331000","project":"system"}
```

`recordMessage()`（`trail.ts:63`）/ `beginLiveTrail()`（`:134`）主要为 `delegation.ts`
的同步调用链服务。**314 行 + 每消息一次文档写入，服务 1 条数据。**

### 1.3 结论：9 套 → 1 套

| 保留 | 塌缩成 | 理由 |
|---|---|---|
| 频道消息 | **Message**（含 `to[]`、`replyTo`、`refs`） | 已经是唯一落库入口（`postToChannel` `channels.ts:171`） |
| `deliver` / `notify` / `decision-delivery` | **Message 的投递函数（一个）** | 三者差的是「带不带摘要 / 有没有频道」，不是语义 |
| 升级链 / disposition / 派活 | **Item**（待决项的 owner + dueAt + 状态） | 三者都在做「谁欠一个东西、什么时候催」 |
| `trail` | **删**（或降级为 `Message.refs` 的派生视图） | 1 条生产数据 |
| 看门狗 | 保留，但只做「扫 Item 的 dueAt + 扫 Message 的未读」 | 现在它自己在造第三套超时语义，见 §2.3 |
| 圆桌 | 保留（`askParticipant` 需要同步收齐，ADR-028 决策 4 明确保留） | 但应复用 Item 的 per-participant 超时 |

---

## 2. 升级链审查（1300 + 857 行）

### 2.1 核心不变量：你说的对了一半

我读到的不变量是三条，只有第 1 条是硬的：

1. **owner 只能由结构算，不能由模型声明。** `decideOwner()`（`routing.ts:81`）从
   `DecisionTopic` + 名册算出该谁拍；`routing.ts:16-19` 的注释写明了理由：
   >「授权只来自结构，不来自『重要性』，因为重要性是主观的，模型会用它给自己授权。」
   这是整个仓库最值钱的一条注释。**必须保留，且应该变成唯一的授权来源。**
2. **不许跳级 / 老板级待办只能 CEO 递**（`canEscalate:181` 允许跳级上报，`canReachOwner:221`
   禁止直接找老板）。这条**不是独立不变量**，它是第 1 条的自然结果：如果 owner 由
   `nextLevelUp()` 一级一级算，那么「直接找老板」在结构上就不可能发生。**为了这一个
   推论多写了一个 `canReachOwner` + ADR-033 + 24 个测试文件（grep "escalat" 命中 26 个测试文件）。**
3. **指令无条件受理**（ADR-026 决策 7）——这条**跟升级链没关系**，它是
   `deliver()` 的 `whenBusy:"steer"`（`deliver.ts:118`）和 `http.ts:908`
   `interruptThenDeliver` 的性质。放错家了。

### 2.2 用「消息 + 待决项 + 超时」能替代吗？能。会丢什么？

**能，而且升级链现在就是它的笨实现。**

通用机制：`Item{kind, owner, dueAt, status}`。到期时唯一的推进动作是
`owner = nextLevelUp(owner)`；`nextLevelUp` 找不到上一级时，`owner = owner` 并标 `stuck`。
「拍板」= 往这个 Item 上写一条 `Message{kind:"answer", refs:{item}}` 且 `status=answered`。
「处置」= `status=closed` + 一条 `Message{kind:"note"}`。

会丢的东西，逐条判定：

| ADR-026 子规则 | 判定 | 依据 |
|---|---|---|
| topic 必须由发起方显式声明（`DecisionTopic`，`routing.ts:16`） | **必要，保留** | 这是防模型自我授权的唯一防线 |
| `decideOwner` 结构计算 | **必要，保留** | 同上 |
| company-level 非 CEO 声明 → 必须 CEO 复核（`review:true`） | **过度设计，删** | 「不是 CEO 却声明 company-level」的等价动作就是「交给我的上级」。多一个 `review` 标志、多一个 phase、多一段 `ensurePending` 分支（`:989`），换来的是同一个结果 |
| `takeOverPendingAtCeo`（`:900`） | **过度设计，删** | 它就是「owner 可以被上级拿回去」= `reassign`。100 行服务一条边 |
| disposition 的 `5min / shelve / 30min resume` 三档默认值 | **过度设计，删** | 生产库 `app.pending` 里 **1 条** 记录（`esc:89:…`，level=ceo），**disposition 0 条**。857 行服务 0 条生产数据 |
| 不许跳级 | **保留但不需要单独代码** | `nextLevelUp` 逐级算的自然结果 |
| 老板级待办只能 CEO 递 | **保留但不需要单独代码** | 同上；`canReachOwner` 可删 |

**净效果：三条必要规则 + 一个 `nextLevelUp()` 函数。1300 行 → ~200 行；
857 行 disposition → ~60 行（Item 关闭 + 一条 Message）。**

### 2.3 更严重的问题：升级链和看门狗在互相打架

这是我在这次调研里最意外的发现，也是它必须被砍掉的理由——**不是「重」，是「错」**：

- `escalation.ensurePending()`（`:989`）在写 PendingItem 的同时，会
  **`postToChannel(kind:"question", mentions:[decisionOwner])`**。
- `watchdog.escalateUnansweredQuestions()`（`watchdog.ts:413`）独立扫描
  **所有** `kind==="question"` 的频道消息，10 分钟（`questionUnansweredMs`）没人回就
  **向 `mentions[0]` 的 `managerId` 发一条【超时升级】**（`:466-485`）。

于是**同一条问题有两条升级轨道，用了两个不同的 owner 算法**：
升级链走 `decideOwner(topic)` → `nextLevelUp` 链；看门狗走「被 @ 那个人的 manager」，
**只升一级、不沿链、不看 topic**。看门狗判断「是否已升级」的启发式是
「后面有没有一条 mentions 完全不同的 question」（`watchdog.ts:440-446`）——
升级链每升一级正好会发这样一条，**所以看门狗会把升级链的第 N 级当成的「已升级记录」，也可能把升级链的目标人换成另一个人。**

真实后果可以推演：员工 161 问负责人 89 一个 `project` topic 的问题 →
`ensurePending` @ 89 → 89 十分钟没回 → 看门狗把 89 的 manager（CEO，1）拉进来 →
同时升级链认为该给 `decideOwner` 另一个人。**两个人同时被唤醒，都以为自己该拍。**
这就是 §4(d) 说的「重复回答」的根源，而且它跟唤醒规则无关，是路由算法分叉导致的。

---

## 3. 任务模型审查

### 3.1 状态机：不是「够不够」，是「有一半没用过」

`TRANSITIONS`（`src/domain/tasks.ts:111`）：
`todo→[doing,cancelled]`、`doing→[blocked,review,done,cancelled]`、`blocked→[doing,cancelled]`、
`review→[doing,done,cancelled]`。

生产库 20 个任务的终态分布：

```
done 15 | todo 4 | cancelled 1
出现在历史 delta 里的 status 字面量：doing 11 次、review 0 次、blocked 0 次
```

**`review` 从未被使用过一次，`blocked` 从未被使用过一次。**
原因不是模型懒，是 `task_update` 的 description（`src/company/tools/universal.ts:457`）写
「todo → doing → review/done」把 review 和 done 并列成了可选项，
模型当然选省事的那条。**ADR-030（必须有验收标准）实际上是在 `createTask` 校验
`acceptance` 非空（`src/company/tasks.ts:147`）里落实的，不是在状态机里落实的。**

验收真实发生在哪？频道里：`kind:"report"` 消息 **77 条**（271 条项目群消息里的 28%）。
即「`done` + evidence 文本 + 负责人在频道里回一句『收』」。

**我的判定：状态机应该只剩 `open → doing → closed`（+ `cancelled`），
把 `review` 删掉。**「待复核」不是一个状态，是「`Item.owner` 变成了验收人」——
这正好是 §5 的 Item 原语。`evidence` 保留（它是最有价值的字段）。

### 3.2 变更需求：现在的路径是「取消 + 新建」，代价是断链

真实案例就在库里，两次：

- **UX-7 的方案变更**：`T-18`（UX-7 前端：私聊与工作记录合并流的渲染层，assignee 1897）
  `status=cancelled`；随后新建 `T-19`（UX-7 前端（**B 方案**）：…，assignee 1897）。
- **D-008 拆分**：`T-20`（D-008-a 修复）的 brief 里写着「CEO 已同意拆 D-008 为 a/b，先修 a」。

所以现在的变更路径是：**旧任务 `cancelled` + 新任务 `createTask` + 人肉把
`dependsOn` 重连 + 旧任务的 `progress`/`evidence` 链路断掉**。
`TaskEntry` 有 `dependsOn` 字段，但**没有任何工具能改它**——`task_create` 时才写一次
（`universal.ts:537`），`task_update`（`:457`）不接受 `dependsOn` 参数。

真实场景推演（老板举的 dino 游戏）：

> 负责人给员工 A 派 `T-21 实现坦克大战`（acceptance：可玩、有胜负判定）。做到一半，
> 老板说「还要有音效」。
> - 现在：A 只能在频道里 `say`（`universal.ts:221`，`kind:"chat"`，不写 @ 就不唤醒任何人）
>   → 负责人因为 `wakeOnAll` 一定会被唤醒 → 负责人读懂了 → 负责人 `createTask T-22 加音效`
>   → 但 `T-21` 的 acceptance 没变，A 报 `T-21 done` 时**没有音效也算完成**
>   → 负责人要自己记得「T-21 其实没完」，而看板上 T-21 是 done。
> - 更糟的分支：负责人直接 `task_update T-21 → done` 之外没有别的手段表达「目标变了」。
>   **只能取消重建，A 会看到自己的 T-21 变 cancelled，不知道是谁、为什么。**

**缺的东西：一个能挂到已有 Item 上的 `kind:"change"` 待决项。** 它改的是父 Item 的
`acceptance` 与 `dueAt`，不新建 Item。这是 §5 Item 原语的第二条用途，也是
「dino 加音效」这个场景的最低成本路径：**1 条 Message（老板）+ 1 个 Item（负责人写）
+ 1 次豁免（A 收到「验收标准变了」）**，而不是「取消 + 新建 + 断链」。

### 3.3 任务 vs 频道：现在是**一个事实写三处**

`transitionTask()`（`src/company/tasks.ts:218`）在 `done/blocked/review` 时做三件事：

```ts
await postToChannel(... kind:"report", mentions:[assignedBy] ...)   // :261  ① 写频道
reported = await notify(assignedBy, { kind:"app.task-report" ... }) // :279  ② 直接投会话
await notify(assignee,  { kind:"app.memory-hint" ... })            // :311  ③ done 时回写自己
```

①和②是**同一个事实的两次投递**：`assignedBy` 会先收到频道消息的正文 + 未读摘要
（`deliver.ts:100-115`），然后**再单独收到一条 `app.task-report` 的 input**。
生产库实证：`kind:"report"` 77 条 —— 这 77 条既是「任务进展」也是「频道噪音」，
而 `notify` 那条根本不落在频道里，所以**频道历史里看不到它，会话历史里又能看到一遍**。

**判定：任务进展应该只写一处 —— Item 的 `progress/evidence`（结构化、可查询、看板直接读），
由系统在状态变化时**生成一条引用它的 Message**。人不再需要「对齐两处」。**
ADR-031「完成上报由系统写」是对的方向，但它只做到了「由系统写频道」，
没做到「不再重复投一次会话」。

---

## 4. 通信模型缺的东西（四个真实场景）

### (a) 两个员工要协作（开发找测试问一句）

- 开发 149 想问问测试 161：「D-001 的复现步骤里第 3 步是必须的吗？」
- 可用工具：`ask`（`universal.ts:262`，参数 `mention`，不填默认问 `managerId`）。
- **必须发在共同频道**：`ask` → `resolveChannel` → 只有 `company` / `proj:system` / `leadership`
  可选。员工没有 `dm:` 频道（`ensureAllChannels` 只给 owner 建 dm，`channels.ts:555`）。
- **所以这句悄悄话是全组广播**：`proj:system` 里 `wakeOnAll:true` 的老板（0，无会话，
  投递必失败）和负责人（89）**都会被唤醒**。负责人被叫醒去读一句跟他无关的话。
- 轮次成本：开发 1 轮（`ask`）→ 测试 1 轮（读、答）→ 开发被**再唤醒 1 轮**（答在频道里，
  `recipientsOf` 只给 `mentions` 和 `wakeOnAll` 发，测试回话时若忘了 @ 开发，
  **开发永远不会被唤醒，问题悬空**，靠 `read_channel` 或 30 秒看门狗兜底扫描）。
  **最少 3 轮，常见情况是无限（对方答了但没 @ 你）。**

### (b) 老板在网页上插一句话

`POST /api/message` → `http.ts` 解析 mentions（`:1155-1160`，**显式 @ ∪ 正文解析，
且滤掉 OWNER_ID 自己**）→ `writeAck` 写受理回执 → `postToChannel`。

- **「所有相关 agent 都看到」做不到**：`recipientsOf`（`domain/channels.ts:424`）只给
  `mentions` + `wakeOnAll` 成员发。项目群里员工不是 `wakeOnAll`，老板不 @ 他们，
  **他们不会被唤醒、也不会看到 digest 提示**（digest 只在下一次被唤醒时才拼一次，
  `digestFor` `domain/channels.ts:468`）。
- **「不重复回应」也做不到**：老板手动 @ 5 个人 → `recipientsOf` 返回 5 个 target →
  `deliver()` 逐条 `submit`（`deliver.ts:118`）→ **5 个 agent 各起一轮、各答一遍**。
  没有任何机制说「这条已经有人答了」。`grep -rn "claim|reserve|answering"` **零命中**。
- 兜底是 `resurfaceSilentOwnerMessages`（`watchdog.ts:562`），但它的判据是
  「频道里后面有没有**任何**人说话」（`:576`）——**5 个人里只要有 1 个说了话，另外 4 个没答就不算漏。**

### (c) 一个 agent 卡住（等一个永远不来的回答）

这条最严重。生产库实测：

```
submissions 里 status=unanswered 且 reason=no_model：67 条
其中 conversationId=89（项目负责人）：48 条
另有 aborted 2 条
```

时间线：`deliver()` → `conversation.submit()` **返回成功** → 该 submission 后来
`settled: unanswered, reason: "no_model"`（`pi-durable` 的类型里这是终态）。
`deliver()` 已经把 target 记进 `delivered`（`deliver.ts:118` 的 try 里），
**频道侧看起来「投递成功」**。

谁会发现？

- `watchdog.drainOne()`（`:709`）只处理 `submission.type==="input" && status==="queued"`（`:684-685`）；
  `unanswered` 已经 settled，**不在 inspect 的未结算集合里，永远不会被扫到**。
- `refreshProgress()`（`:650`）只看「会话最新 entry id 有没有变」，一个 no_model 的 run
  可能**没有新 entry**，于是心跳也不动 → 但没有任何代码把「心跳不动 + 消息已投未读」连起来。
- 做这件事的只有**两个同步调用方**：`delegation.ts:221` 和 `roundtable.ts:694` 检查
  `settled.status === "unanswered"`。**异步的频道投递路径（`deliver`）从不检查。**

**结论：发现时间 = 无限（永不发现），代价 = 0 token（因为没人发现）。**
48 条发给负责人的消息静默死亡，这就是「投递 ≠ 已读」的代价。
修复成本极低：`deliver()` 拿到 `submit` 返回的 submission id 并落进 Message 的
`deliveredTo[]`，看门狗每 30 秒查一次这些 id 的 `settled.status`，
`unanswered` 就重投一次（上限 2 次，复用 `WATCHDOG_DEFAULTS.maxAttempts`）。

### (d) 同一个频道里 5 个 agent 都醒了 → 重复劳动

用 `recipientsOf` 规则对生产库 389 条消息复现，实测：

```
389 条消息 → 673 次唤醒，均值 1.73；最高 5 个 target（3 条消息）
proj:system 271 条，其中 141 条非负责人自己发的 → 负责人被唤醒 141/141（wakeOnAll）
proj:system → conversationId 0（老板）271 次，但 conversations 表里没有 id=0
                  （只有 1,7,13,19,25,31,37,89,149,161,1897,1905）→ 271 次投递全部 failed
```

`chat` 消息 157 条，**平均「发言连段」1.46 条**（186 段 / 271 条）——
这说明项目群不是协作，是**1.46 条就换人的乒乓**。而且因为 `deliver()` 每次都重放
整个会话前缀：

```
全库 usage：576M totalTokens，其中 cacheRead 567M（98.5%）
conversationId 89（负责人）：194,119,553 tokens
```

**一次唤醒的边际成本 ≈ 一次完整上下文重放。** 负责人被 141 次无差别唤醒，是最大的
token 黑洞。这不是提示词能修的，是 `wakeOnAll:true` 这个广播语义的代价。

---

## 5. 通信层最小核心提案

### 5.1 三个原语

**P1 `Message`** —— 一切跨 agent 的**发生过的**事实。
```
{ id, channel, from, to[], kind: chat|question|answer|report|system,
  text, refs?, replyTo?, at }
```
落库一次（沿用 `postToChannel` 的按路径写，实测 141 字节/条，`channels.ts:263` `appendMessageInPlace`）。
`to[]` 是**唯一**的唤醒集：显式 @ 与被指派的 target，两者合并。
**`wakeOnAll` 删除**（广播不是语义，是省事；项目群需要的是 `to[]` 里有负责人）。

**P2 `Item`** —— 一切**尚未结束**的事：任务、提问、变更、升级、处置。
```
{ id, kind: task|question|change|disposal,
  owner,            // 当前该谁处理；只能由 nextLevelUp 推进，模型不能写
  dueAt,            // 从 dueAt 到期起由系统推进，不靠模型自觉
  status: open|claimed|answered|closed,
  acceptance?,      // ADR-030 保留：外部可验证的「做完」定义
  parent?,          // 变更需求挂到父 Item 上（dino 加音效）
  progress[], evidence[] }
```
- 任务 = `kind:task`；提问 = `kind:question`（`escalate` 工具就是「把 owner 交给
  `nextLevelUp(me)`」，即 `Item.owner = nextLevelUp(from)`）；
- 老板级待办 = `owner` 落在 CEO 的 `kind:question`（ADR-033 成为结构性结果，不需要
  `canReachOwner`）；
- 变更需求 = `parent` 指向父 Item 的 `kind:change`；
- 处置 = `status:closed` + 一条 Message（disposition 的三档默认值删除）。

**P3 `Cursor`** —— 谁看到哪儿（`channel.members[cid].lastReadSeq`，已存在，
但被埋在三处地方算）。它决定未读摘要（`digestFor`）、决定「老板的消息没人理」的判据、
决定 §4(d) 的重复唤醒抑制：**同一个 `Item` 已经 `claimed` 就没人再醒**。

### 5.2 两条规则

**R1（唤醒规则）一条 Message 只唤醒 `to[]` 里的人；不在 `to[]` 的人只看到未读计数，
不醒、不拼摘要、不消耗 token。** 唤醒前查 `Item.claimed`，已认领的不再唤醒。
→ 删掉 `wakeOnAll`，`recipientsOf`（`domain/channels.ts:424`）从 44 行降到 ~10 行，`wakeTargets`（`src/company/channels.ts:281`）随之消失。

**R2（推进规则）任何 `open` 的 Item 必须有一个 `owner` 和一个 `dueAt`；到期由系统
（看门狗的一个 tick，不是模型）推进，且只有三种动作：`owner = nextLevelUp(owner)`、
`reassign(owner, x)`、`close(reason)`。owner 只能由结构计算（`decideOwner` + `nextLevelUp`），
模型只能「提交一个待决项」，不能「决定谁拍」。**
→ 升级链、disposition 到期、看门狗的超时升级、delegation 的等待，全部变成这一个函数。

### 5.3 会消失的东西（行数估计）

| 现状 | 行数 | 之后 | 节省 |
|---|---|---|---|
| `src/company/escalation.ts` | 1300 | Item 引擎（含 promote/claim/answer） ~220 | −1080 |
| `src/company/disposition.ts` | 857 | `close()` + 一条 Message，~60 | −797 |
| `src/company/decision-delivery.ts` | 142 | 0（一条 answer Message） | −142 |
| `src/company/delegation.ts` + `delegation-guard.ts` + `wait.ts` | 533+165+42 | 0（`assign_task` = 建 Item） | −740 |
| `src/company/trail.ts` | 314 | 0（`Message.refs` 派生视图，~40） | −274 |
| `src/company/roundtable.ts` | 1128 | 保留但复用 Item per-participant 超时，~400 | −728 |
| `src/company/watchdog.ts` | 790 | 一个 tick 扫 Item.dueAt + Cursor，~260 | −530 |
| `src/domain/tasks.ts` + `src/company/tasks.ts` | 473+395 | 并进 Item 引擎，~180 | −688 |
| `src/company/deliver.ts` | 254 | 一个投递函数（`deliver`+`notify`+`deliverDecision` 合一），~150 | −104 |
| `src/domain/routing.ts` | 241 | 只留 `decideOwner` + `nextLevelUp`，~80 | −161 |
| 新增「投递回执 / settled 检查」 | 0 | ~120（**这是要加的唯一一块**，修 §4(c)） | +120 |

**净：约 8,123 行 → 约 1,500 行（−81%）。** 其中 `org.ts` 2392 行的名册不动（那是 D 席的事）。

### 5.4 风险（我承认的）

1. **生产数据迁移**：`app.pending` 1 条、`app.tasks` 20 条、`app.channels` 389 条消息，
   都是真数据。`PendingDoc` 的 `level` 字段语义与 `Item.owner` 不完全等价
   （`level` 是「停在升级链哪一级」，`owner` 是「现在该谁」，`escalation.ts:100-160` 的
   注释明确区分了两者）。迁移必须逐条映射，不能批量重写。
2. **圆桌不能一刀切塌缩**：`askParticipant`（`roundtable.ts:615`）需要「同步收齐 N 份意见」，
   这是 `Item` 里唯一需要「多 owner」的形态。ADR-028 决策 4 保留它是对的，
   但它现在的 `whenBusy:"followUp"` 是又一条唤醒语义（`roundtable.ts:658`）。
3. **删 `wakeOnAll` 会让「负责人不知道项目群里发生了什么」**。缓解：负责人对项目群
   保持一条 `Cursor`（未读计数 + 摘要按需），而不是每条消息一次唤醒。
   这是本次改动里**唯一会降低「负责人的主动感知」**的地方，需要 D 席（前端）配合给出
   「未读摘要面板」，否则负责人真的会漏事。
4. **最大风险是测试**：`grep -rn "escalat" test/` 命中 26 个文件（e2e 465+462 行、
   `channels-deliver.test.ts` 815 行、`unit/pending-dispose.test.ts` 451 行…）。
   这些测试**大部分在钉「实现路径」而不是「行为」**（例如钉 `POLL_MS=200`）。
   塌缩时会大量重写，不是「改几行」。
5. **`§4(c)` 的缺陷不能等到重构再做**。它是一行 `if` 的量级（`deliver()` 落 submission id +
   看门狗扫 `settled`），应该**先修**，否则重构期间那 48 条消息的死法会继续。

---

## 6. 我最容易被反驳的一点（自评）

**「你要砍掉 `wakeOnAll`，但项目负责人本来就应该知道项目里的每一句话。」**

这个反驳是成立的。我的回应是：**「知道」不等于「每句都唤醒一轮」。**
现在负责人被 141 次唤醒、烧掉 194M token（全库 576M 的三分之一），
而 `chat` 平均连段只有 1.46 条——说明这 141 次唤醒里绝大多数没产生任何决策。
如果 D 席能给出「未读摘要面板 + 一键进群」，`Cursor` 就足以承载「知道」，
不需要 141 次上下文重放。**但如果没有那个面板，我的提案确实会让负责人变聋**——
这一点我接受作为本轮提案的已知代价。
