# B 席（记忆与自进化派）· 第 1 轮书面意见

> 议题：记忆系统 / 动态能力 / 进化。
> 立场：这三件事是**同一件事**的三个面——「能力」是当下能做什么，「记忆」是上次学会了什么，
> 「进化」是能力集合被记忆改写的过程。现在这份代码里，**三者互不相连**，记忆是个孤岛，
> 能力是编译期常量，进化只能由人类手工改代码完成。

---

## 0. 五条结论（先说答案）

1. **记忆系统当前是「写好了但从未跑过」的子系统**：生产库里 `app.memory` 文档 0 个、
   `memory_write` 调用 0 次、`app.memory-hint` 条目 0 条，而库里已有 55 条 `task-report`。
   本轮所有关于记忆的讨论，都在讨论一段**零样本代码**。
2. **就算跑起来，折叠机制也会在 200 次写入内把记忆变成「阶段总结的阶段总结的…」**。
   实测：200 条写入后最深折叠代数 153，最新一条 distill 的 300 字正文里
   前 4/5 是嵌套的标题前缀，真实信息密度趋近 0。这不是容量问题，是**折叠器的设计 bug**。
3. **读侧注入点只有 1 个（`deliver()`），写侧上下文是 0 个**。agent 在「决定要不要写记忆」
   的那一刻，看不到自己已有什么记忆、别人记过什么、这条和哪条重复。所以即使写，也是流水账。
4. **「技能性知识」现在没有任何合法的家**。它只能活在三处：会话历史 + compaction 摘要、
   写死的提示词文案、人类手写的 ADR。前两者会丢，第三者只有人类能写。**这就是「不会进化」的根因**。
5. **动态能力的正确形态是「原子工具（代码）+ 配方（数据）」**：配方只能**重新组合**已有的
   原子工具、只能**追加提示词片段**、只能在自己的层级内组合。这样 ADR-004（权限靠工具不存在）
   和 ADR-032（能力目录声明式）都不用改一个字，而「配方」正好就是技能性知识的家 ——
   记忆和进化在这里合流。

---

## 1. 诊断：现有记忆系统撑不住「进化」

### 1.1 三层容量 50/100/200 + 折叠 —— 真实使用中的退化路径

代码：`src/domain/memory.ts:64` `MEMORY_CAPACITY = {staff:50, project:100, company:200}`、
`src/domain/memory.ts:71` `FOLD_BATCH = 20`、`src/domain/memory.ts:74` `MEMORY_BODY_LIMIT = 300`、
折叠实现在 `src/domain/memory.ts:125 compactMemory`。

**折叠出来的总结是谁写的？** 不是模型，是一段字符串拼接（`src/domain/memory.ts:145-152`）：

```ts
title: `阶段总结（${folded.length} 条，截至 ${date}）`,
body: folded.map((item) => `${item.title}：${firstLine(item.body, 60)}`).join("；")
        .slice(0, MEMORY_BODY_LIMIT),
```

注释（`src/domain/memory.ts:22-25`）说这是刻意的：「折叠不用模型，因为它是确定性维护动作」。
这个理由本身成立，但**拼接出来的东西不是总结，是标题清单**——而且会被 300 字硬截断。

**我把它跑了一遍**（staff 层，200 条 300 字记忆顺序写入，脚本逻辑与 `compactMemory` 逐行对齐）：

```
200 次写入后条数: 48  其中 distill: 1
最深折叠代数: 153
最新一条阶段总结正文（前 300 字）：
  阶段总结（20 条，截至 2026-01-07）
  阶段总结（20 条，截至 2026-01-06）：阶段总结（20 条，截至 2026-01-05）：阶段总结（20 条，截至 2026-01-05）：阶段总结（20 条…；
  经验 134：验收跑真浏览器：第134条经验的正文…
```

原因有两层，都是可修的：

- **第一层（必须修）**：`compactMemory` 会把已有的 `distill` 条目再折一次（`src/domain/memory.ts:129`
  遍历全部条目，`src/domain/memory.ts:137` 取最老 20 条）。注释说这是「否则反复折叠会留下一堆总结」，
  但代价是 distill 自己成了迭代函数：`f(n+1) = f(f(n) 的标题)`。`test/unit/domain-memory.test.ts:95`
  这条测试（「反复折叠不会堆出一堆总结」）**钉住的正是这个 bug 的行为**——它保证条数不涨，
  没保证信息不衰减。
- **第二层**：`firstLine(item.body, 60)` 对 distill 条目取到的恰好是它自己的嵌套标题行，
  60 字足够装下一整串「阶段总结（20 条，截至 …）：」。所以第二代 distill 的正文
  **一个字的新信息都没有**。

结论：50 条上限意味着一个忙碌员工的第 51 条记忆会触发折叠，第 200 条时已经在读「总结的总结」。
**三层容量数值本身没问题（50/100/200 是合理的读侧预算），问题在折叠器。**

### 1.2 读侧只有一个注入点 —— 太窄，但更致命的是写侧没有上下文

唯一注入点：`src/company/deliver.ts:104-114`，在 `deliver()` 拼消息时调
`renderMemoryBrief(memoryState, {level: actor.level, owner: actor.owner, query: options.message.text})`。
`src/company/memory.ts:288 memoryBriefFor` 是同一个东西，但**全仓 0 个调用者**（死代码）。
`src/company/code` 里 `CODE.md §4.7` 自己也写了「读侧只有 `deliver()` 一个注入点」。

三个具体问题：

1. **只注入一层**。`renderMemoryBrief` 只接受单个 `{level, owner}`（`src/domain/memory.ts:205`），
   而 `readableLevels`（`src/company/memory.ts:123`）明明允许员工读三层。
   结果：员工被唤醒时看到的是「我的 5 条」，看不到项目层和公司层——**那两层才是组织知识**。
   要让员工看到项目层，得他自己想到去 `memory_search`；而他连「项目层有东西」都不知道。
2. **预算 3+2=5 条**（`src/domain/memory.ts:77-78`）。对一个 50 条记忆的 agent 来说，
   命中率上限 10%。`BRIEF_MATCHED` 的 2 条是用**当前消息原文**做 bigram 查询得来的，
   而消息里高频的是「你好」「帮我」「看一下」这类词（见 1.3）。
3. **写侧上下文为 0**。`memory_write` 的参数只有 `title/body/tags/task`（`src/company/memory.ts:198-206`），
   工具描述里没有一句话告诉模型「你已经有什么」。去重只靠 `taskId`
   （`src/domain/memory.ts:113-120`），同一件事换个角度写两遍不会被拦。
   **这才是「记忆变流水账」的真正机制**：模型在不知道已有内容的情况下写，最优策略就是
   「把刚发生的事复述一遍」——而这恰好是记忆最没用的形态。

  对比一下写入触发的时机：`src/company/tasks.ts:299` 把 `memoryReminderFor(task.id)` 拼进
   任务完成消息，`src/company/tasks.ts:310-323` 再发一条 `wake: false` 的 `app.memory-hint`。
   `wake: false` 意味着**不进模型上下文**（`src/company/deliver.ts:224-230`：只 `submit({type:"write"})`）。
   所以这条提醒的实际效果是：**它被写进会话流，等这个 agent 下次因为别的原因醒来时才会看到**。
   而它醒来时看到的第一件事是别的任务。此刻它脑子里没有任何「上次我记了什么」。

### 1.3 bigram 打分：中文的具体失败例子（实测）

算法：`src/domain/memory.ts:231 bigrams` 把中文按相邻二字切、英文按 `[a-z0-9_]{2,}` 切；
`src/domain/memory.ts:242 scoreOf` 标题 +3 / 标签 +2 / 正文 +1，**纯 `String.includes` 子串匹配**。

我按同样逻辑跑了 6 组查询（记忆条目 = 一句话，标题与正文同一句）：

| 查询 | 记忆正文 | 得分 | 结果 |
|---|---|---|---|
| `音效` | 「坦克大战的**音频**用 WebAudio 合成」 | 0 | 搜不到 |
| `音频` | 「**音效**全部用 OscillatorNode 合成」 | 0 | 搜不到 |
| `炸了` | 「**爆炸**声的包络要短」 | 0 | 搜不到 |
| `恢复条件` | 「暂停项目必须写 resumeWhen」 | 0 | 搜不到（长查询里 3 个 bigram 全不中） |
| `sqlite` | 「先备份 SQLite 再改 schema」 | 4 | 命中（因为 `toLowerCase` + 英文整词） |
| `备份数据库` | 「迁移前先备份 sqlite」 | 4 | 命中（「备份」二字中） |

**模式很清楚：中英混排的代码仓库里，英文标识符命中率远高于中文。** 三个结构性失效：

1. **单字查询恒为 0**：`bigrams("音")` 返回 `[]`（`for index+2<=run.length` 循环一次都不进），
   而 `scoreOf` 在有 gram 时才算分（`src/domain/memory.ts:172 rankMemory` 的 `query !== ""` 分支）。
   传一个单字等于传空查询。`bigrams("音") → []`、`bigrams("坑") → []`。
2. **同义词/近义词完全不覆盖**：「音效/音频/声音/BGM」、「部署/上线/发布」、「报错/异常/崩了」。
   没有向量、没有同义词表、没有 IDF —— 这是纯 `includes`，不是 BM25。
   （对比：`src/company/tools/tool-search.ts` 对工具做的是**两路混合 + ASCII 词干 + 停用词**，
   比记忆这边认真得多。记忆侧连 `stem()` 都没有。）
3. **长自然句查询信噪比极低**：「音效太糙了，能不能换成更好听的音效，最好有爆炸声和背景音乐」
   切出 23 个 bigram，其中「太糙」「能不」「不能」「好有」都是噪音；唯一有效的「音效」
   只在标题含这两个字时才靠 +3 抬起来。

而注入点的 query 恰好是**整条频道消息原文**（`src/company/deliver.ts:109` `options.message.text`），
就是长自然句。**注入侧的查询质量是这套算法最差的使用方式。**

### 1.4 技能性知识现在存在哪？—— 没有家

问：「某个工具的正确用法 / 某个文件在哪 / 某个坑踩过一次」这类知识存在哪？

答：**没有任何一等公民的地方**。实际分布：

| 载体 | 位置 | 会不会丢 |
|---|---|---|
| 会话历史 | `pi.durable` 的 entries | 会被 compaction 摘掉 |
| compaction 摘要 | `node_modules/@earendil-works/pi-durable/dist/harness/agent.js:10-15` `DEFAULT_COMPACTION_POLICY = {reserveTokens:16384, keepRecentTokens:20000, backgroundTokens:32768}` | 摘要保「做了什么」，丢「怎么做、为什么这样做」 |
| 提示词文案 | `src/company/roles.ts:320 COMMON_GUIDE`、`src/company/tools.ts:243-252` 负责人文案 | 不会丢，但**只有人类能写** |
| 任务 evidence | `src/domain/tasks.ts:45 evidence?: string` | 一次性，不可检索（没有 `evidence` 的检索入口） |
| 记忆 | `app.memory` | 家在这里，但见 1.1–1.3 |

**这张表就是「为什么不会进化」的完整答案**：唯一能长期留存技能性知识的两个地方
（提示词文案、ADR）都只能人类写；能由 agent 写的地方（记忆）质量撑不住。
所以现在系统的「进化」= 老板/我们这些人在改代码。**agent 本身一步都没进化过。**

---

## 2. 「动态创建能力」的正确形态：原子工具（代码）+ 配方（数据）

### 2.1 先确认现有拒绝是对的

`src/company/capabilities.ts:18-21`：

> 工具是 TypeScript 函数，注册即任意代码执行。能力目录是静态代码（受 review），装配是动态的。
> 这条边界不能破。

这条我完全同意，且建议**升级成不可动的红线**。但这句话里藏着一个未被利用的事实：
**「装配是动态的」——那么装配的输入也可以是数据。** 现在装配的输入是
`ROLE_DEFINITIONS[role].capabilityNames`（`src/company/roles.ts:23`）和
`STAFF_TOOLSETS[role]`（`src/company/staff-tools.ts:20`）——两张编译期常量表。
把它们换成一张 Doc 里的配方列表，**架构一点没变，但多了一条「agent 能往里面写」的通路**。

关键差别：配方**不引入新代码**，只做两件事——
(1) 从已有原子工具集合里**选一个子集**；(2) 追加一段**提示词文本**。
两件事都不产生新的执行能力，所以不违反 ADR-004/ADR-032。

### 2.2 Schema 草案：`CapabilityRecipe`

```ts
// src/domain/capabilities.ts（新增，纯函数，无 IO）
import type { CapabilityLayer } from "../company/capabilities.ts";

/** 能力配方：把已有的原子工具按场景重新打包，并附带使用知识。 */
export type CapabilityRecipe = {
	/** 全局唯一，小写连字符。会话装配按名字取。 */
	id: string;
	/** 一句话：什么时候该用我。tool_search 与档案页主要看它。 */
	whenToUse: string;
	/** 中文检索词（避免 1.3 那类「音效/音频」搜不到）。 */
	keywords: readonly string[];
	/**
	 * 原子工具名。**必须全部存在于 CAPABILITIES（src/company/capabilities.ts:42）**，
	 * 且必须落在本配方的 layer 已允许的集合内 —— 这是权限的再组合，不是扩张。
	 */
	tools: readonly string[];
	/** 追加到系统提示词的一段（≤ 600 字）。**技能性知识的家**。 */
	brief: string;
	/** 只对匹配该层的 agent 生效。 */
	layer: CapabilityLayer;
	/** 谁写的。 */
	origin: "builtin" | "owner" | "approved";
	status: "proposed" | "active" | "retired";
	createdAt: number;
	proposedBy?: number;   // conversationId
	approvedBy?: number;   // conversationId
	/** 用后反馈：决定了配方能不能「自我进化」——见 §4。 */
	stats: { hits: number; adopted: number; reverted: number };
};
```

`layer` 的权限校验（复用现成的 `src/company/capabilities.ts:133 capabilitiesOfLayer`）：

```ts
// 伪代码：validateRecipe() 的核心断言
const allowed = new Set([
	...capabilitiesOfLayer("universal"),
	...(recipe.layer === "staff" ? capabilitiesOfLayer("exec") : []),
	...capabilitiesOfLayer(recipe.layer),
]);
const illegal = recipe.tools.filter((name) => !allowed.has(name));
if (illegal.length > 0) throw new Error(`配方 ${recipe.id} 越权引用：${illegal.join(", ")}`);
```

这一行是所有争论的答案：**员工提案的配方，最坏情况也只是「把已有的 10 个工具换个组合 + 写一段提示词」**。
他永远不可能组出 `staff_hire`，因为那个工具不在 `universal ∪ exec ∪ staff` 里。

### 2.3 存哪 / 谁能写 / 怎么生效 / 要不要审批

| 问题 | 答案 | 理由 |
|---|---|---|
| 存在哪 | 新 Doc `app.recipes`（`RecipeDoc`，`defineDoc`，session scope） | 与 `app.memory`（`src/company/memory.ts:32`）同构；一次提交原子生效；可被档案页读 |
| 谁能写 `builtin` | 人类，写进 `src/company/recipes-builtin.ts` | 目前 `STAFF_ROLE_TEMPLATES` / `roles.ts` / `STAFF_TOOLSETS` 三张表搬过去 |
| 谁能写 `owner` | 老板（HTTP 接口，不经模型） | 老板改配置不该烧 token |
| 谁能 `propose` | 任何 agent（员工/负责人/管理层/CEO 都行） | 「发现自己缺东西」是每个层的正当需求 |
| 谁能 `approve` | 提案者所属层的**上级**：员工→项目负责人，负责人→管理层，管理层→CEO | 复用现有汇报线，不新增规则（ADR-033 同款「只能逐级」） |
| 怎么生效 | `approve` 的那次 `commit` 里顺手 `conversation.configure({extensions})` 重装配 | 已有同款先例：`src/company/org.ts:1545 syncStaffInstructions`、`src/company/org.ts:1391` 改名重装配 |
| 要不要审批 | `builtin` 不用；`proposed` **必须** | 配方自带 `brief`，是能改变行为的提示词——等于代码 |

注意「怎么生效」这里我**刻意选了 `configure` 重装配**，而不是 `control.addTools`
（`src/company/tools/tool-search.ts:215`）。原因：`addTools` 只加工具、加不了 `brief`；
而配方的一半价值在 `brief`。重装配是幂等的（`extensions` 整体替换，见 `src/company/org.ts:1391`），
代价是得在 `approve` 事务里多读一次 `CompanyDoc` —— 和 `syncStaffInstructions` 一模一样。

### 2.4 「自己发现缺工具 → 申请 → 批准 → 能力长出来」最少几步

**三步，两个新工具。**

```
①  agent 调 capability_propose({ need, tools, brief, keywords })
      → 写一条 status:"proposed" 的 recipe（app.recipes）
      → 同一事务里 deliver() 一条消息给上级（复用 src/company/deliver.ts，不新增通信原语）
②  上级调 capability_review({ id, approve | reject, note? })
      → status 改 "active"（或 "retired"）
③  同上一个事务内：对提案者的会话 conversation.configure({ extensions }) 重装配
      → 下一次请求起，新配方已在（工具 + brief 都到位）
```

第 ③ 步不是「第四步」，它是 `approve` 的**副作用**，写在同一段代码里。
所以是三步、两个工具、零新增通信机制。

为什么不是两步（提案即生效）：`brief` 是提示词，能改变 agent 的行为准则
（「这个项目的验收标准以 PLAN.md 为准，不看 issue」）。无审批的 brief 就是任意的
提示词注入通道。ADR-004 的思路是「权限靠工具不存在」，这里对应的是
**「行为约束靠人审」**——因为 brief 不进工具集合，它是软性的。

为什么不是四步（提案→审批→装配→通知）：装配后不需要通知。会话下一次被唤醒时
`my_capabilities`（`src/company/capabilities.ts:63`）会如实返回新清单，这是现成的自查入口。

---

## 3. `STAFF_ROLE_TEMPLATES` / `STAFF_TOOLSETS` / `roles.ts` 该不该留

**核心判断：agent 的身份 = 提示词 + 能力集 + 记忆。角色枚举只是这个三元组的一个「预设」。**

一旦接受这句，「角色」的正确语义就出来了：**角色 = 一条 `origin:"builtin"` 的预设配方**。
不是身份，是模板；不是类型，是数据。

按下表处置：

| 现状 | 文件:行 | 处置 | 理由 |
|---|---|---|---|
| 5 条员工角色文案 | `src/company/prompts.ts:19-30`（`STAFF_ROLE_TEMPLATES`，模块内 const，未导出） | **搬**进 `recipes-builtin.ts`，成为 5 条 recipe 的 `brief` | 它本来就是「一段提示词 + 一组工具」；搬过去后与配方同构，`role` 参数自然变成「选哪条内置配方」 |
| 角色→{read,write,bash} | `src/company/staff-tools.ts:20-26`（`STAFF_TOOLSETS`） | **压**成配方里的 `tools: ["read","write","edit"]` / `["read"]` | 5 行 boolean 三元组 → 5 个字符串数组，`toolsForRole` 变成通用映射，**ADR-014 的「按角色分配工具」完全保留**，只是分配表从 TS 常量化成数据 |
| `DEFAULT_TOOLSET` | `src/company/staff-tools.ts:29` | **留**（`toolsForRole` 的兜底） | 未知角色必须最保守，这是安全默认值，不该数据化 |
| `staffCharterOf` / `staffInstructionsFor` | `src/company/prompts.ts:34` / `:54` | **留** | 它们拼的是「汇报关系」——`managerLabelOf` 依赖真实会话号，是结构不是文案 |
| 7 个管理层 `charter` 文案 | `src/company/roles.ts:26 ROLE_DEFINITIONS` 里的 `charter` 字段（7 段） | **搬**进 `recipes-builtin.ts` 作为 management 层 recipe 的 `brief` | 同上：是行为描述，不是结构 |
| `capabilityNames` | `src/company/roles.ts:53,100,138,175,216,253,289` | **留** | 这是**层级权限边界**，必须编译期可审。ADR-004 的物理保证就在这里 |
| `COMMON_GUIDE` | `src/company/roles.ts:320` | **留** | 全局行为准则（自查、不越级、不重启服务），不属于任何角色 |
| 汇报线 / `ask_role` 目标 / 升级链 | `src/company/org.ts`、`src/company/escalation.ts` | **留** | 依赖真实 `conversationId`，是结构 |

**净效果**：三张写死的「角色 → 文案/工具」映射表（`prompts.ts` 107 行 + `staff-tools.ts` 64 行
+ `roles.ts` 里约 140 行 charter 文案）合流成一张内置配方表。**行数净减少**，
而「角色」从编译期枚举降级为数据 —— 这才是老板说的「逻辑越简洁越清晰」。

**写死角色表还剩什么价值？** 两个，都不能省：

1. **招聘时的人类可读性**。`staff_hire` 的 `role` 参数（`src/company/management-tools.ts:488`）
   写着「产品 / 设计 / 开发 / 测试 / 运营」。这是给**人类老板**看的菜单，
   不是给模型的约束。变成配方后菜单变成 `recipe.id` 列表，可读性不变，还能加长（加一个「安全审计」）。
2. **未知角色的安全兜底**。`src/company/prompts.ts:40` 的 `?? \`你是${input.role}。…\``
   和 `src/company/staff-tools.ts:39` 的 `?? DEFAULT_TOOLSET`。加了配方这条路之后更要在：
   配方找不到 → 回落最保守（只 read + 一句「遇到不确定的事上报」）。

一句话：**角色表该从「枚举」降级成「预设配方 + 兜底默认值」，不该删。**

---

## 4. 「能让 agent 真的越用越强」的最小设计

「越用越强」必须是一条**闭环**，缺任一环都不成立：

```
   做事 ──→ 撞墙（缺工具 / 缺方法 / 踩了坑）
     ↑                │
     │                ▼
   生效 ←── 审批 ←── 写成配方（brief = 做法 + 坑）  ← 记忆的第 3 个写入形态
     │                ▲
     └──── 用后反馈（采纳/反悔）──→ stats ──→ 自动降级没人用的配方
```

现在这个环**一环都没有**：记忆写不进去（1.1–1.3），写进去也变不成能力（角色是常量），
变了也没有反馈（没有 stats）。

### 4.1 数据结构（两个 Doc，一个纯函数模块）

**新增 `app.recipes`**：`{ recipes: CapabilityRecipe[] }`（§2.2 的 schema）。

**`app.memory` 扩一个字段**（不是新 Doc）：

```ts
// src/domain/memory.ts 的 MemoryEntry 增加两个可选字段
source: "task" | "manual" | "distill" | "recipe";  // 新增：这条记忆变成过配方
/** 这条记忆派生出哪条配方（闭环的回边）。 */
recipeId?: string;
```

这样「记忆 → 配方 → 能力」是一条可查询的边，档案页能画出来。**不需要新 Doc。**

### 4.2 文件与行数估算

| 文件 | 动作 | 行数 |
|---|---|---|
| `src/domain/capabilities.ts` | **新增**：`CapabilityRecipe` 类型 + `validateRecipe` + `recipesFor(agent)` + `mergeRecipes` + `recipeScore`（bigram 复用 `src/domain/memory.ts:231`） | ~130 |
| `src/company/recipes-builtin.ts` | **新增**：5 条员工预设 + 7 条管理层预设（从 `prompts.ts`/`roles.ts` 搬来的文案） | ~110 |
| `src/company/recipes.ts` | **新增**：`RecipeDoc(app.recipes)` + `proposeRecipe` + `reviewRecipe` + `applyRecipes`（装配）+ 两个工具 | ~170 |
| `src/company/prompts.ts` | **缩**：`STAFF_ROLE_TEMPLATES` 搬走，保留 `staffCharterOf`/`staffInstructionsFor` | 107 → ~45 |
| `src/company/staff-tools.ts` | **缩**：`STAFF_TOOLSETS` 搬走，保留 `DEFAULT_TOOLSET` + `toolsForRole` 通用映射 | 64 → ~35 |
| `src/company/roles.ts` | **缩**：7 段 `charter` 搬到 builtin 配方，保留 `capabilityNames` + `COMMON_GUIDE` + 装配 | 362 → ~215 |
| `src/company/tools.ts` | **改**：`deferNonCore`（:30）输入加配方；`createEmployeeExtension`（:380）/`createRoleExtension` 从配方取 `brief` | +25 / −10 |
| `src/domain/memory.ts` | **改 3 处**：折叠器不折 distill（:125）；`renderMemoryBrief` 支持多层（:205）；新增 `source:"recipe"` | +35 |
| `src/company/deliver.ts` | **改**：:104-114 传多层 scopes | +8 |
| `src/company/memory.ts` | **改**：新增 `memory_promote` 工具（员工层 → 项目层，负责人批准） | +45 |

合计：**新增约 410 行，删除约 250 行，净增约 160 行**。换来的是：三条闭环、两张表合一、
记忆从「只写不读」变成「能变成能力」。

（我知道 A 席会说 160 行不是「越少越好」。见 §5。）

### 4.3 三个必须同时修的记忆改动（否则闭环是假的）

1. **折叠器不折 distill**。`src/domain/memory.ts:129` 的 `for (const level of MEMORY_LEVELS)`
   要跳过 `source === "distill"` 的条目，或者给 distill 单独的容量池。
   更简单的做法：distill 条目的 `body` 改成「只留标题列表 + 一个可点的 `foldedIds: string[]`」，
   **不占用 300 字正文**——这样即使被折也不会有嵌套前缀吃掉信息。
   不做这条，§1.1 的 153 代退化会在第一次折叠就发生。
2. **`renderMemoryBrief` 支持多层**：签名从 `{level, owner}` 改成 `{scopes: {level,owner}[]}`，
   员工注入「自己 3 + 项目 2 + 公司 1 = 6 条」。这是 `readableLevels`
   （`src/company/memory.ts:123`）已经允许的事，读侧却只做了 1/3。
3. **`memory_promote`**：把员工层的一条提升到项目层。这是「个人经验 → 组织知识」的**唯一通道**，
   现在是 0。没有它，每个员工各自踩同样的坑，公司永远学不到东西。

### 4.4 和现有 ADR 边界怎么共存

| ADR | 关切 | 本设计如何不破 |
|---|---|---|
| ADR-004（权限靠工具不存在） | 员工不能有管理工具 | `validateRecipe`（§2.2）强制 `tools ⊆ universal ∪ exec ∪ staff`。**配方是再组合，不是扩张。** `capability_review` 只装在 leader/management/ceo 层 |
| ADR-032（能力目录声明式） | 工具是代码，注册即 RCE | 配方不注册任何新工具，只**引用** `CAPABILITIES`（`src/company/capabilities.ts:42`）里已 review 过的名字；`brief` 不是代码，走人审 |
| ADR-009（新建会话必须显式指定能力包） | 不能拿到全部 | `applyRecipes` 只改扩展的**内容**，扩展仍是显式的（`src/company/org.ts:1139` 那行 `configure(tx, id, {extensions:[employeeExtension]})` 不变） |
| ADR-014（能力包名唯一） | 按名解析 | 配方不新建扩展，扩展名仍是 `role-employee:<project>/<name>`（`src/company/tools.ts:389`） |
| ADR-003（成本只从用量文档取） | — | 无关，但 `stats.hits/adopted/reverted` 也**不从历史求和**，是写入时自增的计数器，同一条原则 |

---

## 5. 反方自检：我这个设计最可能被怎么打

**最容易被 A 席（架构精简派）攻击的一点：**

> 「你要说服我『代码越少越好』，然后给我一张**净增 160 行 + 新增 3 个文件 + 1 个新 Doc**的账单。
> 而且你承认 `RecipeDoc` 和 `MemoryDoc` 是两条独立的路——这不就是又多了一个真相源？」

这个攻击很难反驳，因为它在算术上是对的。我的辩解只有一条，而且是可验证的：
**三张表（`STAFF_ROLE_TEMPLATES` + `STAFF_TOOLSETS` + 7 段 `charter`）现在做的事
是「一个角色 = 一段提示词 + 一组工具」，这本来就是配方的形状，只是被拆成了三种不同的 TS 常量。**
把它们合并是**删除**，配方机制是合并后顺手得到的复用。如果评审认为净增太多，
我可以砍到只剩 §4.3 的三条记忆修复（**净增约 80 行，不新增文件**），
放弃「动态能力」——但那等于承认老板的诉求里「动态创建能力」这一条不做。

**其次会挨的（C 席，通信与任务模型）：**

> 「配方是一条**绕过频道与审批链**的旁路：agent 通过改自己的 `brief` 改变自己的行为准则，
> 而 `brief` 不经过任何通信记录、不进 `app.audit`。你在 ADR-033（老板级待办只能由 CEO 递）
> 建立的『一切有痕迹』的模型上开了一个后门。」

这条我认为**他是对的**，所以设计里必须有：所有 `propose`/`review` 都写进
`app.audit`（现成的 `src/company/docs.ts` AuditDoc），并且**同一事务里**向提案者的上级
频道 `deliver()` 一条消息（复用 `src/company/deliver.ts`，不新增原语）。
配方不是旁路，它是**一条有审批、有留痕、有回边的通道**——但这句话得用代码兑现，不能只在文档里说。

**我自己承认的第三个弱点（还没人打）：**

`stats.reverted` 靠谁填？我写了「用后反馈」，但**没有设计填写时机**。
最可能的结果是它永远是 0，于是「自动降级没人用的配方」这一步也是假的。
诚实的做法是把 `stats` 砍掉——留一个欺骗性的指标比没有指标更糟
（这正是 `docs/DECISIONS.md` ADR-003 的精神：账目必须从真实来源取，不能估）。
**我倾向删掉 `stats`，让配方只能人工淘汰。** 那样这个设计就更小、更诚实，也更难被 A 席打。

---

## 6. 附：本轮实测数据与复现方式

```bash
# ① 记忆系统零使用（生产库）
sqlite3 workspace/company.sqlite "select count(*) from documents where kind='app.memory';"   # 0
sqlite3 workspace/company.sqlite "select count(*) from entries where record like '%memory_write%';"  # 0
sqlite3 workspace/company.sqlite "select count(*) from entries where record like '%memory-hint%';"   # 0
sqlite3 workspace/company.sqlite "select count(*) from entries where record like '%task-report%';"    # 55（任务确实在跑）

# ② 折叠退化（与 src/domain/memory.ts:125 compactMemory 逐行对齐的最小复现）
#    staff 容量 50 / FOLD_BATCH 20 / BODY_LIMIT 300，顺序写入 200 条
#    → 条数 48、distill 1 条、最深折叠代数 153、最新 distill 正文前 4/5 是嵌套标题前缀

# ③ bigram 中文检索（与 src/domain/memory.ts:231/242 逐行对齐）
#    「音效」vs「音频」→ 0；「炸了」vs「爆炸」→ 0；「恢复条件」→ 0；单字查询恒为 0
#    「sqlite」「备份数据库」→ 命中（英文整词 / 二字词中）
```

脚本逻辑是对 `src/domain/memory.ts` 的等价复刻（`bigrams` / `scoreOf` / `compactMemory` /
`firstLine` 逐函数对齐），未修改仓库任何文件。
