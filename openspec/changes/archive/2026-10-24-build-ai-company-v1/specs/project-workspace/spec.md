# Spec Delta

## Purpose

定义项目工作空间的创建与隔离：立项时建立真实目录与立项文档，项目内会话的文件操作限定在该目录内，且不同项目互不干扰。

## ADDED Requirements

### Requirement: 立项时创建真实目录

系统 SHALL 在项目立项时创建该项目的工作空间目录。

#### Scenario: 立项成功

- **WHEN** 管理层成功创建项目
- **THEN** 系统 SHALL 在公司的项目根目录下创建以项目标识命名的目录
- **AND** 该目录 SHALL 在项目索引中登记为该项目的工作空间

#### Scenario: 目录已存在

- **WHEN** 立项时目标目录已存在
- **THEN** 系统 SHALL 复用该目录而 SHALL NOT 失败

#### Scenario: 目录创建失败

- **WHEN** 目录无法创建（例如无写权限）
- **THEN** 立项 SHALL 失败并返回明确错误
- **AND** 系统 SHALL NOT 在索引中留下该项目

### Requirement: 立项文档

系统 SHALL 在立项时向工作空间写入一份立项文档，记录需求摘要与验收标准。

#### Scenario: 立项文档内容

- **WHEN** 项目创建完成
- **THEN** 工作空间中 SHALL 存在立项文档
- **AND** 该文档 SHALL 包含项目名称、需求摘要与验收标准三个部分

#### Scenario: 立项文档可后续补充

- **WHEN** CPO 细化需求后更新立项文档
- **THEN** 更新 SHALL 落盘到同一文件
- **AND** 原有内容 SHALL NOT 被静默丢弃

### Requirement: 项目内文件操作限定在工作空间

系统 SHALL 使项目会话及其员工的文件操作以该项目工作空间为工作目录。

#### Scenario: 员工写文件落在项目目录

- **WHEN** 项目员工使用文件写入能力创建一个文件
- **THEN** 该文件 SHALL 出现在该项目的工作空间目录内
- **AND** SHALL NOT 出现在公司根目录或其他项目目录

#### Scenario: 员工读取项目文件

- **WHEN** 项目员工读取一个相对路径
- **THEN** 该路径 SHALL 相对于该项目工作空间解析

#### Scenario: 未配置工作空间的会话

- **WHEN** 一个没有工作空间的会话尝试使用文件工具
- **THEN** 该工具 SHALL 返回错误结果
- **AND** 系统 SHALL NOT 退化为使用进程当前目录

### Requirement: 项目之间互不干扰

系统 SHALL 保证不同项目的工作空间相互独立。

#### Scenario: 两个项目同名文件

- **WHEN** 两个项目各自创建同名文件
- **THEN** 两份文件 SHALL 分别存在于各自的项目目录中
- **AND** 修改其中一个 SHALL NOT 影响另一个

#### Scenario: 项目标识规范化

- **WHEN** 项目名称包含空格、大小写混合或非字母数字字符
- **THEN** 系统 SHALL 生成规范化的目录标识
- **AND** 该标识 SHALL 仅包含小写字母、数字与连字符
