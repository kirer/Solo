# Proposal

## Why

`ops-defect-loop` 跑起来之后暴露了一个结构问题：项目负责人（许砚舟）在系统里**不是一个可以被引用的上级**。

- `StaffEntry.manager` 只能是七个管理层岗位之一，所以 `log-ops` 写的是 `coo`、`backend-fix` 写的是 `cto`；员工提示词里说「向 COO/CTO 汇报」，老板看到的组织图也把他们挂在 COO/CTO 下面。
- 但两人的真实归属一直是项目负责人（旧 `ProfileDoc.parent` 指向 73），只是这个字段没有任何读取者。
- 负责人能力包里没有执行工具（不能读写项目文件、不能跑命令），也接不了员工上报（没有 `pending_list`/`answer_pending`）；员工能力包里也没有 `escalate`，上报只能由管理层发起。
- 项目状态从立项起就停在 `planning`：枚举里有六个状态，但只有 `createProject` 写 `planning`、`terminateProject` 写 `terminated`，没有任何写 `active` 的路径。

平台给的建议方向是对的（把负责人变成可引用的真实对象、负责人默认持有项目资源面、补状态写接口），但其中「新建负责人实体 + 权限矩阵 + 仓库/CI/部署/凭据权限」超出了本系统的实际模型。本变更按最小可实现集合落地：

- 用 `leader:<slug>` 字符串引用代替新实体（负责人已有稳定 ID 与姓名）；
- 权限继续用「能力包 = 工具存在」表达，不做权限矩阵；
- 资源面只覆盖本仓库真实存在的：项目文件、项目内命令、只读运行数据；不发明仓库/CI/部署/凭据对象；
- 补状态写接口、负责人能力包、员工上报能力、终止回收与迁移脚本。

## What Changes

- **数据模型**：`StaffEntry.manager` 取值域从「七个管理层岗位」扩为「管理层岗位或本项目负责人（`leader:<slug>`）」；招聘默认归本项目负责人；新增变更上级的写路径；退役只写不读的 `ProfileDoc.parent`。
- **项目权限**：项目负责人能力包增加执行工具（read/write/edit/bash）与 `pending_list`/`answer_pending`；员工能力包增加 `escalate`；终止后负责人换成只读能力包。
- **状态流转**：新增 `project_status` 写路径（planning→active、active↔paused、active/paused→done），带权限校验、幂等、非法边拒绝与审计。
- **升级链**：`EscalationInput.manager` 支持负责人引用；待决项按 `leader:<slug>` 层级落库；`pending_list`/`answer_pending` 按「是不是到我这一级」判断，不再写死 `ceo`。
- **迁移**：一次性把 `ops-defect-loop` 的两名员工迁到负责人名下；迁移幂等、可预演、不升文档版本；提供只读验收探针。
- **规格与文档**：新增能力 `project-authority`；修改 `org-structure`、`project-lifecycle`、`escalation`；补 ADR 与 RUNBOOK。

## Capabilities

### New Capabilities

- `project-authority`: 项目负责人的权限边界——默认持有本项目真实资源面的读写执行能力，以及终止后的权限回收、变更上级的生效范围。

### Modified Capabilities

- `org-structure`: 员工直属上级的取值域扩为「岗位或本项目负责人」，招聘默认负责人，支持事后变更，展示与提示词同源。
- `project-lifecycle`: 增加项目状态可推进（planning→active→paused/done）与终止后的权限回收。
- `escalation`: 升级链起点支持项目负责人这一层，待决项按层级精确定位，负责人可接办员工上报。

## Impact

- 代码：`src/company/docs.ts`、`org.ts`、`tools.ts`、`roles.ts`、`management-tools.ts`、`escalation.ts`、`src/server/{org-view,profile,feed}.ts`、`src/company/delegation.ts`
- 脚本：`scripts/migrate-staff-manager.ts`、`scripts/acceptance/reorg-probe.mjs`
- 测试：新增 `test/e2e/reorg-acceptance.test.ts`
- 数据：`workspace/company.sqlite` 中两名员工的 `manager` 字段（一次性迁移，不升文档版本）
- 不影响：任务/会话格式、HTTP 读接口形状、其他项目
