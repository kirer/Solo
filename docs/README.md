# 文档索引

> **给 AI agent 的入口**：先读 [`../AGENTS.md`](../AGENTS.md)，它告诉你「要做什么 → 读哪一份」。
> 本页是地图。

## 文档（会随代码更新，可信）

| 文档 | 内容 | 什么时候读 |
|---|---|---|
| [CORE](CORE.md) | **概念地基**：组织是文件夹、一个人是什么、提示词是投影、能力是热的、技能两层、团队记忆怎么沉淀、文件夹边界。**与代码冲突时以本文档为准** | 要动架构；要判断「某件事该不该这样」 |
| [CODE](CODE.md) | **代码地图**：五层架构与六条边界规则、`src/core` 47 个文件全量表（另附界面源文件表）、「我想改 X → 动这里」对照表、启动顺序的坑、测试布局 | 要动代码 |
| [WEB-API](WEB-API.md) | **网页 API 契约**：18 条路由（去重 15 条路径）、全部响应字段、`kind`/`role` 规则、已知限制、兼容性纪律 | 改 `src/core/interface/http/`、`app/` 或 `ui/app/` |
| [DECISIONS](DECISIONS.md) | **89 条架构决策记录**，每条写了背景、替代方案、为什么这么选 | 想改一个「看起来不该这么写」的地方之前 |
| [CONCESSIONS](CONCESSIONS.md) | **pi-durable 底座让步总账**（C-001…C-009）：底座做不到什么、我们怎么绕的、升级后能不能删掉绕路 | 遇到「这个库好像不支持 X」时；先查有没有记过 |
| [DEPLOY](DEPLOY.md) | 局域网访问、Docker、安全边界、备份、排障（`logs/runtime.jsonl` 与 `/api/diag`） | 要跑起来 / 部署出去 |

## 调研（外部事实，不是本项目状态）

`docs/research/` 是底层库（Pi / pi-durable）的原始调研记录，写代码前查 API 时读：

| 文档 | 内容 |
|---|---|
| [01-pi-docs](research/01-pi-docs.md) | Pi 本体文档：扩展、工具、任务、会话、提示词缓存 |
| [02-pi-durable](research/02-pi-durable.md) | pi-durable：文档模型、提交、任务、休眠、恢复 |
| [03-pi-source-durable](research/03-pi-source-durable.md) | 读 pi-durable 源码得到的细节（比文档更准的地方） |

这三份是**当时抄下来的**，可能落后于依赖版本。冲突时以 `node_modules/@earendil-works/*`
的类型定义为准。

## 已删除的文档

V2 清理时删掉了 `SYSTEM.md`、`COMMS.md`、`RUNBOOK.md`、`TUNNEL.md`、`AGENT.md`、
`history/`、以及 `DECISIONS.md` 里针对旧代码的 18 条 ADR —— 它们描述的实现已经不在仓库里。
需要「当初为什么这么决定」时看 git 历史（`git log -- docs/`）。
