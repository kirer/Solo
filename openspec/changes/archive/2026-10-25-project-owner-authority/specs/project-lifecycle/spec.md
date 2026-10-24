# Spec Delta

## ADDED Requirements

### Requirement: 项目状态可以推进

系统 SHALL 支持把项目状态按显式允许的边推进，并记录变更人。

#### Scenario: 立项后转进行中

- **WHEN** 本项目负责人或管理层把 `planning` 的项目推进为 `active`
- **THEN** 项目状态 SHALL 变为 `active`
- **AND** SHALL 写入一条状态变更审计

#### Scenario: 暂停与恢复

- **WHEN** 项目处于 `active` 或 `paused`
- **THEN** 系统 SHALL 允许在两者之间切换

#### Scenario: 完成

- **WHEN** 项目处于 `active` 或 `paused`
- **THEN** 系统 SHALL 允许推进为 `done`
- **AND** `done` SHALL 是终态，不能再推进

#### Scenario: 幂等

- **WHEN** 把项目推进到它当前已经处于的状态
- **THEN** 系统 SHALL 返回成功
- **AND** SHALL NOT 写入重复的审计事件

#### Scenario: 非法迁移被拒

- **WHEN** 请求一条不在允许边内的迁移（例如 `planning` 直接到 `done`）
- **THEN** 系统 SHALL 拒绝并说明允许的目标状态
- **AND** SHALL NOT 修改任何状态

#### Scenario: 越权推进被拒

- **WHEN** 既不是本项目负责人也不是管理层的会话请求变更项目状态
- **THEN** 系统 SHALL 拒绝
- **AND** SHALL NOT 修改任何状态

#### Scenario: 终止仍走两步流程

- **WHEN** 请求把项目状态改为 `terminated`
- **THEN** 系统 SHALL 指引改用终止流程（终止还要停下在跑的任务、归档员工）

### Requirement: 终止会回收负责人权限

系统 SHALL 在项目终止后收回项目负责人的执行与派活能力，只保留查看与上报。

#### Scenario: 终止后负责人不能执行

- **WHEN** 项目终止完成
- **THEN** 该项目负责人的能力包 SHALL 换成只读版本
- **AND** 其可用工具 SHALL NOT 包含文件读写、命令执行与员工派活
- **AND** 进程重启后 SHALL 仍保持只读
