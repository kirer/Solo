# Tasks

本次实现先于规格落地；任务清单用于逐条核对「规格里的每个行为，代码与测试是否真的成立」。

## 1. 同步转交防死锁

- [x] 1.1 新增等待图与环检测：`src/company/delegation-guard.ts`，`enterDelegation` 在登记前沿目标方向查找闭环
- [x] 1.2 两个同步转交工具接入环检测：`delegate_to_role` / `delegate_to_leader` 拒绝闭环并返回替代方案
- [x] 1.3 目标忙碌快速失败：`busyReason` 检查未结束任务与排队提交，命中则不进入等待
- [x] 1.4 等待可中断：工具 `Context` 经 `management-tools` → `org.ts` → `submission.wait(context)`
- [x] 1.5 单元测试：`test/unit/delegation-guard.test.ts` 覆盖双方环、三方环、自环、连续转交
- [x] 1.6 端到端测试：`test/e2e/web.test.ts`「CEO 卡在同步转交里时，立即处理也能返回并把消息补回去」

## 2. 中断不挂死、不吞消息

- [x] 2.1 `/api/interrupt` 的 abort 增加 5 秒上限：超时也继续投递并返回
- [x] 2.2 abort 前读取队列，abort 后重投「被点击的消息 + 其余排队消息」
- [x] 2.3 消息已经进入对话时返回 `alreadyPlaced`，不重复投递
- [x] 2.4 端到端测试：`test/e2e/web.test.ts` 覆盖普通中断与同步转交中的中断

## 3. 工具卡与排队卡显示

- [x] 3.1 `feed.ts` 用 `callId` 对齐已提交 toolCall，回填参数
- [x] 3.2 已提交的调用不再生成重复的实时卡
- [x] 3.3 无结果且无实时任务的调用标记为 `interrupted`，界面显示「已中断」
- [x] 3.4 转交消息写成 `app.delegate` 条目，`feed.queued` 带 `origin` / `from`
- [x] 3.5 `ui/js/chat.js` 对 agent 来源排队卡不提供「立即处理」
- [x] 3.6 端到端测试：工具卡去重与参数回填、agent 排队来源

## 4. 拍板归属与来源

- [x] 4.1 owner 级待办归属 CEO；只有 owner 级进入老板 `forYou`（既有实现，本次补规格）
- [x] 4.2 `/api/answer` 拒绝非 owner 级问题（既有实现，本次补规格）
- [x] 4.3 上报来源从会话反查真实岗位/姓名，不再写死 `manager`
- [x] 4.4 规格补充：`escalation` 新增「老板只回答自己这一级的问题」

## Workflow follow-up

- [x] 5.1 `npm run check` 通过
- [x] 5.2 `npm test` 通过（203 passed；3 个真实模型用例在网关不可用时自动跳过）
- [x] 5.3 `openspec validate fix-sync-delegation-deadlock --strict` 通过
- [x] 5.4 归档本变更，把 delta 合并进正式规格
