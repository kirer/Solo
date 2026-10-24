# org-structure Specification

## Purpose
定义公司组织模型：老板与 CEO 的对话关系、六个管理层常设岗位、项目与项目员工的创建和归属、全公司名册与项目索引，以及默认模型与按员工分配模型的规则。

## Requirements

### Requirement: 老板与 CEO 的对话通道

系统 SHALL 为老板与 CEO 提供一条固定对话通道，它是公司的根会话。

#### Scenario: 老板向 CEO 下达指令

- **WHEN** 老板在根会话提交一条消息
- **THEN** 该消息 SHALL 成为 CEO 的对话输入
- **AND** CEO 的回答 SHALL 出现在同一通道

#### Scenario: 通道跨重启保持

- **WHEN** 进程重启后老板再次打开公司
- **THEN** 根会话 SHALL 仍承载此前的全部对话历史

### Requirement: 六个管理层常设岗位

系统 SHALL 为 CEO、CTO、CFO、CPO、COO、CMO、CHRO 各提供一个常设会话，每个会话具有独立的职责描述、能力集合与模型配置。

#### Scenario: 首次初始化管理层

- **WHEN** 公司首次初始化
- **THEN** 系统 SHALL 创建 CEO 与六位高管的会话
- **AND** 每个会话 SHALL 在名册中登记其角色名与会话标识

#### Scenario: 管理层不隶属于任何上级会话

- **WHEN** 查询管理层会话的归属
- **THEN** 该归属 SHALL 为无主，SHALL NOT 为某个任务或会话所拥有

#### Scenario: 职责描述可区分

- **WHEN** 读取任一管理层会话的生效配置
- **THEN** 其职责描述 SHALL 包含该岗位的专属职责
- **AND** 不同岗位的职责描述 SHALL NOT 完全相同

#### Scenario: 能力集合按岗位裁剪

- **WHEN** 读取 CFO 会话的生效配置
- **THEN** 其可用能力 SHALL 包含财务与预算相关能力
- **AND** SHALL NOT 包含招聘与派活能力

### Requirement: 项目与项目员工

系统 SHALL 支持创建项目，并在项目下创建员工；每个项目 SHALL 有一个项目负责人会话。员工的直属上级 SHALL 是管理层岗位或本项目负责人。

#### Scenario: 创建项目

- **WHEN** 管理层创建一个新项目
- **THEN** 系统 SHALL 创建一个项目会话并登记到项目索引
- **AND** 该项目的状态 SHALL 初始为规划中

#### Scenario: 项目负责人

- **WHEN** 查询某项目
- **THEN** 该项目 SHALL 关联一个项目负责人会话
- **AND** 该负责人 SHALL 具备向本项目员工派活的能力

#### Scenario: 招聘项目员工

- **WHEN** CHRO 为某项目招聘一名员工并指定角色
- **THEN** 系统 SHALL 创建该员工的会话并登记到名册
- **AND** 该员工 SHALL 关联到所属项目
- **AND** 其直属上级 SHALL 是管理层岗位之一，或**本项目负责人**

#### Scenario: 未指定上级时默认负责人

- **WHEN** 招聘时没有指定直属上级
- **THEN** 该员工的直属上级 SHALL 默认为本项目负责人
- **AND** SHALL NOT 默认挂到某个管理层岗位

#### Scenario: 拒绝跨项目负责人

- **WHEN** 把某员工的直属上级设为另一个项目的负责人
- **THEN** 系统 SHALL 拒绝该变更并说明原因
- **AND** SHALL NOT 修改名册

#### Scenario: 事后变更直属上级

- **WHEN** 管理层变更一名在职员工的直属上级
- **THEN** 系统 SHALL 在同一次提交内更新名册并写入审计（变更前后可追溯）
- **AND** 该员工的职责描述 SHALL 重新渲染，使提示词里的「直属上级」与新值一致
- **AND** 重复提交同一个值 SHALL 视为成功且 SHALL NOT 产生重复审计

#### Scenario: 上级展示与提示词同源

- **WHEN** 查询组织视图、职工档案或员工名册
- **THEN** 员工上级的显示名 SHALL 由名册里的直属上级解析得出
- **AND** SHALL NOT 由另一份独立的字段决定（避免同一个人在两处显示不同上级）

#### Scenario: 员工归属为任务所有

- **WHEN** 查询项目员工会话的归属
- **THEN** 该归属 SHALL 为一个后台任务，使员工工作不被上级会话的中断操作波及

#### Scenario: 员工在上级中断后继续工作

- **WHEN** 老板中断 CEO 会话的当前工作
- **THEN** 正在进行的项目员工工作 SHALL 继续运行至完成

### Requirement: 全公司名册与项目索引

系统 SHALL 维护一个公司级索引，记录角色名册、项目清单、员工名册与归档标记。

#### Scenario: 名册在单次提交内更新

- **WHEN** 创建项目或招聘员工
- **THEN** 索引更新 SHALL 与对应的会话创建在同一次原子提交内完成
- **AND** 崩溃后 SHALL NOT 出现「会话已建但名册未记」或反之

#### Scenario: 按项目查询员工

- **WHEN** 给定项目标识查询员工
- **THEN** 系统 SHALL 返回该项目的全部员工及其角色

#### Scenario: 归档员工

- **WHEN** 管理层归档一名员工
- **THEN** 系统 SHALL 在索引中标记其为已归档
- **AND** 该员工 SHALL NOT 出现在默认的组织视图中

### Requirement: 默认模型与按员工分配模型

系统 SHALL 采用统一的公司默认模型，并允许 CHRO 在招聘员工时为该员工单独指定模型。

#### Scenario: 未指定模型时使用默认

- **WHEN** CHRO 招聘员工时未指定模型
- **THEN** 该员工会话的生效模型 SHALL 等于公司默认模型

#### Scenario: 指定模型时覆盖默认

- **WHEN** CHRO 招聘员工时指定了模型
- **THEN** 该员工会话的生效模型 SHALL 等于指定模型
- **AND** 该员工的成本统计 SHALL 按实际使用的模型分桶

#### Scenario: 模型清单包含价格信息

- **WHEN** CHRO 查询可分配的模型清单
- **THEN** 每一项 SHALL 包含单价信息，使 CHRO 能据此判断成本

#### Scenario: 默认模型变更影响后续招聘

- **WHEN** 公司默认模型被修改
- **THEN** 此后未指定模型的招聘 SHALL 使用新默认值
- **AND** 已存在员工的模型 SHALL NOT 被追溯修改
