# 16 项问题：归并与实施方案

老板在 2026-xx-xx 一次性提出 16 条体验问题。逐条核实代码后，它们其实是 **5 个主题**，
而不是 16 个独立修补点。本文记录归并理由、关键决策与执行顺序。

> 结论先说：**不是架构错了，是「同一个编排逻辑写了三遍」+「同一份数据有两个真相源」。**
> 具体见 §5。

---

## 1. 归并结果

| 主题 | 条目 | 本质 |
| --- | --- | --- |
| **A. 频道信息架构重做** | 1 2 3 4 7 15 | 「私聊」是唯一的两人空间：对话 + 他的流水 + 回复引用 + 档案面板 |
| **B. 聊天体验对齐微信** | 6 8 13 | 时间轴、图片、@ 高亮、小屏、性能、上报精简 |
| **C. 任务与成本可追溯** | 10 11 | 任务有起止时间与 token；模型可编辑并同步到已招员工 |
| **D. 记忆 / 知识分层** | 12 | 员工记忆（任务为单位）→ 项目记忆 → 公司记忆 |
| **E. 架构瘦身** | 16 | 三个巨型文件 + 编排重复 |

---

## 2. A 组：频道信息架构

### 2.1 删掉 `log:<id>` 频道（#4 #15）

**现状**：每个 agent 有两条几乎同义的流——

- `log:<id>` 频道（`src/company/channels.ts:566-585` 建，`wakeOnAll: true`）
- 私聊里的「工作记录」tab（UX-7，数据来自 `/api/staff/:id/activity`）

两者都在讲「这个人干了什么」，是**两个真相源**。老板的口径（#4 #15）：
工作记录不该是独立频道，应该直接长在私聊里。

**改法**：

1. `ensureAllChannels()` 不再建 `log:` 频道，并把已存在的归档。
2. `resolveChannel()`（`src/company/tools/universal.ts:74-110`）的兜底分支
   `return channels.channels[`log:${conversationId}`]` 改为「本项目群 → 私聊 → 公司群」。
3. `shouldBeIn()`（`src/company/channels.ts:118-152`）删掉 `log:` 分支。
4. `channels-view.ts` 的 `kindRank` 删掉 `log: 4`（保留 kind 类型以免老库解析失败）。
5. 前端 `GROUPS` 删掉 `工作记录` 分组。

**风险**：老库里有 `log:` 频道的消息。归档即可（`archiveChannel`），不删数据。

### 2.2 频道分组改成两个（#3）

```
群组        ← company / leadership / project
成员        ← dm
```

`log` 消失后，5 个分组自然塌成 2 个。这也符合「微信」的心智：
群聊一堆、联系人一堆。

### 2.3 私聊 = 对话 + 流水混流（#1 #4）

**删掉 tab**（`#ch-tabs` / `state.subTab` / `applySubTab()` / `resetActivity()` 的
显隐逻辑），改成**单条时间线**：

- 频道消息（`chat` / `task` / `report` / `system`）来自 `channel.messages`
- 员工的 thinking / tool 来自 `/api/staff/:id/activity`

两条流按 `at` 归并排序，渲染时：

- 频道消息 → 现有气泡（头像 + 名字 + 时间）
- thinking → `renderThinking()`（`<details>` 折叠，默认收起）
- tool → `renderTool()`（`<details>` 折叠，默认收起）

**关键取舍：流水默认折叠、且不产生未读。** 理由：老板要的是「能看见他想了什么」，
不是「被每一步工具调用打断」。未读徽章只统计频道消息。

实现上**不合并数据源**（一个是文档、一个是 feed），只在渲染层做一次归并。
数据量：一页 30 条 activity + 60 条消息，归并成本可忽略。

### 2.4 组织页点职员不弹聊天（#1）

`ui/js/org.js:1048-1070` 已经把 `select(id)` 摘掉了（UX-1），只留 `setSelected`。
本次确认保持，并把「点卡片 → 跳频道私聊」做成显式入口（卡片上的一个按钮），
而不是「点一下就开始聊天」。

### 2.5 档案面板迁到频道右上角（#2）

现在 `#chat-fold` 只在对话面板里，频道视图没有入口。

改法：`ui/index.html` 的 `.ch-head-side` 加一个 `#ch-fold` 按钮，复用
`initProfile()`（`ui/js/profile.js`），挂载点改为 `.ch-main` 下的一个
`.ch-dock`（结构照抄 `#chat-dock`）。**同一份 profile.js，两个挂载点。**

### 2.6 回复取代 @（#7 #15）

**#15 的「私聊隐式 @」其实已经实现**：`src/domain/channels.ts:313-327`
`resolveMentions()` 在 `kind === "dm"` 且没写 @ 时，把除自己外的所有成员都算作被 @。
所以私聊里不需要 @，代码层面已经成立。前端要做的只是**别在 UI 上要求/显示 @**。

**#7 回复**：给 `ChannelMessage` 加一个可选字段

```ts
replyTo?: { seq: number; fromLabel: string; excerpt: string };
```

- 前端：消息 hover 出「回复」按钮 → 输入框上方出现引用条 → 发送时带上 `replyTo`
- 渲染：气泡上方一行 `.ch-quote`（点击滚到原消息并高亮）
- 唤醒：回复等同于 @ 被回复的人（在 `postToChannel` 里把 `replyTo.from` 并进 `mentions`）

**为什么不做完整引用链**：微信也只做一层。多层引用在聊天流里视觉噪音太大。

---

## 3. B 组：聊天体验

### 3.1 时间（#6）

现状：`renderMessages()` 每 5 分钟插一个 `<div class="ch-day">`，且只在换发送人时
显示 `clockTime`。**没有「时间分隔条」**——连着说 20 条只有第一条带时间。

改法（对齐微信）：

- 换天 → 日期分隔条（已有）
- **同一天内间隔 > 5 分钟 → 插入一条居中的时间条**（`<div class="ch-time-divider">14:32</div>`）
- 每条消息的时间移到气泡右下角 hover 显示（`title` + CSS `:hover`）

### 3.2 图片与富文本（#6）

现状：`renderMarkdown()` 已支持 markdown，但**不渲染图片**。

改法：`ui/js/markdown.js` 支持 `![](url)` → `<img loading="lazy">`，点击放大。
附件上传接口 `/api/upload` 已有（`src/server/uploads.ts`），频道输入框接上即可。

### 3.3 @ 高亮（#6）

现状：`renderMentions()` 只在气泡**下方**列一排灰/绿点，正文里的 `@许砚舟` 是纯文本。

改法：气泡渲染后，把正文里匹配频道成员 label 的 `@xxx` 包成
`<span class="ch-at">@xxx</span>`（高亮色）。已读点保留但弱化。

### 3.4 小屏适配（#6）

现状：`channels.css` 有 `@media (max-width: 860px)` 的「列表页 / 会话页」两屏切换。
问题是**三栏布局在 860-1100px 之间会挤**。

改法：加一档 `@media (max-width: 1100px)`，成员栏默认收起（现在 `membersOpen` 默认
`false`，但 `applyMembersOpen()` 不看屏宽）。切屏宽时自动收。

### 3.5 性能：一直刷新（#6）

**这是最实的一条**。根因在 `ui/js/channels.js:1185-1200`：

```js
window.addEventListener("aic:org", () => { ... setTimeout(..., 400) ... openChannel(...) });
```

`aic:org` 由 org SSE 推送，**agent 干活时每几秒就来一次**。每次都会：

1. `loadChannels()` —— 全量拉频道列表
2. `openChannel(activeId, { userInitiated: false })` —— 全量拉 60 条消息
3. `renderMessages()` —— **`el.body.innerHTML = ...` 整段重建**

整段重建导致：滚动位置抖、图片重新加载、`<details>` 展开态丢失、动画重播。

改法（三条，按收益排序）：

1. **`renderMessages()` 改成增量**：按 `seq` 做 key，已有节点只 patch 变化的，
   新增的 append。这是 `chat.js` 早就做的事（`rendered = [{key, sig, el}]`），
   频道视图漏了。
2. **org 推送只更新列表徽章**，不动消息流；消息流靠自己的轮询（现在没有独立轮询，
   靠 org 推送顺带刷新）。给频道加一个 4 秒的轻量「拉最后 N 条」轮询，
   只有 `lastSeq` 变了才动 DOM。
3. **`loadChannels()` 加节流**：现在 400ms 去抖，但每次仍然全量。改成「只重拉列表，
   不重拉当前频道详情」。

### 3.6 上报精简（#13）

现状：`escalation.ts` / `transitionTask()` 写进频道的文本动辄几十行。
`src/company/tasks.ts:243-260` 拼的 `【任务完成】标题\n证据：...` 还算短，
但升级链的 `text` 是整段 agent 输出。

改法：**结构化 + 折叠**。

- 群聊里只放 `1. 2. 3.` 三条要点（由发起方给，不给就截断到 3 行）
- 完整内容放 `refs` 指向的详情，前端渲染成「展开详情」
- `MessageKind` 加 `brief` 语义（或复用 `report` + 一个 `collapsed: true`）

---

## 4. C / D 组

### 4.1 任务可追溯（#11）

**现状已有**：`src/domain/tasks.ts:56-58` 的 `createdAt` / `startedAt` / `doneAt` 都在。
缺的是：

- **token 消耗**：`conversationUsage()`（`src/company/cost.ts:53`）是按会话算的，
  不是按任务。要在 `TaskEntry` 上加 `usage?: { tokens: number; costUsd: number }`，
  由 `transitionTask()` 在 `done` 时从 `UsageDoc` 取差值写入。
- **前端任务面板**：频道右上角抽屉里加「正在做 / 待做 / 已完成」三段，
  数据来自已有的 `projectBoard()`（`src/company/tasks.ts:116`）。

### 4.2 模型编辑与同步（#10）

**现状**：`POST /api/models` 只能新增，`DELETE` 只能删自定义模型，**没有 PATCH**。
`ui/js/settings.js` 的 `modelRow()` 也只有 `default-model` / `delete-model` 两个动作。

改法：

1. `src/server/http.ts` 加 `PATCH /api/models?id=`，走 `settingsStore.updateModel()`。
2. 前端 `modelRow()` 加「编辑」按钮 → 复用 `modelFormHtml()` 预填。
3. **同步到已招员工**：模型改完后，`hireStaff` 存的是 `ModelRef` 快照。
   加一个 `POST /api/models/sync` —— 遍历 `CompanyDoc.staff`，把
   `model.modelId` 匹配的员工的 `conversation.configure({ model })` 重下发。
   界面上明确告诉老板「将影响 N 名员工」。

### 4.3 记忆分层（#12）

**这是 16 项里最需要设计的**，也是最容易做错的。老板的担心是对的：
「数据会越来越多，堆积问题很严重。」

**核心原则：记忆是「写时提炼、读时检索」，不是「把聊天记录存起来」。**

三层文档（都用 `defineDoc`，都是 `scope: "conversation"` 或公司级）：

| 层 | kind | 写者 | 内容 |
| --- | --- | --- | --- |
| 员工 | `app.memory.staff` | 自己 | 按任务归档：`{ taskId, at, lesson, tags }` |
| 项目 | `app.memory.project` | 项目负责人 | 项目知识：`{ at, title, body, tags }` |
| 公司 | `app.memory.company` | CEO | 公司级决策与惯例 |

**写入时机**（关键，决定会不会堆积）：

- 员工层：任务 `done` 时，**强制**写一条 ≤ 300 字的经验。这是唯一强制的写入点。
- 项目层：负责人可选写（工具 `memory_write`），或由 CEO 从员工层提炼。
- 公司层：只在 `decide` / `owner-decision` 审计事件时，由 CEO 提炼。

**读取方式**（决定会不会爆上下文）：

- 不做全量注入。员工的提示词里只放**最近 5 条 + 按 tags 匹配当前任务的 3 条**。
- 项目/公司层只在被显式 `memory_search` 时读。

**上限与压缩**：

- 员工层：超过 50 条时，把最老的 20 条压缩成 1 条「阶段总结」（由该员工自己做）。
- 项目层：超过 100 条时同理。
- 公司层：超过 200 条时由 CEO 归档成「公司历史」文档（只读，不进提示词）。

**为什么这样能防堆积**：写入有阈值（任务完成才写）、读取有预算（提示词里最多 8 条）、
总量有压缩（超限自动总结）。三层都设了闸，不会无限涨。

---

## 5. E 组：架构（#16）

**先回答「是不是架构有问题」：不是。** 分层（domain / runtime / company / server /
tui）是干净的，边界检查脚本 `scripts/check-boundaries.mjs` 在守着，没有循环依赖。

**真正的问题是三个巨型文件 + 编排重复：**

| 文件 | 行数 | 问题 |
| --- | --- | --- |
| `src/company/org.ts` | 2457 | 装配 + 招聘 + 改名 + 提示词 + 频道初始化全在一个文件 |
| `src/company/escalation.ts` | 1300 | 升级链的状态机 + 工具 + 留痕 |
| `src/company/roundtable.ts` | 1153 | 又一遍「建任务→等→醒来→写留痕」 |
| `src/server/http.ts` | 1792 | 25 个 `if` 分支的路由表 |

**同一个模式写了两遍**：escalation 和 roundtable 各自实现了
「持久化任务 + 等待 + 醒来 + 留痕」。这是**可以收敛的**。

**收敛顺序**（每步独立可回归）：

1. `http.ts` 的路由改成表驱动（`{ method, pattern, handler }[]`），不动 handler 内部。
2. `org.ts` 拆成 `org/assembly.ts` + `org/hiring.ts` + `org/prompts.ts`（纯搬家）。
3. `escalation.ts` 与 `roundtable.ts` 抽出共享的 `waitFor()` 模式。

**不做的**：不动持久化契约（`defineDoc` 的 kind 是公共协议，见 ADR），
不动公开类型。这两条是硬约束。

---

## 6. 执行顺序

| 批次 | 条目 | 理由 |
| --- | --- | --- |
| P0 ✅ | #9 私聊跑到群里、#8 已读点 | 功能缺陷，已修 |
| P1 ✅ | #3 #5 #2 | 纯前端，风险最低，先见效 |
| P2 ✅ | #1 #4 #15 | 删 `log:` 频道 + 私聊混流，前后端联动 |
| P3 | #6 #13 | 性能与富文本，改动最大 |
| P4 | #7 | 回复功能，依赖 #1 的消息结构 |
| P5 | #10 #11 | 模型编辑 + 任务面板 |
| P6 | #12 | 记忆分层，需要新文档与新工具 |
| P7 | #16 | 架构瘦身，放最后（避免和前面冲突） |

每批都跑 `npm run check` + 相关 `vitest`，不通过不进下一批。

## 7. 附带完成：去掉右侧对话面板（老板中途追加）

老板中途要求「去掉右侧聊天面板」（与 16 项并列的独立需求）。这本来是 P7 的
架构瘦身范围，但既然要动频道，就一起做完了：

- **`ui/index.html`**：`#chat` 整个 section 删除，`.aside-slot` 只留设置抽屉；
  `data-chat` / `data-sheet` / `data-view-aside` 三个 body 属性全部退场，换成
  `data-settings`。
- **待办卡片迁移**（不迁就得让老板失去拍板入口）：后端 `readChannelView` 现在
  在频道视图里带 `pending`，前端新增 `ui/js/pending.js` 渲染选项卡片 + 回复框，
  提交走 `POST /api/channels/:id/messages`（带 `pendingKey`），处置走 `/api/pending/dispose`。
- **删除**：`ui/js/chat.js`（2401 行）、`ui/js/ask.js`、`ui/css/chat.css`（2461 行）。
- **拆出**：`ui/css/profile.css`（角色档案浮层 + `#ch-dock` + `chat-spinner`）、
  `ui/css/markdown.css`（`.md*` + 代码块复制）、`ui/css/pending.css`、`ui/js/toast.js`。
- **`ui/js/app.js`** 771 → 471 行：只剩订阅组织快照 / 切视图 / 分发状态。
- **验收脚本** `scripts/ui-check.mjs` 重写：63 项断言（原 84 项里 21 项是对话面板的），
  连跑三次 63/63 通过。

## 8. 第二轮审查（6 项，老板 2026-10 追加）

频道页做完后老板又提了 6 条，全部落在 A/B 组范围内，已一并完成：

| # | 问题 | 真因 | 改法 |
| --- | --- | --- | --- |
| 1 | 频道页未适配小屏 | 单列媒体查询只改了 `grid-template-columns`，没改 `grid-template-rows`，`#ch-side` 落进隐式第 2 行把布局撑成两行 | `ui/css/channels.css:885-925` 把所有子项钉到同一行同一列；成员栏在 ≤1180px 变右侧浮层 |
| 2 | 私聊消息不停乱滚 | 每个 org SSE 事件都触发一次 `resetActivity()` 整段重建流水；`loadMoreActivity` 的 IntersectionObserver 哨兵重建后又进视口，**连环翻页 8~17 次** | 渲染前后用 `captureScroll/restoreScroll` 保位；哨兵只在真正滚到底时才触发；「执行操作 / 执行命令」的红色竖线删除 |
| 3 | 视图切换没动画 | 原来用 `transition + @starting-style`，起始值被常规规则覆盖，首帧即终态 | 改用 `animation: motion-view-in 260ms`，`app.js` 给新视图挂 `data-enter`，`animationend` 摘掉 |
| 4 | 私聊档案挤在头顶 | 档案用 `#ch-dock` 内嵌在消息流上方，切频道也不收起 | 改成右侧侧边面板（`ui/css/profile.css`，absolute 滑入）；`openChannel()` 与 `#ch-back` 都顺手收起 |
| 5 | 点消息没有操作 | 无此功能 | 新增 `#ch-msg-actions` 浮窗（复制 / 引用回复），回复以 `replyTo` 引用块渲染 |
| 6 | 设置里模型只能加不能改 | `/api/models` 只有 POST/DELETE，`CustomModelSettings` 没有覆盖内置项的机制 | 新增 `PATCH /api/models`；`DELETE` 内置模型改为写 `{ builtin, hidden: true }` 覆盖项；`ui/js/settings.js` 每行加「编辑 / 设为默认 / 删除」 |

验收：`scripts/ui-check.mjs` **63/63** 连跑通过，`npm test` **720 passed**。
