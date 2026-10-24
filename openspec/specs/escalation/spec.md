# escalation Specification

## Purpose
定义决策授权与升级链：管理层在授权范围内自行拍板，超出范围则逐级上报至 CEO，CEO 也无法决断时转为等待老板拍板，并支持跨天等待与恢复。

## Requirements

### Requirement: 管理层在授权范围内自行拍板

系统 SHALL 允许管理层对属于其授权范围的事项直接作出决定，无需上报。

#### Scenario: 授权范围内直接决定

- **WHEN** 管理层收到一个属于其授权范围的问题
- **THEN** 该管理层 SHALL 能直接给出决定
- **AND** 该决定 SHALL 作为终态结果记录在升级流程中

#### Scenario: 未授予决策能力的管理层

- **WHEN** 某管理层的配置中不含决策能力
- **THEN** 该管理层 SHALL NOT 能直接结束升级流程
- **AND** 其唯一路径 SHALL 是上报

#### Scenario: 授权范围由配置决定

- **WHEN** 修改某管理层的授权范围配置
- **THEN** 后续问题的处理路径 SHALL 按新配置执行
- **AND** 已在处理中的升级流程 SHALL NOT 被追溯改变

### Requirement: 逐级上报

系统 SHALL 按「直属管理层 → CEO → 老板」的顺序逐级上报无法决断的问题。

#### Scenario: 管理层无法决断

- **WHEN** 管理层判断该问题超出其授权范围
- **THEN** 系统 SHALL 将该问题上转至 CEO
- **AND** 该升级流程的进度 SHALL 记录当前所处层级

#### Scenario: CEO 无法决断

- **WHEN** CEO 判断该问题超出其授权范围
- **THEN** 系统 SHALL 将该问题转为等待老板拍板
- **AND** 该问题 SHALL 在老板界面中可见并标记为待拍板

#### Scenario: 升级过程不重复询问

- **WHEN** 升级流程在某一层级中断后恢复
- **THEN** 系统 SHALL 从该层级继续
- **AND** SHALL NOT 重新询问已给出结论的层级

### Requirement: 等待老板拍板

系统 SHALL 在等待老板拍板期间不占用运行资源，并允许等待跨越多天。

#### Scenario: 等待期间不占用调度

- **WHEN** 升级流程进入等待老板拍板状态
- **THEN** 该流程 SHALL 处于休眠状态
- **AND** SHALL NOT 占用执行中的任务名额

#### Scenario: 老板离线

- **WHEN** 老板在问题上报后长时间未回应
- **THEN** 该问题 SHALL 保持待拍板状态
- **AND** 进程重启后该状态 SHALL 仍然有效

#### Scenario: 老板拍板后继续

- **WHEN** 老板给出答复
- **THEN** 系统 SHALL 结束等待并将该答复沿原路径返回发起方

### Requirement: 升级全程可追溯

系统 SHALL 记录升级流程中每一次层级跃迁与决定。

#### Scenario: 记录每次跃迁

- **WHEN** 升级流程从一个层级跃迁到下一层级
- **THEN** 系统 SHALL 追加一条记录，包含时间、来源层级与目标层级

#### Scenario: 记录决定

- **WHEN** 任一管理层或老板作出决定
- **THEN** 系统 SHALL 追加一条记录，包含时间、决策者与决定内容

#### Scenario: 重建完整路径

- **WHEN** 查询某次升级流程
- **THEN** 系统 SHALL 能给出从发起到结束的完整层级路径

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
