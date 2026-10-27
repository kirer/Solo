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
| `set_capabilities` | 改某人的 `capabilities` |
| `remember` / `recall` | 写/读 `memory.md` |
| `list_skills` / `read_skill` / `write_skill` | 技能：`skills/<名字>/SKILL.md` |
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
  agents/<slug>/
    identity.md             他是谁：名字、岗位、上级、所在项目、正文
    memory.md               他自己的记忆（可改，不是只增）
    skills/<名字>/SKILL.md  他会怎么做一件事
  projects/<slug>/README.md 这个项目要做什么、谁负责、什么不做
  core.sqlite               频道消息、名册（都是可从文件夹重建的投影）
```

名册（`core.directory`）只是 slug ↔ 会话 id 的缓存，删了能从文件夹重建；频道消息是真
历史，删了就没了。

## 跑起来

```bash
npm run core -- --port 7790 --workspace workspace-core
```

第一次启动会播种一个「离老板最近的人」（`agents/助理/identity.md`）。之后在界面里跟他说
话，让他招人 —— 他会自己写 `identity.md`、自己建文件夹。没有 `--seed` 就不播种。

实测过得通的一条链：老板说「招一个技术负责人叫林越」→ 助理 `hire` → 文件夹出现、
会话开出、自动进公司频道 → 助理在群里 `@林越` → 林越开口向老板报到。

跑真实模型的端到端自测（会花 token，平时不进 `npm test`）：

```bash
npm run core:live
```

它验五件事：被 @ 会回话 / 技能热更新生效 / 项目说明进提示词 / `remember` 真落盘 /
`recall` 真读回。

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
- agent 自己就能 `write_skill` 长出新技能。播种时只给「离老板最近的人」两份：`立项`、`招人`。

判断边界：「做什么」是身份（`identity.md`），「怎么做」是技能（`skills/`），「发生过什么」
是记忆（`memory.md`）。三条都不在代码里。

## 项目：一份 README.md

`projects/<slug>/README.md` 的 YAML 头有 `name` / `owner` / `status`，正文写目标、验收标准、
什么不做、进展到哪。`agents/*/identity.md` 里写 `project: <slug>` 的人，提示词里会自动出现
这份说明 + 项目成员名单。

「什么时候该立项」不在代码里 —— 那是判断，写在助理的 `立项` 技能里。

## 还没做的

- **项目记忆**：`projects/<slug>/` 现在只有 `README.md`。谁在项目里说过什么、做过什么，
  还没有地方沉淀（现在是靠频道历史）。
- **待办拍板 / 任务 / 成本**：旧核心有，新核心一个都没有（界面相应位置是空的）。
- **看门狗 / 崩溃自愈 / IM 出站**：旧核心为长跑攒的运维设施，新核心还没搬。
- **技能的市场/分发**：现在技能只能一个 agent 自己写自己的。跨 agent 共享（「把这门手艺
  给全组」）还没有。
