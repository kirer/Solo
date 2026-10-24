# project-lifecycle Specification

## Purpose
定义项目收尾的两种方式及其门槛：终止是可逆的软停（停下所有活动、归档员工，保留数据与产物），彻底删除是不可逆的清除（移除记录与产物）。两者之间强制一次老板确认，删除前还要校验路径安全。

## Requirements

### Requirement: 终止项目会停下一切活动

系统 SHALL 支持终止一个项目，终止时停止该项目负责人与全部员工的正在执行的工作。

#### Scenario: 终止时停下在跑的活

- **WHEN** 项目中有员工正在执行任务时终止该项目
- **THEN** 该项目负责人与全部员工正在执行的工作 SHALL 被中断
- **AND** 被中断的工作 SHALL NOT 被当作成功完成

#### Scenario: 终止会穿透后台归属

- **WHEN** 终止一个项目
- **THEN** 挂在该项目之下、归属后台任务的员工会话 SHALL 一并被中断
- **AND** SHALL NOT 只停下项目负责人而让员工继续跑

### Requirement: 终止是软停，不删除任何内容

系统 SHALL 在终止项目时保留全部数据与产物。

#### Scenario: 产物文件保留

- **WHEN** 终止一个项目
- **THEN** 该项目工作空间中的文件 SHALL 全部保留在原处
- **AND** 系统 SHALL NOT 删除任何文件

#### Scenario: 员工归档而非删除

- **WHEN** 终止一个项目
- **THEN** 该项目下的员工 SHALL 被标记为已归档
- **AND** 他们 SHALL NOT 出现在默认的在岗名单中
- **AND** 他们的会话与对话历史 SHALL 仍然保留

#### Scenario: 终止记录可追溯

- **WHEN** 终止一个项目
- **THEN** 系统 SHALL 记录终止时间、执行者与终止原因
- **AND** 该记录 SHALL 可在项目档案中查到

### Requirement: 终止会关闭该项目的待办

系统 SHALL 在终止项目时关闭该项目挂着的未决问题。

#### Scenario: 待办自动关闭

- **WHEN** 终止一个项目时该项目存在未答复的待决问题
- **THEN** 这些问题 SHALL 被标记为已关闭并注明原因
- **AND** SHALL NOT 继续出现在待办列表中等待回答

### Requirement: 重复终止被拒绝

系统 SHALL 拒绝终止一个已经终止的项目。

#### Scenario: 二次终止

- **WHEN** 对一个已终止的项目再次发起终止
- **THEN** 系统 SHALL 返回明确的失败结果并说明项目已终止
- **AND** SHALL NOT 产生重复的终止记录

### Requirement: 删除前必须已终止

系统 SHALL 只允许删除已终止的项目。

#### Scenario: 未终止的项目不能删除

- **WHEN** 对未终止的项目发起彻底删除
- **THEN** 系统 SHALL 拒绝并要求先终止
- **AND** SHALL NOT 删除任何文件或记录

#### Scenario: 一句话删不掉正在跑的项目

- **WHEN** 老板在对话中直接要求删除一个仍在进行的项目
- **THEN** 该删除请求 SHALL 因项目未终止而失败
- **AND** 必须先完成终止再确认删除

### Requirement: 删除需要老板明确同意

系统 SHALL 在终止之后向老板询问是否彻底删除，且只在得到明确同意后才执行删除。

#### Scenario: 终止后主动询问

- **WHEN** 项目终止成功
- **THEN** 执行终止的一方 SHALL 向老板说明已终止，并询问是否彻底删除
- **AND** 该询问 SHALL 说明删除的后果（解雇员工、删除产物、不可恢复）

#### Scenario: 老板未回复则停留

- **WHEN** 老板没有对删除询问作出回应
- **THEN** 项目 SHALL 保持在已终止状态
- **AND** 数据与产物 SHALL 保持完整

### Requirement: 删除会清除项目相关内容

系统 SHALL 在删除时移除项目记录、员工名册与工作空间产物。

#### Scenario: 索引与名册被移除

- **WHEN** 删除一个已终止的项目
- **THEN** 该项目 SHALL 从项目索引中移除
- **AND** 该项目下的员工 SHALL 从名册中移除

#### Scenario: 产物文件被删除

- **WHEN** 删除一个已终止的项目
- **THEN** 该项目工作空间目录及其中的全部文件 SHALL 被删除
- **AND** 结果 SHALL 报告删除了多少文件

#### Scenario: 删除后不再出现在组织视图

- **WHEN** 删除一个项目后查看组织视图
- **THEN** 该项目 SHALL NOT 出现在项目列表中

#### Scenario: 删除会留痕

- **WHEN** 删除一个项目
- **THEN** 系统 SHALL 写入一条审计记录，包含执行者、项目、员工数与文件数

### Requirement: 删除文件前校验路径

系统 SHALL 在删除文件之前校验目标路径，校验不通过时不得删除任何文件。

#### Scenario: 路径必须落在工作空间根下

- **WHEN** 项目记录的工作空间路径不在公司的工作空间根目录之下
- **THEN** 系统 SHALL 拒绝删除并说明校验未通过
- **AND** 目标目录中的文件 SHALL 保持完整

#### Scenario: 目录名必须等于项目标识

- **WHEN** 工作空间路径的最后一段不等于项目标识
- **THEN** 系统 SHALL 拒绝删除
- **AND** SHALL NOT 对任何目录执行删除

### Requirement: 会话历史受底层限制而保留

系统 SHALL 如实告知老板删除后哪些内容仍然存在。

#### Scenario: 删除完成后说明残留

- **WHEN** 项目删除完成
- **THEN** 系统 SHALL 说明会话与对话历史因底层限制无法物理删除
- **AND** SHALL 说明这些内容已不再显示

### Requirement: 项目状态可以推进

系统 SHALL 支持把项目状态按显式允许的边推进，并记录变更人。

#### Scenario: 立项后转进行中

- **WHEN** 本项目负责人或管理层把 `planning` 的项目推进为 `active`
- **THEN** 项目状态 SHALL 变为 `active`
- **AND** SHALL 写入一条状态变更审计

#### Scenario: 暂停与恢复

- **WHEN** 项目处于 `active` 或 `paused`
- **THEN** 系统 SHALL 允许在两者之间切换

#### Scenario: 完成

- **WHEN** 项目处于 `active` 或 `paused`
- **THEN** 系统 SHALL 允许推进为 `done`
- **AND** `done` SHALL 是终态，不能再推进

#### Scenario: 幂等

- **WHEN** 把项目推进到它当前已经处于的状态
- **THEN** 系统 SHALL 返回成功
- **AND** SHALL NOT 写入重复的审计事件

#### Scenario: 非法迁移被拒

- **WHEN** 请求一条不在允许边内的迁移（例如 `planning` 直接到 `done`）
- **THEN** 系统 SHALL 拒绝并说明允许的目标状态
- **AND** SHALL NOT 修改任何状态

#### Scenario: 越权推进被拒

- **WHEN** 既不是本项目负责人也不是管理层的会话请求变更项目状态
- **THEN** 系统 SHALL 拒绝
- **AND** SHALL NOT 修改任何状态

#### Scenario: 终止仍走两步流程

- **WHEN** 请求把项目状态改为 `terminated`
- **THEN** 系统 SHALL 指引改用终止流程（终止还要停下在跑的任务、归档员工）

### Requirement: 终止会回收负责人权限

系统 SHALL 在项目终止后收回项目负责人的执行与派活能力，只保留查看与上报。

#### Scenario: 终止后负责人不能执行

- **WHEN** 项目终止完成
- **THEN** 该项目负责人的能力包 SHALL 换成只读版本
- **AND** 其可用工具 SHALL NOT 包含文件读写、命令执行与员工派活
- **AND** 进程重启后 SHALL 仍保持只读
