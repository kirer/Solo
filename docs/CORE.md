# 新核心（`src/core/`）

旧核心（`src/company` + `src/domain` + `src/server` + `src/tui`）还在，能跑，但它把
「组织」写进了代码：七个管理层岗位是枚举、每个岗位的提示词是模板字符串、能力是工具名
数组、待办/任务/成本/升级链各有自己的文档。改一个岗位要改代码、改一次提示词要重新部署。

`src/core/` 是第二代，只有一条原则：

> **组织是文件，不是代码。** 一个人就是一个文件夹；文件夹里的字决定他是什么人。

## 一个人是什么

```
workspace/agents/<slug>/
  identity.md      ← 他是谁（唯一必需）
  memory.md        ← 他记住了什么（他自己写、自己改）
  skills/<名字>/SKILL.md  ← 他会怎么做一件事
```

`identity.md` 只有四个可选的头部字段：

```markdown
---
name: 林越
title: 技术负责人
manager: 助理
project: demo
---

正文是你写的：职责、边界、工作方式。
```

**没有第五个字段，也没有岗位枚举。** 谁是「技术负责人」不是代码决定的，是某个人在
`identity.md` 里写下的；组织架构不是常量表，是把所有 `identity.md` 的 `manager` 连起来
得到的树（`chainUp` / `reportsOf`）。断了、绕成环，都只是「这条汇报线断了」，不崩。

## 提示词是**投影**，不是原文

`renderAgentPrompt({ self, all, ... })` 把「所有人 + 项目 + 技能目录 + 记忆目录 + 注册表里的
全部工具」投影成一段提示词：

- 段落顺序固定、内容确定性（同一输入逐字节相同）——为了 prompt cache 不被打穿；
- 不哄人：查不到的写「（未设置）」；
- **每次渲染都重读磁盘**（`agentSection` 的 `render` 是函数），所以改 `identity.md` /
  `memory.md` / `skills/` 之后**下一条消息就生效**，不用重启、不用重开会话。

这一条把「改我自己」和「改组织」变成同一个动作：写文件。

## 能力是**热**的，而且**不分层**

- 工具只有一套，人人都有（`registeredTools` 直接从注册表实拍，不读任何清单文件）。
  旧核心按岗位发工具包，「员工不能越级」靠少给工具实现；新核心靠提示词约束纪律，
  工具一视同仁。
- 「你能调用的工具」这一段是注册表的投影：注册表里有什么就写什么，删了工具这段话自动
  少一行。**不**手写清单 —— 手写的清单一定会漂，而漂了的提示词就是在撒谎。
- 新增能力 = 往注册表 `install` 一个 extension（一根代码手指头，比如 `bash`）；不需要
  重新部署，也不需要改任何人的身份。
- 想教 agent「怎么用这些手」，用**技能**（`skills/`），不要改代码。

## 通信是**平级**的

所有 agent 用同一套工具说话，没有「向上汇报」专用通道，也没有「管理层才能用」的工具：

| 工具 | 作用 |
| --- | --- |
| `say` | 在频道里说一句（不唤醒） |
| `ask` | 说一句并唤醒被 @ 的人 |
| `read_channel` | 读某个频道最近的对话 |
| `inbox` | 我还没读的 |
| `channels` | 我能在哪些频道说话 |
| `whoami` | 我是谁（渲染后的自我） |
| `org_chart` | 现在公司长什么样 |
| `hire` | 新建一个 agent（写文件夹 + 开会话 + 拉进公司频道） |
| `update_identity` | 改自己或直接下属的 `identity.md` |
| `remember` / `recall` | 写/读我自己的 `memory.md` |
| `remember_project` / `read_project_memory` | 写/读 `projects/<slug>/memory.md` |
| `list_skills` / `read_skill` / `write_skill` | 技能：公司层 + 个人层，同名个人层覆盖 |
| `find_skill` | 去开放技能市场（skills.sh / GitHub）搜或装现成的 |
| `list_projects` / `read_project` / `write_project` | 项目：`projects/<slug>/README.md` |

「层级」不在代码里，在提示词里：某个人的 `identity.md` 写着「你向助理汇报」，他自己
就知道该找谁；写「有问题只能向项目负责人汇报」，他就不会越过负责人去找老板。代码只
保证事实（谁能收到消息、谁的目录归谁），不保证纪律。

频道是 `core.channels` 一份文档：`Message{seq, from, at, text, mentions[], replyTo?, kind}`
+ `Channel{id, title, members[], wakeOnAll[]}`。收件人四条规则：显式 @ 且是成员 /
老板没 @ 任何人时给第一个非老板成员 / `wakeOnAll` / 减去发件人。**引用回复等于 @ 作者**。

## 文件夹就是边界

```
workspace/
  skills/<名字>/SKILL.md        公司层技能：全公司通用
  agents/<slug>/
    identity.md                 他是谁：名字、岗位、上级、所在项目、正文
    memory.md                   他自己的记忆（可改，不是只增）
    skills/<名字>/SKILL.md      个人层技能：只有他看得见，同名覆盖公司层
  projects/<slug>/
    README.md                   这个项目要做什么、谁负责、什么不做
    memory.md                   这个项目发生过什么（项目里的人写，全公司能读）
  core.sqlite                   频道消息、名册（都是可从文件夹重建的投影）
```

名册（`core.agent.roster` 的 `core.directory` 文档）只是 slug ↔ 会话 id 的缓存，删了能从
文件夹重建；频道消息是真历史，删了就没了。

**三级不是设计出来的顺手分层，而是三种不同的变化频率**：公司通用做法几个月改一次、
一个人的手艺天天加、一个项目的坑一次就踩完。混在一起，改一处就得动全部。

| 归属 | 谁写 | 谁读 | 换了人还在吗 |
| --- | --- | --- | --- |
| `agents/<slug>/*` | 他自己 | 他自己 | ✗ 跟着人走 |
| `projects/<slug>/memory.md` | 这个项目的人 | 全公司 | ✓ 跟着项目走 |
| `skills/`（公司层） | 谁都能写（`scope=company`） | 全公司 | ✓ |

## 跑起来

```bash
npm run core -- --port 7790 --workspace workspace-core
```

第一次启动会播种一个「离老板最近的人」（`agents/助理/identity.md`）。之后在界面里跟他说
话，让他招人 —— 他会自己写 `identity.md`、自己建文件夹。没有 `--seed` 就不播种。

### 界面

服务直接把 `ui/web/` 当静态目录发出去（`src/core/shell/serve.ts` 的 `uiDir` 默认值），
所以**没有构建步骤**：改 `ui/web/` 里的文件，刷新浏览器就生效。

```
ui/web/
  index.html      一个骨架：顶栏 / 左栏列表 / 右栏对话
  css/app.css     一个文件，九个颜色变量，4px 栅格
  js/app.js       唯一有状态的模块（一个对象 + 三个渲染函数）
  js/api.js       只有 fetch 与 SSE，错误处理在这里统一
  js/markdown.js  纯函数渲染器（与旧前端共用一份拷贝）
  js/format.js    时间 / 头像色 / 剪贴板
```

三条规矩（旧前端 14533 行、1952 行的 `channels.js` 就是破这三条的代价）：

1. **只画后端真的有的东西。** 没有待办就不画待办卡，没有 trace 就不留占位。
   旧页面为了填满布局画了一堆恒空的块，看的人分不清是「没有」还是「坏了」。
2. **一个区域整体替换**（`replaceChildren`），不做增量 patch。一个频道几百条消息时
   这比 diff 更快，也更难写错。
3. **`[hidden]` 必须真的藏住**（`css/app.css` 里有一条 `display: none !important`）。
   类选择器里的 `display: flex` 会顶掉浏览器默认的 `[hidden]`，于是「本该藏起来的
   引用条」永远挂在输入框上方 —— 旧前端就是这么坏的。

实测过得通的一条链：老板说「招一个技术负责人叫林越」→ 助理 `hire` → 文件夹出现、
会话开出、自动进公司频道 → 助理在群里 `@林越` → 林越开口向老板报到。

跑真实模型的端到端自测（会花 token，平时不进 `npm test`）：

```bash
npm run core:live
```

它验七件事：被 @ 会回话 / 技能热更新生效 / 项目说明进提示词 / `remember` 真落盘 /
`recall` 真读回 / 公司层技能真写到了工作区根 / 项目记忆真落盘。

## 技能：能写成说明书的事就不写代码

一门技能是一个目录 + 一份 `SKILL.md`（YAML 头只有 `name` / `description`）：

```markdown
---
name: 招人
description: 需要一个人来做某件事时，怎么决定招谁、写什么身份、给什么边界。
---

# 招人
## 先问三个问题
...
```

- **`name` + `description` 常驻提示词**，正文按需 `read_skill` 读。一个人攒 20 门手艺，
  常驻的是 20 行描述，不是 20 篇正文 —— 这是成本上最要紧的一条。
- 改文件 → **下一条消息生效**，不重启、不重新部署。
- agent 自己就能 `write_skill` 长出新技能。播种时写两份**公司层**技能：`立项`、`招人`。
- `write_skill` 的 `scope=personal`（默认）写进自己的目录；`scope=company` 写进工作区根的
  `skills/`，所有人立刻看得见。同名时个人层覆盖公司层 —— 这是「我这个人跟公司不一样」
  的唯一机制，没有别的开关。
- **不必自己造技能市场**：`find_skill` 直接调 `npx skills find` / `npx skills add`，
  生态在 skills.sh 和 GitHub 上。装完别直接用，按我们的话重写一遍。

判断边界：「做什么」是身份（`identity.md`），「怎么做」是技能（`skills/`），「发生过什么」
是记忆（`memory.md`）。三条都不在代码里。

## 项目：一份 README.md

`projects/<slug>/README.md` 的 YAML 头有 `name` / `owner` / `status`，正文写目标、验收标准、
什么不做、进展到哪。`agents/*/identity.md` 里写 `project: <slug>` 的人，提示词里会自动出现
这份说明 + 项目成员名单。

「什么时候该立项」不在代码里 —— 那是判断，写在助理的 `立项` 技能里。

## 目录

```
src/core/
  runtime/   openCore + 防腐层
  agent/     identity（他是谁）/ prompt（投影）/ runtime（接进会话）/ memory / skills
             create（新建一个人）/ roster（slug ↔ 会话）
  project/   doc（README.md）/ memory（memory.md）/ settle（自动沉淀）
  channel/   state（纯规则）/ deliver（唤醒）/ post（写一条）/ tools（15+ 个工具）
  shell/     assemble（扫文件夹 → 开会话 → 建频道）/ serve（HTTP+SSE）/ view / main
```

`project/` 与 `agent/`、`channel/` **平级**：项目不是公司的一个子概念，它是与「人」
并列的另一种归属。

## 项目记忆怎么沉淀

两条路，都要有：

1. **主动**：agent 用 `remember_project` 写 `projects/<slug>/memory.md`
   （归属判据是 `identity.md` 里的 `project: <slug>`，不是职位）。
2. **自动**：`src/core/project/settle.ts` 在一条消息落地后检查两件事 ——
   落在 `proj:<slug>` 频道里、`kind` 是 `decision` 或 `report`。命中就把这条
   发给项目负责人，请它判断「这件事长期成立吗」，成立就 `remember_project`。
   找不到负责人时记进 `stranded`，不阻塞其他项目。

**游标分两个，不能合并成一个**：

- `SettleDoc.awaiting[项目]` = 已经问过、但还没等到答复，问到第几条。它的作用只是
  **别重复打扰**。
- `SettleDoc.cursors[项目]` = 这些结论**已经写进记忆了**。它只由
  `remember_project` 落盘成功后推进（`confirmedBy()`）。

为什么必须分开：如果把「问过」当成「写完」，模型只要回一句「没有需要沉淀的」，
这批 decision 就永远不会再被检查 —— 静默丢数据。分开之后，模型不回话 / 写错地方
（用 `remember` 而不是 `remember_project`）/ 什么都没写，游标都不动，下一轮会再问。

**补漏定时器**：`shell/main.ts` 的 `startSettleSweep()` 每 5 分钟跑一次
`shell.settleSweep()`（遍历所有 `proj:` 频道）。`afterPost` 只处理「消息刚落地
的那个项目」，补不了三种漏：①负责人当时不在 ②进程崩在 `afterPost` 中途
③`followUp` 排队后重启丢了队列。

分工的原则：**形状用代码判，语义用模型判**。代码判得准「这条消息带 decision
标签吗」，判不准「这句话是不是真的结论」；后者交给模型，写不写、写什么由它决定。

`say` / `ask` 的 `kind` 参数由说话的人自己声明（`decision` / `report` /
`question` / `chat`），老板在项目频道里拍板时也要带 `kind: "decision"`。

## 技能从哪来

技能的正文**不在代码里**。仓库自带 `seed/skills/<名字>/SKILL.md`，`seedCompanySkills()`
把它们拷进工作区的 `skills/`（公司层），已存在的不覆盖 —— 播种只该发生一次。

改动技能 = 改一个 markdown 文件，下一条消息就生效（`agentSection` 的 `render`
每次重读盘）。写代码等于把「做法」硬编码进 TS，改一句话要重编译、重启。

## 还没做的
- **待办拍板 / 任务 / 成本**：旧核心有，新核心一个都没有（界面相应位置是空的）。
- **看门狗 / 崩溃自愈 / IM 出站**：旧核心为长跑攒的运维设施，新核心还没搬。
- **工具调用 trace**：新界面只显示消息，看不到 agent 中间调了哪些工具（旧核心有
  `/api/staff/:id/activity`，新核心后端还没有这条流）。
- **发图片 / 附件**：输入框只有文本。

