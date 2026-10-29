# 核心：一套「组织是文件」的 agent 运行时

> 这份文档讲**为什么这样设计**和**它现在怎么运转**。
> 只看怎么跑起来 → [README](../README.md)；要改代码 → [CODE](CODE.md)；接口字段 → [WEB-API](WEB-API.md)。

## 0. 一句话

**组织是文件，不是代码。** 一个人就是一个文件夹；文件夹里的字决定他是什么人。

代码只做四件事：读文件夹、把文件夹投影成提示词、把消息写进频道、把频道推给界面。
除此之外的一切（谁是谁、谁向谁汇报、会什么、记住什么、项目做什么）都是磁盘上的
markdown。改公司 = 改文件 = 下一条消息生效，不重启、不重新部署、不改一行 TS。

这条原则有一个不能绕的例外，见 §3。

## 1. 一个人是什么

```
workspace/agents/<slug>/
  identity.md              ← 他是谁（唯一必需）
  memory.md                ← 他记住了什么（他自己写、自己改）
  skills/<名字>/SKILL.md   ← 他会怎么做一件事
```

`identity.md` 只有四个可选的头字段：

```markdown
---
name: 林越
title: 技术负责人
manager: 知言
project: demo
---

正文是你写的：职责、边界、工作方式。
```

**没有第五个字段，也没有岗位枚举。** 谁是「技术负责人」不是代码决定的，是某个人在
`identity.md` 里写下的；组织架构不是常量表，是把所有 `identity.md` 的 `manager` 连起来
得到的树（`chainUp` / `reportsOf`）。断了、绕成环，都只是「这条汇报线断了」，不崩。

## 2. 提示词是**投影**

`renderAgentPrompt()` 把「所有人 + 项目 + 技能目录 + 记忆目录 + 注册表里的全部工具」
投影成一段提示词。三个性质：

- **确定性**：同一输入逐字节相同 —— 为了 prompt cache 不被打穿（cacheRead 便宜一个
  数量级，cacheWrite 更贵）。
- **不哄人**：查不到的写「（未设置）」，不编造。
- **每次渲染都重读磁盘**（`agentSection` 的 `render` 是函数），所以改 `identity.md` /
  `memory.md` / `skills/` 之后**下一条消息就生效**。

这一条把「改我自己」和「改组织」变成同一个动作：写文件。

**公共事实是渲染出来的，不是写下来的。** 每个人的提示词里都有「你在组织里的位置」
（上级、下属、整条汇报线、同项目的人、公司总人数）。这段不存进 `identity.md` ——
组织会变，写死的话 agent 会按三周前的架构认真工作，而你看不出来它错了。

## 3. 能力是**热**的，而且**不分层**

- 工具只有一套，人人都有（`registeredTools()` 直接从注册表实拍，不读任何清单文件）。
- 「你能调用的工具」这一段是注册表的投影：注册表里有什么就写什么。**不手写清单** ——
  手写的清单一定会漂，而漂了的提示词就是在撒谎。
- 新增能力 = 往注册表 `install` 一个 extension；不需要重新部署，也不需要改任何人的身份。
  想教 agent「怎么用这些手」，用**技能**，不要改代码。

**唯一的技术边界**：能力是**真代码**（一个函数）。`identity.md` 里写「你可以执行命令」
并不能凭空造出一个执行命令的工具。所以 —— **「能力是否存在」是代码，「用能力做什么」
是文档。** 这条边界绕不过去：让 agent 自己写代码然后执行，等于把机器交出去。

## 4. 通信是**平级**的

所有 agent 用同一套工具说话，没有「向上汇报」专用通道，也没有「管理层才能用」的工具：

| 工具 | 作用 |
| --- | --- |
| `say` | 在频道说一句；带 `mention` 就是提问并叫醒对方；带 `to` 就是私下发给某一个人；`text` 写 `[PASS]` 表示这一轮不说（只有一个人的频道里会被拒绝，见 ADR-063）；`step: true` 表示这只是过程话，一轮里结论只认一句（ADR-064） |
| `read_channel` | 不传频道=未读摘要+频道列表；传频道=读历史消息 |
| `org` | 我是谁、上级下属、全公司架构 |
| `hire` | 新建一个 agent（写文件夹 + 开会话 + 拉进公司频道与项目频道） |
| `update_identity` | 改自己或直接下属的 `identity.md` |
| `remember` / `recall` | 写/读记忆；`scope=project` 切到项目记忆 |
| `read_history` | 翻自己被压缩掉的历史对话（原文还在 storage 里，压缩后模型看不见） |
| `list_skills` / `read_skill` / `write_skill` | 技能：两层（公司 + 个人）+ 按需读正文 |
| `run` / `write_file` / `read_file` | 执行：跑命令 / 写文件 / 读文件（`run` 结果自动记个人频道） |
| `list_projects` / `read_project` / `write_project` | 项目：`projects/<slug>/README.md` |

「层级」不在代码里，在提示词里：某个人的 `identity.md` 写着「你向知言汇报」，他自己
就知道该找谁。代码只保证事实（谁能收到消息、谁的目录归谁），不保证纪律。

**拍板是逐级往上的，不是直达老板。** `renderAgentPrompt` 的「你在组织里的位置」一节
会按 `manager` 链给每个人写下这句：能自己定的就自己定；确实超出职责才问上级；上级也
拍不了才往上一级。跳级就是「告诉你上面的人没用」。这条规则来自组织事实（谁的上级是
谁），不是某个人的性格设定。

### 频道

`core.channels` 一份文档装全部频道：`Message{seq, from, at, text, mentions[], replyTo?, kind}`
+ `Channel{id, title, members[], wakeOnAll[]}`。收件人四条规则：

1. 显式 `@` 且是频道成员；
2. 老板发言且没 `@` 任何人 → 第一个非老板成员；
3. `wakeOnAll` 的成员；
4. 减去发件人自己。

**引用回复等于 @ 作者**（`appendMessage` 里把被引用者并进 mentions）。`kind` 是语义
标签（`chat` / `question` / `decision` / `report`），只有项目频道里的 `decision` /
`report` 会触发记忆沉淀。

`@` 写的是**名字**，`mentions` 存的是 **slug**：`channel/alias.ts` 把「老板 / BOSS / CEO /
真名 / title」翻成 slug（`@` 别名解析，ADR-036），解析不出来的一律丢弃（`@import` /
`@media` 不是人）。**成员过滤不动** —— 别名只是翻译，不是放宽边界。两条说话规矩也
写在这里而不是提示词里：要老板拍板的事由 `needsOwner` 自动补 `owner`（ADR-037）；投递
正文第一行写清频道 id，私聊额外说一句「只回这里」，兜底频道永远先排掉个人频道。

## 5. 文件夹就是边界

```
workspace/
  skills/<名字>/SKILL.md        公司层技能：全公司通用（写技能 / 找现成技能 / 工作规矩 / 记忆整理）
  agents/<slug>/
    identity.md                 他是谁
    memory.md                   他自己的记忆
    skills/<名字>/SKILL.md      个人层技能：同名覆盖公司层（知言的立项 / 招人）
  projects/<slug>/
    README.md                   要做什么、谁负责、什么不做
    memory.md                   这个项目发生过什么（项目里的人写，全公司能读）
  core.sqlite                   频道消息、名册、沉淀游标
```

名册（`core.directory`）只是 slug ↔ 会话 id 的缓存，删了能从文件夹重建；**频道消息是
真历史，删了就没了**。

三级不是顺手分层，是**三种不同的变化频率**：公司通用做法几个月改一次、一个人的手艺
天天加、一个项目的坑一次就踩完。混在一起，改一处就得动全部。

| 归属 | 谁写 | 谁读 | 换了人还在吗 |
| --- | --- | --- | --- |
| `agents/<slug>/*` | 他自己 | 他自己 | ✗ 跟着人走 |
| `projects/<slug>/memory.md` | 这个项目的人 | 全公司 | ✓ 跟着项目走 |
| `skills/`（公司层） | 谁都能写（`scope=company`） | 全公司 | ✓ |

另有一条纪律（不是代码约束）：**有 `bash` 的 agent 能读写全盘，包括别人的记忆**。
这是已知且被接受的 —— 隔离靠的是「目录归谁」的约定，不是沙箱。

## 6. 技能：能写成说明书的事就不写代码

一门技能是一个目录 + 一份 `SKILL.md`（YAML 头只有 `name` / `description`）：

- **`name` + `description` 常驻提示词**，正文按需 `read_skill` 读。一个人攒 20 门手艺，
  常驻的是 20 行描述，不是 20 篇正文 —— 成本上最要紧的一条。
- agent 自己就能 `write_skill` 长出新技能。`scope=personal`（默认）写自己目录，
  `scope=company` 写工作区根的 `skills/`。同名时个人层覆盖公司层。
- **不必自己造技能市场**：`run` 跑 `npx skills find` / `npx skills add`，生态在
  skills.sh 和 GitHub。装完按我们的话重写一遍再用。
- 技能的正文**不在代码里**。播种源在 `seed/`：`seed/skills/` → 公司层，
  `seed/assistant/` → 知言个人层。两份入口都**已存在的不覆盖** —— 播种只该发生一次，
  之后正文归 agent 自己迭代。

判断边界：「做什么」是身份（`identity.md`），「怎么做」是技能（`skills/`），
「发生过什么」是记忆（`memory.md`）。三条都不在代码里。

## 7. 项目：一份 README.md

`projects/<slug>/README.md` 的 YAML 头有 `name` / `owner` / `status`，正文写目标、验收
标准、什么不做、进展。`identity.md` 里写 `project: <slug>` 的人，提示词里自动出现这份
说明 + 项目成员名单。

**一个项目必须有负责人**（`owner`）。项目频道的成员是这份文档的投影：老板 + 负责人 +
负责人的**整条汇报线**（向上到老板，含知言这类统筹者）+ 所有 `project:` 指向它的人。
负责人靠 `write_project` 改，改完立刻重投影 —— 否则员工在项目频道里 @ 不到刚任命的负责人。

为什么把负责人的上级也拉进项目频道：统筹者（知言）要在项目频道里给负责人派活、负责人要向统筹者
汇报（见 ADR-024）；缺了统筹者，「统筹者 ↔ 负责人在项目频道协作」就落不下。成员表是事实的投影，
用整体替换而非只加不删，避免改名/重建后旧 slug 残留在成员表里变成幽灵成员。「什么时候该立项」
是判断，写在知言的 `立项` 技能里。

## 8. 记忆怎么沉淀

两条路，都要有：

1. **主动**：agent 用 `remember(scope=project)` 写 `projects/<slug>/memory.md`。
2. **自动**：一条消息落地后 `settle.ts` 只检查一件事 —— 落在 `proj:<slug>` 频道里。
   命中就把**这条连同还没处理的新消息**交给项目负责人，请它按公司技能「记忆整理」判断
   「哪些长期成立」，成立就 `remember(scope=project)`。找不到负责人时游标照常推进，不阻塞别人。

**单游标**：`cursors[项目]` = **已确认**沉淀到第几条 seq。`settleProject` 问完**不推进**，
只记一笔 `waiting`（问到的 seq + 提问那一刻项目记忆文件的 mtime）；下次检查时记忆文件
真的变了才推进。负责人被打断或写砸了，这批消息下次还会被看到。`remember(scope=project)`
落盘后 `confirmedBy()` 做兜底推进。（ADR-033）

**判断规则不在代码里**：什么该记、什么不该记、什么时候整理、记完怎么回话，都写在公司技能
「记忆整理」（`seed/skills/记忆整理/SKILL.md`）里 —— 人和 agent 都能改，改它不用改代码。



分工原则：**形状用代码判，语义用模型判**。代码判得准「这条消息带 decision 标签吗」，
判不准「这句话是不是真的结论」；后者交给模型。

## 9. 界面

服务把 `ui/web/` 当静态目录发出去，**没有构建步骤**：改文件、刷新浏览器就生效。

```
ui/web/
  index.html      一个骨架：顶栏 / 左栏列表 / 右栏对话
  css/app.css     一个文件，九个颜色变量，4px 栅格
  js/app.js       唯一有状态的模块（一个对象 + 几个渲染函数）
  js/api.js       只有 fetch 与 SSE，错误处理统一在这里
  js/markdown.js  纯函数渲染器
  js/format.js    时间 / 头像色 / 剪贴板
```

三条规矩：

1. **只画后端真的有的东西。** 没有待办就不画待办卡，没有 trace 就不留占位。为填满
   布局画一堆恒空的块，看的人分不清是「没有」还是「坏了」。
2. **一个区域整体替换**（`replaceChildren`），不做增量 patch。几百条消息时这比 diff
   更快，也更难写错。
3. **`[hidden]` 必须真的藏住**（`app.css` 里有一条 `display: none !important`）。
   类选择器里的 `display: flex` 会顶掉浏览器默认的 `[hidden]`。

频道分三组：公司（`company` / `lead` 前缀）、项目（`proj:`）、个人（`dm:`）。
消息按 `kind` 区分显示：`chat` 普通发言、`work` 执行记录（折叠等宽字体块）、
`note` 系统留痕（灰色淡显）、`decision`/`report` 带标签（触发项目记忆沉淀）。
`kind` 由 `view.ts` 的 `kindOf(id)` 从 id 前缀反推频道种类 —— 核心没有「频道类型」
这个概念，它是界面的事。

### 思考与过程也看得见

老板在个人频道里能看见员工**想了什么、说了什么、调了什么**，不只是 `run` 的输出。
机制在 `channel/transcript.ts`（纯投影函数）+ `shell/projector.ts`（订阅、游标、回填）：
装配时订阅会话提交，把每条
`pi.assistant` 条目里的三类内容块投影成个人频道的消息 ——

| 会话块 | 投影成 `kind` | 界面样式 |
|---|---|---|
| `thinking` | `think` | 折叠的浅色「思考」块（仿 ChatGPT） |
| `text` | `say` | 正文，一段一条 |
| `toolCall`（除 `say`） | `tool` | 折叠的工具调用卡片（名字 + 参数摘要） |

`say` 的调用不投影（它本身就是一条真正的频道消息，再投一次是重复）；工具**结果**
也不投影（`run` 已通过 `logWork` 落过）。投影只落**个人频道**，因为思考是过程不是结论。

投影是**落库**的，不是读时拼接 —— 会话条目没有时间戳，读时拼不出「这句思考在哪两条
消息之间」（ADR-028）。代价是双份存储，但两份都只按条数线性增长：写入无放大是
ADR-027 守的底线（`test/core/channel-write.test.ts` 把「每写一条花多少字节」当契约测）。
单条消息还有个硬上限：`run` 的输出落进频道前剪到 3,000 字（留头留尾），回给模型的剪到
8,000 字 —— 一次跑整个测试套件就是 512 KB，不剪等于让它把整段日志读进上下文。
这是「代码连线」而非「提示词让 agent 复述」：读它已写下的记录，零额外推理、零失真。

投影进度存在 `ChannelState.cursors`（会话 id → 已投影的最大条目 id），随频道文档一起
持久化。装配时先做一遍**历史回填**：把每个 agent 会话里游标之后还没投影过的
`pi.assistant` 条目按时间顺序补进个人频道，再开投影订阅只听新提交。没有这一步，
历史条目就永远不会被投影 —— 个人频道只剩 `run` 的 `work` 卡，看不到 agent 怎么想。

## 10. 目录

```
src/core/
  runtime/   openCore + 防腐层（唯一能 import pi-durable / pi-ai 的地方）
             models / settings 也在这里
  agent/     identity（他是谁）/ prompt（投影）/ runtime（接进会话）
             memory / skills / create（新建一个人）/ roster（slug ↔ 会话）
  project/   doc（README.md）/ memory（memory.md）/ settle（自动沉淀）
  channel/   state（纯规则）/ deliver（唤醒）/ post（写一条）/ tools（20 个工具）
  shell/     assemble（扫文件夹 → 开会话 → 建频道）/ serve（HTTP+SSE）/ view / main
             http/（routes / static-assets / network）
```

`project/` 与 `agent/`、`channel/` **平级**：项目不是公司的子概念，它是与「人」并列的
另一种归属。

## 11. 开机做了什么

`npm start` 按顺序只做五件事：

1. 读 `workspace/settings.json` 里的模型，装配 `models`；
2. `openCore()` 打开 SQLite；
3. `assembleCore()` —— 扫 `agents/` → 每人开一个会话 → 绑名册 → 建公司频道 →
   按 `identity.md` 的 `project:` 拉进项目频道 → 每人建个人频道；
4. `serveCore()` 起 HTTP + SSE；
5. 等 Ctrl-C。

`agents/` 为空时播种一个「离老板最近的人」（`seedOwnerAssistant()`）—— 这是**唯一**
一处预置身份的地方，而且只写文件、不写代码。之后它自己 `hire` 别人。

**刻意没有的东西**：看门狗、崩溃自愈、IM 出站、成本核算。
加回任何一样之前先问「不修它，公司会不会停摆」，答案是否就别加。

## 12. 还没做的

- **工具调用 trace**：界面只显示消息，看不到 agent 中间调了哪些工具。
- **待办拍板 / 任务 / 成本**：一个都没有（界面相应位置是空的）。
- **看门狗 / 崩溃自愈 / IM 出站**：不为长跑兜底。
- **发图片 / 附件**：输入框只有文本。

