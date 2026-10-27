# C 席 · 第 2 轮交叉辩论（通信与任务模型派）

> R1 原文 `docs/roundtable/r1/C-comms.md`。行号与数字均为本轮实测；脚本 `/tmp/c1.mjs`–`/tmp/c8.mjs`（对 `workspace/company.sqlite` 的 `app.channels` 回放，407 条消息）。

## 我读完后改变的看法

三条，全是**被数据打掉的**，不是被论据说服的。

1. **我的 `-81%` 分母错了，且错得对我有利。A 席这一枪打准。** R1 表列 10 项今日 `wc -l` 合计 **6,634**，表头写 **8,123**。差 1,648 是我漏列 5 个文件：`channels.ts` 590 + `domain/channels.ts` 542 + `membership.ts` 357 + `roundtable-tools.ts` 152 + `decision-routing.ts` 7。18 个通信/任务文件全量 **8,282**。同口径重算：6,634 → 1,510 = **-77.2%**。
2. **`wakeOnAll` 的代价我指错了人。** 实测（`/tmp/c7.mjs`：663 次唤醒 → 显式 `to[]` 后 342 次）：老板 **-273**、负责人 **-48**、其余 9 会话 **0**。**95% 落在老板身上**，而老板在 `proj:system` 一条消息都没发过（`from=0` 计数 0）。
3. **D 席的 `writeAck`、B 席的 `app.memory` 0 文档，各打掉我一条保守。** 我的 P1 `Message` 没有 `ack` 字段——只解决了「负责人看不到消息」，没解决「老板不知道话被谁接住」。我说「`deliver()` 已拼 digest 所以够」是偷懒：`renderMemoryBrief`（`deliver.ts:109`）从未跑过（`app.memory` 文档不存在）。

**没有改变**：三原语方向；「投递成功 ≠ 已读」是正确性 bug（A 席已采纳）。

## Q1 唤醒判据

**5 条必须唤醒（全可机器判定）**

| # | 规则 | 判定式 | 依据 |
|---|---|---|---|
| H1 | 显式 @ 我 | `(m.mentions??[]).includes(me)` | 唯一无歧义定向信号；生产 93/141 |
| H2 | `kind === "question"` | 字段 | 提问必须有人答（ADR-026 无条件受理） |
| H3 | `from === 0` | 字段 | 老板只在 `company` 说话（38 条），插话即最高优先 |
| H4 | 结构化交付 | `kind==="report"` ∨ `/【T-\d+ (提交验收\|取消\|交付\|阻塞\|完成)】/` | 负责人是默认验收人（ADR-030） |
| H5 | 阻塞词 | `/阻塞\|卡住\|求助\|请裁\|需要你\|定一下\|请确认\|越权\|紧急\|失败/` | 「没人能往下走」的显式文本信号 |

**2 条只该进未读（负规则优先于正规则）**

| # | 规则 | 判定式 | 理由 |
|---|---|---|---|
| U1 | 进度模板 | `/^【T-\d+ 开始】/` | 26 条同一句式，43–219 字，信息量 = 一个状态位 |
| U2 | 同一对话段 | `kind==="chat"` ∧ `(m.at - 我上条发言.at) < 5min` | 我人在场（我 130 轮发言间隔中位 **0.82 分钟**，57% <1 分钟） |

不命中任何一条 → **S 软唤醒**（标题 + 正文前 80 字）。

**用这组判据重算那 141 条**

| 档 | 条数 | 正文字数 |
|---|---|---|
| H1 @我 | 93 | 129,442 |
| H4 结构化交付 | 33 | 19,927 |
| H5 阻塞词 | 8 | 17,712 |
| S 软唤醒 | 2 | 1,029 |
| U2 同段闲聊 | 5 | 8,422 |
| **合计** | **141** | **176,532** |

**诚实结论：134/141 仍然唤醒，只省 5.4% 字数。我 R1 说的「砍掉 141 条广播」在条数口径上不成立。**

收益在**轮次**（`/tmp/c8.mjs`，窗口合并）：不合并 134 → 0.5min **77** → 1min **58** → 2min **40** → 5min **17** → 10min 5。
再一条推翻我自己的：141 条里 **123 条（87%）落在我静默 <5 分钟的窗口内**，静默 >5min 才到的只有 **18 条**（`/tmp/c3.mjs`）。→ **真正「打断我思考」的只有 18 条**，我把 141 次唤醒当成了 141 次打断。

**D 席的面板能补多少：他补错了人**

| 谁 | 现状 | 显式 `to[]` 后 | 差 | 面板能补 | 补不了 |
|---|---|---|---|---|---|
| 老板(0) | 312 | 39 | **-273** | 徽章/未读汇总已在跑（`channels-view.ts:345 unreadSummary`、`http.ts:483`） | **老板不进网页**，入口是对话不是列表 |
| 负责人(89) | 171 | 123 | -48 | 事后知情：`read_channel`（`tools/universal.ts:340`）+ `inbox`（`:387`）已具备 | 时延 |
| 其余 9 个 | 180 | 180 | 0 | — | — |

「补 80%」预设了「砍掉的是感知」——数据说不是：老板那 271 次里，`@0` 的消息 **0 条**。
若一定要说剩下 20%，损失是两件具体事：①**静默期那 18 条**（占 12.8%，面板结构上补不了，只能靠升级粒度——其中 16 条本就命中 H1–H5）；②**U2 那 5 条 + 被判同段闲聊的实质正文**（seq 248/263/272/284 这类「补上判 PASS 的那一半」），我 3 分钟后才看见，员工多跑一轮。

## Q2 自审账单

**先闭合分母**：R1 表头 8,123（未点名来源，**错**）／表列合计 6,634／18 文件全量 **8,282**／漏列 5 个 = 1,648。
`wc -l` 实测：escalation 1300 / disposition 857 / decision-delivery 142 / delegation 533 / guard 165 / wait 42 / trail 314 / roundtable 1128 / roundtable-tools 152 / watchdog 790 / tasks 395 / domain/tasks 473 / deliver 254 / routing 241 / decision-routing 7 / channels 590 / domain/channels 542 / membership 357。

**逐项标注**

| 项 | 原报 | 类型 | 判据（可查） |
|---|---|---|---|
| decision-delivery →0 | -142 | **删重复** | `deliverDecision()`（`decision-delivery.ts:51`）⊂ `deliver()`（`deliver.ts:100-115` 已做 digest/memory/replyContext） |
| delegation+guard →0 | -698 | **删重复** | ADR-028 整条替代 ADR-025；`grep -rn "deps.delegate" src/` 零命中。**wait.ts 42 不可删（A 席对，我错）**：`http.ts:31,969,1088`、`roundtable.ts:58,505,513,670,684` 在用 |
| 四回答入口→1 | -200 | **删重复** | `answerPendingAsCeo`（`:634-656`）、`answerPendingAtLevel`（`:1269,:1288`）都是 3 个前置检查 + 转调 `answerPending` |
| 三 phase 克隆→循环 | -135 | **改数据结构** | `createEscalationTask`（`:266-490`，225 行）三段同构 |
| disposition 到期两点合一 | -250 | **删重复** | `settleDueDispositions`（`disposition.ts:434`）被 `escalation.ts:685` 读侧 try/catch 吞；`applyDueDispositionDefaults`（`:630`）被 `watchdog.ts:340` 定时扫 |
| disposition 857→60 | **-797** | **删功能** | `test/e2e/disposition.test.ts:80` 钉的是产品承诺（`shelve` / 5 分钟 / 30 分钟恢复） |
| roundtable 1128→400 | **-728** | **删功能** | A 席说该由老板拍，我同意 |
| watchdog 790→260 | **-530** | **删功能** | 删 retry = 僵住任务只能人工 `/api/interrupt` |
| takeOver 76 行 | **-76** | **删功能** | 同一语义在 `escalation.ts:350-362`+`:415-432` 已实现 → 应改薄包装 |
| tasks 868→180 | -688 | 改结构 **+部分删功能** | `TRANSITIONS`（`domain/tasks.ts:111`）的 `review`/`blocked` 生产字面量 0 次，但删掉是状态机少两态 |
| trail 314→40 | -274 | 改数据结构 | 生产 4 条边 / 2 ref / 1 项目 |
| routing 241→80 | -161 | 改结构 | `decideOwner`（`:81`）必留；`canReachOwner`（`:221`）零运行时调用 |
| deliver 254→150 | -104 | 改结构 | `notify()` ⊂ `deliver()` |
| 投递回执+ack | +120 | 加功能 | 修 unanswered 69 条 |

**依赖「老板接受少一个功能」的行数**

| 项 | 行数 |
|---|---|
| disposition 三档默认值 | -797 |
| roundtable 多 owner 收齐 | -728 |
| watchdog retry | -530 |
| 删 review/blocked | -150 |
| takeOver 按钮 | -76 |
| **合计** | **-2,281（占 -5,124 的 44.5%）** |

**接近一半。A 席「你的账里混着砍功能」这半个指控成立。**

**保守版（只删重复，功能零变化）**

| 项 | 行数 | 行为变化 |
|---|---|---|
| `decision-delivery.ts` 全删 | -142 | 零（`deliver()` 已覆盖） |
| `delegation.ts` + `guard` | -698 | 零（ADR-028 已替代） |
| 四回答入口合 1（留三个前置断言） | -200 | 零 |
| disposition 到期两执行点合一 | -250 | 零（`settleDueDispositions` 只剩一个调用者） |
| `waitEscalation` 移出 `src/` | -60 | 零（`grep` 无生产调用，只被 2 个 test 用） |
| `transitionTask` 三副作用合一 | -60 | 零（`:261/:279/:311` 都走 `deliver()/notify()`） |
| trail 测试专用导出降级 | -60 | 零 |
| `canReachOwner` 死函数 + `decision-routing.ts` | -57 | 零 |
| **合计** | **-1,527** | **老板感知不到任何变化** |

激进版 -5,124 vs 保守版 -1,527 = **1 : 3.4**。即我报的 83% 节省里，只有 30% 是不砍功能的。

**A 席说「我做完 -2,174 后你有一半白做」——同意哪些**

| 他的项 | 我账里 | 判定 |
|---|---|---|
| delegation 698 | 含 | **白做** |
| trail 导出 ~100 | 含 | **白做** |
| decision-routing 7 | 含 | **白做** |
| 升级链去重 450 | 含 | **白做** |
| disposition 到期合一 250 | 含 | **白做** |
| **合计白做** | **-1,505** | **占 -5,124 的 29.4%，不是一半** |

不同意两点：①**「覆盖」方向他说反了**——他的 5 项是我账的子集，是我的账覆盖他的账。这不改变结论，但恰好证明「先做我才会产生白做」，所以**顺序上该先做他**，这点我认。②**「一半」把「白做」和「功能批不下来」混算了**：硬白做 29.4%，加上砍不掉的 -2,281 = **74%**。两个数都给他挑。

## Q3 数据迁移方案

**底层已经给了路**：`defineDoc` 支持 `migrate?(value, fromVersion): T`（`pi-durable/dist/types.d.ts:65`）；版本升高时**强制写完整 base 而不是 delta**（`dist/session/transaction.js:794-800`：`loaded.storedVersion < version ? {content:{version, kind:"base", value}} : ...`）。→ **不需要双写期**，迁移 = 读旧版 → `migrate()` → 原子写新 base。`src/` 目前**零处使用 `migrate`**。照抄 `scripts/migrate-staff-manager.ts`（179 行）：`--db` 必填无默认、`--dry-run`、`--check`（未完成退出码 1）、幂等、**停 7788 端口**、**不调 `recover()`**。

| 文档 | 生产现状 | 方案 | 理由 |
|---|---|---|---|
| `app.pending` | **2 条**，都 `level:"ceo"`、`decisionOwner:"ceo"`、**都已有 `answer`**，无 `takenOver`/`disposed` | `version 1→2` + `migrate()`，2 条逐条映射 | 2 行数据，不该有脚本 |
| `app.channels` | 407 条 / base 462KB + 57 delta | `version 1→2` 加 `to?: number[]`；**历史消息 `to` 留空**，读者回退 `mentions` | 不碰 462KB |
| `app.tasks` | 20 个，`{tasks:{T-N:{}}}` 对象；done 15 / todo 4 / cancelled 1 | `version 1→2` 只归一 `status`（`review`→`doing`、`blocked`→`doing` 保留 `blockedReason`） | 生产 **0 个**任务处于被删两态 → 迁移可断言 `migrated===0` |
| `app.trail` | 4 条边 / 2 ref / 1 项目 | **直接丢**（不写 migrate） | 同事实 `app.audit` 8 条 events 全有（`escalate`×2 + `decide`×4 + `project-status`，同 `ref`） |

**`level` → `owner` 不等价，那 2 条变成什么**：`PendingItem` 注释原文——`level` 是「停在链上哪一级」，`decisionOwner` 是「结构上该谁拍」；升一级后 `level` 变、`decisionOwner` 不变。映射（**逐字段定向，不批量重写**）：
`owner = decisionOwner ?? level`（与现存 `decisionOwnerOfItem` `:668` 同口径）；`status = answer!==undefined ? "answered" : disposed!==undefined ? "closed" : "open"`；`originConversationId = originConversationId ?? fromConversationId`。
结果：`owner:"ceo"`、`status:"answered"`、`originConversationId:89` —— **与今天的可观测行为完全一致**。`level` 不丢弃，降级成 `hops[]` 长度；新代码不再用它判定。

**不做迁移的代价**

| 丢什么 | 老板会发现吗 | 为什么 |
|---|---|---|
| `app.channels` 407 条 | **会，当天** | 唯一可回看的对话记录，`read_channel`/`inbox`/digest 全依赖。**禁止丢** |
| `app.tasks` 20 个 | **会** | 看板 + 验收唯一载体（ADR-030）。**禁止丢** |
| `app.pending` 2 条 | **不会** | 都是终态；「谁何时定了什么」在 `app.audit` 的 `decide` 事件里，note 300+ 字全文 |
| `app.trail` 4 条 | **不会** | `audit` 有同 `ref` 的 8 条 events |
| 21 份报告 | **完全无关** | 在 `workspace/projects/system/reports/*.md`，本就不在 sqlite |

**答案不是「能不能丢」，是「哪两个能丢」：trail 与 pending 可丢（信息冗余），channels/tasks 不可丢。**

## Q4 升级链执行顺序

**「1 条 pending、0 条 disposition」不能当激进重写的证据。三条理由，每条可证伪：**

1. **这 2 条绕过了所有危险路径**：都 `level:"ceo"`、都 `answer`、无 `takenOver`、无 `disposed` → owner 级 / escalate / takeOver / dispose 四条路一条没走过。用没走过的路证明路通。
2. **`disposition` 0 条是反证不是正证**：857 行 + 36 条 unit test 服务 0 条数据，只有两种可能——从没触发，或触发路径本身坏了。**不知是哪一个就重写，等于把未知当安全。**
3. **真证据是测试覆盖**：`grep -rln "escalat" test/` = 26 文件 10,503 行，其中以升级链为主题 6 个，共 **58 条**。

**抽样：几钉实现、几钉行为**

| 文件 | 钉实现 | 钉行为 | 关键 file:line |
|---|---|---|---|
| `owner-only-from-ceo.test.ts` | 0 | **11** | `:67` 只查 `allowed`+`reason` 文案；`:87` 断言 `nextLevelUp(org,"leader:alpha")`→`cto`→`ceo`→`owner`；`:254` 走真入口 `escalateUp()` 后断言有 `level==="ceo"`、无 `level==="owner"` |
| `unit/escalation-seq.test.ts` | **3** | 0 | `:23-24` `expect(seq).toBeGreaterThan(Date.now())`；`:36` `keys.size===50` —— 纯编号生成器，整文件可删 |
| `unit/pending-dispose.test.ts` | 6–8 | **10+** | `:132 test("old data：没有 decisionOwner 时回退到 level")`（兼容回退，很值钱）；`:304` 断言 `AuditDoc` 写 `type=dispose`；`:404 同一 key 在多层各有一条时` —— **钉的正是我要消灭的形态** |
| `e2e/escalation.test.ts` | 0 | **9** | `:199 test("等待期间任务处于休眠，不占用执行")` 断言 `task.state.kind==="sleeping"` —— **`pollDelay` 的机读版**；`:235` 老板长时间不回应待决问题保持 |
| `e2e/disposition.test.ts` | 0 | **5（产品承诺）** | `:80` 断言 `defaultDisposition==="shelve"`、`resumeAfterMs===DEFAULT_RESUME_AFTER_MS`、正文含「① 暂搁（推荐）② 永久放弃」「恢复条件」 |

**58 条里约 47 条钉行为（可迁移），只有一类是真实现钉：编号生成器 3 条 + 「多行同 key」形态 6–8 条。**

**执行顺序（离不变量最远 → 最近）**

| 步 | 删什么 | 行数 | 验证 | 回滚 |
|---|---|---|---|---|
| **0** | **不删，只加断言**：把 `canReachOwner`（`routing.ts:221`）从死函数接成唯一闸门 | +20 | `owner-only-from-ceo.test.ts` 13 条 | 无 |
| 1 | `decision-delivery.ts` 全删（纯投递，离 ADR-033 最远） | -142 | `decision-loop.test.ts` + `channels-deliver.test.ts` | 极低 |
| 2 | disposition 两个到期执行点合一，**先删读侧兜底** `escalation.ts:685` 的 try/catch | -250 | `disposition.test.ts`(5) + `unit/disposition.test.ts`；断言 `settleDueDispositions` 只剩 1 调用者 | 低 |
| 3 | `takeOverPendingAtCeo` 改薄包装**不删功能** | -76 | `escalation-ceo-gate.test.ts:239` 4 条（接管/幂等/非 CEO 拒绝） | 低 |
| 4 | 四回答入口合 1 | -200 | `pending-dispose.test.ts:109-145`（权限口径）+ `owner-gate.test.ts:204`（老板只收自己那级） | 中 |
| 5 | **三 phase 克隆→循环**（`createEscalationTask:266-490`）。**红线：`pollDelay`（`:256`）一个字不许改** | -135 | `escalation.test.ts:199` + **新增计时断言：200ms 窗口内必须有反应** | **高** |
| 6 | `waitEscalation` 移出 `src/` | -60 | `escalation.test.ts` 改用投递回执等待 | 低 |

**每步一个 PR，每步全绿 58 条。第 5 步前置：第 0 步的断言已在跑。**

**ADR-033 删完怎么还在（三层）**

| 层 | 保证 | 可执行验证 |
|---|---|---|
| 结构 | 不变量 = `nextLevelUp(org,"ceo")==="owner"` ∧ `∀x≠ceo: nextLevelUp(org,x)≠"owner"`。第 0 步让它从注释变执行体（phase 机里 `if (!canReachOwner({callerLevel, startAtOwner}).allowed) throw`） | `grep -rn "canReachOwner" src/` **必须不再是 2 行** |
| 测试 | 11 条原样保留（改实现不红、改语义必红）+ 新增「非 CEO 的 `escalate:true` 必须停在 ceo」 | `npx vitest run test/e2e/owner-only-from-ceo.test.ts` |
| 数据 | `migrate()` 里硬断言 `items.filter(i => i.level==="owner" && i.fromLevel!=="ceo").length === 0`，不满足抛错、退出码 1（照抄 `--check`） | `node scripts/migrate-*.ts --check` |

**为什么不能靠保留那个函数**：它今天**零运行时调用**（`src/` 里只有 `routing.ts:221` 定义 + `escalation.ts:422` 一句注释）。真闸是 `escalation.ts:350-362`（`up==="owner"`）与 `:415-432`（`if (outcome.escalate)`）。保住它 = 保住测试专用函数，不是保住不变量。

## Q5 回答

**「我原来太保守」两条**

| 谁 | 哪条 | 我改什么 |
|---|---|---|
| D 席 | 老板发一句话 5 分钟界面 100% 无反馈；`writeAck`（`src/server/http.ts:1212`）进会话流不进频道 | P1 `Message` 加 `ack?: {at, by, status}`。我原来以为「负责人看不到消息」是唯一问题 |
| B 席 | `app.memory` 0 文档、`memory_write` 0 次、`memoryBriefFor`（`company/memory.ts:288`）**全仓 0 调用者** | 「`deliver()` 已拼 digest 所以够」是偷懒。digest≠memory：一个是频道未读，一个是跨会话知识。三原语缺第四个 `Note` |

**认为有人明显错了（事实错，不是风险大）**

| # | 谁 | 错在哪 | 证据 |
|---|---|---|---|
| 1 | D 席 | 由「`GET /api/pending` 零消费者」推出「待办在界面不可见」 | **前半对后半错**。待办走频道视图内嵌 `pending[]`：`channels-view.ts:205` `viewer===OWNER_ID ? await ownerPendingForChannel(...) : []`、`:229` 放进视图，`ui/js/pending.js:233` 消费 `/api/pending/take-over`。**所以「删 takeOver 没人受影响」也不成立** |
| 2 | A 席 | 「`STAFF_ROLE_TEMPLATES`（`prompts.ts:19`）唯一消费方是 `profile.ts:126`（档案页展示）」 | **错**。它由 `staffCharterOf`（`prompts.ts:34`）消费，后者被 `staffInstructionsFor`（`:54`）调用，装配**员工真实提示词**（`org.ts:2333` re-export）。删它改的是员工行为——**他的 -15 是「改功能」不是「删重复」** |
| 3 | B 席 | 无事实错。他自己先认 `stats.reverted` 永远 0，也自己写下了折叠 bug（`domain/memory.ts:125` `compactMemory` 会把 `distill` 再折） | — |
| 4 | 我自己 | `delegation+guard+wait 740→0`、`8,123` 分母、`wakeOnAll 主要伤负责人` | 见开头三条 |

## 我给老板的一句话建议

**先做 -1,527 的纯去重（delegation、四回答入口、到期扫描合一）；disposition 与圆桌是产品承诺，得你点头才动。**
