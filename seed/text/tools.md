# 工具文案

工具的描述、参数说明、拒绝与回话。`## 键名` 下就是模型看到的那段话，可以用 `{{插槽}}`。
改这里要重启（工具描述在装配时定型）。

## tool.self.missing
你还不在名册里。

## tool.action.invalid
{{label}} 只有 {{allowed}}，没有「{{value}}」。

## tool.clip.marker
…（原文 {{length}} 字，中间省略）…

## say.description
在频道里说话。不带 mention 是一句普通发言（正文里写 @某人 才叫醒他）；带 mention 就一定会叫醒他。

## say.param.text
要说的话。这一轮没有新东西就写 `[PASS]`（这一轮只有你被叫醒时会被拒）。

## say.param.mention
@ 谁，写名字或 slug（`@我` 指我）。带上会叫醒他。

## say.param.channel
频道 id 或频道名（`chats` 能列出你在的），省略 = 我刚被叫醒的那个频道。不在那个频道里的人 @ 不到。

## say.param.replyTo
要引用回复的消息序号

## say.param.options
要我选：2–6 个互不相同的选项。带上它这条就一定会叫醒我，我会在最下面看到一排选项。
只在你**直接问我**时用：正文写给我看（在选什么、为什么现在要定），别把对同事说的话和选项混成一条。
要问的是助理、不是直接问我 —— 别带 options，用 mention 叫醒他；带上就等于叫醒我。
正文点了别人（@助理、@某个成员）又带 options 会被拒绝：选项卡只会画给我。

## say.self.missing
你还不在名册里。先看 members/<你>/identity.md，或请助理重新登记你。

## say.refuse.monologue
这条没发出去：它以「{{opener}}」开头，英文占多数 —— 那是你的思考，不是对别人说的话。思考用 think；要对人说话就用中文写结论（谁、做了什么、结果、下一步）。重写一遍。

## say.refuse.pass
这一轮只有你被叫醒，没有别人接得住，所以不能 PASS。把结论写出来：谁、做了什么、卡在哪、下一步。几十个字就够，不要写报告。

## say.pass.ok
这一句不说了（这一轮还有 {{others}} 在）。

## say.refuse.long
太长了：{{length}} 字，{{channel}} 里一条最多 {{limit}} 字。频道里只放结论，把过程或整份内容写进团队文件，再发一句结论加路径。

## say.refuse.options.count
选项要 2–6 个（现在是 {{count}} 个）。真的要我自己想，就别给选项，直接问。

## say.refuse.options.dup
选项不要重复：重复的两个选项我分不出该点哪个。

## say.refuse.options.others
这条没发出去：带选项的消息是给我画的选项卡，可你点的是 {{names}} —— 发出去只会变成「老板，你定」。要同事做选择就别带 options：把选项写进正文、用 mention 叫醒他；要问我，正文里写 @我。

## say.refuse.mention
「{{channel}}」里没有「{{name}}」。可以 @：{{available}}

## say.done
已发到「{{title}}」#{{seq}}。{{woken}}

## say.done.woken
已唤醒：{{names}}。

## say.done.nobody
没有人被唤醒（这只是一句话）。

## chats.description
看会话、建群。`action=list`（默认）列我在的会话：标题、群聊还是私聊、未读数、最后一条；`action=read` 读某个频道的历史消息（读完标已读）；`action=create` 用 title + members 拉一个群，我自动在里面。

## chats.param.action
list（默认）列会话 / read 读消息 / create 拉群

## chats.param.channel
频道 id。read 时省略 = 刚叫醒我的那个频道

## chats.param.since
只要这个序号之后的消息（read）

## chats.param.limit
最多几条，默认 30，上限 100

## chats.param.title
群名。建群时必填；同一个名字只能有一个群。

## chats.param.members
群里还有谁：名字或 slug，一个数组。建群的人自动在群里。

## chats.create.done
已建群「{{title}}」（{{id}}），成员：{{names}}。在这个群里说话会用 `say` 的 channel 参数。

## chats.row.kind.dm
私聊

## chats.row.kind.group
群聊

## chats.row
- {{id}}「{{title}}」{{kind}}{{unread}}（{{count}} 人）
  {{preview}}

## chats.row.unread
 · {{count}} 条未读

## chats.row.empty
（还没有消息）

## chats.header.unread
未读消息：

## chats.header.channels
你的频道：

## chats.none
你不在任何频道里。

## chats.channel.missing
没有这个频道。

## chats.empty
「{{title}}」里还没有消息。

## chats.empty.since
「{{title}}」在 #{{since}} 之后没有新消息。

## chats.read.header
「{{title}}」最近 {{shown}} 条（共 {{total}} 条）：

## chats.read.footer
（已标记到 #{{seq}} 为已读）

## history.description
翻历史。`scope=channel`（默认）查我自己这个会话（上下文被压缩掉的部分也查得到）；`scope=memory`（或 personal / team 简写）翻记忆全文，可以只筛包含某个词的段落。

## history.param.scope
channel（默认，对话历史）/ memory（我的记忆）/ team（团队记忆；也可以先写 memory 再给 team）

## history.param.query
关键词（不区分大小写），只留包含它的条目 / 段落

## history.param.team
团队 slug，默认是我所在的团队（scope=team / memory 且要看团队时用）

## history.param.around
条目 id（每行开头的 #号）。从这条往前翻（只看对话历史）

## history.param.limit
最多几条，默认 12，上限 50（只看对话历史）

## history.ago.unknown
时间未知

## history.ago.now
刚刚

## history.ago.minutes
{{n}} 分钟前

## history.ago.hours
{{n}} 小时前

## history.ago.days
{{n}} 天前

## history.speaker.compaction
[压缩摘要]

## history.speaker.other
对方

## history.speaker.self
你

## history.empty.conversation
这个会话还没有任何记录。

## history.empty.match
这个会话里没有匹配的记录。

## history.more
还有更早的，用 around={{id}} 继续往前。

## remember.description
记一条经验。scope=personal（默认）写进你自己的记忆（members/<我>/memory.md）；scope=team 写进所在团队的记忆（teams/<团队>/memory.md，带日期和你的名字）。该记什么见技能「记忆整理」。

## remember.param.text
要记的东西。一句话说清一条，几条就调几次。

## remember.param.scope
personal（默认，自己的记忆）或 team（团队记忆）

## remember.param.team
团队 slug；scope=team 时用。默认是我所在的团队

## remember.refuse.no-team
我不在任何团队里。要记团队的事，先说清是哪个团队。

## remember.refuse.not-member
你不在团队「{{team}}」里。团队记忆只能由这个团队的人写。

## remember.team.done
已记进团队「{{team}}」的记忆{{tail}}。下一条消息就会出现在这个团队的记忆目录里。

## remember.done
已记下。下一条消息的记忆目录里就会出现它。

## hire.refuse.no-roster
你还不在名册里，招不了人。

## hire.refuse.not-assistant
招人和开除只有助理能做。你要人，就 @助理 说清要什么样的人、进哪个团队。

## hire.description
`action=create`（默认）招一个人：在 members/ 下建文件夹、写 identity.md、给他自己的工作目录。`action=fire` 让一个人离开：目录移到 members/.retired/，从频道与名册里移除，私聊归档。`action=models` 列出现在能挑的模型。招人与开除只有助理能做。写法见技能「招人」。

## hire.param.action
create（默认）/ fire / models

## hire.param.name
姓名（create 必填）

## hire.param.title
身份标签，纯展示用

## hire.param.team
所在团队 slug

## hire.param.body
identity.md 的正文：①负责什么 ②不做什么 ③怎么汇报 ④做得好是什么样。

## hire.param.model
他用的模型，写成 提供商/模型。只能从 action=models 列出的里面挑；不传就跟默认。

## hire.models.none
还没配任何模型：设置 → 模型，或写应用目录里的 settings.json。

## hire.models.list
能挑的模型：
{{rows}}

按角色分：协调、汇总、写文档用便宜的；复杂开发、攻坚用强的。

## hire.models.row
- {{ref}}{{default}}

## hire.models.default
（默认）

## hire.nobody
（没有人）

## hire.fire.missing
没有这个人：{{name}}。现有：{{slugs}}

## hire.fire.owner
那是我，不能开除。

## hire.fire.assistant
它是助理，不能开除。

## hire.fire.done
已让 {{name}}（{{slug}}）离开：目录移到 members/.retired/，频道与名册里都不再有他。

## hire.fire.sync-failed
团队 {{team}} 的频道没重算（{{error}}）：里面可能还留着他，重新写一次团队 README 或重启都能修。

## hire.create.model-failed
（模型没换成：{{error}}）

## hire.create.model-ok
，模型 {{model}}

## hire.create.where
身份在 members/{{slug}}/identity.md，工作目录在 members/{{slug}}/workspace/

## hire.create.team-missing
团队 `{{team}}` 还没有 README（`teams/{{team}}/README.md` 不存在），所以还没有团队频道，他也不会被拉进任何群。用 `file` 把这份 README 写出来（头里写 `name`），团队频道才会出现。

## hire.create.announce-failed
{{name}} 进团队频道了，但报到没发出去（{{error}}）：频道里看不见他，必要时让他自己说一句。

## hire.create.done
已新建 {{name}}（slug: {{slug}}），会话 {{id}} 已就绪{{model}}。{{where}}。{{teamNote}}

## run.description
执行一条 shell 命令，返回 stdout / stderr / 退出码。`background: true` = 丢到后台跑（最多 30 分钟），立刻返回；跑完结果发回这个频道并叫醒你。以 `&` 结尾或以 `nohup` 开头 = 纯脱手，立即返回 PID，永远不会有回音。

## run.param.command
要执行的命令

## run.param.cwd
工作目录，默认是你自己的 workspace（`members/<你>/workspace`）；写团队的事可以传那个团队的 workspace 路径

## run.param.timeout
超时秒数，默认 60

## run.param.background
丢到后台跑，跑完把结果发回频道并叫醒你（最多 30 分钟）

## run.result.done
后台命令跑完了。
$ {{command}}
{{body}}
{{ending}}

## run.result.empty
（没有输出）

## run.result.timeout
（超过 {{minutes}} 分钟，已杀掉；全文在 {{path}}）

## run.result.exit
(退出码 {{code}}；全文在 {{path}})

## run.result.signal
被信号结束

## run.background.started
$ {{command}}
(后台运行，PID {{pid}}）
跑完结果会发到「{{title}}」并叫你。这中间你可以干别的。

## run.background.detached
$ {{command}}
(后台运行，PID {{pid}}）

## run.foreground.stderr
[stderr] {{text}}

## run.foreground.too-much
（输出超过 512 KB，后面的被丢弃）

## run.foreground.exit
(退出码 {{code}})

## run.foreground.timeout
（超时被杀：这条命令跑了超过 {{seconds}} 秒。真需要更久就重跑并给 timeout，最大 300）

## run.foreground.signal
（被信号 {{signal}} 结束）

## run.foreground.spawn-failed
（命令没起来：{{text}}）

## file.description
工作区里的一个文件。`action=read`（默认）读它；`action=write` 写它（大段代码、配置、文档走这个，不经过 shell 转义）。路径按第一段决定落在哪：`members/…` `teams/…` `skills/…` 是用户目录，`assistant/…` `plugins/…` `prompt/…` 是应用私有目录。`../` 会被拒。写 `teams/<团队>/README.md` 会顺手刷新那个团队的频道成员。

## file.param.action
read / write（给了 content 就是 write，不用再写 action）

## file.param.path
文件路径（相对工作区根）

## file.param.content
write 必填：文件内容

## file.param.offset
read 从第几行开始（1 起），默认 1

## file.param.limit
read 最多几行，默认 400

## file.refuse.outside
路径在工作区之外：{{path}}

## file.refuse.secret
这个文件不开放。

## file.refuse.no-content
write 要带 content（写什么）。只想读文件用 action=read。

## file.write.done
已写入 {{path}}（{{length}} 字）

## file.write.sync-failed
已写入 {{path}}（{{length}} 字），但团队频道刷新失败：{{error}}

## file.write.team-sync-failed
团队 {{team}} 的频道没重算（{{error}}）：里面的成员可能还是旧的。

## file.read.missing
文件不存在：{{path}}

## file.read.truncated
…（已截断）

## file.read.footer
（共 {{rows}} 行、{{chars}} 字；这里从第 {{offset}} 行起{{more}}）

## file.read.more
，还有，用 offset={{next}} 继续

## file.create.no-roster
你还不在名册里，建不了团队。

## channel.not-member
你不在「{{title}}」里。

## channel.ambiguous
有两个频道都叫「{{name}}」：{{ids}}。写 id，别写名字。

## channel.missing
没有这个频道：{{name}}。你在：{{channels}}。

## channel.no-wake
这一轮没有唤醒记录，不知道该回哪个频道。请显式给 channel（`chats` 能列出你在的频道）。

## recall.team.empty
团队「{{team}}」还没有记忆。

## recall.team.no-match
团队「{{team}}」的记忆里没有「{{keyword}}」。

## recall.self.empty
我还没记过任何东西。

## recall.self.no-match
记忆里没有「{{keyword}}」。

## recall.attachment.image
[图片 {{name}} · uploads/{{id}}]

## recall.attachment.file
[文件 {{name}} · uploads/{{id}}]

## org.name.what.agent
slug

## org.name.what.team
团队 slug

## org.name.what.skill
技能名

## org.name.invalid
不能用作{{what}}：{{value}}。只能用字母、数字、中文、- 和 _。

## org.name.exhausted
找不到可用名：{{base}}

## org.team.create.denied
建团队只有助理能做。你是「{{slug}}」——需要新团队，在频道里 @助理 说清要做什么。

## org.memory.empty
这条记忆是空的。

## org.memory.too-long
这条记忆 {{limit}} 字上限，现在 {{length}} 字。请说得更短，或拆成两条。

## org.memory.secret
这看起来是密钥或密码，绝对不能写进记忆。记忆会被拼进每一轮提示词。

## org.memory.header
# 记忆

## org.memory.team-header
# 团队记忆：{{team}}

## org.memory.more
（还有 {{count}} 条更早的没列出）

## org.memory.saved
已记下。

## org.memory.rewritten
已重写。

## org.memory.duplicate
这条记忆已经有了。


## group.refuse.title
群要有名字：写一句 title。

## group.refuse.member
没有「{{name}}」这个人。可以拉：{{names}}

## group.refuse.few
群至少要有两个人：你，加上至少一个成员。

## group.refuse.exists
已经有叫「{{title}}」的群了，换个名字。

## group.refuse.responder
接话的人「{{name}}」不在这个群里。

## route.description
助理专用：把频道里的一条消息在后台交给该看的人。他能看到原文，频道里不会出现「转交」这条消息。

## route.param.to
交给谁（名字或 slug），一个或几个。必须在这个频道里。

## route.param.seq
转哪一条消息，默认我刚被叫醒的那条。

## route.param.channel
哪个频道，默认我刚被叫醒的频道。

## route.self.missing
你还不在名册里。

## route.refuse.not-assistant
只有助理能用 route：一条消息该给谁看，由助理判断。

## route.refuse.no-seq
不知道要转哪一条：用 seq 指明。

## route.refuse.missing
「{{channel}}」里没有 #{{seq}} 这条消息。

## route.refuse.self
不用转给自己。

## route.refuse.owner
我不走 route：要我拍板就在正文里 @我。

## route.refuse.target
「{{name}}」不在「{{channel}}」里。可以转给：{{names}}

## route.refuse.empty
没有指定要转给谁。

## route.note
把 #{{seq}} 交给 {{names}} 看。

## route.done
已把 #{{seq}} 交给：{{names}}。频道里没有留下可见消息。{{failed ?? }}

## route.done.failed
没叫醒：{{names}}。

## route.done.none
没有叫醒任何人（{{names}} 还没有会话）。
