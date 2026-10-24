# Spec Delta

## Purpose

定义派活与回报机制：管理层与项目负责人向员工派发任务并获取结果，员工产出回流给派活者，且员工的能力边界使其无法越级。

## ADDED Requirements

### Requirement: 派活给员工

系统 SHALL 允许管理层或项目负责人向指定员工派发任务并等待其答复。

#### Scenario: 派活并取得答复

- **WHEN** 管理层向某员工派发一条任务
- **THEN** 该任务 SHALL 作为输入进入该员工的会话
- **AND** 派活方 SHALL 收到该员工的答复内容

#### Scenario: 目标员工不存在

- **WHEN** 派活时指定的员工不在名册中
- **THEN** 派活 SHALL 返回明确的失败结果
- **AND** SHALL NOT 创建任何新会话

#### Scenario: 派活给已归档员工

- **WHEN** 派活的目标员工已被归档
- **THEN** 派活 SHALL 被拒绝并说明原因

### Requirement: 员工能力边界

系统 SHALL 使项目员工的可用能力集合不包含任何管理类能力。

#### Scenario: 员工没有管理能力

- **WHEN** 读取任一项目员工的生效能力集合
- **THEN** 该集合 SHALL NOT 包含招聘、派活、立项、创建会话或向上越级的能力

#### Scenario: 员工无法自行创建下属

- **WHEN** 员工尝试创建新的会话或招聘新员工
- **THEN** 系统 SHALL 因该能力不存在而无法执行

#### Scenario: 管理层具备管理能力

- **WHEN** 读取 CHRO 的生效能力集合
- **THEN** 该集合 SHALL 包含招聘与查看名册的能力

### Requirement: 员工产出回流

系统 SHALL 将员工的工作产出以可追溯的方式回流给派活方。

#### Scenario: 派活结果记录在派活方会话

- **WHEN** 员工完成一条派活并给出答复
- **THEN** 派活方会话中 SHALL 出现该答复的记录

#### Scenario: 派活失败

- **WHEN** 员工的工作未能完成（例如被打断或出错）
- **THEN** 派活方 SHALL 收到明确的失败状态
- **AND** SHALL NOT 被当作成功答复

### Requirement: 员工状态查询

系统 SHALL 允许管理层查询项目内员工的在岗与忙碌状态。

#### Scenario: 列出项目员工及状态

- **WHEN** 管理层查询某项目的员工清单
- **THEN** 系统 SHALL 返回每名员工的角色、模型与当前是否忙碌

#### Scenario: 员工正在处理上一条派活

- **WHEN** 向正在忙碌的员工派发新任务
- **THEN** 系统 SHALL 按配置的排队策略处理该任务
- **AND** 该策略 SHALL 至少支持排队为后续输入与拒绝两种模式
