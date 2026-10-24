# Spec Delta

## ADDED Requirements

### Requirement: 项目卡翻转展开团队

系统 SHALL 允许在主视图中通过点击项目卡查看该项目的团队结构。

#### Scenario: 点击项目卡翻转

- **WHEN** 用户点击一个项目卡
- **THEN** 卡片 SHALL 以翻转动画切换到背面
- **AND** 背面 SHALL 显示项目负责人在上、员工列表在下的层级结构

#### Scenario: 翻转是三维动画而非展开

- **WHEN** 项目卡翻转
- **THEN** 该变化 SHALL 表现为卡片自身的翻转
- **AND** SHALL NOT 表现为在原地向下展开内容

#### Scenario: 翻转时高度平滑过渡

- **WHEN** 卡片从正面翻到背面（或反向）
- **THEN** 卡片容器高度 SHALL 从当前高度平滑过渡到目标面的高度
- **AND** SHALL NOT 出现高度跳变

#### Scenario: 未翻转的卡片不受影响

- **WHEN** 一个项目卡翻转到背面（背面通常更高）
- **THEN** 同一行其他未翻转的卡片 SHALL 保持原高度
- **AND** SHALL NOT 被撑高

#### Scenario: 翻回正面

- **WHEN** 用户在背面点击返回
- **THEN** 卡片 SHALL 翻转回正面
- **AND** 高度 SHALL 过渡回正面高度

#### Scenario: 从背面打开员工

- **WHEN** 用户在背面点击某个员工
- **THEN** 右侧 SHALL 打开该员工的对话面板
- **AND** 卡片 SHALL 保持当前朝向

### Requirement: 已终止项目在主视图中可辨识

系统 SHALL 在主视图中明确区分已终止的项目。

#### Scenario: 终止状态可见

- **WHEN** 查看组织视图
- **THEN** 已终止的项目 SHALL 显示终止标记
- **AND** SHALL 显示终止原因与终止时间
- **AND** SHALL NOT 显示为进行中的项目

#### Scenario: 已终止项目不再翻转

- **WHEN** 用户查看已终止的项目卡
- **THEN** 卡片 SHALL 直接呈现终止结果
- **AND** SHALL NOT 提供翻转交互

#### Scenario: 提示下一步

- **WHEN** 项目处于已终止状态
- **THEN** 卡片 SHALL 提示可以如何彻底删除它

#### Scenario: 归档员工仍可查看

- **WHEN** 查看已终止项目的员工
- **THEN** 已归档的员工 SHALL 仍然可见并标记为已归档
- **AND** SHALL NOT 与在岗员工混淆

### Requirement: 对话面板显示排队消息

系统 SHALL 在对话面板中显示等待处理的排队消息。

#### Scenario: 排队消息出现在对话流末尾

- **WHEN** 当前会话有排队中的消息
- **THEN** 对话面板 SHALL 在流末尾显示这些消息
- **AND** 每条 SHALL 标明其排队语义

#### Scenario: 提供立即处理入口

- **WHEN** 显示排队消息
- **THEN** 每条消息 SHALL 提供「立即处理」入口
- **AND** 点击后 SHALL 触发插队处理

#### Scenario: 发送后立刻可见

- **WHEN** 用户在面板中输入并发送消息
- **THEN** 该消息 SHALL 立刻显示在面板中
- **AND** SHALL NOT 等到下一次服务端推送才出现
