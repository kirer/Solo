# Proposal

## Why

真实跑 dino-runner 时，CEO → CTO → 项目负责人 → 又转交回 CTO，三个会话互相同步等待，形成死锁。表象是三个问题：

1. 工具卡永远停在「运行中 / 等待输出…」，参数还显示「（无参数）」；
2. 老板点「立即处理」没有任何反应——`abort()` 要等会话 idle，而环永远不 idle；更糟的是 abort 先撤队列，消息被吞掉；
3. 项目负责人/员工看起来在等老板拍板，实际上是等 CEO；`from` 还写死成 `manager`。

修复已经落地并有测试覆盖，但正式规格里没有对应契约，而且 `delegation` 规格里「插队只保留被点击的那一条」已经与实现相反。本次补齐规格，避免下次改动把死锁防线和消息保全逻辑推翻。

## What Changes

- 修改 `delegation`：同步转交必须做环检测与忙碌快速失败；等待必须可中断；插队不得丢失其它排队消息；排队消息必须区分老板与 agent 来源。
- 修改 `tui-workspace`：同一工具调用只出现一张卡、参数完整、中断后显示「已中断」；agent 派来的排队任务不提供「立即处理」。
- 修改 `escalation`：只有 owner 级问题出现在老板拍板队列；owner 级统一归属 CEO；来源显示真实岗位而不是 `manager`。

## Capabilities

### Modified Capabilities

- `delegation`: 补充同步转交的防死锁约束、可中断等待、插队消息保全与排队来源区分。
- `tui-workspace`: 补充工具卡去重/参数回填/中断态，以及排队卡的来源语义。
- `escalation`: 补充老板待办层级与来源归属约束。

## Impact

- 代码：`src/company/delegation-guard.ts`、`src/company/org.ts`、`src/company/delegation.ts`、`src/company/management-tools.ts`、`src/server/http.ts`、`src/server/feed.ts`、`ui/js/chat.js`、`ui/css/chat.css`
- 测试：`test/unit/delegation-guard.test.ts`、`test/e2e/web.test.ts`
- 文档：`docs/design/DECISIONS.md`（ADR-025）、`docs/design/WEB-UI-CONTRACT.md`、`docs/RUNBOOK.md`
