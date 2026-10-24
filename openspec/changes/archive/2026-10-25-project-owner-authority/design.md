# Design

## 决策 1：用字符串引用，不新建「负责人实体」

`project.leader`（会话 ID）+ `leaderName` 已经是稳定身份。真正缺的只是「员工能不能引用它」。

因此 `manager` 改为：

```ts
type ManagerRef = ManagementRole | `leader:${string}`;
```

不复用对象形状 `{kind, conversationId}`，原因是升级链把层级原样存进待决文档并用 `===` 比较：

- 对象经 JSON 落盘/恢复后引用必然不等 → 升级任务永远等不到答复（表现为 30s 超时，不是报错）；
- 8 处 `ROLE_LABELS[person.manager]` 对对象返回 `undefined`（模板显示 "undefined"、`/api/org` 丢 parent）；
- 6 处 `ROLE_LABELS[x] ?? x.toUpperCase()` 会 TypeError。

字符串方案的代价是每个展示点都要走解析器，收益是不动升级状态机、不升 `CompanyDoc` 版本（升版本必须写 `migrate`，否则 `pi-durable` 启动即抛「requires migration」）。

`leader:<slug>` 而不是 `leader:<conversationId>`：负责人换人时自动跟随，不需要迁移员工记录；项目删除后解析失败，回落到 CEO 并告警。

## 决策 2：权限 = 能力包里的工具，不做权限矩阵

沿用 ADR-004/010。负责人权限落成两件事：

- `createProjectLeaderExtension` 增加 `read/write/edit/bash`（执行面）与 `pending_list`/`answer_pending`（接上报）；
- 能力包本身仍是全局唯一、纯函数，项目名由 instructions 注入。

CTO 明确排除的细粒度矩阵因此完全不需要：要收回权限，换能力包即可（终止后换成 `role-leader-readonly`）。

## 决策 3：终止时换只读能力包，而不是只改提示词

`terminateProject` 成功后把负责人的 `extensions` 换成 `role-leader-readonly`（只留 org_tree/escalate/decide/pending_list/project_list/staff_list）。

启动修复 `repairLeaderAgents` 也按 `project.status` 选包，否则重启一次就把执行权限还回去了。

## 决策 4：状态机只接受显式边，不把权限挂在 active 上

现有枚举六态，实际只写过 `planning` 与 `terminated`。新增：

```
planning → active
active   → paused | done
paused   → active | done
terminated / done → 终态
```

- 同状态幂等成功、不写事件；非法边 `E_INVALID_TRANSITION`；`terminated` 仍走 `terminateProject`（它还要停任务、归档员工），传 terminated 返回 `E_USE_TERMINATE`。
- 调用方：本项目负责人或管理层；其他会话 `E_FORBIDDEN`。
- **不**让执行权限依赖 `status === "active"`：线上项目改造时仍在 `planning`，一旦依赖 active 会静默失去权限。只有终止触发回收。

## 决策 5：双真相源收敛为一份

`ProfileDoc.parent` 自始至终没有读取者，`staff.manager` 才是被展示/提示词消费的那份。本变更停止写 `parent` 并删除字段类型，避免第三份「上级」。

所有展示与提示词统一走 `managerLabelOf` / `managerConversationOf`。

## 决策 6：迁移是显式动作，不在启动时偷偷做

`migrateStaffManagers` 由脚本调用，接受 `--project`、`--staff`、`--dry-run`；启动时只做 `repairStaffManagers`（修非法引用，不改变合法配置）。

迁移不升文档版本（形状仍是 string），因此旧代码仍能启动（只是把 `leader:<slug>` 显示成 `undefined`），回滚只需回代码。

## 风险与未做

- **bash 没有沙箱**：执行环境只有 `cwd`，项目目录又在主仓 worktree 内。给负责人 bash 等于「能写整仓」，这是本变更已知的最大残留风险。收紧需要路径围栏（读写工具与 shell 都要处理），会破坏运维项目跨目录读 `workspace/company.sqlite` 的现有用法，留到下一期单独设计。
- 未做负责人换人 API：`leader:<slug>` 天然跟随，但换人仍需人工改 `project.leader`（目前没有写路径）。
- 未做凭据级权限：本系统只有全局模型凭据，没有项目级凭据存储。
