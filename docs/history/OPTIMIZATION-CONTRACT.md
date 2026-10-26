# 【已归档 · 不再维护】

> 这份文档写于某个时间点，记录**当时**的设计推理与施工过程，**内容已冻结**。
> 现状一律以 `docs/SYSTEM.md`、`docs/CODE.md`、`docs/DECISIONS.md`、`openspec/specs/` 为准。
> 保留它只是为了回答「当初为什么这么决定」。里面的行号、文件路径、数量、截图链接都可能已失效。

---

# 优化轮 · 并行施工契约（2026-10-24）

> 本文件是本轮多 agent 并行改造的**唯一契约**。开工前先读完，只改自己名下的文件。
> 与 `WEB-UI-CONTRACT.md` 冲突时，以本文件为准（本文件更新）。

## 0. 用户这次要什么（原话要点，不可曲解）

前端：
1. 重新考虑配色：**思考 / 运行 → 绿色荧光边框**；**等待 / 等待拍板 → 黄色**；**故障 / 出错 → 红色**。
2. 聊天框：
   - 2.1 最新消息离输入框太近，底部要留白。
   - 2.2 名字只用一个边框 chip 框住，不要「一个边框 + 另一个名字」两套。
   - 2.3 **每条消息都要有发送者名字**（老板发的、别人发来的都要）。
   - 2.4 思考 / 命令 / 工具调用**去掉外边框**，只留展开收起箭头；展开后的内容可以有边框。
   - 2.5 聊天顶部那个「全部展开 / 收起」按钮换功能：改成展示**这位职工的角色预制提示词 / 技能**。

后端：
1. 审查逻辑。
2. 从**真实运行中的聊天记录**发现问题并修掉（已知：负责人会话卡在「正在忙」、同步转交无限等待）。
3. 优化逻辑；要有**圆桌讨论**；架构清晰；**容错机制好，不出现卡住**；需要老板处理的事越少越好。

> ⚠️ **文件所有权表已过时**（多 agent 并行改版的阶段产物）。当前单人维护，
> 直接改即可；另外右侧对话面板已删除，`ui/js/chat.js`、`ui/css/chat.css`、
> `ui/js/ask.js` 不再存在。

## 1. 文件所有权（只改自己的，跨文件先发消息给 Lead）

| 文件 | 负责人 |
| --- | --- |
| `src/company/delegation.ts`、`delegation-guard.ts`、`src/company/watchdog.ts`（新）、`src/runtime/recover.ts`、`src/company/escalation.ts` | **backend-core** |
| `src/company/roundtable.ts`（新）、`src/company/roundtable-tools.ts`（新）、`src/company/roles.ts`、`src/company/tools.ts`、`src/company/management-tools.ts` | **backend-roundtable** |
| `src/server/http.ts`、`src/server/feed.ts`、`src/server/org-view.ts`、`src/company/org.ts` | **backend-api** |
| `ui/css/tokens.css`、`ui/css/graph.css`、`ui/js/org.js`、`ui/js/format.js` | **fe-theme** |
| `ui/js/chat.js`、`ui/css/chat.css`、`ui/js/markdown.js`、`ui/js/profile.js`（新） | **fe-chat** |
| `ui/index.html`、`ui/js/app.js`、`ui/js/ask.js`、`ui/js/icons.js`、`ui/css/shell.css`、`scripts/*`、`docs/*` | **Lead** |
| `test/e2e/reliability*.test.ts`、`test/unit/delegation-guard.test.ts` | backend-core |
| `test/e2e/roundtable.test.ts`（新）、`test/e2e/hierarchy.test.ts` | backend-roundtable |
| `test/e2e/web.test.ts`、`test/e2e/trail.test.ts` | backend-api |

**新增文件可以，改名 / 删别人的文件不行。** 需要改别人文件时发消息给 Lead，不要抢。

## 2. 状态语义与配色（fe-theme 执行，其它人只读）

`data-status` 只有四个值，全站统一：

| data-status | 含义 | 边框 | 动效 |
| --- | --- | --- | --- |
| `busy` | 在跑 / 在思考 / 工具调用中 | 绿色 1px + 绿色荧光外圈 | 光沿边框走一圈（2.8s） |
| `waiting` | 等你拍板 / 等上级裁定 | 黄色 1px + 黄色荧光外圈 | 光沿边框走一圈（6s，更慢） |
| `error` | 故障 / 失败 / 已终止 | 红色 1px | 无动画 |
| `idle` | 空闲 | 中性 1px | 无动画 |

新增令牌（`tokens.css`，两个主题各一套，**组件只能用令牌**）：

```
--run / --run-strong / --run-soft / --run-line    绿色：在跑、在思考
--warn / --warn-soft / --warn-line                黄色：等待拍板
--danger / --danger-soft / --danger-line          红色：故障
--accent / --accent-soft / --accent-line          蓝色：**只用于焦点与选中**，不再表示运行
```

- 深色：`--run #3ddc84`，`--warn #f5c518`，`--danger #ff5f56`
- 浅色：`--run #0e7a4a`，`--warn #8a6a00`，`--danger #c0392b`
- 「荧光」= 1px 边框 + `box-shadow: 0 0 0 1px <color>55, 0 0 18px -6px <color>88`。
  不要做全屏泛光、不要 blur 大面积、不要脉冲呼吸（`prefers-reduced-motion` 全部关掉）。
- 思考中的消息（chat 里的 `details.think[data-live="true"]`）也用 `--run`。

## 3. 数据契约：消息发送者（backend-api 产出，fe-chat 消费）

```ts
/** 一个发言人。 */
type ActorRef = {
  readonly conversationId?: number;
  readonly label: string;                       // 「CEO」「周牧」「老板」
  readonly kind: "owner" | "role" | "project" | "staff" | "system";
};

type FeedItem =
  | { kind: "user"; id; text; at; from: ActorRef }        // ← 新增 from（谁说的）
  | { kind: "assistant"; id; text; at }
  | { kind: "thinking"; id; text; at }
  | { kind: "tool"; id; name; args; output; state; collapsible; callId?; at }
  | { kind: "note"; id; text; at; from?: ActorRef; to?: ActorRef }
  | { kind: "alert"; id; text; at };

type Feed = {
  ...现有字段,
  actor: ActorRef;   // ← 新增：这个会话的主人（助手消息的发言人）
};
```

规则：
- `user` 条目的 `from`：老板自己发的 → `{ label: "老板", kind: "owner" }`；
  别的 agent 派来的（`app.delegate` 条目）→ 派活方 `{ label: "CEO", kind: "role", conversationId }`。
- `assistant` / `thinking` / `tool` 的发言人一律是 `Feed.actor`，不重复塞进每个条目。
- `note` 的 `from`/`to` 来自留痕条目（派活 / 回报 / 升级 / 决定），拿不到就省略。

## 4. 数据契约：职工档案（backend-api 产出，fe-chat 消费）

`GET /api/profile/:conversationId` → 200

```ts
type ActorProfile = {
  conversationId: number;
  label: string;
  kind: "owner" | "role" | "project" | "staff";
  subtitle: string;          // 一句话职责
  role?: string;             // 员工角色（产品/设计/开发/测试/运营）
  project?: string;          // 所属项目名
  parent?: string;           // 上级显示名
  model: string;             // provider/modelId
  charter: string;           // 角色预制提示词（纯文本，可能多段，用 \n 分隔）
  guide?: string;            // 通用工作准则
  tools: { name: string; description: string }[];   // 该会话实际可用的技能/工具
};
```

后端怎么拿：**从 `CompanyDoc` + `ROLE_DEFINITIONS` + `PROJECT_LEADER_CHARTER` + `STAFF_TOOLSETS` 推导**，
不要去读底层会话配置（experimental，且拿不全）。员工会话的 charter 用
`createEmployeeExtension` 里那段员工职责 + 角色说明拼出来。
404 时返回 `{ error: "..." }`，前端降级成「暂无档案」。

## 5. 后端：不卡住（backend-core）

从真实库（`workspace/company.sqlite`）复现到的卡死链路：

1. 负责人会话里 `staff_assign` 同步等员工 → 员工自己也在忙 → 请求进队列；
2. 员工那轮里有工具报错，负责人这一轮变成 `tool error: interrupted and may have partially run`；
3. 但 `pi.generation` 仍是 `waiting`（`on: [toolId]`），`inspect()` 一直把它算作「在忙」；
4. 于是 `isEmployeeBusy` / `isBusy` 永远为真，后续派活全部排队，界面显示「正在忙，还有没结束的任务」；
5. 老板点「立即处理」也只是再排一条，没有任何东西会去收尾。

必须做的：
1. **同步等待必须有上限**：`delegate` / `delegateToRole` / `delegateToLeader` 接受 `timeoutMs`
   （默认 180s），超时返回 `{ ok:false, reason:"timeout" }`，并且**释放等待图**。
2. **看门狗 `src/company/watchdog.ts`**：定期（默认 30s）巡检
   - `running` / `waiting` 且 `startedAt` 超过阈值（generation 600s / tool 300s）的任务；
   - 发现即调 `runtime.harness.retryTask` 或对会话 `abort`，并写一条 `alert` 留痕（进 feed，看得见）；
   - 同一条任务最多自动重试 2 次，超过就标 `error` 并把状态如实报给界面（`status: "error"`）。
3. **状态判定要区分「真的在跑」和「僵住的 waiting」**：
   `inspect()` 里 `state.kind === "waiting"` 的任务，如果 `on` 指向的子任务已全部 terminal，
   视为僵住，不再算 busy（给 watchdog 处理）。
4. **队列排空**：会话重新变空闲时，若 inbox 里还有老板的排队消息，自动投一次（`followUp`），
   不要等下一次老板说话。
5. **恢复要自动**：`recover()` 启动时对僵住任务直接调度恢复，不要只报「受阻任务」等人点。
6. 全部行为要有测试，且**不引入新依赖**。

## 6. 后端：圆桌讨论（backend-roundtable）

架构（清晰、可解释、可恢复）：

```
roundtable(topic, roles[], rounds=1, timeoutMs)
  └─ 创建 RoundtableDoc 记录（持久化：议题、参与者、每轮意见、结论、状态）
  └─ 第 1 轮：并行向每个 role 会话投递「议题 + 你的视角」，各自作答（互不可见）
  └─ 第 2 轮（可选）：把第 1 轮全部意见汇总再投给每人，要求「保留 / 修正 / 反对 + 理由」
  └─ 主持人（调用方会话）汇总 → 写纪要 → 返回给模型
```

容错硬要求：
- **每个参与者独立超时**，超时/失败标 `absent`，**不阻塞整体**；全体失败也要产出纪要（说明原因）。
- 总时长有硬上限（`rounds * timeoutMs + 30s`），超了立即收口返回已收到的部分。
- 中途 abort（老板「立即处理」）要能干净退出，纪要标 `aborted`。
- 结论写入 `RoundtableDoc` 与 `AuditDoc`，重启后 `roundtable_minutes` 能查到。
- 参与者**不允许**是调用方自己（跳过），不允许重复。

工具：
- `roundtable`：参数 `topic`（必填）、`roles`（可选，默认 `["cto","cfo","cpo","coo"]`）、`rounds`（1–2）、
  `question`（可选，要大家拍板的具体问题）。返回结构化纪要摘要（谁说了什么、共识、分歧、结论建议）。
- `roundtable_minutes`：参数 `id`（可选，默认最近一次），返回完整纪要。

权限：`ceo` / `coo` / `cto` 有 `roundtable`；`ceo` / `coo` 有 `roundtable_minutes`。
**员工没有**（沿用 ADR-004）。

## 7. 验收（所有人）

```bash
npm run check          # 类型 + 边界
npm test               # 全绿
node scripts/ui-shot.mjs --url http://127.0.0.1:7789/ --out .taste-skill/opt --name <名字> --sizes 1440x900
```

- 界面改动必须**真截图看过**（`read_image`），只看代码不算验收。
- 控制台 0 错误，页面不横向溢出。
- 改完在汇报里写：改了哪些文件、怎么验的、还剩什么问题。
