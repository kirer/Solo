# Spec Delta

## MODIFIED Requirements

### Requirement: 会话流渲染

系统 SHALL 在会话流中渲染对话历史、正在生成的回答与工具调用，并保证同一次工具调用只出现一条记录、参数完整、中断状态可辨认。

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

#### Scenario: 同一工具调用只出现一条

- **WHEN** 某次工具调用已经作为助手消息提交，且仍在执行
- **THEN** 会话流 SHALL 只展示这一条工具卡
- **AND** SHALL NOT 因为实时状态再追加一条重复的卡

#### Scenario: 运行中工具的参数必须完整

- **WHEN** 展示一条正在运行的工具卡
- **THEN** 参数 SHALL 来自该工具调用的已提交参数
- **AND** SHALL NOT 因实时状态缺少参数而显示为「（无参数）」

#### Scenario: 中断的工具调用不再假装运行中

- **WHEN** 一次工具调用已经提交但永远没有返回结果，且会话已不再有实时任务
- **THEN** 该工具卡 SHALL 显示为「已中断」
- **AND** SHALL NOT 一直显示「运行中 / 等待输出…」

#### Scenario: 工具输出折叠

- **WHEN** 工具返回大量输出
- **THEN** 默认 SHALL 折叠显示摘要
- **AND** 用户 SHALL 能展开查看完整内容

#### Scenario: 自动滚动

- **WHEN** 新内容追加到会话流
- **THEN** 视图 SHALL 保持在最新内容处
- **AND** 若用户已向上滚动查看历史，SHALL NOT 强制跳回底部

### Requirement: 对话面板显示排队消息

系统 SHALL 在对话面板中显示等待处理的排队消息，并按来源决定可执行的操作。

#### Scenario: 排队消息出现在对话流末尾

- **WHEN** 当前会话有排队中的消息
- **THEN** 对话面板 SHALL 在流末尾显示这些消息
- **AND** 每条 SHALL 标明其排队语义与来源

#### Scenario: 提供立即处理入口

- **WHEN** 显示的是老板自己发送的排队消息
- **THEN** 该消息 SHALL 提供「立即处理」入口
- **AND** 点击后 SHALL 触发插队处理

#### Scenario: agent 任务不显示老板操作

- **WHEN** 显示的是其它 agent 派来的排队任务
- **THEN** 该消息 SHALL 标明「由谁派来」
- **AND** SHALL NOT 提供「立即处理」入口

#### Scenario: 发送后立刻可见

- **WHEN** 用户在面板中输入并发送消息
- **THEN** 该消息 SHALL 立刻显示在面板中
- **AND** SHALL NOT 等到下一次服务端推送才出现
