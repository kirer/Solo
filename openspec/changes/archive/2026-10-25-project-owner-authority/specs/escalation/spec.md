# Spec Delta

## MODIFIED Requirements

### Requirement: 逐级上报

系统 SHALL 按「直属上级 → CEO → 老板」的顺序逐级上报无法决断的问题。员工的直属上级 SHALL 可以是管理层岗位或本项目负责人。

#### Scenario: 员工向直属上级上报

- **WHEN** 员工提出一个超出自身权限的问题
- **THEN** 系统 SHALL 按该员工的直属上级路由：岗位则到对应管理层，负责人则到本项目负责人
- **AND** 该待决项 SHALL 以对应层级落库（负责人层为 `leader:<项目slug>`）
- **AND** 只有该层级对应的会话能答复它

#### Scenario: 管理层无法决断

- **WHEN** 管理层判断该问题超出其授权范围
- **THEN** 系统 SHALL 将该问题上转至 CEO
- **AND** 该升级流程的进度 SHALL 记录当前所处层级

#### Scenario: CEO 无法决断

- **WHEN** CEO 判断该问题超出其授权范围
- **THEN** 系统 SHALL 将该问题转为等待老板拍板
- **AND** 该问题 SHALL 在老板界面中可见并标记为待拍板

#### Scenario: 越级答复被拒

- **WHEN** CEO 尝试答复一条落在项目负责人层级的待决项
- **THEN** 系统 SHALL 拒绝
- **AND** 该待决项 SHALL 保持未答复

#### Scenario: 升级过程不重复询问

- **WHEN** 升级流程在某一层级中断后恢复
- **THEN** 系统 SHALL 从该层级继续
- **AND** SHALL NOT 重新询问已给出结论的层级

#### Scenario: 层级在审计与留痕里可读

- **WHEN** 某一层级作出决定
- **THEN** 审计与沟通留痕 SHALL 记录该层级的可读名字（负责人记姓名，不记内部引用串）
- **AND** 该记录的会话归属 SHALL 指向作出决定的会话，而不是提问者
