# Spec Delta

## Purpose

定义三栏终端界面：左侧组织树导航、中间会话流（含流式输出与工具调用）、右侧任务与成本面板、底部输入框，以及键盘操作与中断语义。

## ADDED Requirements

### Requirement: 三栏常驻布局

系统 SHALL 以三栏常驻布局呈现公司，三栏分别为组织树、会话流、任务与成本面板。

#### Scenario: 启动即呈现三栏

- **WHEN** 用户启动界面
- **THEN** 界面 SHALL 同时显示组织树、会话流与任务成本面板
- **AND** 底部 SHALL 存在输入框

#### Scenario: 窗口尺寸变化

- **WHEN** 终端窗口尺寸改变
- **THEN** 三栏 SHALL 重新布局以适应新尺寸
- **AND** 会话流 SHALL 占据可变宽度的剩余空间

#### Scenario: 极窄窗口

- **WHEN** 终端宽度不足以容纳三栏
- **THEN** 界面 SHALL 折叠侧栏并保持会话流与输入可用
- **AND** SHALL NOT 崩溃或显示错乱

### Requirement: 组织树导航

系统 SHALL 在组织树中按层级展示 CEO、管理层、项目与项目员工。

#### Scenario: 层级结构

- **WHEN** 查看组织树
- **THEN** 其顶层 SHALL 为 CEO 与六位管理层
- **AND** 项目 SHALL 作为独立分组展示，项目下 SHALL 展示其员工

#### Scenario: 状态指示

- **WHEN** 某会话正在工作、等待答复或空闲
- **THEN** 组织树中该节点 SHALL 显示对应的状态标记

#### Scenario: 选中与进入

- **WHEN** 用户用方向键选中某节点并按确认键
- **THEN** 会话流 SHALL 切换为该会话
- **AND** 输入框的投递目标 SHALL 随之切换

#### Scenario: 待拍板提示

- **WHEN** 存在等待老板拍板的升级流程
- **THEN** 组织树中相关节点 SHALL 显著标记
- **AND** 任务面板 SHALL 显示待拍板数量

### Requirement: 会话流渲染

系统 SHALL 在会话流中渲染对话历史、正在生成的回答与工具调用。

#### Scenario: 渲染历史消息

- **WHEN** 打开一个有历史的会话
- **THEN** 会话流 SHALL 按时间顺序展示消息
- **AND** 不同角色（用户、助手、工具结果）SHALL 有可区分的呈现

#### Scenario: 流式生成

- **WHEN** 助手正在生成回答
- **THEN** 会话流 SHALL 逐步展示已生成的内容
- **AND** 生成完成时 SHALL 更新为完整内容

#### Scenario: 工具调用可见

- **WHEN** 助手发起一次工具调用
- **THEN** 会话流 SHALL 展示工具名与运行状态
- **AND** 完成后 SHALL 展示成功或失败

#### Scenario: 工具输出折叠

- **WHEN** 工具返回大量输出
- **THEN** 默认 SHALL 折叠显示摘要
- **AND** 用户 SHALL 能展开查看完整内容

#### Scenario: 自动滚动

- **WHEN** 新内容追加到会话流
- **THEN** 视图 SHALL 保持在最新内容处
- **AND** 若用户已向上滚动查看历史，SHALL NOT 强制跳回底部

### Requirement: 输入与中断

系统 SHALL 提供输入框用于向当前会话投递消息，并支持在生成过程中干预。

#### Scenario: 提交消息

- **WHEN** 用户输入内容并提交
- **THEN** 该内容 SHALL 作为输入投递给当前选中的会话

#### Scenario: 生成中追加输入

- **WHEN** 当前会话正在生成且用户提交新内容
- **THEN** 系统 SHALL 按配置的排队策略处理该输入

#### Scenario: 中断当前工作

- **WHEN** 用户按下中断键
- **THEN** 当前会话正在执行的工作 SHALL 被取消
- **AND** 界面 SHALL 显示该工作已被中断

#### Scenario: 中断不波及后台员工

- **WHEN** 用户中断某个管理层会话
- **THEN** 该管理层下属项目员工正在进行的工作 SHALL NOT 被取消

### Requirement: 任务与成本面板

系统 SHALL 在右侧面板展示活跃任务与成本数字。

#### Scenario: 活跃任务列表

- **WHEN** 查看任务面板
- **THEN** 其 SHALL 列出当前活跃任务及其状态
- **AND** 等待中的任务 SHALL 显示其在等待哪个任务

#### Scenario: 成本数字

- **WHEN** 查看任务面板
- **THEN** 其 SHALL 显示当前会话、当前项目与全公司的成本

#### Scenario: 面板随工作更新

- **WHEN** 任务状态或成本发生变化
- **THEN** 面板 SHALL 在一个短暂延迟内更新

### Requirement: 实时订阅

系统 SHALL 订阅会话与任务的变更，使界面反映已提交的最新状态。

#### Scenario: 订阅会话变更

- **WHEN** 界面附着到某会话
- **THEN** 系统 SHALL 先呈现该会话的当前状态
- **AND** 此后每次提交 SHALL 触发界面更新

#### Scenario: 切换会话时解除旧订阅

- **WHEN** 用户从一个会话切换到另一个
- **THEN** 旧会话的订阅 SHALL 被停止
- **AND** SHALL NOT 继续消耗资源

#### Scenario: 迟到附着

- **WHEN** 界面在一个会话已有大量历史后附着
- **THEN** 系统 SHALL 呈现该会话当前状态
- **AND** SHALL NOT 要求重放历史事件

### Requirement: 键盘操作

系统 SHALL 支持纯键盘完成主要操作。

#### Scenario: 焦点切换

- **WHEN** 用户按下焦点切换键
- **THEN** 焦点 SHALL 在组织树、会话流与输入框之间轮转

#### Scenario: 退出

- **WHEN** 用户按下退出键
- **THEN** 界面 SHALL 正常关闭
- **AND** 运行时 SHALL 被正确关闭，未完成的工作保留至下次打开

#### Scenario: 分叉对话

- **WHEN** 用户在会话流中选中某条消息并按下分叉键
- **THEN** 系统 SHALL 以该消息为分叉点创建新分支
- **AND** 界面 SHALL 进入该分支视图且标明其来源
