# project-authority Specification

## Purpose
TBD - created by archiving change project-owner-authority. Update Purpose after archive.

## Requirements

### Requirement: 项目负责人默认持有本项目资源面

系统 SHALL 让项目负责人默认持有本项目真实资源面的读写执行能力，权限随负责人身份自动生效，不需要逐项授权。

#### Scenario: 负责人能读写本项目文件

- **WHEN** 项目负责人要修改本项目工作空间里的文件
- **THEN** 它 SHALL 能读取、写入与编辑
- **AND** 它执行命令时的默认目录 SHALL 是本项目工作空间

#### Scenario: 负责人能接员工上报

- **WHEN** 项目内员工把问题上报给负责人
- **THEN** 负责人 SHALL 能在自己的待决队列里看到并答复
- **AND** 只有负责人这一级能答复该问题

#### Scenario: 负责人不能做公司级动作

- **WHEN** 项目负责人尝试招聘员工、立项、终止项目或删除项目
- **THEN** 系统 SHALL NOT 提供这些能力
- **AND** 这些动作 SHALL 只能由具备对应能力包的管理层执行

#### Scenario: 权限不跨项目

- **WHEN** 项目负责人操作另一个项目的状态或员工
- **THEN** 系统 SHALL 拒绝

### Requirement: 权限随身份变化自动调整

系统 SHALL 让项目负责人的权限跟随其身份与项目状态变化，而不是依赖逐项配置。

#### Scenario: 负责人变更

- **WHEN** 一个项目的负责人换成另一个人
- **THEN** 该项目的员工上级引用 SHALL 自动指向新负责人
- **AND** 不需要逐条迁移员工记录

#### Scenario: 终止后回收

- **WHEN** 项目被终止
- **THEN** 负责人的执行与派活能力 SHALL 被收回
- **AND** 只保留查看与上报

### Requirement: 项目负责人可变更员工直属上级

系统 SHALL 允许管理层变更已招员工的直属上级，且变更结果在展示、提示词与上报路由三处一致生效。

#### Scenario: 变更后三处一致

- **WHEN** 管理层把某员工的直属上级改为 `cto`
- **THEN** 组织视图与职工档案 SHALL 显示 CTO
- **AND** 该员工的职责描述 SHALL 写 CTO
- **AND** 它之后的上报 SHALL 路由到 CTO

#### Scenario: 变更留痕

- **WHEN** 直属上级发生变更
- **THEN** 系统 SHALL 记录变更前后、执行者与时间
- **AND** 记录 SHALL 可追溯到具体员工
