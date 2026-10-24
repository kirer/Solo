# Tasks

## 1. 数据模型

- [x] 1.1 `ManagerRef = ManagementRole | leader:<slug>`，`StaffEntry.manager` 放宽（持久化仍是 string，不升文档版本）
- [x] 1.2 `managerLabelOf` / `managerConversationOf` / `leaderSlugOf` / `isLeaderManagerRef` / `isValidManagerRef` 作为唯一解析入口
- [x] 1.3 招聘 `manager` 可选，缺省 `leader:<project>`；非法值在写库前拒绝
- [x] 1.4 `reassignStaff` 写路径：单事务改索引 + 审计 `staff-manager-change` + 重渲染员工提示词
- [x] 1.5 停写 `ProfileDoc.parent` 并删除字段

## 2. 权限

- [x] 2.1 负责人能力包增加 `read/write/edit/bash` 与 `pending_list`/`answer_pending`/`project_status`
- [x] 2.2 负责人职责描述同步更新（执行面、接上报、只到项目边界）
- [x] 2.3 员工能力包增加 `escalate`（按角色工具 + 上报）
- [x] 2.4 终止后负责人换 `role-leader-readonly`，启动修复按项目状态选包
- [x] 2.5 管理层岗位补充 `staff_reassign`（CHRO/CEO）、`project_status`（CEO/CPO）

## 3. 状态

- [x] 3.1 `setProjectStatus`：显式迁移边、幂等、非法边、终态、权限校验、审计 `project-status`
- [x] 3.2 `project_status` 工具接入管理层与负责人能力包

## 4. 升级链

- [x] 4.1 `EscalationInput.manager` 接受 `leader:<slug>`，层级按字符串落库
- [x] 4.2 `levelOfConversation` / `answerPendingAtLevel`：待决项按层级精确匹配，不再写死 `ceo`
- [x] 4.3 启动修复：非法上级引用回落到本项目负责人（项目不存在则 CEO）

## 5. 迁移与验收

- [x] 5.1 `scripts/migrate-staff-manager.ts`（`--db/--project/--staff/--dry-run/--check`）
- [x] 5.2 `scripts/acceptance/reorg-probe.mjs`（只读探针，`--expect before|after|--dump`）
- [x] 5.3 `test/e2e/reorg-acceptance.test.ts` 覆盖数据/展示/提示词/能力/状态/终止回收/上报路由/迁移幂等
- [x] 5.4 `npm run check` 与 `npm test` 全绿（离线门禁排除 `real-model.test.ts`）

## 6. 文档

- [x] 6.1 ADR：字符串引用与权限回收（补进 DECISIONS）
- [x] 6.2 RUNBOOK：迁移步骤（停服 → 备份 → dry-run → 执行 → 验证 → 起服）
- [x] 6.3 决策备忘录标注落地结果
