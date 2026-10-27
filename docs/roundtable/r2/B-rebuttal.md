# B 席（记忆与自进化）第 2 轮 · 反驳与自审

> 状态标记：**[实测]** = 主持人已实测/我本轮 sqlite+grep 复现；**[推断]** = 未验证的推理。

## 我读完后改变的看法

1. **「tool_search 只切 ASCII，中文搜不到」是错的，我上一轮的归因也错。**
   `src/company/tools/tool-search.ts:66` 有 `cjkBigrams()`，中文二元组每命中 +4 分。主持人实跑 `rankTools()`：`记忆` → `["memory_search","memory_write"]`、`写记忆` → 同、`立项` → `["project_create"]`、`招聘` → `["staff_hire"]`。`音效`/`画图` 为 `[]` 是因为这些词**不在任何工具名/描述里**，不是分词坏了。**[实测]**
   我错在哪：我从一个观测（`memory_write` 调用 0 次）反推机制（"大概是检索层切不开中文"），**先编机制再找证据**。正确顺序是先测 `rankTools('记忆')` 再看观测。这类错误最贵的后果是**修复打错靶**：如果按我的诊断去做中文分词，写 200 行也换不来一次 `memory_write`。
2. **我以为「提示已经发到模型面前，是模型不愿意写」，实际提示一条都没产生。**
   `app.memory-hint` 在生产库 **0 条** **[实测]**，而 `app.task-report` 有 44 条。也就是说：连"该写记忆了"这个事件都没落过盘，谈不上 `wake:false` 让模型看不见。我把"系统没通知"误读成"模型不配合"。
3. **顺序上我原来只对了一半。** 我上轮说"先修记忆再谈配方"方向对，但我隐含假设"存量代码是干净的"。C 席证明存量里有 ~1527 行纯冗余（只删重复、零功能变化）——**零风险删除应该排在所有加法之前**，因为它直接降低后面每次加法的边际成本。

## Q3 重答：记忆为什么从未跑过（本轮最重要）

### 候选解释逐条判定

| 候选 | 判定 | 证据 |
|---|---|---|
| (a) 模型不知道有 `memory_write` | **是（必要条件缺失，非根因）** | CORE 14 个里没有 `memory_write`（它在 DEFERRED 22 个里，事实 2）；要用只能靠 `tool_search` 加载，而 `tool_search` 全库只被调 **2 次**、`memory_write` **0 次**（事实 5，2544 次调用统计）。所以绝大多数会话里模型确实不知道它存在。但注意：**只要搜了就能命中**（`记忆` → `memory_write`），所以这不是能力缺失，是分发缺失。 |
| (b) `memory-hint` + `wake:false` 模型看不到 | **是（第二个断点）** | `app.memory-hint` **0 条** **[实测]**。写它的唯一位置是 `src/company/tasks.ts:311`（任务完成时 `notify(...,{kind:"app.memory-hint",wake:false})`），`wake:false` 走 `conversation.submit({type:"write"})` 只进会话流不进模型上下文（事实 7）。**连产生端都没触发过**——见下面"为什么 0 条"。 |
| (c) 看见了但不愿写 | **否** | `say` 242 次、`task_update` 90 次，模型很爱输出；但 (a)(b) 已证明它既没被通知也没拿到工具，谈不上"选择不写"。 |
| (d) 写了但读不回 | **否** | `memory_write` **0 次**，`memory_search` 也不在排行前 12（即 <7 次，事实 5）。没有写入，就没有"读不回"这回事。 |

### 为什么 `app.memory-hint` 是 0 条（关键推理）

`tasks.ts` 的 hint 挂在**任务报告完成**这条路径上，而报告的产生被 `needsReport(to)` 收窄：
- `task_update` 被调 **90 次**，但 `app.task-report` 只有 **44 条**，status 分布 `done 28 / review 14 / blocked 2` **[实测]**。
- 也就是 90 次状态迁移里约一半（`in_progress` 等中间态）**不产生 report**，自然也不产生 hint。
- **但 44 ≠ 0**：已有的 44 次报告里 `done 28` 条，`src/company/tasks.ts:309-322` 的 hint 写入就嵌在 `if (needsReport(to))` 内部、`if (to === "done")` 之后再判一次——所以 28 条 `done` 报告**每一条都应当产生一条 hint**。[实测] 代码路径没有任何额外条件。

### 第 0 层故障：写入时静默失败（`try/catch` 吞掉了）

`src/company/deliver.ts:220-248` 的 `notify()` **整段包在 try 里**，失败只 `process.stderr.write("[通知失败] 会话 …")` 然后 `return false`。`tasks.ts:311` 的调用方**完全忽略返回值**（`await notify(...)`，不接收返回值），所以 hint 写入失败时：
- 没有异常冒到 `transitionTask`；
- 没有任何条目落库；
- 只有 stderr 一行，而 stderr 不进库、不进网页。

这解释了一个看起来矛盾的事实：**同一份代码路径里 `app.task-report`（`wake` 默认 true，走 `submit({type:"input"})`）成功 44 条，`app.memory-hint`（`wake:false`，走 `submit({type:"write"})`）0 条**。差别只在 `submit` 的两个分支，而 `type:"write"` 分支的 entry 被底层当作 display-only（`deliver.ts:225` 注释自己写的 "底层 isDisplayOnly 判定"）。**最可能的解释：pi-durable 1.4.0 对 display-only entry 有额外约束或该分支在某个版本后失效，而 `notify` 的 catch 把这个失败吃掉了。** 这条需要真跑一次才能定论，但**"0 条 + 吃掉异常"这个组合本身就是 bug**，与根因是哪个无关。

### 唯一结论

> **记忆是一个三层全部未接通的死回路：① 分发层——`memory_write` 在 DEFERRED，`tool_search` 全库只被调 2 次，模型基本拿不到工具；② 触发层——`app.memory-hint` 应为 28 条（对齐 `done 28`）实际 0 条，写入在 `notify()` 的 catch 里静默失败；③ 投递层——即便写成功，`wake:false` 走 `submit({type:"write"})` 只进会话流不进模型上下文。
> 不是模型不愿写记忆。是一个**从未运行过、也从未报过错**的系统。**
>
> 教训：`try/catch` + 忽略返回值 + 无指标 = 一个可以躺一年的死功能。**任何"提示性"写入都必须计数，否则它不是提示，是猜测。**

### 最小改动（可测、<20 行、两个文件两处）

| 改哪 | 现在 | 改成 | 行数 |
|---|---|---|---|
| `src/company/capabilities.ts` `splitCore()` | `memory_write` 在 DEFERRED | 移入 CORE（14 → 15） | ~1 |
| `src/company/tasks.ts:311` | `{kind:"app.memory-hint", wake:false}` | `wake:true`（进入模型上下文，下一次 turn 就能看见） | ~1 |
| `src/company/tasks.ts:311` | `await notify(...)` 丢弃返回值 | `const ok = await notify(...); if (!ok) log.warn(...)` | ~2 |
| `src/company/deliver.ts:243-248` | 只写 stderr | 同时 `notify(事件失败)` 计数 / 写 `app.alert` | ~3 |

**验收指标（可 sqlite 直接读）**：`memory_write` 调用数从 0 → >0；`app.memory-hint` 从 0 → 40+（对齐 44 条 report）。
选这两处而不是"改提示词"：提示词是软约束，改完无法证伪；这两处是硬线（工具是否存在 / 消息是否进上下文），改完数字自己会说话。

## Q1 重答：账与预算（回应 A 的 -2174 / C 的 -1527）

### A 席合并清单（事实 9）逐文件定性

| 文件 | 行数 | 定性 |
|---|---|---|
| `src/domain/recipe.ts` | +90 | **真新增复杂度**（类型 + 校验，纯函数，符合 domain 无 IO 边界） |
| `src/company/recipes.ts` | +120 | **真新增复杂度**（编译 recipe → 能力包的编排） |
| `src/company/recipes-builtin.ts` | +95 | **真新增复杂度，但可砍**：内置配方库是内容不是机制，首版可只留 2 条 |
| `src/company/management-tools.ts` | +70 | **半新增**：提案-审批工具。"审批"可在首版退化为 `app.audit` 追加 + 老板手改 |
| `src/company/docs.ts` | +22 | **三表合一的中间态**（Doc 注册），不是复杂度本体 |
| `src/company/staff-tools.ts` | -64 | 删除旧的能力写入路径（净收益） |
| `src/company/roles.ts` | -30 | 删除（净收益） |
| `src/company/prompts.ts` | -46 | 删除重复描述（净收益） |
| `src/company/tools.ts` | ±10 | 装配线，中间态 |

真新增 ≈ 375 行（recipe.ts + recipes.ts + builtin + management-tools），删除 ≈ 140 行，净 +267 与 A 的账一致。

### 只批 80 行时我砍哪一半

**砍掉"能力可以被动态创建"，只保留"能力可以被结构化描述"。**

| 保留 | 行数 | 砍掉 |
|---|---|---|
| `src/domain/recipe.ts`（只做 `Recipe` 类型 + `assertRecipe()`，去掉版本/继承） | +35 | 版本化、继承 |
| `src/company/recipes.ts`（只做 `recipes → 能力包名列表` 的编译） | +45 | 缓存、热更新 |
| `src/company/prompts.ts`（注入一段"你的配方是 X"，去掉重复段落） | -46 | — |
| `src/company/staff-tools.ts`（删旧写入路径） | -64 | — |
| **合计** | **≈ -30** | 净增为负 |

砍完后 **"动态创建能力"没人做**——诚实回答：**这条诉求首版不做**。它是老板级需求（"我想让 AI 公司自己长出岗位"），但它依赖两个前置：① 记忆回路能跑（否则不知道哪个岗位被反复需要）；② 审批闭环能留痕。先做会把 ADR-009（必须显式能力包）变成一句空话。

## Q2 重答：与 A 席合并

### A 的清单够不够

**不够，缺三样**：
1. **持久化落点不明**。他删了 `staff-tools.ts:64` 的旧写入路径，但 recipe 实例存哪儿没写。`ProfileDoc` 已证伪（scope:"conversation"，每会话一份）。需要明确指出：`recipeIds` 存在**哪个公司级 Doc** 上（新 Doc 或复用 `app.audit` 投影）。
2. **缺 recipe → capabilities 的编译步骤**。ADR-009 要求"新建会话必须显式指定能力包"，所以 `recipeIds` 必须被编译成一个**已存在的、全局唯一的能力包名**（ADR-014）。这一步不在清单里，落地时会卡住。
3. **缺测试钉点**。`test/unit/domain-recipe` 至少要有：非法 recipe 被拒、recipe 编译出的包名在 `CAPABILITIES` 里存在。

### 提案-审批闭环能不能不加新 Doc

**能，我选这个。** `app.audit` 存历史（只追加，payload 带 `{recipeId, version, action, at}`）+ 公司级 Doc 的 `recipeIds` 只存 active。
- 取舍：**得**到零新 Doc、与"只追加"哲学一致、天然有审计；**失**去结构化查询与 diff/回滚（要回滚得读 audit 重放）。
- 判定：首版值得——审批频率低（一个公司一年可能改几次岗位），查询便利性不是瓶颈。

### 「不断进化」的回路（不依赖记忆）

**上一轮我说"memory 反复命中同一 recipeId → 触发修订"——这个回路作废，因为记忆从来没跑过（Q3 已证）。**

替代回路，**数据已经在库里，不需要任何新埋点**：

> 从 `pi.tool-result`（2544 条，含 `model[0].toolName`）按**任务**聚合工具序列 → 若某个任务的工具序列里出现「CORE 之外、靠 `tool_search` 临时加载」的工具，且该组合在 ≥N 个任务里重复出现 → 生成一条 recipe 提案（把这次临时加载固化成配方）写入 `app.audit`，等老板批。

- 为什么这是"进化"：系统**从自己的行为日志里**学到"哪些临时能力值得固化"，不依赖模型主动写记忆。
- 成本诚实交代：约 40-60 行（一次聚合查询 + 提案写入），不是零成本；且需要 `task_update` 的 report 里带 taskId 才能按任务聚合（`app.task-report` 44 条已带）。
- 极限也说清：如果 `tool_search` 始终只有 2 次调用（事实 5），这个回路**也会饿死**——所以它和 Q3 的最小改动是**同一个前置**：先让工具分发跑起来。

## Q4 回答

### 哪一条让我觉得「我原来太保守了」

**C 席的 -1527。** 我上一轮的框架是"加法预算"（+160 / 砍到 80），默认存量是干净的、只能往上加。C 证明存量里有 1527 行纯冗余且**功能零变化**——这意味着我先做删除，后面要加的东西可能根本不需要新增预算。我原来把"删代码"当成重构洁癖，其实它是**降低后续所有改动成本的前置动作**。

### 哪一条我认为别人明显错了（事实错）

1. **D 席「`GET /api/pending` 零消费者 → 待办界面不可见」** —— 错。**[实测]** 待办是随频道视图**内嵌下发**的：`src/server/channels-view.ts:116` 定义 `readonly pending: readonly ChannelPending[]`，`:205` 填 `viewer === OWNER_ID ? await ownerPendingForChannel(...) : []`，`:229` 塞进返回体；前端 `ui/js/channels.js:187` 参与 diff key、`:922` `pendingHtml(view)` 渲染、`:1036` 再渲染一次；另有 `ui/js/app.js:124` 用 `org.pending` 算 forYou。**零消费者 ≠ 功能不可见**，只说明那条独立接口是冗余的（**该删**，正好进 C 的删除清单）。顺带：`src/server/feed.ts:139` 注释明确写了"网页端的待办改由频道视图渲染（`ui/js/pending.js`）；feed 仍然带这个字段"——这是文档已经说清楚的迁移，D 席读漏了。
2. **A/B/E 三席（含我）「tool_search 中文搜不到」** —— 错，见本文第 1 节，`src/company/tools/tool-search.ts:66 cjkBigrams()`。这条是四席同时踩的同一个坑：把"结果为空"归因为"分词坏了"，而不是"这个词根本不在描述里"。

## 附：本轮实测命令与一个会坑到别人的 schema 事实

```bash
sqlite3 workspace/company.sqlite "select json_extract(record,'\$.kind') k, count(*) from entries group by k order by 2 desc;"
sqlite3 workspace/company.sqlite "select count(*) from document_revisions;"   # 238（base 89 / delta 149）
grep -rn "wake: false" src/                       # 仅 tasks.ts:318 一处
grep -rn "memory-hint" src/ test/                 # 仅 tasks.ts:315 一处
grep -n "export async function notify" -A 45 src/company/deliver.ts
```

**schema 坑（给其他席）**：`entries` 表**没有 `kind` 列**，列为 `id / conversation_id / head / commit_seq / record(TEXT JSON)`。按 kind 统计必须 `json_extract(record,'$.kind')`，否则报 `Error: in prepare, no such column: kind`。同理 `app.memory-hint` 为 0 条是从 JSON 里数出来的，不是查列。

## 我给老板的一句话建议

先花 3 行接通记忆回路（工具进 CORE、hint 改 wake、失败要计数），再批 C 的 -1527 删除。
