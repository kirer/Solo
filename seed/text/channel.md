# 频道文案

投递正文的机械部分、附件说明、没答上来的留痕、提示词的兜底句。改这里要重启。

## delivery.head
【{{title}}】#{{seq}}（频道 {{id}}）{{quoted ?? }}

## delivery.quoted
（回复 #{{seq}}）

## delivery.also-mentioned
这条还 @ 了：{{names}}

## delivery.woken
这条会叫醒：{{names}}{{position ?? }}

## delivery.woken.position
（你在第 {{n}} 位）

## delivery.routed
（{{name}} 让你看这条。）

## delivery.attachments
附件：

## delivery.digest.row
- {{title}}：{{unread}} 条 {{preview ?? }}

## delivery.digest.preview
— {{text}}

## attachments.file
- 文件「{{name}}」（{{size}}）：用 file(action=read) 读它，path 写 uploads/{{id}}

## attachments.image.missing
- 图片「{{name}}」（{{size}}）：没有取到文件，别假装看过。

## attachments.image.too-big
- 图片「{{name}}」（{{size}}）：太大，没有直接给你看。要细节请我说一句里面的内容，或者裁小一点再发。

## attachments.image.too-many
- 图片「{{name}}」（{{size}}）：这条消息图片超过 {{limit}} 张，这一张没给你看。

## attachments.image.over-total
- 图片「{{name}}」（{{size}}）：加上其它图超过单条上限，这一张没给你看。

## attachments.image.gone
- 图片「{{name}}」（{{size}}）：文件已不在，别假装看过。

## attachments.image.ok
- 图片「{{name}}」已经直接给你看了。

## attachments.placeholder.image
[图片] {{name}}

## attachments.placeholder.file
[文件] {{name}}

## unanswered.reason.none
没有说明原因

## unanswered.reason.no-model
没有可用的模型（还没配，或 `settings.json` 的 `defaultModel` 指向了不存在的模型）——去「设置 → 模型」看一眼

## unanswered.reason.aborted
这一轮被中断了

## unanswered.reason.run-failed
这一轮跑失败了

## unanswered.reason.model-error
调模型失败（网关拒了这次请求，通常是模型名、额度或网关本身的问题）

## unanswered.reason.interrupted
这一轮被重启打断了（模型正在回答时进程停了）

## unanswered.reason.restart-limit
这一轮连续被重启打断，已经放弃

## unanswered.reason.nothing-to-answer
这一轮没有需要回答的内容（上下文停在一条已经答完的消息上）

## unanswered.reason.turn-limit
这一轮的工具轮数到了上限

## unanswered.reason.faulted
这一轮的任务异常退出

## unanswered.reason.orphaned
这一轮的任务在重启后找不到承接它的定义

## unanswered.reason.reset
这一轮被一次重置打断了

## unanswered.reason.restart
进程重启，这一轮没跑完

## unanswered.line
#{{seq}} 叫了 @{{label}}，但他这一轮没答上来：{{reason}}{{detail ?? }}。

## unanswered.detail
（{{detail}}）

## post.issue.failed
#{{seq}} 叫了 @{{label}}，投递失败：{{detail}}。

## post.issue.skipped
#{{seq}} 叫了 @{{label}}，但它还没有会话（还没被打开过）—— 这条不会有人答。

## post.issue.unknown
未知原因

## membership.joined
你刚进了「{{title}}」团队频道。用一句话介绍自己：名字、职务、负责什么 —— 发在这里，之后大家才知道 @ 谁。

## turn.interrupted
服务重启，{{name}} 在 #{{seq}} 之后的那一轮被打断了。

## sections.identityless
# 你还没有身份文件

目录：`members/{{slug}}/`。

## sections.no-summary
（没有说明）

## sections.skill.all
（全员通用）

## sections.skill.team
（团队共用）

## sections.skill.team-override
（团队改过的版本，覆盖了全员的同名技能）

## sections.skill.personal
（你自己写的）

## sections.skill.personal-override
（你自己改过的版本，覆盖了同名的团队/全员技能）

## sections.peer
{{name}}（{{title}}）

## sections.peer.title
成员

## sections.chats.dm
已开

## sections.owner
我（用户本人）

## sections.assistant.self
你自己
