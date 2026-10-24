# delegation Specification

## Purpose
定义派活与回报机制：管理层与项目负责人向员工派发任务并获取结果，员工产出回流给派活者，且员工的能力边界使其无法越级。

## Requirements

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

### Requirement: 忙碌时的消息排队必须可见

系统 SHALL 在向正在忙碌的会话发送消息时，让发送方看到该消息处于排队状态。

#### Scenario: 消息未立刻进入对话时显示为已排队

- **WHEN** 向一个正在执行工作的会话发送消息
- **THEN** 该消息 SHALL 在界面上显示为「已排队」状态
- **AND** SHALL 显示这条消息的原文
- **AND** SHALL NOT 让发送方误以为消息没有发出

#### Scenario: 排队消息处理完成后消失

- **WHEN** 排队的消息被处理并进入对话
- **THEN** 它 SHALL 从排队状态变为对话中的一条普通消息
- **AND** 排队标记 SHALL 消失

#### Scenario: 空闲时发送不进入排队

- **WHEN** 向一个空闲的会话发送消息
- **THEN** 该消息 SHALL 直接进入对话
- **AND** SHALL NOT 显示排队状态

### Requirement: 排队策略默认优先于当前轮次

系统 SHALL 让新发送的消息优先于当前轮次的剩余工作被处理，而不是排在整轮结束之后。

#### Scenario: 默认排队语义

- **WHEN** 向忙碌会话发送消息且未指定策略
- **THEN** 该消息 SHALL 在当前轮次的工具调用结束后被处理
- **AND** SHALL NOT 等到整轮回答完全结束

#### Scenario: 可显式指定排队方式

- **WHEN** 发送消息时显式指定了排队方式
- **THEN** 系统 SHALL 按指定的方式排队

### Requirement: 排队消息可以插队立即处理

系统 SHALL 允许发送方把一条排队中的消息提升为立即处理。

#### Scenario: 立即处理会打断当前工作

- **WHEN** 发送方对一条排队消息选择「立即处理」
- **THEN** 目标会话当前正在执行的工作 SHALL 被中断
- **AND** 该消息 SHALL 被重新投递并立即成为待处理输入

#### Scenario: 插队后队列清空

- **WHEN** 插队处理完成
- **THEN** 发送方看到的排队状态 SHALL 消失
- **AND** 该消息 SHALL 出现在对话中

#### Scenario: 插队只保留被点击的那一条

- **WHEN** 有多条消息排队时对其中一条选择「立即处理」
- **THEN** 中断 SHALL 清空其余排队消息
- **AND** 只有被点击的那一条 SHALL 被重新投递
