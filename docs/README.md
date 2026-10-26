# 文档索引

> **给 AI agent 的入口**：先读 [`AGENTS.md`](../AGENTS.md)，它告诉你「要做什么 → 读哪一份」。
> 本页是文档地图，`AGENTS.md` 是行为约定。

按「你想干什么」找。

## 现行文档（会随代码更新，可信）

| 文档 | 内容 | 什么时候读 |
|---|---|---|
| [SYSTEM](SYSTEM.md) | **系统逻辑**：不用读代码就能懂。公司长什么样、一次派活怎么走完、各个数据文档存什么、升级链和看门狗为什么存在、成本花在哪、哪里是坑 | 第一次接触；要判断「某件事该不该这样」 |
| [CODE](CODE.md) | **代码地图**：要改某个东西该动哪个文件。分层与边界、启动顺序（含三个顺序坑）、能力包、接口清单、「我想改 X → 动这里」对照表、改动前检查清单 | 要动代码 |
| [DECISIONS](DECISIONS.md) | **33 条架构决策记录（ADR）**，每条写了背景、替代方案、为什么这么选 | 想改一个「看起来不该这么写」的地方之前 |
| [COMMS](COMMS.md) | **通信模型**：频道 / 消息 / 任务 / 投递与唤醒策略、六条核心流程、模块结构 | 碰 `src/domain/channels.ts`、`src/company/deliver.ts`、频道界面 |
| [WEB-API](WEB-API.md) | **网页 API 契约**：前端只按这里写，后端改字段必须同步这里 | 改 `src/server/routes.ts` / `http.ts` 或 `ui/` |
| [RUNBOOK](RUNBOOK.md) | 换模型、备份、升级依赖、排障、数据文件说明 | 运维 / 出故障 |
| [DEPLOY](DEPLOY.md) | 局域网访问、Docker 部署、安全边界、Tauri 桌面壳评估 | 要部署出去 |
| [TUNNEL](TUNNEL.md) | **内网穿透**：cloudflared-manager、`https://oxfff.com`、Cloudflare Access 白名单、踩过的坑 | 要让外网访问 |

## 历史文档（冻结，只记录「当时为什么这么决定」）

`docs/history/` 下的文件**不再维护**，里面的行号、文件路径、数量、截图都可能失效。
需要理解「当初的推理」时读，不要当现状。

| 文档 | 内容 |
|---|---|
| [history/PLAN](history/PLAN.md) | 技术选型：为什么是 pi-durable 而不是 Pi 本体或 SDK；架构怎么定；15 个必踩的坑 |
| [history/ANSWERS](history/ANSWERS.md) | 七个设计问题的详细回答：各层是什么、项目建不建文件夹、skill/MCP 谁给、决策权、分支对话、token 分账、沟通追踪 |
| [history/HANDOFF](history/HANDOFF.md) | 完成报告：做了什么、修过哪些真 bug、当时的判断 |
| [history/PLAN-16](history/PLAN-16.md) | 16 项体验问题的归并与实施记录 |
| [history/OPTIMIZATION-CONTRACT](history/OPTIMIZATION-CONTRACT.md) | 某一轮多 agent 并行改界面的施工契约 |
| [history/WEB-UI-CONTRACT](history/WEB-UI-CONTRACT.md) | 网页界面设计契约（右侧对话面板时代的版本） |
| [history/WEB-UI-BACKEND-MATRIX](history/WEB-UI-BACKEND-MATRIX.md) | 界面 × 后端能力对照快照 |
| [history/OWNER-AUTHORITY-DECISION](history/OWNER-AUTHORITY-DECISION.md) | 项目负责人权限改造的规格裁定与 v2 |

## 底层调研（`docs/research/`）

| 文档 | 内容 |
|---|---|
| [research/01-pi-docs](research/01-pi-docs.md) | Pi 官方文档全量调研（643 行）：形态、配置、扩展开发、约 40 个事件、SDK/RPC 嵌入 |
| [research/02-pi-durable](research/02-pi-durable.md) | pi-durable 深度调研（597 行）：定位、架构、二次开发、多 agent 编排、成本、风险 |
| [research/03-pi-source-durable](research/03-pi-source-durable.md) | 源码研读（800 行）：真实签名、31 个示例逐个解读、12 个可复用模式 |

---

## 阅读顺序建议

**第一次接触** → `AGENTS.md` → SYSTEM（它怎么运转）→ README（怎么启动）

**要改代码** → CODE（先找到文件）→ DECISIONS（哪些边界不能碰）→ SYSTEM / COMMS（这块现在是什么行为）→ `src/`

**要改界面** → CODE 第 6 节（`ui/` 模块边界）→ WEB-API（数据从哪来）→ COMMS §7

**要升级 pi-durable** → history/PLAN 附录 B（15 个坑）→ `test/contract/`（契约测试会告诉你底层行为有没有变）

---

## 文档为什么这么组织

- **一份事实只有一个家**：系统逻辑在 SYSTEM，代码位置在 CODE，不变量在 DECISIONS，接口字段在 WEB-API。这四份会随代码更新，其余文档都不该出现重复的事实。
- **历史不删、但不假装是现状**：`docs/history/` 全部冻结，文件头有「已归档」横幅。想在文档里写「为什么当初这么选」，写进 DECISIONS（那是持续有效的）；一次性的施工语境留在 history。
- **截图不入库**：需要图就用 `npm run ui:shot`（输出到 `.taste-skill/shots/`，已 gitignore），别提交 PNG。
