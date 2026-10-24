# Spec Delta

## ADDED Requirements

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
