# Spec Delta

## Purpose

提供公司的运行时生命周期：打开与关闭、存储选择、崩溃后恢复未完成的工作、卡死任务巡检，以及把 experimental 依赖隔离在一层边界内的约束。

## ADDED Requirements

### Requirement: 打开公司运行时

系统 SHALL 通过唯一入口打开公司运行时，绑定一个持久化存储、模型访问、能力注册表和执行环境。

#### Scenario: 首次打开

- **WHEN** 存储为空时打开运行时
- **THEN** 系统 SHALL 创建根会话作为老板与 CEO 的对话通道
- **AND** 系统 SHALL 在同一提交内创建全部内置文档

#### Scenario: 再次打开

- **WHEN** 已有数据的存储被再次打开
- **THEN** 系统 SHALL 返回与上次相同的根会话标识
- **AND** 系统 SHALL NOT 重复创建根会话

#### Scenario: 执行环境按会话区分

- **WHEN** 任一工具调用需要执行环境
- **THEN** 系统 SHALL 依据该会话的工作目录构建执行环境
- **AND** 未配置工作目录的会话 SHALL 得到未定义的环境，且内置文件工具 SHALL 返回错误结果而非静默成功

### Requirement: 崩溃后恢复未完成的工作

系统 SHALL 在打开运行时后恢复上次进程遗留的未完成任务，使被打断的工作继续推进。

#### Scenario: 工具执行中途进程退出

- **WHEN** 进程在工具执行期间退出，随后重新打开同一存储
- **THEN** 系统 SHALL 在恢复前将遗留任务报告为待运行状态
- **AND** 恢复后 SHALL 继续该任务直至终态

#### Scenario: 同一请求重复提交

- **WHEN** 使用与崩溃前相同的请求标识再次提交同一输入
- **THEN** 系统 SHALL 返回原提交记录，而 SHALL NOT 创建第二个提交

#### Scenario: 恢复前不执行任何处理器

- **WHEN** 运行时刚打开且尚未开始调度
- **THEN** 系统 SHALL NOT 执行任何任务处理器

### Requirement: 卡死任务巡检与重试

系统 SHALL 报告因反复崩溃而被暂停的任务，并允许宿主重新运行它们。

#### Scenario: 反复崩溃达到上限

- **WHEN** 某任务在未提交新状态的情况下连续中断达到重启上限
- **THEN** 系统 SHALL 将该任务标记为受阻并给出原因
- **AND** 该任务 SHALL NOT 被视为活跃工作

#### Scenario: 手动重试受阻任务

- **WHEN** 宿主对受阻任务发起重试
- **THEN** 系统 SHALL 重新调度该任务

### Requirement: 存储故障后的自我恢复

系统 SHALL 在存储层故障导致运行时失效后，允许宿主重新打开并继续工作。

#### Scenario: 存储错误导致运行时失效

- **WHEN** 任一存储操作失败
- **THEN** 运行时 SHALL 进入失效状态并关闭自身
- **AND** 所有等待中的调用 SHALL 收到明确的失效错误，而 SHALL NOT 静默挂起

#### Scenario: 宿主自动重开

- **WHEN** 宿主观察到运行时因故障关闭
- **THEN** 宿主 SHALL 重新打开同一存储
- **AND** 重开后的重复投递 SHALL 依靠请求标识去重

### Requirement: 隔离 experimental 依赖

系统 SHALL 把对底层运行时库的调用限制在一层边界内，使该库的破坏性变更只影响该边界。

#### Scenario: 业务层不直接依赖底层库

- **WHEN** 检查业务层与界面层的导入
- **THEN** 这些层 SHALL NOT 直接导入底层运行时库
- **AND** 仅防腐层 SHALL 导入它

#### Scenario: 升级前契约验证

- **WHEN** 底层库版本发生变化
- **THEN** 系统 SHALL 能通过契约测试判定行为是否仍然符合本规格
