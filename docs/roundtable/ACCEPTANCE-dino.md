# 真实验收：小恐龙游戏 + 中途插入音效

**执行时间**：2026-10-27 04:27 – 04:35
**分支**：`feat/slim-and-chat`（commit `8a4575c`）
**环境**：隔离实例 `--port 7801 --db /tmp/dino-ws/company.sqlite --workspace /tmp/dino-ws`，真实模型走本地网关 `127.0.0.1:3425`（`auto/deepseek-v4.1-flash`）。生产库未触碰。

---

## 一、结论

| 验收项 | 结果 | 证据 |
|---|---|---|
| 老板一句话能启动整条链路 | **通过** | `POST /api/channels/dm:1/messages` → `{ok:true, seq:1, delivered:[1], failed:[]}` |
| 立项 | **通过** | `GET /api/channels` 出现 `proj:dino-game`（kind=project），成员 5 人 |
| 按职责配人（B1 改动） | **通过** | 名册 `dino-lead` tools=read/write/edit/bash、`dino-dev` 同；管理层工具栏只有管理类 |
| 派活 + 状态机 | **通过** | T-1 done / T-2 done / T-3 cancelled / T-4 cancelled / T-5 复核 |
| 产出可运行文件 | **通过** | `/tmp/dino-ws/projects/dino-game/index.html`，11893 字节，headless Chrome 截图见 `m01246` |
| 中途插需求「音效」 | **通过** | WebAudio `createOscillator` ×2 + `AudioContext` ×3，无外部资源，仍是单文件 |
| 记忆系统首次真正工作（M1/M2） | **通过** | `memory_write` 调用 **3 次**、`app.memory-hint` **2 条**、`app.memory` 文档存在且 **6 条**记忆。对照：生产库 `memory_write` 0 次、`app.memory` 0 条 |
| 投递回执（B4） | **通过** | `app.channels` 文档里 `deliveredTo` 已落库；`submissions` 无 `unanswered` |
| 前端默认视图（F1） | **通过** | `GET /api/org` 返回的 actor 已含 `unanswered` 字段 |
| `openTasks`（F2） | **通过**（列表级） | `GET /api/channels` 的每条都带 `openTasks`；频道详情走 `tasks` 数组（见发现 3） |
| 老板收到回执（`app.ack`） | **通过** | 2 条 `app.ack`，`plan:"立即处理"`，与老板发的 2 条消息一一对应 |

**总评：链路是通的，产出是真的，记忆和回执这两块新功能第一次在生产形态下跑起来了。**
但暴露出 **4 个真实缺陷**，其中 2 个是本次改动没覆盖到的老问题。

---

## 二、发现的问题

### 1（严重）两个 agent 抢写同一个文件，靠「频道里喊话」协调

`dino-lead` 和 `dino-dev` 同时对 `index.html` 有 write 权限，且都被派了「写这个文件」的任务。
`dino-dev` 直接把 `dino-lead` 已通过自测的版本覆盖了，`dino-lead` 在频道里发现：

> 「@dino-dev 停手：index.html 刚被你的版本覆盖了我已通过自测的版本（#25 我说过这个文件由我持有）」

最后靠 `dino-lead` 手工备份、靠喊话"请不要再写"收场。

**这不是 UI 问题，是能力粒度问题**：`tools: ["read","write","edit","bash"]` 是**整个工作空间**的写权限，没有文件级/目录级隔离。B1 把「角色决定能力」改成了「显式声明能力」，但**声明粒度还停在「有没有 write」**，没有到「能写哪个目录」。

这也解释了为什么 CEO 一开始派了 T-2，CHRO 又派了 T-3，负责人又拆出 T-4——**同一件事三张单**。记忆里 `dino-lead` 自己写下了这条教训：

> 「CEO 派活先立项再派单，避免 T-2/T-3/T-4 重复」

### 2（中等）管理层的 charter 里写着「实测名册」，但它没有 `bash`/`read`

`CHRO` 在频道里说：

> 「我（CHRO）名下工具同样只有名册/任务/频道类，没有 bash/read，无法实地打开文件」

而 `src/company/roles.ts` 里 CHRO/CPO 的 charter 都有「用 `staff_list` 实测名册」「按原始输出审」这类要求。**它们能拿到名册是对的（`staff_list` 在 capabilityNames 里），但 charter 里出现「实地核验」「跑一遍」就会诱导它们承诺做不到的事**，然后在频道里反复对齐「我不能实地验」——这一轮里 CPO 和 CHRO 花了 **4 条长消息**（`leadership` #48–#51）专门对齐这件事。

### 3（轻微，但文档口径不一致）`openTasks` 只在列表级，详情级用的是 `tasks[]`

- `GET /api/channels` → 每条 `ChannelListItem` 有 `openTasks: number`（F2 用的就是这个）
- `GET /api/channels/:id` → **没有 `openTasks`**，返回的是 `tasks: TaskEntry[]` 数组

前端 `channels.js` 消费的是列表级的那个，所以 F2 生效了。但 D 席当初报的是「频道详情里 `/api/channels/:id` 也算了 `openTasks` 却被前端丢弃」——实际是**两个接口形状不同**，`channels-view.ts:46` 的 `openTasks` 只出现在 `ChannelListItem`，`ChannelView` 用的是 `tasks`。**D 席和我在这一点上都读错了地方**。不算 bug，但值得在 `docs/WEB-API.md` 写清。

### 4（设计疑问）老板在 dm 里说话，`app.ack` 写进了 CEO 的会话流，但**频道里看不到**

`app.ack` 有 2 条，`plan:"立即处理"`，时间与老板发言对齐（1793046450628 / 1793046560123）。但它仍然只进**会话流**（`type:"write"`），`src/server/feed.ts` 能渲染、**频道视图拿不到**。这正是 D 席首轮指控的「老板发完消息界面零反馈」，本次**没有修**（VERDICT 把它排在 B4 之外）。

上面的 `deliveredTo` 是给看门狗用的，不是给界面用的。**老板在自己发的消息下面看不到「已排队 / 处理中 / 已完成」**。

---

## 三、圆桌预测 vs 实际

| 圆桌时的判断 | 实际 | 判定 |
|---|---|---|
| E 席：「改需求『加音效』**预测必卡**，因为 `task_update` 不接受 `dependsOn`，只能 cancel + 新建，trail 断裂」 | 制度上确实走了「T-4 取消 → T-5 复核」，**但需求本身没有断链**：CPO 直接更新了 PLAN.md（6 条 → 7 条），CHRO 在 `company` #31 明确「音效进范围」，负责人照着改代码。**断的不是需求，是任务谱系** | **部分成立** |
| C 席：「`wakeOnAll` 让负责人被 141/141 唤醒」 | 项目群 26 条消息，负责人 `dino-lead` 每条都在响应，且**它自己也在高频发言**（#25、#52、#55、#60 都是长消息）。真正的问题不是被唤醒太多，是**它同时是执行者和协调者**，两件事互相打断 | **症状对，归因偏了** |
| E 席：「验收六步：③派活后 submissions 里必须有一条不是 `unanswered`」 | 全部 `done`（38 条），无 `unanswered` | **通过** |
| B 席：「先花 3 行接通记忆回路」 | 3 次 `memory_write` + 6 条记忆 + 2 条 hint，**记忆第一次有内容**，而且内容质量不低（写的是「配人别先招后撤」「派活别三张单」这类可复用教训） | **成功** |
| A 席：「`STAFF_ROLE_TEMPLATES` 是隐蔽 bug」 | 管理层建人时明确写 `tools`，`dino-lead` 拿到 `read/write/edit/bash`，`dino-dev` 同。**没有出现只读员工** | **修复有效** |

---

## 四、B4 投递回执的实际观察

- `deliveredTo` 已落库（在 `app.channels` 的 base 里能查到该字段）
- `submissions`：`done 38 / placed 47 / queued 1`，**`unanswered` 0 条**
- 也就是说：**这一轮没有触发重投路径**。回执的价值在这一轮体现为「事后能查到每条消息落到了哪个 submission」，而不是「救回了死消息」。

> 真实触发需要 `no_model` 这类失败。生产库历史上那 69 条就是 `reason=no_model`。
> 建议验收时手工制造一次：把某个员工的 `modelId` 改成不存在的，看 30 秒后是否出现 `redeliver` 告警。**这一步本轮没做**。

---

## 五、下一步建议（按价值排序）

1. **能力粒度到目录**：`tools: ["write:src/"]` 这种形式，或 `staff_hire` 加 `scope` 字段。当前「所有开发都能写整个项目目录」在多人协作时必然撞车。这是本轮实测暴露的最有价值的问题。
2. **`app.ack` 进频道视图**：老板发的消息下面应当能看到 `已排队 / 处理中 / 已完成 / 对方未处理（unanswered）`。数据全都有（`app.ack` + `deliveredTo`），只差投影到 `MessageView`。
3. **管理层 charter 去掉「实地核验」类措辞**：`roles.ts` 里 CPO/CHRO 的话术要与其真实工具集一致，否则它们会花 token 反复对齐「我做不到」。
4. **手工触发一次 B4 重投**：改一个员工的 modelId 为空，验证 30 秒后的 `redeliver` 告警与 `giveUp` 上限。
5. **派活去重**：CEO/CHRO/负责人三处都能创建任务，本轮出现 T-2/T-3/T-4 三张同单。记忆里已经记下教训，但**机制上没有拦**（没有「同一 channel 下 open 任务标题相似度」检查）。

---

## 六、§5 五条的落地情况

> 本节记录「建议」变成「代码」的实际结果。每条都附**可复跑的证据**，因为
> 这一轮最大的教训就是「结论必须能说出它是怎么量出来的」。

### 1 能力粒度到目录 —— 做了

`tools` 从「工具名的集合」升级成「带作用域的工具名」：`["read", "write:src/", "bash"]`。
底层 `createWriteTool()` 不接受 root 参数（`node_modules/@earendil-works/pi-durable/dist/tools/write.js`
直接拿 `env.absolutePath()` 的返回值写），所以作用域由业务层自己包装（ADR-035）。

关键约束：路径比较必须在**归一化之后**按分隔符边界进行，`/proj/src` 不能匹配 `/proj/src-evil`。
`bash` 故意不做作用域——它的逃逸面（`cd ..`、`sh -c`、`$(...)`）无法用字符串前缀拦住，
半吊子的限制比没有限制更危险。这个取舍写进了 ADR-035 而不是藏在注释里。

### 2 `app.ack` 进频道视图 —— 做了

`writeAck()` 现在带 `messageSeq`，`MessageView.acks[]` 把「已排队 / 当前工具 / 立即处理」
投影到对应的那条消息上。界面显示为消息下方的弱化小字，不占正文位置。

**没有**把 ack 塞进 `deliveredTo`：那个字段是 `redeliverUnanswered()` 的遍历依据，
混入非投递记录会让重投逻辑数错次数。

### 3 管理层 charter 与真实工具集对齐 —— 做了

`roles.ts` 的 CPO / CHRO / `COMMON_GUIDE` 三处改话术，并新增
`test/unit/role-charter.test.ts`（6 条）钉住「文案不许承诺工具集里没有的能力」。

**这条测试第一次跑就抓到了我自己刚写的文案**——CPO 的新守则里有一句
「不要写『你亲自确认一下』」，正则命中了「亲自确认」。修法不是删守则，而是让检查器
区分「禁止」与「承诺」：按句号/分号/冒号切小句，命中词所在小句里带「不 / 别 / 禁止」
就不算承诺。一个分不清这两者的检查器会逼人把守则改得模糊才能变绿——那比没有测试更坏。

### 4 手工触发 B4 重投 —— 做了，且发现了真库从未走过这条路

第一次尝试（把真库副本里一条已有回执的 submission 结算成 `unanswered`）**什么都没发生**。
原因不是代码错，而是 `applySubmissionChange()`（`dist/session/transaction.js:13-14`）
对已结算的记录**直接返回原文**：

```js
if (current.status === "done" || current.status === "unanswered") return current;
```

改成「新发一条消息 → 把它的 submission 结算成 unanswered → 跑一轮巡检」之后，
完整生命周期在**真公司库的副本**上跑通了：

```
[probe] 频道 = proj:dino-game 成员 = 0,90,183,216,224
[probe] 新消息 seq = 161
[probe] 第 1 次结算 unanswered → submission 2940
[probe] unanswered 计数 = [[90,1]]
[probe] 巡检 1: redeliver=1  giveUp=false attempt=1 :: …第 1 次重投已入队。
[probe]   回执条数 = 2
[probe] 巡检 2: redeliver=1  giveUp=false attempt=2 :: …第 2 次重投已入队。
[probe]   回执条数 = 3
[probe] 巡检 3: redeliver=1  giveUp=true  attempt=3 :: …连续 3 次未被处理（no_model），已停止自动重投，请人工看一眼。
[probe]   回执条数 = 3
```

两轮后 `giveUp` 且回执不再增长——上限与「放弃也要安静」都成立。

**顺带得到一个答案**：小恐龙那一轮 190 条 submission **全是 `done`**，一条 `unanswered` 都没有。
所以 B4 的重投路径在真实运行中一次都没被走到。这不是缺陷（没坏消息要救），
但它说明「回执能救回死消息」这个价值主张**尚未被真实场景验证过**，
本节的探针是目前唯一的证据。

### 5 派活去重 —— 做了

`src/domain/tasks.ts` 新增 `findDuplicate()`，`validateCreate()` 在建单前拦一道。
判据故意宽（`theirs === mine || theirs.includes(mine) || mine.includes(theirs)`）：
目的是「让人抬头看一眼」，不是精确判重。报错文案给两条出路——就是同一件事就用
`task_update` 在原任务上继续；确实不是就把标题写具体，让区别出现在标题里。

三个设计取舍：

- **跳过终态**。否则一个项目做完一轮，同名任务再也建不了。
- **跨项目不拦**。「修复登录」出现在两个项目里通常是两件事。
- **标题归一化去掉前缀与标点**（`【新任务 T-1】登录接口加 Token 过期处理`
  与「登录接口加token过期处理」判为同一件），否则 `【…】` 前缀会让判重全部失效。

`test/unit/domain-tasks.test.ts` 新增 6 条覆盖上述边界。

### 未做

- `duplicateOf` 没有透传到 `CreateTaskResult`。`exactOptionalPropertyTypes: true` 下
  `string | undefined` 不能赋给可选 `string`，实测 TS2322。它只在 domain 层的
  `Validation` 里存在，够用（报错文案里已经带了被撞任务的编号）。
