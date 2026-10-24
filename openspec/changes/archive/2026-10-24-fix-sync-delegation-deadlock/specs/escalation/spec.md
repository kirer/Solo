# Spec Delta

## ADDED Requirements

### Requirement: 老板只回答自己这一级的问题

系统 SHALL 只把 owner 级的待决问题呈现为老板待办，并拒绝老板替代管理层拍板。

#### Scenario: CEO 上报落到 owner 级

- **WHEN** CEO 判断问题超出自己的授权范围并上报老板
- **THEN** 该问题 SHALL 出现在老板待办中
- **AND** 其归属 SHALL 记在 CEO 名下，而不是最初发起的员工或项目负责人

#### Scenario: 管理层自己的待办不算老板待办

- **WHEN** 存在等待 CEO 回答的 ceo 级待决问题
- **THEN** 该问题 SHALL NOT 出现在老板的拍板队列
- **AND** 对应的管理层节点 SHALL NOT 显示为「待老板拍板」

#### Scenario: 老板不能回答 ceo 级问题

- **WHEN** 老板尝试回答一条非 owner 级的待决问题
- **THEN** 系统 SHALL 拒绝该请求
- **AND** SHALL 说明这条问题应由 CEO 或对应管理层拍板

#### Scenario: 来源显示真实岗位

- **WHEN** 展示一条待决问题的来源
- **THEN** 来源 SHALL 是真实岗位或姓名（如 CTO、林跃）
- **AND** SHALL NOT 统一显示为 `manager`
