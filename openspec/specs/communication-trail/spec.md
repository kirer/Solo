# communication-trail Specification

## Purpose
定义沟通留痕：角色之间、角色与员工之间的每一条指令与回报都落成不可变记录，支持按会话追溯与重建全公司时间线，为图形界面预留数据形态。

## Requirements

### Requirement: 每条沟通落成不可变记录

系统 SHALL 将角色之间、角色与员工之间的每一次指令、回报、升级与决定记录为不可变条目。

#### Scenario: 派活被记录

- **WHEN** 管理层向员工派发任务
- **THEN** 系统 SHALL 记录一条包含时间、发送方、接收方与类型的条目

#### Scenario: 答复被记录

- **WHEN** 员工给出答复
- **THEN** 系统 SHALL 记录一条包含时间、发送方、接收方与类型的条目

#### Scenario: 记录不可修改

- **WHEN** 任何一方尝试修改已记录的沟通条目
- **THEN** 该修改 SHALL NOT 生效
- **AND** 原始记录 SHALL 保持可读

### Requirement: 双向留痕

系统 SHALL 在沟通双方的会话中分别留下记录，使任一端都能追溯完整往来。

#### Scenario: 发送方视角

- **WHEN** 甲向乙发送一条消息
- **THEN** 甲的会话中 SHALL 出现一条「我发给乙」的记录

#### Scenario: 接收方视角

- **WHEN** 甲向乙发送一条消息
- **THEN** 乙的会话中 SHALL 出现一条「甲发给我」的记录

#### Scenario: 两端记录可对应

- **WHEN** 比较双方的记录
- **THEN** 两者 SHALL 能通过共同标识对应到同一次沟通

### Requirement: 跨会话追溯

系统 SHALL 支持跨全部会话检索沟通记录并重建时间线。

#### Scenario: 按时间重建时间线

- **WHEN** 请求全公司沟通时间线
- **THEN** 系统 SHALL 返回按时间排序的全部沟通记录
- **AND** 每条 SHALL 标明发生在哪个会话

#### Scenario: 按项目过滤

- **WHEN** 请求某项目的沟通记录
- **THEN** 系统 SHALL 返回该项目负责人与该项目员工相关的记录

#### Scenario: 追溯链条完整

- **WHEN** 查询某次升级流程相关的沟通
- **THEN** 系统 SHALL 能给出从员工反馈到最终决定的完整记录链

### Requirement: 沟通类型可区分

系统 SHALL 为沟通记录标注类型，使不同类型的往来可区分呈现。

#### Scenario: 类型标注

- **WHEN** 记录一条沟通
- **THEN** 其类型 SHALL 属于一组预定义类型，至少覆盖：指令、答复、上报、决定、招聘、归档

#### Scenario: 按类型过滤

- **WHEN** 请求仅包含上报类记录
- **THEN** 系统 SHALL 返回该类型的记录集合

### Requirement: 为图形界面预留的数据形态

系统 SHALL 提供可直接渲染为关系图的数据形态。

#### Scenario: 节点与边

- **WHEN** 请求组织关系图数据
- **THEN** 系统 SHALL 返回节点集合（角色、项目、员工）与边集合（沟通记录）
- **AND** 每条边 SHALL 标明起点会话、终点会话、类型与时间

#### Scenario: 实时协作结构

- **WHEN** 请求当前协作结构
- **THEN** 系统 SHALL 返回全部活跃任务及其归属关系与状态
- **AND** 该结构 SHALL 随工作推进而更新
