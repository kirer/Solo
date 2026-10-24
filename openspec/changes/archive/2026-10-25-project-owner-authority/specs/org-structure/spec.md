# Spec Delta

## MODIFIED Requirements

### Requirement: 项目与项目员工

系统 SHALL 支持创建项目，并在项目下创建员工；每个项目 SHALL 有一个项目负责人会话。员工的直属上级 SHALL 是管理层岗位或本项目负责人。

#### Scenario: 创建项目

- **WHEN** 管理层创建一个新项目
- **THEN** 系统 SHALL 创建一个项目会话并登记到项目索引
- **AND** 该项目的状态 SHALL 初始为规划中

#### Scenario: 项目负责人

- **WHEN** 查询某项目
- **THEN** 该项目 SHALL 关联一个项目负责人会话
- **AND** 该负责人 SHALL 具备向本项目员工派活的能力

#### Scenario: 招聘项目员工

- **WHEN** CHRO 为某项目招聘一名员工并指定角色
- **THEN** 系统 SHALL 创建该员工的会话并登记到名册
- **AND** 该员工 SHALL 关联到所属项目
- **AND** 其直属上级 SHALL 是管理层岗位之一，或**本项目负责人**

#### Scenario: 未指定上级时默认负责人

- **WHEN** 招聘时没有指定直属上级
- **THEN** 该员工的直属上级 SHALL 默认为本项目负责人
- **AND** SHALL NOT 默认挂到某个管理层岗位

#### Scenario: 拒绝跨项目负责人

- **WHEN** 把某员工的直属上级设为另一个项目的负责人
- **THEN** 系统 SHALL 拒绝该变更并说明原因
- **AND** SHALL NOT 修改名册

#### Scenario: 事后变更直属上级

- **WHEN** 管理层变更一名在职员工的直属上级
- **THEN** 系统 SHALL 在同一次提交内更新名册并写入审计（变更前后可追溯）
- **AND** 该员工的职责描述 SHALL 重新渲染，使提示词里的「直属上级」与新值一致
- **AND** 重复提交同一个值 SHALL 视为成功且 SHALL NOT 产生重复审计

#### Scenario: 上级展示与提示词同源

- **WHEN** 查询组织视图、职工档案或员工名册
- **THEN** 员工上级的显示名 SHALL 由名册里的直属上级解析得出
- **AND** SHALL NOT 由另一份独立的字段决定（避免同一个人在两处显示不同上级）

#### Scenario: 员工归属为任务所有

- **WHEN** 查询项目员工会话的归属
- **THEN** 该归属 SHALL 为一个后台任务，使员工工作不被上级会话的中断操作波及

#### Scenario: 员工在上级中断后继续工作

- **WHEN** 老板中断 CEO 会话的当前工作
- **THEN** 正在进行的项目员工工作 SHALL 继续运行至完成
