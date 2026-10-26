# D 席（前端交互派）· 第 1 轮书面意见

> 结论先行：**问题不在「前端写多了」，而在「前端在替后端猜」。**
> 14775 行 UI 里真正属于「老板和 AI 公司聊天」的不超过 4000 行；剩下的绝大部分是
> ①手写 markdown 渲染器 ②不参与交互的星空 ③三套互不相干的「任务」呈现 ④把后端该算的东西重算一遍。
> 砍的顺序是：**先让后端多说几句话（视图投影补齐），前端才能整块删掉。**

---

## 1. `ui/js/channels.js` 解剖：1874 行 = 6 类职责

### 1.1 函数清单（实测行号，`grep -n "^function \|^export function "`）

| 行 | 函数 | 一句话职责 | 我判定的归属 |
|---|---|---|---|
| 24 | `$` | `getElementById` 简写 | 工具 |
| 122 | `fetchJson` | fetch + 读服务端中文 error 体 | **网络层**（该独立） |
| 140 | `loadChannels` | `GET /api/channels`，自动选第一个，窄屏不自动进 | 状态机 |
| 171 | `viewSignature` | 手拼 30 行字符串签名，判断「这轮要不要重渲染」 | **架构气味（§2.4）** |
| 204 | `openChannel` | 打开频道（**90 行**）：并发令牌、窄屏不抢屏、保滚动、渲染 4 段、`POST /read` | 状态机 |
| 297 | `loadEarlier` | 往上翻页 + 高度补偿 | 滚动域 |
| 332 | `announceNewMessages` | `aria-live` 只播新增、跳过自己发的 | 无障碍 |
| 352 / 358 | `captureScroll` / `restoreScroll` | 记 / 还原滚动位置 | 滚动域 |
| 370 | `sendMessage` | sending 锁、POST、仅当输入框仍是原文才清空 | **发送域** |
| 412 | `extractMentions` | 按候选 label 做 `text.includes` | **该由后端做（§2.2）** |
| 423 / 432 / 440 / 453 | `quoteLine` / `setReplyTo` / `closeActions` / `openActions` | 引用行、回复目标、消息浮窗（**自己算坐标**） | 发送域 / 浮窗 |
| 504 / 564 / 575 | `renderList` / `updateActiveRow` / `renderListError` | 左栏：分组、头像、preview、徽章、高亮、失败态 | 列表域（94 行） |
| 597 / 611 | `showsMembers` / `applyMembersOpen` | 哪类频道有成员栏（`hidden`/`inert`/`aria-expanded` 三写） | 布局策略 |
| 625 | `renderHeader` | 标题 + `kindLabel · N 人` + 档案按钮显隐（仅 dm） | 头部 |
| 673 / 686 / 699 | `activityStaffId` / `itemAt` / `timelineOf` | **把「频道消息」与「私聊 activity 流水」按时间归并** | **私聊专属（最重）** |
| 722 / 747 / 815 | `renderTrace` / `renderTraceGroup` / `traceKey` | think/tool 流水、成组、失败破组 | 私聊专属 |
| 787 / 793 / 822 / 827 | `disarm` / `arm` / `observeActivitySentinel` / `onUserScrollAttempt` | IntersectionObserver 哨兵四件套，只认人手动作 | 私聊专属 |
| 834 / 877 / 911 | `loadMoreActivity` / `resetActivity` / `sameActivity` | `/api/staff/:id/activity?limit=30&before=` 分页与重置 | 私聊专属 |
| 917 | `renderMessages` | **117 行**：日分隔/5 分钟时间条/同人折叠/流水分组/卡片/气泡/patch | **渲染核心** |
| 1064 / 1081 / 1124 / 1131 | `keyed` / `patchBody` / `signatureOf` / `htmlToNode` | 增量对齐；`outerHTML` 长度+首尾 32 字节判变（**补丁的补丁**） | patch |
| 1143 | `pendingHtml` | 老板待办卡**嵌在消息流里**（永远 append 在末尾） | 待办 |
| 1161 / 1199 | `highlightMentions` / `highlightText` | 在 **HTML 串**上切标签高亮 @，跳过 code/pre/a | **该由后端做** |
| 494 / 1232 / 1247 / 1268 / 1285 / 1297 / 1310 | `avatar` / `renderBubble` / `renderAvatar` / `renderMsgHead` / `renderQuote` / `renderMentions` / `renderCard` | 头像（`/api/avatar` + `onerror` 兜底首字）、气泡、作者行、引用、@已读灰绿点、task/report 卡片 | 渲染 |
| 1252 / 1257 | `dayKey` / `dayLabel` | 日期分隔文案（用浏览器时区） | **该由后端做** |
| 1328 / 1396 / 1417 / 1441 / 1505 | `renderMembers` / `renderTasks` / `taskRowHtml` / `elapsedLabel` / `roleLabel` | 侧栏成员与任务（**唯一读 TaskDoc 的地方**）、耗时、role→中文 | 侧栏 |
| 1456 / 1478 | `renderBodyError` / `scrollToBottom` | 消息区错误；粘底（临时关 smooth + rAF 兜底） | 错误 / 滚动 |
| 1511 / 1521 / 1526 | `loadMentionCandidates` / `onInput` / `autoSize` | `GET /mentionable`、输入事件、高度 ≤160px | @ 选择 / 输入框 |
| 1533 / 1545 / 1598 / 1611 / 1618 | `detectMention` / `updateMentionPopup` / `moveMentionActive` / `pickMentionActive` / `insertMention` | 检测、弹层（最多 8 项）、键盘选择、插入 | @ 选择（124 行） |
| 1644 | `notify` | 转发 toast | 工具 |
| 1650 | `initChannels` | **224 行**：挂 19 个 DOM 引用 + 全部事件 + `aic:org` 400ms 节流 + 导出 4 个方法 | **装配** |

### 1.2 承担了 6 类职责（细分 11 项）

1. 频道列表（分组/排序/徽章/preview/已读）— `renderList` 等 4 个函数 94 行
2. 消息流渲染（日分隔/时间条/折叠/卡片/气泡）— `renderMessages` 226 行
3. 增量 DOM patch（`keyed`/`patchBody`/`signatureOf`/`htmlToNode`）— 68 行
4. 私聊 activity 流水（哨兵 + 分页 + 归并 + trace 渲染）— **254 行，只对 dm 生效**
5. 发送与回复（`sendMessage`/`setReplyTo`/浮窗/引用）+ @ 选择器（124 行）+ 输入框自适应与 IME 兼容
6. 已读上报（`POST /read`）+ @ 已读点；侧栏（成员 + 任务）；滚动粘底（**3 处独立实现**）；全局装配（19 个 DOM 引用 + `aic:org` 节流）

**关键：第 4 条（私聊流水）与第 2/3 条（群聊消息流）其实是两个产品**——不同数据源、不同分页、
不同滚动策略，只共用一个 `#ch-body`；`timelineOf()`(:699) 是那个「假装统一」的胶水。

---

## 2. 哪些职责本该属于后端

判据只有一条：**「只有浏览器知道的」留在前端，其余上移。**
浏览器独有的只有三样：视口尺寸、滚动位置、焦点与输入法状态。

### 2.1 必须留在前端（无可争议）

`captureScroll`/`restoreScroll`/`scrollToBottom`(352/358/1478)、`autoSize`(1526)、
`detectMention`/`updateMentionPopup`(1533/1545)、`openActions`(453) 的浮窗坐标、
`armActivitySentinel`(793)、`announceNewMessages`(332)——全部依赖视口、`scrollHeight`、
光标位置与 IME、`getBoundingClientRect`、IntersectionObserver、`aria-live`。

### 2.2 该上移到后端的（现在前端在算）

| 前端在算 | 应该谁算 | 为什么 |
|---|---|---|
| `extractMentions`(412) 按 label `includes` | 后端（**已经算了**）| `postChannelMessage` 里 `parseMentions(content, channel, org)` 会二次解析并过滤非成员（src/server/http.ts:1140 附近）。`/mentionable` 候选只该当**下拉提示**、不该参与发送语义——两边算法不同（前端 label 子串、后端解析 @token），会出现「前端以为 @ 了 A，后端解析成 B」 |
| `highlightMentions`/`highlightText`(1161/1199) | 后端 | `MessageView` 已带 `mentions[{id,label,read}]`（src/server/channels-view.ts:50），但没下发位置，前端只能对**最终 HTML 串**做替换——`1199` 那个 `insideSkip` 递归就是为了躲开 `<code>`/`<pre>`/`<a>`。**典型「前端替后端补偏移量」**：后端多给一个 `at: number[]` 就等于删掉这段 |
| `viewSignature`(171) | 后端 | 手拼字符串含 seq/read/mentions/replyTo.seq/成员 unread/任务 status+usage.tokens/pending key——**用字符串模拟一个 diff 协议**。后端已知道什么变了，下发 `rev` 或 `changed:["messages","tasks"]` 即可，前端一行 `if (rev === last) return` |
| `signatureOf`(1124) | 删除 | `outerHTML` 长度 + 首尾 32 字节判断节点变没变——**对 patch 本身的补丁**。有了服务端 `rev` + `data-seq` 幂等，这 68 行全可删 |
| `dayKey`/`dayLabel`/5 分钟时间条(1252/1257) | 后端 | 纯时间分组，且**时区必须在服务端统一**（现在用浏览器本地时区；老板换台机器看历史消息，日期分隔线会变） |
| `elapsedLabel`(1441) 任务耗时 | 后端 | `startedAt` 前端算差值，浏览器时钟不准就显示负数或「0 秒」 |
| `timelineOf`(699) 会话+流水归并 | 后端 | 归并规则（消息 `at` vs activity `at` 混排、谁在前）写在客户端 = 换一个客户端就要重写一遍。应有一个 `GET /api/channels/:id/timeline` 或 `ChannelView` 直接带 `items[]` |
| `previewLine` 截断 80 字 / `pendingHtml`(1143) 把待办混进消息流 | 后端 | preview 后端已截（`channels-view.ts:146`）**前端又截一次**；待办卡在末尾 `el.body.append`(:1039)，永远在最下面、与时间序无关，定序该由后端给 |

### 2.3 后端根本没给、前端只好不做的（真缺口）

这三个是**最该补的**，因为它们是老板问「谁在干什么」的全部答案：

| 缺什么 | 现状 |
|---|---|
| **回执 / 排队状态** | `writeAck`(src/server/http.ts:1212) 写 `app.ack` **进会话流**，`feed.ts` 能渲染，**频道视图拿不到**——发完零反馈（见 §5.1） |
| **任务被拒 / 阻塞的原因** | `TaskEntry` 有 `acceptance`/`blockedReason`/`evidence`/`progress[]`（src/domain/tasks.ts:41），`ui/js/*.js` **grep 0 命中**；侧栏 `taskRowHtml`(:1417) 只显示 id/title/status/人/耗时/tokens |
| **@ 是否被看到** | `mentions[{id,label,read}]` 有 `read`，但**没有「正在看这条」** |

### 2.4 `viewSignature` 是前端越界的最清晰证据

`viewSignature()`(171) 约 30 行，逐字段拼 `channel.id|title|hasMore + 每条 seq/read/mentions/replyTo.seq +
成员 id+unread + 任务 id/status/startedAt/doneAt/usage.tokens + pending key/askedAt`。注释自陈「不变则跳过 4 个
render」——**前端已不再信任「有推送就重渲染」，它在做服务端该做的变更检测**；补一个后端 `rev` 就能删掉它加
`signatureOf`（约 60 行）。

---

## 3. 拆分方案：1874 行 → 6 个文件

**目标**：单文件 ≤ 600 行，无框架，`ui/js/` 不再有 1000 行文件。

| 新文件 | 约行数 | 职责 | 从哪搬 |
|---|---|---|---|
| `ui/js/chat/net.js` | 80 | `fetchJson`、`GET /api/channels*`、`POST /messages`、`POST /read`、`GET /mentionable`、`GET /staff/:id/activity`。**唯一发请求的地方** | 122, 297, 370, 834, 1511 |
| `ui/js/chat/list.js` | 130 | 左栏：`GROUPS`、`renderList`、`updateActiveRow`、`renderListError`、顶栏徽章 | 486–579 |
| `ui/js/chat/stream.js` | 480 | 消息流：`renderMessages`、`keyed`/`patchBody`/`htmlToNode`、`renderBubble/Head/Quote/Mentions/Card`、`dayKey/dayLabel`、`scrollToBottom`、`capture/restoreScroll`、`announceNewMessages` | 332–358, 917–1198(部分), 1232–1310, 1456, 1478 |
| `ui/js/chat/dm.js` | 300 | **私聊专属**：`activityStaffId`/`itemAt`/`timelineOf`、`renderTrace`/`renderTraceGroup`、哨兵四件套、`resetActivity`/`sameActivity`/`traceKey` | 663–916 |
| `ui/js/chat/composer.js` | 220 | 输入框：`sendMessage`、`setReplyTo`、引用条、`autoSize`、`detectMention`、弹层、`insertMention`、IME 兼容、键位 | 370–440, 1509–1632 |
| `ui/js/chat/side.js` | 200 | 侧栏：`showsMembers`/`applyMembersOpen`、`renderHeader`、`renderMembers`、`renderTasks`/`taskRowHtml`/`elapsedLabel`、`pendingHtml` | 597–662, 1143, 1328–1455 |
| `ui/js/chat/index.js` | 180 | 装配：只挂 DOM + 事件委托 + `aic:org` 节流 + 导出 `open/refresh` | 1650–1874 |

**拆分纪律**（否则一个月后又长回 1874 行）：

1. **只有 `net.js` 能 `fetch`，只有 `index.js` 能 `getElementById`。** 子模块从参数收节点（现有 `el` 对象已经这么做，把它显式化）。
2. **`dm.js` 必须能整体删掉**——它是唯一「只服务 1/5 频道类型」的模块；若哪天私聊不再用 activity 流水，删一个文件即可（现在要跨 4 段代码删约 400 行）。
3. **`stream.js` 不许 import `dm.js`**，两者由 `index.js` 用 `items` 数组合流——`timelineOf` 归并上移到后端后这条自动成立。

**再进一步（推荐）**：后端补 `ChannelView.items[]`（消息+流水+待办已定序）与 `rev` 后，`stream.js` 可降到
300 行、`dm.js` 整个消失 → 1874 → **约 1150 行**。

---

## 4. 「类公司的聊天形态」有没有被正确建模

### 4.1 现在有几类频道

`src/domain/channels.ts` 的 `parseChannelId` 认 5 种，`ensureAllChannels`（src/company/channels.ts:465）只建 4 种：

| kind | 例子 | 成员数 | 谁能看 | 界面上怎么区分 |
|---|---|---|---|---|
| `company` | 全员 | 全部 | 全部 | 左栏「群组」组内，`sub` 省略 kindLabel |
| `leadership` | 管理层 | ceo + 6 管理层 | 仅 ceo/management（channels.ts:134） | 同上 |
| `project` | `proj:tank` | 负责人 + 员工 + 老板 | 全部 | 同上 |
| `dm` | `dm:1897` | 老板 + 1 人 | 只有这两人 | 「成员」组；**只有它有右侧档案按钮 `#ch-fold`** |
| `log` | `log:<id>` | 1 人 | 自己 | **已停建**，只为读旧库保留（channels.ts 注释） |

**回答：是，区别「几乎只在标题」。** 全部差异只有三处：左栏分组（`GROUPS` 两档，
company/leadership/project 混在一档）、`#ch-fold` 档案按钮仅 dm 显示（`channels.js:625`）、
dm 才有 activity 流水混排（`channels.js:699`）。

`leadership`（7 人的管理层频道）与 `company`（全员）在界面上**完全一样**；`project` 与
`company` 也一样——`ChannelListItem.project` 字段**前端根本没渲染**（grep `\.project` 只命中 board/dev-fixtures）。

### 4.2 老板打开界面第一眼该看到什么

**现在**：`applyView(stored)`(ui/js/app.js:365) 从 `localStorage["ai-company.view"]` 恢复上次视图，**默认 `"org"`**
→ 一屏三层组织图卡片 + 星空背景；频道是三个平级 tab 中的第二个（`#view-channels`）。

**我认为这是错的**，三条理由：①老板原话是「主要是发送和回复」，但他每次打开都要先看一张
**不可交互的组织图**（`org.js:32 onSelect` 接线保留但从不调用，注释 UX-1「暂时无任何操作」——
**1095 行的模块，点击没有任何反应**）；②组织图的信息（谁是谁下属）一年变一次，频道未读每 10 分钟变一次，
**默认视图该给变化最快的**；③三个平级 tab 意味着「我该去哪」每次都要重新决策。

**建议的信息架构**（砍一个 tab，改默认）：

```
┌ 频道（默认首页）─┬─ 消息流 ─┬─ 详情 ───┐    组织图 / 看板
│ ● 全员      3    │          │ 成员/任务 │    ↓
│ ● 管理层    1    │          │          │    顶栏二级入口
│ ● 坦克大战  7    │          │          │    ⌘1 / ⌘2
│ ─ 私聊 ─        │          │          │
│ ● CEO       2    │          │          │
└─────────────────┴──────────┴──────────┘
```

即：**频道从「三个 tab 之一」变成「应用的默认页面」**，org/board 降为「资料视图」。

### 4.3 私聊 vs 项目群：数据结构差异 & 界面必须让老板感知的差异

**数据结构上**（`src/company/channels.ts:465`）：两者都是 `Channel`，都有 `messages[]`/`members{}`/`lastSeq`；
私聊 `members` **恰好 2 个**（老板 + 1），项目群是 N 个；私聊**额外有一条数据源**——该员工会话的
**activity 流水**（think/tool），频道里没有；私聊 `title` 是对方名字，项目群是项目名 + `project` 字段。

**界面上必须让老板感知的差异（按重要性）**：

| 差异 | 为什么必须能感知 | 现在做了吗 |
|---|---|---|
| **私聊的内容别人看不到** | 老板要能放心说「这个人是不是不行」 | ❌ 完全没有提示。`renderHeader`(:625) 只显示「私聊 · 2 人」 |
| **私聊对方「正在干什么」是可见的** | 这正是 `activity` 流水的价值：私聊能看到 think/tool，群聊看不到 | ⚠️ 显示了（`timelineOf`），但**没有一句说明**「这些灰字是他在干活，不会出现在群里」 |
| **私聊里说的话默认只有他一个人收到** | 群聊里老板说话 → 老板无 @ 时投给频道 owner（COMMS.md §3）；私聊 → 对方。**同一个动作两种后果** | ❌ 输入框占位符是同一个「说点什么」 |
| **群聊有「成员」概念，私聊没有** | 影响 @ 候选、影响「@已读 N/M」 | ✅ `showsMembers()`(:597) 白名单已区分 |

**具体建议**：①私聊头部加一行 `.ch-privacy`「只有你和 CEO 看得到」；②输入框 placeholder 按 kind 变
（群聊「对『全员』说，不 @ 就由 CEO 接」/ 私聊「对 CEO 说」）——**这一行字解决「我发出去会叫醒谁」
这个最大的心智负担**（现在零信息）；③群聊气泡旁显示「已读 N/M」，私聊不显示（COMMS.md §7.6 已要求，
`renderMentions`(:1297) 只做了 @ 的灰绿点，**没做「已读 N/M」**）。

### 4.4 「工作记录 / 任务 / 频道消息」= 三张互不相干的表

**现状确认：是的，三套语义、三个界面、互不引用。**

| 概念 | 数据源 | 界面位置 | 语义 |
|---|---|---|---|
| 频道消息 | `Channel.messages[]`（800 上限） | 频道消息流 | 「谁说了什么」 |
| 任务 | `TaskEntry`（`TaskDoc`，有状态机） | ①侧栏 `renderTasks`(:1396) ②看板 `/api/board` | 「谁负责做什么，到哪一步」 |
| 工作记录 | `pi.live` 条目（think/tool/assistant） | **只在私聊**（`GET /api/staff/:id/activity`） | 「他此刻在干什么」 |

**三者的断裂处（老板「一眼看不懂」的真正原因）**：

1. **看板不读 TaskDoc**（ADR-030 明文要求）。`src/server/board.ts` 的 doing 列仍是
   `nodes.filter(node => node.status === "busy")`——**看板显示「谁在忙」，侧栏显示「任务状态」，
   两者永不一致**：频道里看到「任务 A 阻塞」、看板里看到「小张正在写代码」，判断不了是不是同一件事。
2. **消息提到任务，任务不回链消息**：`TaskEntry.channelId` 有，`MessageView` 没有 `taskId`；
   `kind === "task"` 的消息（`renderCard`(:1310)）只是一条**长得像卡片的文本**，点不开、拿不到状态。
3. **activity 流水只在私聊**：项目群 8 个人在干活，老板**看不到任何「正在干」的迹象**。

**一个改动解决三件事**：

1. **后端**：`MessageView` 加可选 `task?: { id, status, blockedReason?, evidence? }`，`buildBoardView` 改读 TaskDoc。
2. **前端**：`renderCard`(:1310) 对 `kind === "task"` 渲染**可展开任务卡**，展开显示 `acceptance` /
   `progress[].note` / `blockedReason`——**这三个字段现在前端 0 引用，取了不用是最大的浪费。**
3. **看板与侧栏合成一个渲染函数**（现在 `board.js:298 cardHtml` 与 `channels.js:1417 taskRowHtml` 是同一 `TaskEntry` 的两种长相）。

于是老板的眼睛路径收敛成一条：**频道里看到任务卡 → 展开看验收标准与阻塞原因 → 就地回复或派活 →
看板只是同一批任务的另一种排布**。

---

## 5. 「发送与回复」的细节处理审查

### 5.1 agent 在忙时发消息 → 界面怎么表现「已排队」？能不能插队？

**ADR 现状先说清**：ADR-024（`docs/DECISIONS.md:402`）要求「虚线框显示已排队 + 立刻处理按钮」；
**ADR-026（:451）已把它推翻**，仅限老板通道，老板原话是「他发出的每条指令都必须被无条件受理」
「他不要在界面上再看到『已排队 / 立即处理 / 插入』这类需要他二次点击的提示」。
所以正确答案**不是「补排队 UI」，而是「补回执 UI」**。

**现状判断（这条是全篇最严重的缺陷）**：

- `postChannelMessage`（src/server/http.ts:1123）确实调了 `writeAck`(:1212)，但 `writeAck` 把
  `app.ack {busy, busyWith, plan}` 写进**目标会话的流**，**不写进频道** → 老板看到自己那句话孤零零挂着，
  **没有任何「已收到 / 正在处理」**。
- 唯一兜底是看门狗 `resurfaceSilentOwnerMessages`（src/company/watchdog.ts:562），阈值
  `ownerSilentMs = 5 * 60_000`（:124），**5 分钟后**才告警；它写的 `app.alert`(:749) 也进**会话流**，
  `feed.ts:697` 才渲染 → **频道界面同样看不到**。
- 判定还很弱：`replied = channel.messages.some(entry => entry.seq > message.seq)`（:577）——**任何人说一句都算老板被回应**，群里闲聊一句就「有回应」了。

> **结论：老板发一句话，5 分钟内界面 100% 无反馈；群里有人说话后，连看门狗都不会救。**

**建议 4 条（都很小）**：①**回执进频道**——`writeAck` 同时 `postToChannel(from:-1, kind:"system", text:"已收到 ·
正在处理（本轮工具结束后）")`（src/server/http.ts:1212，约 10 行）；②**前端乐观回执**——发送成功后立刻在自己气泡下
挂浅灰 `.ch-receipt[data-state="pending"]`「已送达，等回应」（`composer.js`，20 行，**能立刻解决 90% 体感且不依赖后端**）；
③**看门狗判定改严**——`replied` 改成「有更晚的、来自 channel owner 或 @ 目标的消息」（watchdog.ts:577，3 行）；
④**别让老板看到「排队」**——ADR-026 已定，但 `ui/js/board.js:29` 仍有 `queued: "排队"`，删 1 行。

**能不能插队？** 老板通道按 ADR-026 **永不排队**（`POST /api/message` 默认 `whenBusy:"now"`），
所以**频道里不该有任何插入按钮**。但频道消息走 `deliver()`（src/company/deliver.ts:79），注释只说
「只保证进队列、不等回复」，`whenBusy:"steer"`（:138/:238）——**比老板直聊 CEO 弱一档**。
产品不一致：私聊 CEO 是 `now`，「全员」里说话是 `steer`；应统一成 `now` 或在输入框旁标注（§4.3 建议 2）。

### 5.2 「回复」取代「@」之后，从属关系怎么显示？跨频道引用怎么办？

**现状**：后端已做 `MessageView.replyTo = {seq, from, fromLabel, excerpt}`，摘要服务端现算
（`resolveQuoted`，src/server/channels-view.ts:335），**查不到就不下发**；前端 `renderQuote`(:1285)
渲染一行引用块，`setReplyTo`(:432) 支持点消息 → 浮窗 → 回复 → `#ch-reply-bar`。

**问题 3 个 + 对应建议**：

1. **只在同一频道内有效**——`replyTo` 是 `seq`，而 seq 是**频道内**的；跨频道引用（「项目群里那条说的就是这个」）**没有任何机制**。→ 改成 `{channelId, seq}`，前端渲染 `↩ 坦克大战 #42` 可点跳转（`aic:open-channel` 事件已存在，ui/js/app.js:57，**白送的**）。
2. **查不到就静默消失**——消息被 800 条上限裁掉或早于分页时 `replyTo` 不下发，老板看到一条普通气泡，**不知道它在回什么**。→ 查不到时下发 `{seq, missing: true}`，渲染成「（原消息已不在本频道）」。**静默消失 = 老板以为自己记错了，这是「信任」级 bug。**
3. **没有引用链的视觉层次**——1 层能显示，2 层（A 回 B 的回 A）就看不出谁在回谁。→ 深度 > 1 不嵌套，只显示 `↩ 张三 → 李四 → 你`。

### 5.3 流式输出 / 思考过程 / 工具调用，界面怎么显示？该不该显示？

**现状**：**只在私聊显示**（`timelineOf`(:699) + `renderTrace`(:722) + `renderTraceGroup`(:747)，
数据来自 `GET /api/staff/:id/activity`，30 条/页；群聊**完全没有**。`feed-render.js`(91) 的
`renderThinking`/`renderTool` 只被 `channels.js:18` 引入、用在 :728/:730，`trace.css` 280 行专为它服务。

**我的判断：显示，但只显示三层，且要分层折叠。**

| 层 | 老板关心吗 | 建议 |
|---|---|---|
| **正在干什么**（一句「正在跑 npm test」） | **极度关心**——「他是不是卡住了」的唯一答案 | **必须有，且群聊也要有**（现在群聊零信息） |
| **工具调用明细**（name + 参数 + 输出摘要） | 出问题时关心 | 折叠默认收起；**失败的工具调用默认展开**（`renderTraceGroup`(:747) 已这么做，好评） |
| **思考过程**（think 全文） | 几乎不关心，且**可能泄漏内部推理** | 折叠默认收起。现在 `COLLAPSE_LINES` 里 chat 28 行，thinking **没有单独阈值** |

**关键缺陷**：**项目群看不到任何人的 activity**——8 个人在干活，老板只看到他们"说话"。建议 `ChannelView` 加
`working[]: {conversationId, label, doing, since}`，消息流底部渲染一行 `.ch-working`（`小张 正在跑测试 · 小李
正在读代码（12 分钟）`）。**一行字解决「谁在干什么」**，成本：后端 1 个查询 + 前端 20 行。

### 5.4 长消息 / 代码块 / 图片附件 / @人 / markdown 的渲染边界

| 项 | 现状 | 边界在哪 | 判断 |
|---|---|---|---|
| **markdown** | `ui/js/markdown.js` **手写 422 行** + `ui/css/markdown.css` 335 行 | 先 `escapeHtml` 再拼受控 HTML；`SAFE_URL` 白名单，`//host` 拒绝 | **安全边界清楚，好评。** 但 422 行渲染器对内部工具过度投入（§7） |
| **长消息** | `COLLAPSE_LINES = {chat:28, question:28, task:12, ack:6,...}`，`.ch-expand` 展开 | 26em + 渐隐 | 合理。但 **28 行对 1440×900 太高**，一屏只有 ~30 行，等于「每条长消息都占满一屏」。建议降到 16 行 |
| **代码块** | 围栏码 + `.md-code-copy` 复制按钮 | 无横向滚动条样式？ | 缺 `overflow-x: auto`，长命令会撑破气泡。**必须验** |
| **图片** | 看：`lightbox.js`(97) 全局委托，点正文图片放大 ✅。**发：UI 完全不存在**——`POST /api/upload` 零消费者（grep 无命中），但 `docs/WEB-API.md §7` 有完整契约、`postChannelMessage` 已支持 `attachments[]` | 后端已有、前端没做 | **要么做，要么把 WEB-API §7 与 `/api/upload` 一起删。现在是最坏中间态：契约存在但没人实现，后来的 agent 会以为已实现** |
| **@人** | 前端在 HTML 串上替换(:1161) + 灰/绿已读点(:1297) | 偏移量应后端给（§2.2） | 功能对，实现位置错 |

### 5.5 错误 / 超时 / 崩溃 / 模型不可用 —— 这决定老板信不信

| 故障 | 界面表现 | 评价 |
|---|---|---|
| 列表 / 消息体拉取失败 | `renderListError`(:575) / `renderBodyError`(:1456) 各一行字 | 弱但存在 |
| SSE 断开 | `#conn` 显示「重连中」（`app.js:402 setConnected`） | ✅ 有 |
| 服务完全不可达 | `showFatal`(`app.js:411`) 写进 `#graph`，`#stage-sub = "服务未连接"` | ⚠️ **只覆盖组织图区域**。如果老板在频道视图，`#graph` 是不可见的 → **整屏没有任何提示** |
| **agent 崩溃 / 超时 / 模型不可用** | 无。`app.alert` 只在 feed，频道看不到 | ❌ |
| **发送失败 / 被拒（503 undelivered）** | `sendMessage`(:370) 抛错 → `notify` toast，原文**留在输入框**；503 语义 `/api/message` 有、**频道路径没有** | ⚠️ toast 3 秒消失，**没有「重发」按钮**；被拒无声 |
| **后端不可用 → 显示假数据** | `board.js:125 mockBoard()` + `:423` 只改 `title` 和一行 meta 显示「示例数据」 | ❌❌ **这是最危险的一条**：老板看到三列卡片，以为是真任务 |

**建议（按「信任」优先级排序）**：

1. **任何降级为 mock 必须显眼**：顶部持久横条 `⚠ 数据不可用，下面显示的是示例` + 卡片整体斜纹背景。`title` 里写一句不够——老板不会 hover。
2. **全局连接状态条上移到顶栏**，不依赖当前视图（`#conn` 已有 DOM，`showFatal` 也改用它）。
3. **agent 无响应必须在频道里可见**：把 `app.alert` 双写进频道（`kind:"system"`），阈值保留 5 分钟。
4. **发送失败给「重发」按钮**，不要只 toast——原文已在输入框，加一个 `Retry` 就够。
5. **终局必须有一条**（ADR-026 要求「不允许静默结束」）：自己的消息发出后 90 秒内没有对方任何消息，
   就在该消息下渲染 `.ch-receipt[data-state="waiting"]`：`已送达 · 暂无回应（已 90 秒）`。
   **纯前端、零后端改动，却覆盖「模型挂了 / 崩溃了 / 被遗忘了」全部情况。**

### 5.6 焦点与键盘：老板能不能全程不碰鼠标

**现状：不能，差得远。** 全部键位只有 5 处：`⌘K` 循环切视图（ui/js/app.js:419）；`Enter` 发送 / `Shift+Enter`
换行 / `↑↓ Enter Tab Esc` 在 @ 弹层内选择（ui/js/channels.js:1802 附近）；`Esc` 关浮窗与关设置
（channels.js:1781、app.js:243）；`↑ PageUp Home` 仅用于武装上翻哨兵（channels.js:1687）。

**必须支持的快捷键清单（8 组，按价值排序）**：

| # | 键 | 行为 | 理由 |
|---|---|---|---|
| 1 | `⌘1/2/3` | 频道 / 组织图 / 看板（**直接跳，不循环**） | 现在 `⌘K` 只能循环，常要按 2 次才知道自己在哪 |
| 2 | `⌘K` | **改成命令面板**：搜频道 / 搜消息 / 跳任务 | 这个键现在只做循环切换，完全浪费 |
| 3 | `⌘F` | 在本频道内搜索 | **全局没有任何搜索**（grep `search` 只命中图标定义） |
| 4 | `⌥↑/⌥↓` | 上一个 / 下一个频道 | 老板高频动作 |
| 5 | `⌘⏎` | 强制发送（忽略 IME） | 中文输入法下 `Enter` 常被吞 |
| 6 | `Esc` | 清空回复条 → 再按一次收侧栏（现在只关浮窗） | 后退路径 |
| 7 | `⌘⇧U` · `⌘/` | 跳到下一个未读 · 快捷键帮助 | 未读现在只能看不能跳；可发现性 |
| 8 | `↑`（输入框空时）/ `R` / `A` / `⌘Z` | 编辑上一条 / 回复选中 / @ 人 / 撤回刚发 | Slack 肌肉记忆，替掉「点浮窗」；老板会发错话 |

**必须先做 1–6** —— 覆盖 90% 键盘场景，**都不需要后端改动**。

**另外两个焦点缺陷**：①`applyView`(app.js:302) 切视图**不移动焦点**，键盘用户切到频道后焦点还在顶栏，
要 Tab 十几次才到输入框（切视图后 `input.focus()` 即可）；②新消息到达**不提示**——粘底被用户上翻
打断后新消息静默堆积，需要 `.ch-jump-new` 浮动按钮（「↓ 3 条新消息」）。

---

## 6. 界面元素 → 数据来源 → 现状问题

| 界面元素 | 数据来源 | 现状问题 |
|---|---|---|
| **组织图** `#org` | `GET /api/stream/org`（SSE，唯一实时源） | ①**点击无任何反应**（`org.js:32 onSelect` 从不调用），却占 1095 + `edges.js` 334 行 ②默认首页但信息半衰期最长 ③背后是 `starfield.js` 342 行 + `three.module.js` **691648 字节** |
| **频道列表** `#ch-list` | `GET /api/channels`（每次 `aic:org` 事件 + 400ms 节流重拉全量） | ①**每次全量重拉**，没有增量 ②排序在后端（`channels-view.ts:167`）✅ 但前端 `renderList` 又自己分组一遍 ③`preview` 后端截 80 字，前端再截一次 ④**没有搜索/筛选**（11 个频道还行，20 个就崩） |
| **消息流** `#ch-body` | `GET /api/channels/:id`（**没有 SSE**，靠 `aic:org` 事件触发重拉） | ①**违反 ADR-008「订阅驱动不轮询」/ ADR-021「数据只走一个流」**：`/api/stream/feed/:id` 存在但**零消费者** ②`viewSignature`(:171) 手拼 30 行签名做变更检测 ③`patchBody`+`signatureOf` 68 行补丁的补丁 ④待办卡永远 append 在最后(:1039)，与时间序无关 |
| **看板** `#board` | `GET /api/board`，**9 秒轮询**（`board.js:509`） | ①**轮询**，违反 ADR-008 ②**doing 列不读 TaskDoc**（`src/server/board.ts` doing = `status === "busy"`），违反 ADR-030 ③**后端挂了静默显示 mock 假数据**（`board.js:125/423`）④与频道侧栏是**两套任务语义** |
| **待办** | `GET /api/pending`（**零消费者！**）+ `ChannelView.pending` | ⚠️ 路由存在但 ui/js grep 不到 `api/pending`。待办是**通过频道视图的 `pending` 字段**拿到的（`pending.js` 用 `/api/answer` `/api/pending/dispose` `/api/pending/take-over`）。`GET /api/pending` 是死接口 |
| **档案** `#ch-dock` | `GET /api/profile/:conversationId` | ✅ 唯一「按需加载、失败降级为 null」的干净模块（`profile.js` 342 行）。**但只在私聊可开**（`#ch-fold` 仅 dm 显示）——项目群里想看「这个员工有什么工具」没有入口 |
| **工作记录** | `GET /api/staff/:id/activity?limit=30&before=` | ①**只在私聊**，群聊零信息 ②`ACTIVITY_PAGE = 30` 手写死值 ③哨兵四件套（`arm`/`disarm`/`observe`/`onUserScrollAttempt`）只为它存在 ④**历史踩坑**：注释记载「私聊打开时哨兵连拉 17 页导致消息不停乱滚」——这是设计脆弱性的直接证据 |
| **设置** `#aside-slot` | `GET/PATCH /api/settings`、`POST/PATCH/DELETE /api/models` | `settings.js` **1239 行**：「模型/IM/网络/主题」3 表单 + 3 套校验 + 3 套提交塞一个文件——**和「聊天」无关的运维界面，行数是 `channels.js` 的 66%** |
| **重连提示** `#conn` | SSE `onerror` → `setConnected(false)` | ✅ 有。但 `showFatal`(app.js:411) 只写 `#graph`，**频道视图下整屏无提示** |

**汇总**：

- **重复请求**：`GET /api/channels`（列表）与 `GET /api/channels/:id`（详情）每次 `aic:org` 都可能各拉一次，而列表是详情的子集 → 一次事件 2 个请求；看板另有 9s 轮询。
- **前端推导**：`viewSignature`(171)、`signatureOf`(1124)、`extractMentions`(412)、`highlightMentions`(1161)、`dayKey/dayLabel`(1252)、`elapsedLabel`(1441)、`timelineOf`(699)、`preview` 二次截断。
- **无后端支持**：回执/排队、`acceptance`/`blockedReason`/`evidence`、群聊 activity、`@已读 N/M`、跨频道引用、消息内搜索、附件 UI、`taskId` 反向链接。
- **有后端但零消费者**：`GET /api/pending`、`GET /api/feed/:id`、`GET /api/stream/feed/:id`、`POST /api/interrupt`、`POST /api/upload`——**五个接口白写**。

---

## 7. 前端该砍什么

14775 行对「老板和 AI 公司聊天」**太多了**。取舍原则：**能换回「信任」的留，只提供「氛围」的砍。**

### 7.1 直接删（零损失）

| 模块 | 行数 | 理由 |
|---|---|---|
| `ui/js/starfield.js` + 相关 CSS | 342 | 为不可交互的背景背 **`three.module.js` 680KB**。`app.js:475` 已用 `requestIdleCallback` 延迟加载——**连作者都觉得它是负担**。换 CSS 渐变：**省 680KB + 342 行**，视觉损失近乎零 |
| `ui/js/edges.js` | 334 | 组织图的连边动画。组织图本身点击无反应（`org.js:32`），**一条不参与交互的装饰线 334 行** |
| `ui/js/dev-fixtures.js` | 210 | 仅 `?dev` 使用（`app.js:452` 动态 import）。移到 `scripts/` 或 `test/` |
| `board.js:125 mockBoard()` | ~95 | **显示假任务**。这是信任风险，不是功能。后端挂了就该说「拿不到」 |
| 5 个零消费者后端接口：`GET /api/pending`、`GET /api/feed/:id`、`/api/stream/feed/:id`、`POST /api/interrupt`、`POST /api/upload` | — | 要么用起来（附件/中断），要么删掉以免误导 |

### 7.2 大幅压缩

| 模块 | 现状 | 目标 | 手段 |
|---|---|---|---|
| `ui/js/markdown.js` | **422 行手写渲染器** + 335 行 CSS | **≤ 120 行** | 正文真实需求只有 6 样：粗体/行内码/围栏码/链接/列表/引用。表格、任务列表、图片、h1–h3 都是「因为能写所以写了」；删表格与图片语法（图片走附件）→ 约 120 行，CSS 335 → 150 |
| `ui/js/settings.js` | **1239 行** | 拆 3 文件，各 ≤ 350 | 模型 / IM / 网络+主题。三个表单**互不共享状态**，只是被塞在一起 |
| `ui/js/profile.js` | 342 | **保持** | 已是最佳实践（按需、降级为 null、无状态泄漏） |
| `ui/css/channels.css` | 1380 | ≤ 900 | 86 个 class 只有 2 个无引用，**冗余不在这里**；真冗余是同一件事写两遍：`.ch-trace` 与 `trace.css` 的 `.think`/`.tool` 语义重叠（trace.css 280 + channels.css:1113-1169） |
| `ui/css/graph.css` | 1155 | ≤ 300 | 组织图若降为二级入口，卡片质感可大幅简化 |

### 7.3 合并

| 合并 | 理由 |
|---|---|
| `board.js` 与 `channels.js:renderTasks` | 同一个 `TaskEntry` 两种渲染（`cardHtml` vs `taskRowHtml`）→ 一个 `task-card.js` |
| `trace.css` 与 `channels.css` 的 trace 段 | 285 行说同一件事 |
| `feed-render.js`(91) 归入 `chat/stream.js`；`dom-utils.js`(35)/`format.js`(272)/`icons.js`(83) **保留** | 前者只有 channels 一个消费者；后三者是真公共库（`format.js` 被 10 个模块引用） |

### 7.4 砍完的账

账：`14775 − 342(starfield) − 334(edges) − 300(markdown) − 700(channels 拆分) − 200(board mock/合并) − 900(CSS) ≈ 12000 行`。
若再加上后端补 5 个字段（`rev` / `items` / `taskId` / `working[]` / ack 进频道），可再降 400 → **约 11000 行**。
**我的立场：14775 → 11000 是诚实的目标；再多就是砍功能，不是砍代码。**

---

## 8. 验收：改完怎么证明变好了

### 8.1 可脚本化的界面断言（8 条，加进 `scripts/ui-check.mjs`）

工具现成：`npm run ui:check -- --url http://127.0.0.1:7788/`（**默认连 7789，必须显式传**）、
`npm run ui:shot -- --url ... --out ...`。每条都用 `cdp.eval` 取纯数据 + `check()`，**不做像素比较**（动画下必假）。

| # | 断言名 | 断言内容（真实可达的 DOM 事实） |
|---|---|---|
| 1 | **默认首页是频道 + 首屏不加载星空** | 首屏 `body.dataset.view === "channels"`、`#ch-list` 有 ≥1 行；`performance.getEntriesByType("resource")` 里**没有** `three.module.js`（钉住 §4.2 与 §7.1） |
| 2 | **发消息 3 秒内出现回执** | 在输入框打字 + 点发送，`sleep(3000)` 后：该 `data-seq` 气泡下存在 `.ch-receipt`，且其 `textContent` 匹配 `/已送达|已收到|等回应/` |
| 3 | **不出现「排队 / 立即处理 / 插入」字样** | 遍历 `#channels` 全部 `textContent`，`!/已排队|立即处理|插入/`（ADR-026 决策 7 的机读版） |
| 4 | **私聊与群聊头部文案不同** | 打开第一个 `dm:` 行取 `#ch-sub`，再打开第一个 `project` 行取 `#ch-sub`，断言 `dmSub !== projSub` **且** `dmSub` 匹配 `/只有|仅/`（隐私提示存在） |
| 5 | **任务卡能展开出验收标准** | 在有 `task` 消息的频道里点第一张任务卡，断言出现 `.ch-task-detail` 且其文本包含 `TaskEntry.acceptance` 的前 8 个字（从 `/api/channels/:id` 现取，避免硬编码） |
| 6 | **看板与侧栏是同一批任务** | 取 `/api/board` 全部 title 集合 A，切到频道视图读侧栏 `#ch-tasks .ch-task-title` 集合 B，断言 `A ∩ B` 非空（ADR-030 的机读版：两边必须能对上） |
| 7 | **降级为 mock 时页面必须显眼标注** | `?dev&mock=1`（或断网模拟）下断言存在 `[data-mock="true"]` 元素 **且**其 `getBoundingClientRect().height > 0`（不是 `display:none`） |
| 8 | **12 条快捷键至少 6 条可用** | 依次 `press:Meta+1`/`Meta+2`/`Meta+3`/`Escape`/`Alt+ArrowDown`/`Meta+Slash`，断言每次 `body.dataset.view` 或焦点位置按预期改变 |

**最关键的是 #1、#2、#3、#6** —— 各自钉住一个架构结论，改回去就立刻红。

### 8.2 必须人眼看的三场（脚本断言看不出来的）

| # | 场景 | 看什么 | 为什么脚本不行 |
|---|---|---|---|
| 1 | **老板说一句话，CEO 正在忙** | ①1 秒内有没有「已送达」②回执排版是否**不抢眼但不消失** ③30 秒后是否变「暂无回应」而非一直「正在处理」 | 这是「信任」问题，判据是**体感**：老板会不会怀疑没发出去 |
| 2 | **项目群 + 私聊来回切三次** | ①滚动位置还在原位吗 ②有没有「消息乱滚」（踩坑：哨兵连拉 17 页）③私聊的灰字流水在群聊里是否**不存在** | 滚动是时序 + 视口耦合，headless 不稳；「乱滚」恰好是人眼最好判的 |
| 3 | **`npm start` 后 `kill` 掉服务再点几次** | ①顶栏有没有**不依赖当前视图**的红/黄条 ②看板是否停止显示「看起来是真的」卡片 ③恢复后是否自动复原 | 故障态的产品感只能看。这是老板「信不信」的决定性 30 秒 |

---

## 9. 一句话总结（留给交叉辩论）

**前端不缺功能，缺的是「后端已经把话说清楚」这个前提。**`channels.js` 1874 行里 grep 得出至少 8 处
「前端替后端算」：`viewSignature`(171)、`signatureOf`(1124)、`extractMentions`(412)、
`highlightMentions`(1161)、`dayKey`(1252)、`elapsedLabel`(1441)、`timelineOf`(699)、`preview` 二次截断。
每补一个后端字段就少一段推导，就少一次「两边算出不同结果」的可能。

**我这一席最容易被反驳的地方**：我说「默认首页改成频道、组织图降级」，但组织图是这套系统
**唯一的空间感来源**——「一人公司」这个产品概念的视觉承担者就是它。若 B 席或 A 席认为
「老板打开就想看见自己的公司长什么样」，这条我要退让。**我守的底线：默认视图必须是「变化最快」的那个；
如果组织图能承载变化（把「谁正在忙」画在节点上），它就有资格当首页。**
