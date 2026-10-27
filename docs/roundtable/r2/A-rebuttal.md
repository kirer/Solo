# A 席 · 第 2 轮交叉辩论（架构精简派）

> 本席 R1 原文：`docs/roundtable/r1/A-arch.md`。以下所有行号为本轮实测，命令见各表注。

## 我读完后改变的看法

三条，都是被别人的**事实**打掉的，不是被论据说服的。

1. **C 席的「投递成功 ≠ 已读」让我承认：我的分界尺对「该不该先做」无效。**
   我在 R1 把 watchdog 归进 Tier 2 并标注「不推荐」（watchdog retry -200）。理由是它不删代码、只加代码。
   但 C 席证明它是**正确性 bug**：`deliver()` 只记 delivered（`src/company/deliver.ts:118`），`watchdog.drainOne()`（`src/company/watchdog.ts:709`）只扫 `type==="input" && status==="queued"`（`:684-685`），settled 的 unanswered 永不重扫 → 生产库 unanswered 69 条。
   我的错在于**把「有没有第二个实现点」同时当成了合流判据和优先级判据**。前者成立，后者不成立。下文 Q3 我改用第三个判据。

2. **B 席的 recipe 让我承认：我的 `Capability = {name, tools[], charter}` 存 `ProfileDoc` 位置错了，且只满足「可配置」不满足「不断进化」。** 详见 Q2。这是本轮我最该认的一条。

3. **D 席的「老板发一句话 5 分钟无反馈」让我承认：我的 Tier 表里完全没有「老板体验」这一栏。** 我 400 行里出现 0 次 `writeAck`（`src/server/http.ts:1212`）。一个只在 `src/company/` 里找重复实现的人，看不见「只有一处实现但实现的时机错了」。

**没有改变的：** 我的分界尺与 Tier 0+1 的项清单。复核后仍成立（下 Q1 表逐项对账）。唯一数字修正：delegation 是 533+165=**698**，不是 668，所以 Tier 0+1 = **-2174**（原报 -2144 是我 R1 的加法手误）。

---

## Q1 回答（对 C 席）

### 1.1 先纠他的账：8123 不闭合

C 席表格逐项相加（我跑 `node -e` 核过）：

| escalation | disposition | decision-delivery | delegation+guard+wait | trail | roundtable | watchdog | tasks | deliver | routing |
|---|---|---|---|---|---|---|---|---|---|
| 1300 | 857 | 142 | 740 | 314 | 1128 | 790 | 868 | 254 | 241 |

**pre 合计 = 6634**，不是 8123。缺口 1489 他必须点名（我猜是 3 个辅助模块 + 类型声明行，但那是他的账，不是我的推测），否则「-81%」是拿两个不同分母算出来的。
post 列合计 1390，加「新增投递回执 +120」= 1510，与他写的「~1500」一致。**所以错的只有分母。**

### 1.2 一处事实错：`wait.ts` 不是 delegation 专属

他写 `delegation+guard+wait 740→0`。但 `src/company/wait.ts`（42 行，`wc -l` 实测）的消费者是：

- `src/server/http.ts:31,969,1088` —— 两处都是 `waitOrTimeout(conversation.abort(BACKGROUND_CONTEXT), INTERRUPT_TIMEOUT_MS)`
- `src/company/roundtable.ts:58,505,513,670,684`

删掉 delegation 后 wait.ts 仍活着。**可删量是 698（533+165），不是 740。**

顺带自我纠错：我在 R1 报的 `-668` 是加法错，`533+165=698`。本表「原报」列保留 -668 以便对账，但下面所有合计用 698。

### 1.3 他的塌缩包含我的哪些项 —— 「谁做谁白做」表

| 我的项 | 原报 | C 席做完后 | 判定 |
|---|---|---|---|
| Tier 0 · delegation 533 + guard 165 | -668 | 已含（他的 -740 里） | **全白做** |
| Tier 0 · trail 2 导出（trailForConversation / trailForRef / organizationGraph） | 含在 -180 | 已含（trail 314→40） | **白做** |
| Tier 0 · decision-routing -7 | -7 | 已含（routing 241→80） | **白做**（本来就只有 7 行 re-export，`src/company/decision-routing.ts` 全文 7 行） |
| Tier 0 · membership 4 导出（canView/canMention/mentionable/visibleChannels） | 约 -80 | **不含**：他的 P1/P2/P3 里没有「频道可见性判定」这一原语 | **仍独立** |
| Tier 0 · tool-search -219 | -219 | **不含** | **仍独立**，但被他的 P2 挤压（见 1.4） |
| Tier 1 · 能力单层化 -370 | -370 | **不含** | **仍独立**，且是他 P1/P2 的前置 |
| Tier 1 · 升级链去重 -450 | -450 | 已含（escalation 1300→220 + disposition 857→60） | **白做** |
| Tier 1 · disposition 到期扫描合一 -250 | -250 | 已含 | **白做** |

**净账：C 席做完，我 Tier 0+1 的 -2174 里 -1505 变成重复劳动（698+7+450+250+trail 约 100），只剩 -669（membership 80 + tool-search 219 + 能力单层化 370）。**
反过来，我的 -2174 覆盖他的 **0 项**。

### 1.4 但有一条我不同意他：tool-search 与他的原语互斥

他的 P1 是 `Message{to[]}`，前提是「谁能收」可静态枚举。而 `src/company/tools/tool-search.ts` 存在的理由是「能力目录 37 项一次装不完」（`src/company/capabilities.ts` 全文 163 行）。**他把能力列表塌成 `tools[]` 数组之后，tool-search 失去存在理由；他不塌，tool-search 删不掉。** 我的 -219 依赖他的原语化，不是白做，而是**必须排在他之后**。

### 1.5 二选一：选 C 席。判断依据（不是偏好）

| 依据 | 先做 C（-6634） | 先做 A（-2174） |
|---|---|---|
| 集合覆盖 | C 覆盖 A 的 8 项中的 5 项 | A 覆盖 C 的 0 项 |
| 做完 C 后 A 的剩余工作量 | -669（从 -2174 缩到 -669） | — |
| 做完 A 后 C 的剩余工作量 | — | 仍是完整 -6634→-1510（A 的 -1505 是重复劳动） |
| 验收方式 | 生产数据可证（unanswered 69、唤醒 673/389） | 只有行数变化，生产零变化 |
| **唯一合法反转条件** | **若老板说「这个月不许动生产库」** | A 的 Tier 0 零迁移；C 要迁 pending 1 / tasks 20 / channels 389 |

前四行是集合论与可验收性，不掺偏好。**第五行是我能给 C 席的唯一反方依据 —— 而这只在「生产库冻结」这一条约束下成立。**

---

## Q2 回答（对 B 席）

### 2.1 判定：合并成立。但**必须新 Doc**，我的 `ProfileDoc` 位置是错的

我的原方案把 `Capability` 存 `ProfileDoc`。`ProfileDoc` 的 `scope` 是 `"conversation"`（`src/company/docs.ts:93`）——**每个会话一份**。

老板要的是「这套能力」在进化，不是「这个会话的字段」在变。存 conversation 级的后果：

| 场景 | 存 ProfileDoc | 存 session 级 RecipeDoc |
|---|---|---|
| 同一套「音效调试」给 3 个员工 | 3 份副本，改一次改 3 处 | 1 份，改一次生效 3 个 |
| 「公司现在有哪些能力」 | 无法回答（要遍历所有会话） | 一条快照 |
| 能力提案 → 审批 → 生效 | 无处记录审批链 | 文档自带 origin/approvedBy |
| 员工 fork 出分支 | 自动继承（这点好，见下） | 需要显式拷 recipeIds |

**所以拆成两层：能力定义（recipe）走 session 级新 Doc；「这个员工装了哪几个」走 `ProfileDoc.recipeIds`。** 后者的 fork 继承（`src/company/docs.ts:95-96` `fork: "asOf"`）正好是对的语义——分支保留能力。

### 2.2 我的 `{name, tools[], charter}` 与 B 的 recipe 不冲突

它们是同一个对象的两个切面：我的三字段是 recipe 的**最终形态**（运行时长什么样），B 的 `whenToUse/keywords/brief/status/origin` 是 recipe 的**生命周期**（怎么来的、怎么被挑中）。合并 = 一个对象同时有这两组字段。

### 2.3 文件级清单与行数账（我的版本 = B 的 3 个新文件，但把 `domain/capabilities.ts` 并进 `domain/recipe.ts`）

| 文件 | 动作 | 行数 |
|---|---|---|
| `src/domain/recipe.ts` | 新增：`Recipe` 类型 + `validateRecipe`（`tools ⊆ CAPABILITIES` 名集） | +90 |
| `src/company/recipes-builtin.ts` | 新增：5 个内置 recipe（产品/设计/开发/测试/运营 5 键，见 `src/company/staff-tools.ts:20-27`），吞掉 `STAFF_TOOLSETS`；管理层的 `capabilityNames` 仍留 `roles.ts`（理由见本表末「我要认的第二个错」） | +95 |
| `src/company/recipes.ts` | 新增：Doc 读写 + propose/review/activate + 重装配 | +120 |
| `src/company/docs.ts` | 改：新增 `RecipeDoc`（`scope:"session"`）+ `ProfileState` 加 `recipeIds?: readonly string[]`（`:78-88`） | +22 |
| `src/company/staff-tools.ts` | **删**（64 行）→ `toolsForRole` 改读 recipe | -64 |
| `src/company/roles.ts` | 只删 `STAFF_ROLE_TEMPLATES` 对应文案与重复的 charter 拼接，`capabilityNames`（`:53,100,138,175,216,253,289`）**保留**（层级边界要编译期可审，这是 B 席的判断，我接受） | -30 |
| `src/company/prompts.ts` | `STAFF_ROLE_TEMPLATES`（`:19`）→ `recipe.brief`；`staffCharterOf`（`:34`）保留 | -46 |
| `src/company/tools.ts` | `createEmployeeExtension`（`:383`）按 `recipe.tools` 过滤 | ±10 |
| `src/company/management-tools.ts` | 新增 `capability_propose` / `capability_review`（参照 `deps.` 注入风格，`:91/:101/:110` 那三处死接线**不要**复活） | +70 |
| **合计** | | **新增 407 / 删除 140 / 净增约 267** |

**我要认的第二个错：我在 R1 说「净减 500–600 行」是错的，差了一个数量级方向。** 我算的是「删表」的收益，没算「把知识搬进 `recipe.brief` 并补审批环」的成本。真实是**净增 267 行**。B 席的净增 160 比我诚实（差异来自我多算 2 个工具与 `RecipeDoc`）。

### 2.4 「不断进化」判定 —— 这是我认的第三条

| 老板要的 | 我的原方案 | 合并方案 |
|---|---|---|
| 可配置（人能改） | ✅ | ✅ |
| 动态创建（agent 自己提） | ❌ | ✅ propose→review |
| 不断进化（经验回流成新能力） | ❌ | ⚠️ **只有骨架，没有回路** |
| 审计留痕 | ❌ | ✅ 若进 `app.audit` |

**诚实结论：合并方案满足「动态创建」，只部分满足「不断进化」。**
缺的那一环，B 席自己已经指出来了：`stats.reverted` 没人填永远是 0（B 自曝③）。我同意删掉 stats，但**删掉 stats 之后「进化」就没有度量了**。

我认为唯一成立的回路是：`memory_write` 带上来源 `recipeId` → `distill` 层若反复命中同一 recipeId → 触发一次 `capability_propose` 修订。**但这要求 memory 先能跑。** 而 B 席实测：`app.memory` 0 文档、`memory_write` 0 次、折叠器 `src/domain/memory.ts:125` 会把 distill 再折（200 次写入 → 48 条、最深折叠代数 153）。

**所以顺序是：先做 B 的三条记忆修复（净增 ~80 行、零新文件），再做 recipe。反了就是给一个从不运行的记忆系统配配方。**

---

## Q3 回答（自我攻击）

### 选哪件：**删 delegation。**

### 用哪个标准：两个都不用了，换第三个

我在 R1 §5 说过「按对老板诉求的回应强度排，第 2 件（能力单层化）该第一」。**本轮我作废这个标准。**
理由：**「对老板诉求的回应强度」不可证伪**——没有任何命令能证明「这件事比那件更回应老板」。一个月只做一件时，选一个无法验收的标准等于选一个无法交付的标准。

我改用第三个：**「做完之后，系统行为是否可以被一条命令证明不变 / 证明变对了」**。

| 三件 | 生产行为变化 | 可证伪的命令 | 风险 |
|---|---|---|---|
| 删 delegation | **零**（`grep -rn "deps.delegate" src/` 零命中，`org.ts:242/386/494` 三处死接线） | `grep -rn "delegation" src/` 归零 | 无 |
| 能力单层化 | **变**（前端 `["read"]` → `["read","write","edit"]`） | 探针调 `toolNamesForRole` | 中（要回归） |
| 升级链去重 | **变**（且 C 席会做，我做了白做） | 生产 pending 1 条迁移 | 高 |

### 另外两件推迟的代价（明说）

| 推迟项 | 代价 | 可观测性 |
|---|---|---|
| **能力单层化** | 「前端」「backend」「Rust工程师」三类员工**现在就是只读的**——招了也写不了文件（主持人已实测：`前端 → ["read"]`）。根因是 `src/company/staff-tools.ts:39` 的 `STAFF_TOOLSETS[role] ?? DEFAULT_TOOLSET`：**未知角色不报错，静默退化成最保守的一档**。这不是风险，是**已发生的故障**，只是没人报出来。 | 有：一行探针 |
| **升级链去重** | **0。** C 席的 escalation 1300→220 + disposition 857→60 已经把它做完。我做的每一行都是重复劳动。 | 无 |
| **删 delegation 不做（作为对照）** | 698 行死代码继续留在仓库里，其中 `org.ts:242/386/494` 三处接线**看起来是能用的**。代价 = 下一个 agent 会照着它写第四处死接线。慢性，不可观测。 | 无 |

### 一句必须加的：能力单层化的真实修法只有 4 行

删 `src/company/staff-tools.ts:29` 的 `const DEFAULT_TOOLSET`，把 `:39` 的 `STAFF_TOOLSETS[role] ?? DEFAULT_TOOLSET` 改成未知角色**抛错**（招聘时就炸，而不是运行时静默只读）；`staff_hire` 侧捕获错误文案。剩下 -367 行是能力单层化的收益，那部分可以等。**所以「推迟能力单层化」的正确做法不是全推，是把那 4 行单独拎出来这个月做掉。** 这是我对自己 Q3 答案的修正。

---

## Q4 回答（共同问题）

### 4.1 「我原来太保守了」的那一条

**C 席的「投递成功被当成已读」。** 具体、不抽象：

- 我 R1 把 watchdog 放进 Tier 2 并写「不推荐」。判据是「它不加代码只减代码之外的收益」。
- 实际情况：`src/company/deliver.ts:118` 记 delivered 就返回，`src/company/watchdog.ts:709` 的 `drainOne()` 只扫 `type==="input" && status==="queued"`（`:684-685`），settled 的 unanswered 永不重扫。
- 生产证据：unanswered 69 条，其中 conversationId 89 占 50 条（reason=no_model）。
- C 席的修法约 120 行。**我因为「这是加法」把它排到了最后，等于用「代码越少」这条尺子惩罚了唯一修正确性的方案。**

### 4.2 我认为别人明显错了的（事实错，不是风险大）

| # | 谁 | 错在哪 | 证据 |
|---|---|---|---|
| 1 | C 席 | 表头 8123 与逐项合计 6634 差 1489，缺口未点名 | 逐项相加（`node -e`）；post 列 1390+120 与「~1500」自洽，说明只有分母错 |
| 2 | C 席 | `delegation+guard+wait → 0` 把 `wait.ts` 算进 delegation | `src/company/wait.ts` 被 `src/server/http.ts:31,969,1088` 与 `src/company/roundtable.ts:58,505,513,670,684` 使用；可删量 698 不是 740 |
| 3 | D 席（口径，非事实） | 「14775 → 约 11000（-25%）」把「拆分成 7 个文件」也算进「变少」 | `channels.js` 1874 → 拆分后 1590 只是**净 -284**。可核的删除项：starfield 342 + edges 334 + dev-fixtures 210 + mockBoard 95 + markdown 302 + CSS 185 + channels.css 480 + graph.css 855 ≈ 2803，加 -284 加 settings 1239→1050（-189）≈ **-3276**，而他写 -3775。虚高约 500 行 |
| 4 | B 席 | 无事实错。他自己先认了 `stats.reverted` 是假的。 | — |

我**没有**发现 C 席的「投递成功=已读」有错，也没有发现 D 席的「`GET /api/pending` 零消费者」有错——后者我复核过：`ui/js/pending.js` 用的是 `/api/answer`、`/api/pending/dispose`、`/api/pending/take-over`（`:13,:110,:216,:233`），`src/server/http.ts:332` 只有路由定义。

---

## 我给老板的一句话建议

**删 delegation（698 行死代码），再把 `staff-tools.ts:39` 的静默默认改成抛错（4 行）。**

（59 字。C 席的通信塌缩 -6634 排下一轮：它覆盖我 8 项中的 5 项，先做它我的那 5 项就是重复劳动；唯一反转条件是你要求「这个月不许动生产库」。）
