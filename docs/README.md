# 文档索引

按「你想干什么」找。

## 我想先搞懂它现在是怎么运转的

| 文档 | 内容 |
|---|---|
| [SYSTEM](SYSTEM.md) | **系统逻辑**：不用读代码就能懂。公司长什么样、一次派活怎么走完、9 个数据文档各存什么、升级链和看门狗为什么存在、成本花在哪、哪里是坑 |
| [CODE](CODE.md) | **代码地图**：要改某个东西该动哪个文件。分层与边界、启动顺序（含三个顺序坑）、能力包、接口清单、「我想改 X → 动这里」对照表、改动前检查清单 |

## 我要用起来

| 文档 | 内容 |
|---|---|
| [README](../README.md) | 安装、启动、界面操作、终止项目 |
| [RUNBOOK](RUNBOOK.md) | 换模型、备份、升级依赖、排障、数据文件说明 |
| [DEPLOY](DEPLOY.md) | 局域网访问、Docker 部署、安全边界、Tauri 桌面壳评估 |
| [TUNNEL](TUNNEL.md) | **内网穿透**：cloudflared-manager 部署、`https://oxfff.com`、Cloudflare Access 白名单、日常运维与踩过的坑 |

## 我想知道这东西是怎么被做出来的

| 文档 | 内容 |
|---|---|
| [HANDOFF](HANDOFF.md) | 完成报告：做了什么、修过哪些真 bug、当时的判断 |
| [design/PLAN](design/PLAN.md) | 技术选型：为什么是 pi-durable 而不是 Pi 本体或 SDK；架构怎么定；15 个必踩的坑 |
| [design/ANSWERS](design/ANSWERS.md) | 七个设计问题的详细回答：各层是什么、项目建不建文件夹、skill/MCP 谁给、决策权、分支对话、token 分账、沟通追踪 |
| [design/DECISIONS](design/DECISIONS.md) | **24 条架构决策记录**，每条都写了背景、替代方案、为什么这么选 |
| [design/OWNER-AUTHORITY-DECISION](design/OWNER-AUTHORITY-DECISION.md) | **项目负责人权限改造的规格裁定与 v2**：原稿哪里要收窄、哪里要加项，可直接转交改造方 |
| [design/WEB-API](design/WEB-API.md) | **网页 API 契约**：设置 / 模型 / 附件 / 看板 / IM / 局域网的字段与错误码，改接口先改它 |
| [`openspec/specs/`](../openspec/specs/) | **规格库**：9 个能力、54 条需求。改代码前先看这里「什么行为不能变」 |

## 我想了解底层

| 文档 | 内容 |
|---|---|
| [research/01-pi-docs](research/01-pi-docs.md) | Pi 官方文档全量调研（643 行）：形态、配置、扩展开发、约 40 个事件、SDK/RPC 嵌入 |
| [research/02-pi-durable](research/02-pi-durable.md) | pi-durable 深度调研（597 行）：定位、架构、二次开发、多 agent 编排、成本、风险 |
| [research/03-pi-source-durable](research/03-pi-source-durable.md) | 源码研读（800 行）：真实签名、31 个示例逐个解读、12 个可复用模式 |

## 截图

`docs/shots/` 下是界面截图，按时间顺序（**2026-10 之前的旧版**：那时右侧还有
常驻对话面板，该面板后来已删除，界面现在是「组织 / 频道 / 看板」三视图）：

1. 主视图（组织架构）
2. 项目翻转（负责人 + 员工）
3. 对话面板（思考 / 工具调用 / 输出）
4. 真实项目跑起来的样子
5. 已终止的项目
6. 消息排队与「立即处理」

---

## 阅读顺序建议

**第一次接触** → SYSTEM（它怎么运转）→ README → RUNBOOK

**要改代码** → CODE（先找到文件）→ `openspec/specs/`（这个能力现在保证什么行为）→ design/DECISIONS（哪些边界不能碰）→ design/PLAN 第 2 章（架构）→ `src/`

**要升级 pi-durable** → design/PLAN 附录 B（15 个坑）→ `test/contract/`（契约测试会告诉你底层行为有没有变）
