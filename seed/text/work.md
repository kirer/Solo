# 派活的文案

工具描述、参数说明、回报话术。`## key` 是键名，代码只认键名。

## work.description

要动手的活先立工单，再动手；不是活就别开。`open` 把一条消息接成工单（写清 title 与 scope，返回工单号 T1、T2…）；`report` 推进一步（progress / ready / blocked / failed）；`ask` 停下来问人；`answer` 是人答过之后接着干；`retry` 按原授权重来；`stop` 收工；`list` 看手上有什么。工单号要抄进回话里，人和你都靠它认事。

## work.param.action

open（接活）/ report（报进度）/ ask（问人）/ answer（人答过了）/ retry（重来）/ stop（收工）/ list（看手上有什么）

## work.param.ticket

工单号，例如 T3。`open` 不需要。

## work.param.title

一句话说清这件活是什么。会显示给人看，别写成「处理一下」。

## work.param.scope

这件事允许动什么：哪个文件、哪个目录、哪一步。越界要重新请示。

## work.param.trigger

这条活是从哪条消息来的：`频道#序号`。不写就是叫醒你的那条。

## work.param.outcome

progress（还在做）/ waiting（我这边没事了，等人）/ ready（做完了，等人验收）/ blocked（卡住）/ failed（做砸了）/ dropped（不做了）

## work.param.text

一句话说清这次汇报做了什么、卡在哪、下一步是什么。

## work.param.question

要问人的那句话。一个问题只问一件事。

## work.param.options

给人挑的选项，2–6 个。给了选项，人就能直接点，不用打字。

## work.wake.line

这件事记在工单 {{id}}「{{title}}」上。

## work.line

`{{id}}` {{title}} —— {{stage}}（{{strength}}）

## work.strength.explicit

我说了就做

## work.strength.inferred

按规矩接的

## work.open.done

立了工单 {{id}}：{{title}}。范围：{{scope}}。依据：{{strength}}。做完了用 report 报 ready，再在频道里说一句结论。

## work.open.refused

接不了：{{reason}} 继续当聊天处理就行。

## work.open.default-title

{{text}}

## work.open.default-scope

这次在叫你的那个频道里说清这件事，需要动文件时只动自己的工作区。

## work.report.done

{{id}} 记下了。现在：{{stage}}。

## work.ask.done

问了，第 {{seq}} 条。{{id}} 停在等人回答。

## work.retry.done

{{id}} 重新排上了（第 {{attempts}} 次）。接着做之前先看一眼上次卡在哪。

## work.retry.refused

先别动：{{reason}}

## work.answer.done

{{id}} 接着干。

## work.stop.done

{{id}} 收工了。

## work.list.empty

手上没有没做完的活。

## work.refuse.unknown

没有这张工单：{{id}}。用 list 看一眼手上有什么。

## work.refuse.ended

这张工单已经结束了：{{id}}。有新的事就开一张新的。

## work.refuse.taken

这张工单不是你的。

## work.refuse.not-accepted

这条消息按现在的策略接不了。

## work.refuse.no-wake

不知道这一轮是从哪儿被叫醒的，没法接活。用 say 问一句更稳妥。

## work.refuse.no-channel

找不到这个频道，或者你不在里面。

## work.refuse.no-message

那个频道里没有第 {{seq}} 条消息。

## work.refuse.no-id

要给工单号。

## work.refuse.bad-outcome

outcome 只能是 progress / waiting / ready / blocked / failed / dropped。

## work.refuse.no-text

要写一句汇报内容。

## work.refuse.no-question

要写清问什么。

## work.refuse.bad-options

选项要么不给，要么给 2–6 个、不重复。

## work.refuse.bad-action

action 只能是 open / report / ask / answer / retry / stop / list。
