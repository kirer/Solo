# pi-durable 底座让步总账

> 这个项目跑在 `@earendil-works/pi-durable`（experimental）上。底座做不到的事，我们绕了路。
> 绕路本身不丢人；**忘了自己绕过路**才丢人 —— 下次会重新撞一遍、重新讨论一遍，甚至再写一段
> 绕路代码。所以这里一条一行地记下来。
>
> **只追加，不删。** 处理完了把「底座升级后」一列改成「已处理 + 日期」，保留原条目。
> 新条目从 C-007 往下排；同一件事如果底座升级后仍成立，就更新「现在的做法」，别开新号。

| 编号 | 日期 | 相关 | 底座限制（pi-durable 的真实约束） | 现在的做法 | 代价 | 底座升级后 |
|---|---|---|---|---|---|---|
| C-001 | 2026-10-28 | `channel/deliver.ts` / `channel/post.ts` | `conversation.submit()` 是「投递即忘」，**没有「回合结束」钩子** | 靠 agent 自己 `say` 汇报 | 无法实现严格的 bot→bot handoff 与串行轮次 | 若 pi-durable 提供 turn 结束事件，可做 handoff |
| C-002 | 2026-10-28 | `channel/tools.ts` / 上下文压缩 | 上下文压缩成 `pi.compaction` 后**原文不可见** | 加了 `read_history` 工具（翻自己被压缩掉的历史） | 多一个工具、模型要记得用 | 若 harness 提供「压缩前原文可按需取回」，可删该工具 |
| C-003 | 2026-10-28 | `agent/runtime.ts` 的 `agentSection` | **没有 session 级 system prompt 热更新 API**（只能改 conversation 的 `model`/`instructions`） | `agentSection` 用 `tag:false` 每轮重渲染整段 | 前缀缓存会被打穿（每轮 system 段变化） | 若有「section 变更通知」，可只在文件 mtime 变化时才重渲染 |
| C-004 | 2026-10-28 | `channel/state.ts` 的 `appendMessage` | `documents` 的 state 只能是 JSON，**没有原地更新 API**，一律走 path 式 delta | 单元素追加 + 频道文档定期压基线（ADR-027）；早期用整值替换导致平方放大，库涨到 70MB | 追加逻辑必须自己保证 seq / 下标正确 | 若支持结构化 append，可删掉 splice 逻辑 |
| C-005 | 2026-10-28 | `team/memory.ts` / `agent/memory.ts` | **没有多进程安全** | 单进程；记忆写入用模块级 Promise 串行队列 | 不能水平扩展 | 若 storage 提供锁，可去掉队列 |
| C-006 | 2026-10-28 | `runtime/open.ts` | `tasks` 表**没有「孤儿任务」的自动回收** | `reconcileZombieTasks` 在启动时把 `LIVE` 状态强制结算成 `terminal` + `outcome:{status:"orphaned",reason:"restart"}`，并摘掉 `pi.live` 里指向已终态任务的 `run` | 重启会有一次全表扫描 | 若 harness 自带崩溃恢复，可删 |
| C-007 | 2026-10-28 | `runtime/drafts.ts` / 频道 SSE | **没有可用的 token 流**：`watchEvents()` 只在助手正文上零星推 `text_delta`，工具调用的参数（`say` 的 `text`）**一次 `toolcall_delta` 都不推**；而且串行化代理过不了它的 `WeakMap` 品牌检查（报 `Not a Harness`） | 不再等事件流，改从**提交快照**里取：`subscribeCommits` 的 `DocumentCommitChange` 带着 `pi.live` 的整份 `value`，挑 `kind === "pi.live"` 的读 `generation.message` 里 `say` 的 `text`（实测每 100ms 一次、逐字变长）。`runtime/drafts.ts` 只读不写，`serve.ts` 节流 260ms 后以 SSE `draft` 事件推给频道成员，界面画成「正在说」草稿行 | 每次提交都要遍历 `changes` 判一次 `kind`（一次提交几条，可忽略）；草稿只在 `say` 参数已经出现后才可见，`think`/`run` 参数不推（也不该推） | **已处理 2026-10-30**：整套草稿删掉了（`runtime/drafts.ts`、SSE `draft` 事件、「正在说」界面，ADR-081）—— 界面在干活期间是静的，只看到最终的 `say`。以后要「正在输入」用 `harness.inspect()` 的忙闲在读取时派生，不落库、不发 SSE |
| C-008 | 2026-10-29 | `channel/deliver.ts`（ADR-066） | `harness.abortTask()` 打断一个正在跑的任务，会把**同一会话里排队等着的输入**一起吞掉：`deliver()` 已经 `submit` 成功（`delivered` 里有这个人），但对方 transcript 里连这条消息的条目都没有，我看到的是彻底没回应 | 「我问话插队」不再打断任务，改成只撤 `status: "queued"` 的排队项；长命令跑着的时候，我的问题仍然要等它结束 | 插队实际退化成「排队」 | 等 pi-durable 提供「打断但保留排队输入」的语义再重试 |
