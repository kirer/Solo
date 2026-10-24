# Spec Delta

## Purpose

定义成本记账与聚合：按会话取得 token 与成本、按项目与角色聚合、分叉会话不重复计账，并保证成本数字在界面中准确可见。

## ADDED Requirements

### Requirement: 按会话取得用量

系统 SHALL 能取得任意单个会话的 token 用量与成本，并按模型与工具分桶。

#### Scenario: 读取单会话用量

- **WHEN** 查询某会话的用量
- **THEN** 系统 SHALL 返回按「提供方/模型」分组的 token 与成本
- **AND** 若该会话使用过多个模型，各模型 SHALL 分别成组

#### Scenario: 会话尚无用量

- **WHEN** 查询一个从未执行过模型请求的会话
- **THEN** 系统 SHALL 返回零值而非错误

#### Scenario: 失败与中断也计入

- **WHEN** 一次模型请求失败或被中断
- **THEN** 其消耗的 token SHALL 计入该会话用量

### Requirement: 分叉会话不重复计账

系统 SHALL 保证分叉会话的用量从其自身起点开始计算，不包含父会话已计入的消耗。

#### Scenario: 分叉后分别统计

- **WHEN** 在父会话某条消息处分叉并继续对话
- **THEN** 父会话与分叉会话的用量 SHALL 分别独立统计
- **AND** 两者相加 SHALL 等于全公司总量

#### Scenario: 分叉历史不作为用量依据

- **WHEN** 统计分叉会话的用量
- **THEN** 系统 SHALL 依据该会话自身的用量记录
- **AND** SHALL NOT 通过累加会话可见历史中的消息消耗来统计，因为分叉会话的历史包含父会话的消息

### Requirement: 按项目与角色聚合

系统 SHALL 能按项目与按角色聚合成本。

#### Scenario: 按项目聚合

- **WHEN** 查询某项目的成本
- **THEN** 系统 SHALL 返回该项目的项目负责人与全部员工的用量合计

#### Scenario: 按角色聚合

- **WHEN** 查询某管理层岗位的成本
- **THEN** 系统 SHALL 返回该岗位会话的用量

#### Scenario: 全公司合计

- **WHEN** 查询全公司成本
- **THEN** 系统 SHALL 返回所有会话用量的合计
- **AND** 该合计 SHALL 等于各会话分别求和的结果

### Requirement: 成本数字的准确性前提

系统 SHALL 在使用非官方模型提供方时明确成本可能为零并说明原因。

#### Scenario: 提供方未提供价格

- **WHEN** 模型提供方未声明价格信息
- **THEN** token 数量 SHALL 仍然准确
- **AND** 成本金额 SHALL 为零，且系统 SHALL 能让宿主识别这一情况

#### Scenario: 事后补算

- **WHEN** 宿主获得模型价格信息后需要补算历史成本
- **THEN** 系统 SHALL 支持依据已记录的 token 数量重新计算成本

### Requirement: 界面中的成本可见

系统 SHALL 在界面中常驻显示当前会话、当前项目与全公司的成本。

#### Scenario: 切换会话时成本更新

- **WHEN** 用户切换到另一个会话
- **THEN** 界面的当前会话成本 SHALL 更新为该会话的数字
- **AND** 当前项目成本 SHALL 更新为该项目

#### Scenario: 成本随对话推进

- **WHEN** 一个会话完成一轮模型请求
- **THEN** 界面中的成本 SHALL 在一个短暂延迟内反映新增消耗
