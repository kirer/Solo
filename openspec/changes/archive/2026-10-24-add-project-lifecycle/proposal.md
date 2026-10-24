# Proposal

## Why

`build-ai-company-v1` 归档时，v1 的八项能力已经全部进正式规格。但归档之后又落地了四项能力，它们**已经在代码里跑通、有测试覆盖，却没有对应的规格**：

- **终止项目**：老板跟 CEO 说一句就能停下整个项目
- **彻底删除项目**：确认后移除项目记录、员工名册与工作区产物
- **消息排队与插队**：老板在 CEO 忙时发消息，能看到「已排队」并选择立即处理
- **项目卡翻转**：网页主视图里点击项目卡，翻转成「负责人 + 员工」的层级

规格缺失的后果是具体的：下次改动这些功能时，没有「什么行为不能变」的契约可依；`test/e2e/terminate.test.ts` 里的 15 个用例断言的行为，在规格层面是不可见的。

本变更补齐这些规格，使规格库与代码重新对齐。

## What Changes

- 新增能力 `project-lifecycle`：覆盖项目的终止与删除两步流程
- 修改能力 `delegation`：补充「忙碌时消息的排队与插队可见性」
- 修改能力 `tui-workspace`：补充「项目卡翻转展开团队」与「排队消息的可见与处理」

不改变任何实现——这是纯规格补充。

## Capabilities

### New Capabilities

- `project-lifecycle`: 项目的生命周期收尾——终止（可逆的软停）与彻底删除（不可逆），以及两者之间的确认门槛与路径安全校验。

### Modified Capabilities

- `delegation`: 增加「向忙碌会话发消息时必须可见排队状态，并允许插队立即处理」的要求。
- `tui-workspace`: 增加「点击项目卡翻转展开团队」与「排队消息的显示与立即处理」的要求。

## Impact

- 只影响 `archive/openspec/` 下的规格文档
- 不改代码、不改测试
- 涉及代码位置（供对照，不修改）：`src/company/org.ts`（terminateProject / deleteProject）、`src/server/http.ts`（/api/message、/api/interrupt）、`src/server/feed.ts`（queued）、`ui/app.js`（翻转与排队渲染）
