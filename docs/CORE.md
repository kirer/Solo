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
  capabilities     ← 他额外会什么（可选，一行一个工具名）
  memory.md        ← 他记住了什么（可选，他自己写）
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

`renderAgentPrompt({ self, all, ... })` 把「所有人 + 项目 + 能力清单」投影成一段提示词：

- 段落顺序固定、内容确定性（同一输入逐字节相同）——为了 prompt cache 不被打穿；
- 不哄人：查不到的写「（未设置）」；
- **每次渲染都重读磁盘**（`agentSection` 的 `render` 是函数），所以改 `identity.md`
  之后**下一条消息就生效**，不用重启、不用重开会话。

这一条把「改我自己」和「改组织」变成同一个动作：写文件。

## 能力是**热**的

- `capabilities` 文件里写工具名，`describeCapabilities` 只列注册表里**真存在**的（拼错
  的名字不会凭空造出一个能力，也不会静默变成空清单）。
- 工具是注册表里的对象，`set_capabilities` 改完文件，下一次渲染就换了一批工具。
- 新增能力 = 往注册表 `install` 一个 extension；不需要重新部署，也不需要改任何人的身份。

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

「层级」不在代码里，在提示词里：某个人的 `identity.md` 写着「你向助理汇报」，他自己
就知道该找谁；写「有问题只能向项目负责人汇报」，他就不会越过负责人去找老板。代码只
保证事实（谁能收到消息、谁的目录归谁），不保证纪律。

频道是 `core.channels` 一份文档：`Message{seq, from, at, text, mentions[], replyTo?, kind}`
+ `Channel{id, title, members[], wakeOnAll[]}`。收件人四条规则：显式 @ 且是成员 /
老板没 @ 任何人时给第一个非老板成员 / `wakeOnAll` / 减去发件人。**引用回复等于 @ 作者**。

## 文件夹就是边界

```
workspace/
  agents/<slug>/            每个人的身份、能力、记忆
  projects/<slug>/README.md  项目的说明（谁在这个项目、目标是什么）
  core.sqlite                频道消息、名册（都是可从文件夹重建的投影）
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

## 还没做的

- **项目记忆**：`projects/<slug>/` 现在只有 `README.md`，没有「这个项目发生过什么」。
- **技能**：`capabilities` 只是一行一个工具名，没有「怎么做一件事」的说明书。
- **待办拍板 / 任务 / 成本**：旧核心有，新核心一个都没有（界面相应位置是空的）。
- **看门狗 / 崩溃自愈 / IM 出站**：旧核心为长跑攒的运维设施，新核心还没搬。
