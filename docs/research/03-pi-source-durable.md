# Pi `packages/durable` 源码技术报告

> 对象：`/Users/kirer/projects/ai-company/archive/reference/pi`（HEAD `f3fa8bd92`，`git describe` = `v1.4.0-42-gf3fa8bd92`）
> 范围：仓库结构、`packages/durable/src/**`（62 文件）、`test/examples/*`（31 个）、关键测试、`docs/spec.md`（5594 行）
> 签名抄自实际源码，标注 `path:line`。

---

## 结论摘要（给决策者）

**一句话**：`packages/durable` 是「先落盘、再展示」的 agent 运行时内核。它把**对话记录（Entry）+ 可变 JSON 状态（Document）+ 可恢复状态机（Task）+ 可等待输入（Submission）**放进同一个原子提交；进程挂了重开 storage 就从最后一个 checkpoint 继续。**它天生支持多 agent 组织编排**——靠的不是 prompt 技巧，而是 `ownership` 树 + 子会话 + 后台任务 + task graph。

1. **它是 npm 包，不是只能 fork 的框架**。`@earendil-works/pi-durable@1.4.0`，有 `files:["dist",...]`、`publish` 脚本、20 个子路径导出。二次开发两种正当姿势：装 npm 包，或 monorepo 加 workspace package（`packages/env` 就是这样：`dependencies:{"@earendil-works/pi-durable":"1.4.0"}`）。
2. **四个核心抽象**：`Harness`（打开 storage 的运行时）、`Conversation`（transcript 作用域，handle 无状态、按 `id` 比较）、`Task`（durable 状态机）、`Document`（带版本 JSON）。`Session` 是更底层 kernel，`Harness extends Session`（`types.ts:788`）。
3. **多 agent 的官方姿势 = 子会话 + task ownership**：`21-subagent-foreground.ts`（父工具调用创建自己拥有的子会话，等答完返回）与 `22-subagent-background.ts`（常驻子 agent，spawn/send/stop/status，答案异步回报，重启后仍送达）。**正好对应「分阶段开会」与「老板实时查看/分叉沟通」。**
4. **owner 树是编排语义的全部来源**：`TaskOptions.ownership` 必填（`src/types.ts:376-377`）。abort 向下传播、idle 等待向上汇总、`background:true` 是边界——父 agent 的 Esc 和 idle 等待穿不过它，但 `abort({background:true})` 能。**直接解决「员工不能被老板 Esc 打断，但管理员可一键全停」。**
5. **成本核算内建、按会话隔离**：`pi.usage` 按 `provider/modelId` 与工具名累计 `Usage`（含 `cost.*`），在与 assistant entry **同一次提交**里写入（`src/harness/generation.ts:740-749`）；`harness.usage()` 汇总全 Session（`src/harness/harness.ts:352-362`）。**但不按项目/组织聚合，那层要自己写。**
6. **没有硬性阻碍**：SQLite 走 Node 内置 `node:sqlite` 的 `DatabaseSync`（`packages/chord/src/sqlite/node.ts:3-4,186`），**不需要编译原生 addon**。唯一的原生味是图像处理 `@silvia-odwyer/photon`（WASM），不用 `read` 读图就不加载。
7. **但 API 是 experimental**。README 第 3 行：「**Experimental.** The API changes without notice between releases.」`CHANGELOG` 的 `[1.4.0]` 有 6 条 Breaking Changes，`[Unreleased]` 又有 4 条。**结论：锁死精确版本 + 不做深 fork，领域逻辑全写在 extension/document/task 三件套里。**
8. **没有多租户概念**。一个 `Storage` 一个 `Harness`，一个进程一个 storage（`README.md:783`：「no cross-process locking」）。**「项目=工作空间文件夹」只能靠 conversation + document + `env` 的 cwd 做逻辑隔离。**
9. **UI 契约是 committed state，不是事件流**。`conversation.watch()` 给 `{conversation, entries, docs["pi.live"|"pi.inbox"|"pi.usage"|"pi.agent"|"pi.provider"]}`；慢消费者最多缓存 100 帧、溢出退化成整帧快照（`README.md:493`）。`watchEvents()` 是 experimental。**老板看板用 `watch()` + `watchTaskGraph()`，别押注 `watchEvents`。**
10. **流式是 100ms 节流提交**（`DEFAULT_PROGRESS_POLICY`，`agent.ts:34-38`）。看板天然 100ms 粒度，不是 token 级。
11. **恢复是「至少一次」**。Task phase 崩溃后从 checkpoint 重跑，副作用必须幂等或用 `runtime.memo()` 去重（`12-recovery.ts:32-35`）；工具默认 `replay:"unsafe"`，崩溃后模型拿 `interrupted` 而非重跑（`src/harness/types.ts:303-304`）。
12. **测试基建可直接抄**：`test/session-support.ts` 的 `ControlledStorage`、`test/harness-support.ts` 的 `openHarness/addTool/addTask/addHooks`、`test/task-support.ts` 的 `openTasks/deferred/eventually`。

---

## A. 仓库结构总览

### A.1 包管理器与 Node/TS 版本

根 `package.json:5-13` 是 **npm workspaces**（不是 pnpm）：`"packages/*", "apps/*", "packages/coding-agent/examples/extensions/*"`。仓库只有 `package-lock.json`；`pnpm@11.15.1` 仅是 root devDependency，被 `scripts/local-package-install.mjs` 用来验证「消费者用 pnpm 装我们的包」。

- `engines.node: ">=22.19.0"`（根 `package.json:71-73`；`packages/durable/package.json:149-150` 同）。22.19 是 `node:sqlite` 稳定 + strip-types 可用的门槛。
- root devDeps：`typescript 7.0.2`、`@types/node 22.19.19`、`@biomejs/biome 2.3.5`。
- `tsconfig.base.json`：`target/lib ES2024`、`module/moduleResolution Node16`、`strict`、**`erasableSyntaxOnly: true`**、`verbatimModuleSyntax`、`allowImportingTsExtensions` + `rewriteRelativeImportExtensions`。
- **`erasableSyntaxOnly` 是硬约束**：源码不能用 `enum`、`namespace`、参数属性、`import =`。我们加 package 时要守。

### A.2 各 package 职责与依赖（实测 `dependencies`）

| package | 职责 | 内部依赖 |
|---|---|---|
| `telemetry` | 厂商中立 telemetry 契约与 typed schema | — |
| `chord` | 跨进程「对象」+ 引用 + 热重载；提供 `Context`、document delta、`WatchHandle`、`sqlite` 抽象 | telemetry |
| `tui` / `codemode` / `mcp` | 终端 UI（差分渲染）/ QuickJS(WASM) 跑模型写的 JS / 独立 MCP 客户端 | — |
| `ai` | 统一 LLM API、provider、token/cost 统计 | telemetry |
| `durable` | **durable agent harness**：会话/任务/文档运行时 | chord, ai, codemode, telemetry |
| `env` | 远程执行环境（SSH + Rust daemon），实现 durable 的 `ExecutionEnv` | chord, **durable** |
| `agent` | 有状态 agent + 工具执行 + 事件流（轻量、无持久化） | ai |
| `coding-agent` | 成品 coding agent（CLI/TUI/RPC） | agent-core, ai, codemode, mcp, tui |
| `evals` | 行为评测 | — |

关键：**`durable` 不依赖 `agent`**。`pi-agent-core`（内存态）与 `pi-durable`（持久态）是两条平行路线，`coding-agent` 选了 `agent-core`。**我们要持久化多 agent 组织，只走 `durable`，不要混。** 另：`env` 依赖 `durable`，不是反过来——远程环境是可插拔能力。`durable` 外部依赖只有 4 个：`diff`、`typebox`、`@silvia-odwyer/photon`、以及 chord/ai/codemode/telemetry。

### A.3 构建顺序 = 依赖拓扑

根 `package.json:16` 的 `build` 是一条 `cd ... && npm run build` 长链，顺序即拓扑：

```
telemetry → chord → tui → codemode → mcp → ai → durable → env → agent → coding-agent
```

`durable` 第 7 位，前 6 个都是前置。`packages/durable/package.json` 的 `build` 是 `tsc -p tsconfig.build.json`（纯 tsc，无 bundler）。`tsconfig.build.json` 用 `paths` 把 `chord`/`pi-ai` 指向 `../*/dist/index.d.ts`——**必须先 build 前置包**。

---

## B. `packages/durable` 实现

### B.1 入口导出面（`src/index.ts`，214 行）

| 分组 | 导出符号 |
|---|---|
| 文档定义 | `defineDoc, defineDocFamily` |
| Entry | `defineEntry, UserEntry, AssistantEntry, SystemEntry, ToolResultEntry, ResetEntry, CompactionEntry` |
| 错误 | `ConversationBusy, ReadAfterWrite, ReadOnlySession, SessionFailed, StorageRequestError` |
| Agent | `AgentDoc, configure, DEFAULT_RETRY_POLICY, DEFAULT_COMPACTION_POLICY, DEFAULT_PROGRESS_POLICY, DEFAULT_RESTART_LIMIT` |
| 内置 Task | `GenerationTask`、`ToolTask`(+`NestedCallDoc/NestedCallState`)、`CompactionTask`（各自的 `Checkpoint/Input/Result` 同时导出） |
| Extension / 其他 | `defineExtension, defineTool, hook, section, wrapSection, wrapTool` / `Harness, DEFAULT_HARNESS_IDENTITY, createRegistry, createSession, MemoryStorage, defineTask, DURABLE_TELEMETRY_SCHEMA, ROOT_CONVERSATION_ID`(=`1`) |
| 内置 Document | `InboxDoc`、`LiveDoc`、`ProviderDoc`、`UsageDoc`（各自的 State/Slot 类型同时导出） |
| 观察/事件 | `watchEvents`(+`AgentEvent/AgentEventStream/MessageChange/SnapshotEvent/ToolEventCall`)、`ConversationView`、`TaskGraph/TaskGraphNode/TaskGraphState/TaskGraphWatch`、`BlockedReason`、`WatchEnd/WatchHandle` |

外加两个大类型桶：`src/harness/types.ts`（100+ Harness 层类型）与 `src/types.ts`（`Storage/StorageWrite/Tx/Session/EntryRecord/EntryDraft/TaskRecord/TaskState/TaskDefinition/TaskRuntime/TaskOptions/TaskOutcome/TaskOwnership/ConversationRecord/ConversationOwnership/SubmissionRecord/DocumentRecord/DocDefinition/DocFamilyDefinition/CommitPublication/SetTimer` + branded ID `ConversationId/EntryId/TaskId<R>/SubmissionId/DocumentId/Seq`）。

### B.2 `src/harness/` 模块职责与真实签名（23 文件，约 8400 行）

**`harness.ts`(556) — 门面**：`HarnessImpl extends SessionImpl`（`:203`）。
```ts
// src/harness/harness.ts:531-555
export const Harness = {
  async open<Tool extends ToolRegistration>(storage: Storage, options: HarnessOptions<Tool>, context: Context): Promise<Harness>
};
```
`open()` 校验 registry 含 3 个内置 task，缺一即抛（`:540-544`）→ **必须用 `createRegistry()`**。

**`types.ts`(914) — 公共契约**（完整定义见 `src/harness/types.ts:730-844`）：
```ts
export interface Conversation {   // :730-783
  readonly id: ConversationId;
  agent(context: Context): Promise<Agent>;
  configure(change: AgentChange, context: Context): Promise<void>;
  submit(submission: SubmissionDraft, context: Context): Promise<Submission>;
  reset(handoff: string | undefined, context: Context): Promise<void>;
  compact(instructions: string | undefined, context: Context): Promise<TaskId<CompactionResult>>;
  commit<T>(change: (tx: Tx) => T | Promise<T>, context: Context): Promise<T>;
  context(context: Context, options?: { readonly at?: EntryId }): Promise<ContextView>;
  entries(query: Omit<EntryQuery,"conversationId">, limit: number, cursor: Cursor|undefined, context: Context): Promise<Page<EntryRecord,Cursor>>;
  fork(at: EntryId, options: ConversationCreateOptions, context: Context): Promise<Conversation>;
  abort(context: Context, options?: ConversationAbortOptions): Promise<void>;
  waitForIdle(context: Context): Promise<void>;   watch(context: Context): Promise<ConversationWatch>;
}
export interface Harness extends Session {   // :788-844
  resume(): void;  wake(): Wake;
  root(context: Context, options?: { readonly agent?: AgentChange; readonly init?: ConversationInit }): Promise<Conversation>;
  conversation(id: ConversationId, context: Context): Promise<Conversation | undefined>;
  createConversation(options: ConversationCreateOptions, context: Context): Promise<Conversation>;
  getTask<R>(id: TaskId<R>, context: Context): Promise<TaskRecord<JsonValue,JsonValue,R> | undefined>;
  inspect(context: Context): Promise<HarnessInspection>;
  submission(id: SubmissionId, context: Context): Promise<Submission | undefined>;
  abortSubmission(id, context, conversationId?): Promise<"aborted"|"already_placed"|"settled"|"not_found">;
  abortTask(id: TaskId, context: Context): Promise<"marked"|"terminal">;
  retryTask(id: TaskId, context: Context): Promise<void>;
  waitForTask<R>(id: TaskId<R>, context: Context): Promise<SettledTask<R>>;
  waitForIdle(context: Context): Promise<void>;
  usage(context: Context): Promise<UsageState>;
  watchTaskGraph(context: Context): Promise<TaskGraphWatch>;
}
```
另两个小接口：`Submission`（`:89-94`）`{ id; status(ctx); wait(ctx); abort(ctx) }`；`ConversationHandle`（`:130-137`，任务/工具内的 invocation-bound handle）`{ id; submit(draft,ctx); abort(ctx,opts?); waitForIdle(ctx) }`。

**`generation.ts`(774) — 内置 `pi.generation`**。`GenerationCheckpoint`（`:54-99`）是 5 个 phase 的联合：`prepare`(实现 `:133`) / `request`(`:209`) / `retry`(`:238`) / `poll`(`:252`) / `tools`(`:264`)。`request` 存 `{ attempt, model, thinkingLevel, streamOptions, cutoff: EntryId }`，`tools` 存 `{ assistant: EntryId, tools: TaskId<ToolTaskResult>[], pending: string[] }`；`GenerationResult = { entryId: EntryId }`。

**`tool.ts`(964) — 内置 `pi.tool`**（version **2**，`:126`）。`ToolTaskInput`（`:62-74`）= `{kind:"model", assistant, callId}` 或 `{kind:"nested", parent, parentCallId, key, call, progress?}`；`ToolTaskCheckpoint`（`:74-84`）= `{phase:"call"}` 或 `{phase:"execute", arguments, replay:"safe"|"unsafe"}`（**intent 在执行前落盘**）；`ToolTaskResult`（`:85`）= `{kind:"model", entryId, control?}` 或 `{kind:"nested"}`。`NestedCallDoc`（`:106-116`）是 task 作用域的 family document，key 是嵌套调用的 key，让 replay-safe 工具重跑时拿回已完成的结果。

**`compaction.ts`(483) — 内置 `pi.compaction`**：`CompactionInput = { reason: CompactionReason; instructions?: string }`（`:40`）；`SummaryRequest`（`:43-55`）= `{ attempt; model; thinkingLevel; streamOptions; maxTokens; tail: EntryId; firstKept: EntryId }`；只有 `summarize` 一个 phase（`:157`）。

**`scheduler.ts`(2521，最大文件) — 调度器**：`export class TaskScheduler`（`:258`）。不变式（`:253-257`）：
> every task transition is decided and written by one callback serialized on the Session line.

`open(context)`(`:382`) 加载 live task、遗留 `running` 改回 `pending` 并计 restart；`resume()`(`:433`) 开启调度（readOnly 抛 `ReadOnlySession`）；`blockedReason(record)`(`:459`) → `BlockedReason = "missing_task"|"task_too_old"|"migration_failed"|"restart_limit"`(`:94`)；`retry(id,context)`(`:444`) 解除停车；`join()`(`:534`) close 时 signal 全部 invocation、写回 `pending`（**close 不算 crash**）。

**`agent.ts`(353) — `pi.agent` + 解析**。默认策略（`:20-57`）：`DEFAULT_RETRY_POLICY = { enabled:true, maxRetries:3, baseDelayMs:2000, maxAgentDelayMs:60000 }`、`DEFAULT_COMPACTION_POLICY = { enabled:true, reserveTokens:16384, keepRecentTokens:20000, backgroundTokens:32768 }`、`DEFAULT_PROGRESS_POLICY = { partialIntervalMs:100, outputIntervalMs:100 }`、`DEFAULT_RESTART_LIMIT = 5`、`INSTRUCTIONS_KEY = "instructions"`。`AgentDoc`（`:43-50`）= `defineDoc<AgentState>({ kind:"pi.agent", version:1, scope:"conversation", history:"rewindable", fork:"asOf", initial:()=>({}), checkpointWhen:()=>true })`。函数：`resolveSettings`(:65)、`configure`(:103 附近)、`addTools`(:112)、`createAgent`(:174)、`resolveAgent`(:222)。

**`registry.ts`(114)**：`BUILTIN_TASKS = [GenerationTask, ToolTask, CompactionTask]`(`:10`)；`createRegistry()`(`:112`)。`install()` 按 name 原地替换（`:73-80`）= 热重载；task name 冲突抛错（`:26`）；校验（`:96-109`）tool 名唯一、section key 匹配 `/^[a-z][a-z0-9_-]*$/`、不能叫 `instructions`。
**`inbox.ts`(168)**：`InboxItem = {id, mode:"steer"|"followUp", content, entry?} | {id, mode:"write", entry}`；`InboxDoc`(`:21-29`，`checkpointWhen: v => v.items.length === 0`)。函数：`prepareBoundary`(:51)/`applyBoundary`(:70)/`appendInput`(:113)/`isDisplayOnly`(:135)/`hasQueuedReset`(:140)/`isStale`(:145)/`withdrawQueuedInputs`(:160)。
**`submissions.ts`(283) — 准入**：`admitSubmission(...)`(`:201`)。requestId 去重(:212-221)、display-only write 立刻落地(:223-231)、busy + `whenBusy:"reject"` 抛 `ConversationBusy`(:240)、否则进 inbox。
**`live.ts`(268) — `pi.live`（UI 唯一真相）**：`LiveState`(`:82-110`) = `{ run?:{taskId,inputs}, generation?:{attempt,message?,retry?,deferred?}, tools?: ToolSlot[], nestedTools?: NestedToolSlot[], compactions?, compactionFailure? }`；`ToolSlot`(`:26-38`) = `{callId,name,status,output?,droppedBytes?,droppedLines?,details?,diagnostics?,taskId?,entry?}`。

**`events.ts`(504) — 事件流（experimental）**：`watchEvents(harness, conversationId, context)`(`:164`) → `AgentEventStream { snapshot; start(l); stop(); closed }`(`:112-118`)。`AgentEvent`(`:59-97`) 覆盖 20 种：`run_start/run_end/turn_start/turn_end/message_start/message_update/message_end/tool_execution_start/tool_execution_update/tool_execution_end/inbox_update/submission/auto_retry_start/auto_retry_end/deferred_poll/entry_appended/agent_changed/usage_changed/task_failed/compaction_start/compaction_end`。

**其余**：`context.ts`(333，`readContext`:112/`deriveContext`:129)｜`prompt.ts`(158，`renderSections`:25/`planSystemEntries`:66)｜`view.ts`(250，`ConversationView`:24)｜`task-graph.ts`(283，`TaskGraph`:50)｜`provider.ts`(39，`ProviderDoc`:12)｜`define.ts`(44)｜`usage.ts`(72)｜`telemetry.ts`(139)｜`json.ts`(31)｜`util.ts`(66)。

### B.3 `src/session/`、`src/storage/` 与根文件

**`session/session.ts`(1070) — kernel**（一条 mutation line、document tracker 缓存、commit 发布）：`createSession(storage, { now?, documentRetentionMs?, setTimer? }): Session`（`:72-82`）；另有 `setDefaultDocumentRetention`(:89)、`documentRetention`(:97)、`contained`(:868)。`session/transaction.ts`(1071) 是 `Tx` 实现；`session/forks.ts`(97) 处理 fork 时 conversation 记录与各 document 的 `fork` 语义。

**`Tx` 接口**（`src/types.ts:910-1005`，40+ 方法）核心：`createConversation`/`forkConversation`/`appendEntry`(含 typed 重载)/`createTask`/`createSubmission`/`settleSubmission`/`placeSubmission`/`doc`(session|conversation|task|family 四种重载)/`retireDoc`，以及只读的 `conversation/entry/task/scanConversations/scanEntries/scanTasks/latestHeadMarker/submissionByRequest`。

**`storage/` — 5 种实现**：Memory（包根 `MemoryStorage`，参考语义实现 866 行，**拷贝所有写入值与读取结果**）｜SQLite（`openNodeSqliteStorage(path, options)`，一个 SQL 事务 = 一次 commit，WAL + `synchronous=NORMAL`）｜SQLite-Cloudflare（`openDurableObjectSqliteStorage(ctx.storage, options)`）｜JSONL（`openNodeJsonlStorage(directory, context, options)`，append-only，`{fsync:true}` 才保证掉电，**全量历史留内存**）｜IndexedDB（`IndexedDbStorage.open(name, options)`，浏览器、单 owner 需 Web Lock）。

`Storage` 接口（`src/types.ts:1129-1228`）18 个方法，核心 3 个：
```ts
commit(writes: readonly StorageWrite[], adopt: (seq: Seq) => void, context: Context): Promise<Seq>;
mintId<I extends Id<string>>(): Promise<I>;
close(context: Context): Promise<void>;
```
其余：`conversation/scanConversations/entry/findLatestHeadMarker/scanEntries/task/scanTasks/submission/scanSubmissions/submissionByRequest/findDocument/document/scanDocuments`。
**自定义 storage 必须实现 `adopt(seq)`**（`CHANGELOG` Unreleased Breaking #1）：批次 durable 后**同步**调一次再 resolve `seq`；批次未 durable 就失败时**永不调用**。用 `registerStorageConformance` 跑官方套件。

**`documents.ts`(208)**：
`defineDoc`（`:39-57`）有 4 个重载，按 `scope`+`history`+`fork` 组合推断 token 类型：session / conversation+latest / conversation+rewindable / task。`defineDocFamily`（`:60-81`）同构，多 `family: true` 与 `initial(seed: I)`。
必填字段（`CommonDocDefinition`，`src/types.ts:73-87`）：
```ts
{ readonly kind: string; readonly version: number; initial(): T;
  migrate?(value: JsonObject, fromVersion: number): T;
  checkpointWhen(value: Readonly<T>, ops: readonly Op[], info: CheckpointInfo): boolean }   // 必填，无默认
```
语义维度（`src/types.ts:52-58`）：`session`（全局单例）｜`conversation`+`history:"latest"`+`fork:"current"|"initial"`｜`conversation`+`history:"rewindable"`+`fork:"asOf"|"current"|"initial"`｜`task`。

**`tasks.ts`(8) 与 `TaskDefinition`**（`src/types.ts:334-357`）：
```ts
export function defineTask<I, S extends { phase: string }, R, H extends object = object>(definition: TaskDefinition<I,S,R,H>): Task<I,S,R,H>
export type TaskDefinition<I, S extends { phase: string }, R, H extends object> = {
  readonly name: string;      // 持久化在 TaskRecord.kind
  readonly version: number;
  initial(input: I): S;
  readonly phases: { readonly [P in S["phase"]]: PhaseHandler<I, Extract<S,{phase:P}>, S, R, H> };
  abort(task: RunningTask<I,S,R>, runtime: TaskRuntime<I,S,R,H>, context: Context): Promise<void>;   // 必填
  migrate?(input: JsonValue, checkpoint: JsonValue, fromVersion: number): { input: I; checkpoint: S };
  readonly hooks?: H;
};
// :226-230
type PhaseHandler<I,P,S,R,H extends object> = (task: RunningTask<I,P,R>, runtime: TaskRuntime<I,S,R,H>, context: Context) => Promise<void>;
```
`TaskRuntime`（`src/types.ts:245-331`）关键成员：`taskId/conversationId/signal/registry/settings/models/hooks`；`agent(ctx)`/`env(ctx)`；`commit(change, ctx)`；`memo(name,ctx)`/`memo(name,candidate,ctx)`；`getTask/waitForTask/abortOwned/ownedTasks/outcomes`；`conversation(id,ctx)`/`entry(id,ctx)`/`context(conversationId,ctx,options?)`；`now()`/`setTimer(cb,delayMs)`/`report(err,from?)`/`sleepUntil(until, checkpoint, ctx)`。

**`entries.ts`(34)**：`defineEntry<D>(kind)` + 6 个内置 token（`pi.user`/`pi.assistant`/`pi.system`/`pi.tool-result`(`data:{diagnostics}`)/`pi.reset`/`pi.compaction`(`data:{reason}`)）。

**`timers.ts`(79)**：`nativeTimer`（setTimeout；background unref；CF Workers 里直接拒绝）、`Timers = { foreground, background }`、`hostTimers(setTimer, report)`。**foreground timer 必须触发**，宿主抛错/拒绝时回落 `setTimeout`（`:60-69`）；**background 只用于释放内存**，可拒绝（`:70-77`）。

### B.4 持久化模型

| kind | 谁写 | `model` | `data` |
|---|---|---|---|
| `pi.user` | submission 落地 | `[UserMessage]` | — |
| `pi.assistant` | generation | `[AssistantMessage]` | — |
| `pi.system` | generation（位置性 prompt/工具变更） | `[SystemMessage]`，`content:""` | — |
| `pi.tool-result` | tool task / generation | `[ToolResultMessage]`（含诊断块） | `{ diagnostics }` |
| `pi.reset` | `reset()` / `control.handoff` | 可选 `[UserMessage]`，`head:"self"` | — |
| `pi.compaction` | compaction task | `[UserMessage]`（摘要），`head`=第一个保留 entry | `{ reason }` |
| 自定义 | 应用 | 可选 | 可选 |

```ts
// src/types.ts:428-443
export type EntryRecord = {
  readonly id: EntryId; readonly conversationId: ConversationId; readonly kind: string;
  readonly model?: readonly Message[];     // 贡献给模型上下文
  readonly data?: JsonValue;               // 只给应用看
  readonly head?: EntryId;                 // 从这里开始新上下文
  readonly edits?: readonly ContextEdit[]; // 对更早 entry 的上下文覆盖
  readonly byTaskId?: TaskId;
};
```
**`model`/`data` 分离是这套设计最实用的地方**：同一 entry「给模型看 A，给 UI 看 B」。`21-subagent-foreground.ts:33-37` 就用 `tx.entry(AssistantEntry, answer)` 把文本捞出来返回给父 agent。

**如何 commit**：唯一路径 `session.commit(cb,ctx)` / `conversation.commit(cb,ctx)`，cb 拿 `Tx`，全成或全不成（`spec.md` 不变式 1）。流程：Session line 上执行 cb 收集 `StorageWrite[]` + document delta → `Storage.commit(writes, adopt, ctx)` 单次原子持久化 → durable 后**同步** `adopt(seq)` 切内存态 → 之后才发布给 watcher/事件流。三条铁律（`spec.md` §12）：**① Read after write 禁止**（表读取须在第一次表写入前，违反抛 `ReadAfterWrite`）；**② 回调里不能 await 模型/工具/网络/人工**；**③ 回调里不能调 `snapshot()`/`watchDoc()`/`getTask()`**（可能排队永不 resolve，用 `tx` 读）。

**崩溃恢复**：核心在 `TaskScheduler.open()`（`src/harness/scheduler.ts:382-420`）：遍历 live task，`running` 改回 `pending` 并 `restarts+1`；达 `restartLimit`（默认 5）且无 abort mark 就 park。三层保护：
1. **running → pending 回退**：进程死时正在跑的 task 下次从头执行该 phase。
2. **restart 计数 + 停车**：连续被 cut off 5 次没提交新状态 → `blocked: restart_limit`，`wake()` 不算 active，`onReport` 收一次 `task_parked`，`retryTask(id)` 解除。**防「必崩代码无限重启」。**
3. **`abandonOnRestart`**：只在内存里被 await 的任务（如非 replay-safe 工具创建的子任务），新 Harness 调度时直接 abort-mark（`abortReason:"restart"`），连同其拥有的全部工作，在任何东西重跑之前。

**close 不算 crash**：`join()`(`:534-540`) 把停下的 task 写回 `pending` 且不计数。工具恢复（`src/harness/types.ts:303-304`）：`replay:"safe"` 崩溃后重跑；默认 `"unsafe"` 则模型收到 `interrupted` 错误结果，已提交的部分输出保留。
**effect sandwich**（`spec.md` §5.2）：`commit intent → perform effect → commit outcome/next phase`。在 intent 阶段重开 ⇒ 副作用可能已发生 ⇒ handler 必须重试安全、或轮询外部 handle、或记录中断。`12-recovery.ts:32-35` 用 `runtime.memo()` 去重：
```ts
if ((await runtime.memo(`printed-${n}`, taskContext)) === undefined) {
  await runtime.memo(`printed-${n}`, true, taskContext);
  console.log(`tick ${n}`);
}
```

### B.5 usage / cost 如何记录

```ts
// src/harness/usage.ts:7-22
export type UsageState = {
  /** Assistant entries and summarization attempts, keyed `provider/modelId`. */
  models: Record<string, JsonRepresentation<Usage>>;
  /** Tool results, keyed by tool name; their usage has no model identity. */
  tools: Record<string, JsonRepresentation<Usage>>;
};
export const UsageDoc = defineDoc<UsageState>({ kind: "pi.usage", version: 1, scope: "conversation",
  history: "latest", fork: "initial", initial: () => ({ models: {}, tools: {} }), checkpointWhen: () => true });
```
四个写入点，全部在「记录该结果的那次提交」内：
1. **assistant 消息**（`src/harness/generation.ts:740-749`，`appendAssistant`）：`await recordUsage(tx, conversationId, "models", \`${message.provider}/${message.model}\`, message.usage);` 紧接 `tx.appendEntry(AssistantEntry, conversationId, { model: [message] })`。源注释：「every built-in writer of assistant entries goes through here, so the usage ledger stays complete.」
2. **工具结果带 usage**（`src/harness/tool.ts:911`）：`if (result.usage !== undefined) await recordUsage(tx, conversationId, "tools", call.name, result.usage);`
3. **嵌套调用**（`src/harness/tool.ts:663`）：同上，key 是 `call.name`。
4. **compaction 摘要请求**（`src/harness/compaction.ts:196-202`）——**没有对应 entry，纯记账**。

`Usage` 字段（`packages/ai/src/types.ts:459-490`）：`{ input, output, cacheRead, cacheWrite, cacheWrite1h?, reasoning?, totalTokens, cost:{ input, output, cacheRead, cacheWrite, total } }`。`recordUsage`（`src/harness/usage.ts:25-39`）按 bucket+key 取已有 totals，有则 `addUsage`，无则 `copyJson` 存入。
汇总（`src/harness/harness.ts:352-362`）：`usage(ctx)` 先 `scanAll(cursor => storage.scanConversations({}, 256, cursor, ctx))` 扫全部会话，再对每个 `snapshot(UsageDoc, id, ctx)` 调 `addUsageState(total, state)` 累加。**这个函数就是「按组织聚合」要抄的模板**：把 `scanConversations` 的结果按 owner/项目分组，再分别求和。
**限制（对我们影响很大）**：只有「会话级」账本 + 「Session 级」总和，**没有项目级/部门级/员工级聚合**；fork 从 0 开始（`README.md:745`）；跑子会话的工具不能把子会话 usage 再报一遍否则重复计（`spec.md` §12「Double-counted subagent spend」）——按组织树聚合的正确做法是 `scanConversations` 后按 `ConversationRecord.owner` 做子树求和（spec 明说「other totals, such as an ownership subtree, are application sums over `scanConversations()`」）；失败/中断也计数；compaction 每次尝试都花钱、摘要过期照付。

## C. `packages/durable/test` 示例解读

`test/examples/` 有 31 个 `.ts`（`00`–`30`），都是可独立运行的脚本，不是 vitest 测试：

```bash
cd packages/durable
node --conditions=source --experimental-strip-types test/examples/13-chat.ts
```
`--conditions=source` 让 `exports` 解析到 `src/*.ts`；`--experimental-strip-types` 让 Node 直接剥类型。只有 `15-real-model.ts` 要 `OPENAI_API_KEY`，其余用 `@earendil-works/pi-ai/providers/faux`。分层：`00`–`12` 底层原语，`13`–`30` 产品形态。

### C.1 与「多 agent 组织编排」最相关的 13 个

**① `01-documents.ts`(46) — Document 与 as-of 快照**。定义 `history:"rewindable"` + `fork:"asOf"` 的会话级 document（`:14-22`），在**同一次 commit** 里 `tx.appendEntry(...)` + `(await tx.doc(Notes, chat.id)).text = "after hello"`（`:28-32`），然后 `snapshot()` 读最新值、`snapshotAsOf(Notes, id, firstEntry.id, ctx)` 读该 entry 时刻的值（`:42-44`）。
**可复用**：项目状态面板、组织架构快照。`snapshotAsOf` 能回答「老板三天前看到的那份周报是什么样」。

**② `02-forks.ts`(56) — fork 会话，document 按各自语义分叉**。`session.commit(tx => tx.forkConversation(chat.id, firstEntry.id, { ownership: { kind: "ownerless" } }))`（`:35-38`）；fork 看到父到该 entry 的 transcript，`Notes` 因 `fork:"asOf"` 取那一刻的值；分支上改 document 不影响父（`:50-54` 对照打印两个 `snapshot`）。
**可复用**：老板在某节点插进来问一句、不污染主线。注意 fork 拿到新的 provider sessionId（`ProviderDoc` 的 `fork:"initial"`），provider 侧 prompt cache 不共享。

**③ `05-harness.ts`(67) — 最小可用 Harness**。`defineTool` + `createRegistry` + `Harness.open` + `root({agent, init})`；root 懒创建（ID 恒为 1），`agent` 与 `init` 在同一 commit 生效（`:50-58`：`harness.root(context, { agent:{thinkingLevel:"low"}, init: async (tx, rootId) => { (await tx.doc(Notes, rootId)).text = "root notes"; } })`）。
**可复用**：应用启动 bootstrap。`init` 是「给新会话预置 document」的官方钩子。

**④ `07-harness-conversations.ts`(42) — typed entry / 独立会话 / fork**。`defineEntry<{from:string}>("message")` 定义类型化 entry，`tx.appendEntry(Message, root.id, { data, model })`；`createConversation({ownership, agent})` 与 `root.fork(hello.id, {ownership})` 都在创建 commit 里应用 agent（`:33-39`）。
**可复用**：定义我们自己的 entry 类型（`app.ceo_decision`、`app.meeting_minutes`）——`kind` 不以 `pi.` 开头就安全。

**⑤ `11-tasks.ts`(64) — 自定义 durable task 的完整骨架**。`defineTask({ name, version, initial, phases, abort })`；每个 phase 必须 `runtime.commit()` 提交下一状态或终态。骨架（`:24-45`）：`prepare` phase 先落 intent `commit(() => ({ status:"running", checkpoint:{ phase:"charge", key:\`payment-${task.id}\` } }))`；`charge` phase 做幂等副作用（`if (!payments.has(key)) ...`）再 `commit(() => ({ status:"terminal", outcome:{ status:"completed", result:{ receipt } } }))`；`abort` 提交 `{ status:"terminal", outcome:{ status:"aborted" } }`。创建与等待（`:56-62`）：`root.commit(tx => tx.createTask(Payment, { amount: 5 }, { ownership: { kind: "conversation" } }))` → `harness.waitForTask(paymentId, context)`。
**可复用**：「分阶段开会」每阶段一个 phase；「升级链」每级一个 phase（checkpoint 记当前层级）。

**⑥ `12-recovery.ts`(91) — 崩溃后从 checkpoint 继续**。SQLite 落盘，跑到 tick 2 就 close（模拟 crash）；先用一个**从不 resume 的只读 Harness** 读出 `saved.state` 和 `saved.memos`（`:79-82`），再重开并 `waitForTask(tickerId, context)` —— **等待本身就会开启调度**（`:87-89`）。`:48` 的 `await runtime.sleepUntil(runtime.now() + 50, { phase: "tick", n: n + 1 }, taskContext)` 说明 **sleep 是持久化的，睡眠中的 task 不占 invocation**。
**可复用**：老板关笔记本、服务器重启、长会议跨天——所有「工作必须跨进程存活」的场景。

**⑦ `19-inbox.ts`(72) — busy 时的提交队列**（`:34-46`）：`submit({type:"input",content})` 默认 followUp；`whenBusy:"steer"` 插到当前工具轮后；`submit({type:"write",entry:{kind,data}})` 立刻落地；`whenBusy:"reject"` 抛 `ConversationBusy`；`submission.abort(ctx)` 撤回排队项。语义见 `inbox.ts:70-110`、`README.md:508-513`；`settings.steeringMode/followUpMode:"all"` 可一次放全部。
**可复用**：老板实时插话用 `steer`，排队用默认 followUp；「员工只对接管理层」用 `reject` + `ConversationBusy` 拒绝越级输入。

**⑧ `21-subagent-foreground.ts`(136) — 前台子 agent（最核心编排范例）**。
```ts
// test/examples/21-subagent-foreground.ts:42-74（产品代码节选）
defineTool({ name: "subagent", parameters: Type.Object({ task: Type.String() }),
	replay: "safe",   // 崩溃重跑能找到已创建的子会话和已提交的 submission
	execute: async (args, api, callContext) => {
		const child = await api.commit(async (tx) => {
			const existing = (await tx.scanConversations({ ownerTaskId: api.taskId }, 1)).items[0];
			if (existing !== undefined) return existing.id;
			const created = await tx.createConversation({ ownership: { kind: "task", taskId: api.taskId } });
			await configure(tx, created.id, { extensions: { remove: [Subagent] } });   // 子 agent 不能再开子 agent
			return created.id;
		}, callContext);
		await api.details({ conversationId: child }, callContext);   // UI 靠这个发现子会话
		const handle = (await api.conversation(child, callContext))!;
		const request = { type: "input", content: args.task, requestId: `subagent:${api.taskId}` } as const;
		const settled = await (await handle.submit(request, callContext)).wait(callContext);
		if (settled.status !== "done" || settled.type !== "input") throw new Error(`Subagent failed: ${settled.status}`);
		return { output: [{ type: "text", text: await answerText(api, settled.answer, callContext) }], details: { conversationId: child } };
	} });
```
三个必抄细节：**① `replay:"safe"` + `requestId` + 幂等查重**（`:54-55`、`:67`）——重跑不创建第二个子会话、不重复投递；**② `extensions:{remove:[Subagent]}`**（`:59`）——控制组织层级；**③ `api.details({conversationId})`**（`:63`）——UI 发现子会话的通道；示例 `attach()`（`:113-126`）收到 `tool_execution_update` 且 `event.details.conversationId` 未 attach 过 → 缩进+2 递归 attach。
**可复用**：CEO 派单个明确任务给高管、要答案才能继续。注意「owned work holds its owner」——前台子 agent 会 hold 住调用它的工具和整个 run，所以老板不能同时问别的（要用后台模式）。

**⑨ `22-subagent-background.ts`(364) — 常驻后台子 agent（最接近我们需求）**。一个 `subagent` 工具带 `spawn/send/stop/status`；每个子 agent 独立会话；答案异步回报；**进程重启后仍送达**。四个机制：
**① Anchor task = ownership 边界**（`:57-72`）。注释原文：「A subagent must outlive the main agent's turns, so its conversation is owned by an anchor: a background task that finishes at once. A background task is a boundary: the main agent's Esc and idle waits stop there, but `abort({ background: true })` still reaches past it, so a host can stop everything.」实现就是一个立刻 commit 终态的 task。
**② Reporter task = 投递与回报**，两个 phase 分离：`deliver` 做副作用（发消息、等回答），`report` 只做可重试的投递，中间态落 checkpoint。关键 8 行（`:86-107` 节选）：
```ts
deliver: async (reporter, runtime, ctx) => {
	const subagent = (await runtime.conversation(reporter.input.conversationId, ctx))!;
	const request = { type: "input", content: reporter.input.message, whenBusy: reporter.input.followUp ? "followUp" : "steer" } as const;
	const settled = await (await subagent.submit({ ...request, requestId: `subagent:${reporter.id}` }, ctx)).wait(ctx);
	await runtime.commit(async (tx) => {
		const next = (report?: string) => ({ status: "running", checkpoint: { phase: "report", report } }) as const;
		if (settled.status === "unanswered") return next(settled.reason === "aborted" ? undefined : `[subagent ${reporter.input.name} failed: ${settled.reason}]`);
		if (settled.type !== "input") return next();
		const agent = (await tx.doc(Subagents, runtime.conversationId)).agents[reporter.input.name]!;
		if (agent.reported.includes(settled.answer)) return next();     // 已报过就不重复报
		agent.reported.push(settled.answer);
		const answer = (await tx.entry(AssistantEntry, settled.answer))?.model?.[0] as AssistantMessage;
		return next(`[subagent ${reporter.input.name} answered, no reply needed] ${textOf(answer)}`);
	}, ctx);
},
report: async (reporter, runtime, ctx) => {   // 只做可重试的投递
	const report = reporter.state.checkpoint.report;
	if (report !== undefined) await (await runtime.conversation(runtime.conversationId, ctx))!
		.submit({ type: "input", content: report, whenBusy: "followUp", requestId: `subagent-report:${reporter.id}` }, ctx);
	await runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result: null } }), ctx);
},
```
**③ 子 agent 注册表 document**（`:46-55`）：`defineDoc({ kind:"app.subagents", scope:"conversation", history:"latest", fork:"initial", checkpointWhen:()=>false, initial:()=>({ agents:{}, reporters:{} }) })`。
**④ spawn 时配置子 agent**（`:187-199`）：`createTask(Anchor, null, {ownership:{kind:"conversation"}, background:true})` → `createConversation({ ownership:{kind:"task", taskId: anchor} })` → `configure(tx, child.id, { extensions:{remove:[SubagentTools]}, instructions: "You are the subagent ..." })`。
`status` 判断忙闲（`:167`）：`const busy = (await api.snapshot(LiveDoc, found.conversationId, callContext))?.run !== undefined;`
**可复用**：**这就是「项目内员工」的模板。** 每个员工 = 一个会话 + 一个 anchor task + 名字到会话的映射 document。派活 = `send`；看进度 = `status`（读 `LiveDoc.run`）；叫停 = `stop`（`conversation.abort()`）。重启后 reporter 自动继续，答案补送进老板 inbox。

**⑩ `23-child-tasks.ts`(146) — 一个 task 拥有并等待多个子 task**。`pay` phase 在一个 commit 里建 N 个子 task 并提交 `{ status:"waiting", checkpoint:{phase:"decide",payments}, on: payments, policy:"failFast" }`（`:71-79`）；`decide` phase 用 `runtime.outcomes(ids)` 读全部结果再决定终态（`:80-91`）。任务树打印（`:107-116`）按 `candidate.owner === node.id` 递归，`waiting` 显示 `waiting on ${state.on.join(", ")}`。示例还测了：一张卡被拒（failFast 级联 abort 其他）、客户取消（`abortTask`）、**进程中途死掉后重开继续**（`:137-143`）。
语义（`README.md:697-699`）：**waiting** 不跑代码，`allSettled` 等全部 / `failFast` 第一个失败就 abort 其他；**completing** outcome 已定但拥有工作未 drain 时还不 terminal；**abort 自底向上**。
**可复用**：「分阶段开会」——CEO 主持，把议题拆给 6 个高管并行处理，全员完成后进 `decide` 汇总；`watchTaskGraph` 直接就是会议进度看板。

**⑪ `26-plan-mode.ts`(116) — 用 `configure()` 切能力边界**。extension 自带 `app.plan` document；工具 `submit_plan` 写 document 并返回 `control:{terminate:true}` 直接结束 run（`:39-49`）；模式切换就是改 agent（`:61-63`）：`const enterPlanMode = { extensions:{add:[Plan]}, tools:[read, submitPlan] };` / `const leavePlanMode = { extensions:null, tools:null };`（`null` = 回到宿主默认）。registry 装了 Plan 但 `settings:{extensions:[CodingTools]}` 只默认选 CodingTools，会话 opt-in（`:86-87`）。
**可复用**：「讨论阶段」只给只读工具 + `submit_proposal`；「执行阶段」才给写工具。

**⑫ `27-reviewer.ts`(111) — 独立角色 agent（多角色组织最直接的模板）**。角色 extension（`:33-44`）= `defineExtension({ name:"reviewer", sections:[section("role", () => "You review diffs...Never edit files.")], hooks:[hook(GenerationTask, { onYield: (answer) => textOf(answer).includes(DONE) ? undefined : { continue: "Look again..." } })] })`——`onYield` 就是「反复复查直到没问题」的循环。角色会话（`:79-90`）= `createConversation({ ownership:{kind:"ownerless"}, agent:{ model:{provider:"faux",modelId:"small"}, extensions:[CodingTools, Reviewer], tools:[createReadTool()], cwd: worktree } })`。
**可复用**：**CFO/CPO/COO/CHRO 每个角色 = 一个 extension + 一个 `createConversation({agent})`**。角色 prompt 用 `section("role")`；能力用 `tools`；模型用 `model`；目录用 `cwd`；专属循环用 `hook(GenerationTask, { onYield })`。

**⑬ `30-reload-and-restart.ts`(90) — 热重载 + 存名字不存代码**。运行中 `registry.install(loadVersioned("v2"))` 同名原地替换——正在跑的调用用旧代码完成、下一次用新代码（`:70-77`）；进程重启后会话存的是 extension **名字**，装了 v3 就自动用 v3（`:81-87`）。
**可复用**：角色定义（prompt、工具集）一定会频繁迭代，存名字意味着改 prompt 不用迁移数据。但**删掉 extension 后选它的会话会静默失去能力**，直到重新安装——所以要有「启动时确保所有角色 extension 都装了」的校验。

### C.2 测试基建怎么用

**`test/session-support.ts`(166，最有用)**：`context = BACKGROUND_CONTEXT`（`:18`）。`ControlledStorage extends MemoryStorage`（`:37`）提供：`.commits`/`.admittedCommits` 观察提交；`holdCommits(): Gate`（`.entered`/`.release()`）卡住提交测竞态；`.crash()` 模拟崩溃（被 hold 的 commit 永不到 storage）；`.failNextCommit(error)` 注入失败；`.reopen()` 同一对象当新进程用。另有 `flush()`（`:164`）冲刷宏任务队列。

**`test/harness-support.ts`(158)**：`openHarness(storage, toolNames?, {registry?, onReport?})`（`:33-47`）；`addTool/addTask/addHooks/addSection`（`:124-157`）**都返回 `Installed = { dispose(): void }`**——**这个模式值得照抄**，它让「extension 卸载后的行为」可测。消息工厂 `user/assistant/toolResult/system/describeMessage`（`:49-113`）。

**`test/task-support.ts`(132)**：
```ts
export type Deferred<T=void> = { readonly promise: Promise<T>; resolve(value: T): void; reject(e: unknown): void };  // :16-30
export async function openTasks(storage: Storage, tasks: readonly AnyTask[], options: {registry?; now?; settings?; onWake?; setTimer?} = {},
): Promise<{ harness; registry; reports: unknown[]; infos: ReportInfo[] }>   // :65-102
export function aborted(signal: AbortSignal): Promise<never>;                                  // :33
export async function eventually(check: () => boolean | Promise<boolean>): Promise<void>;      // :41（最多 200 次）
export async function settled(promise: Promise<unknown>): Promise<boolean>;                    // :50
export function completed<R>(result: R);  export function abortedWith(reason: string);         // :105-112
```
`reports`/`infos` 收集 `onReport` 参数——**测错误路径的标准姿势**。

**`test/storage-memory.ts`(238) 不是测试基建，是基准脚本**（`package.json` 的 `bench:storage:memory`），用 `@earendil-works/pi-durable/testing` 的 `seedStorageBenchmark` 在 memory/sqlite/jsonl 上跑合成负载，量 heap/RSS/磁盘。可照它写容量压测。

**`src/testing/`（官方套件，要复用）**：`registerStorageConformance(runner, name, withStorage)`（`src/testing/runner.ts:14-21`）、`registerEnvConformance`，`StorageConformanceProvider = (use: (storage: Storage) => Promise<void>) => Promise<void>`。自己做 storage/env 适配层时直接接这套用例。

**`test/setup-document-retention.ts`**：vitest `setupFiles` 加载，`PI_DURABLE_DOCUMENT_RETENTION_MS` 让整个套件用「立刻驱逐 document」模式再跑一遍（`package.json` 的 `test` 跑两遍）。**同一套用例在不同缓存策略下各跑一遍，值得学。**

## D. 二次开发流程（源码级）

### D.1 装 npm 包 vs 加 workspace package

**推荐装 npm 包**，理由：① 它是真正发布的包（`files:["dist",...]`、`publish` 脚本、`repository.directory`）；② 扩展点足够，**不需要改源码**就能实现我们的全部需求；③ `packages/env` 证明了外部 package 可以干净地依赖它；④ 官方强制精确版本（root devDeps 全是 `"1.4.0"` 而非 `"^1.4.0"`，`scripts/check-pinned-deps.mjs` 会检查）。

**不需要 fork 就能做的**：自定义 `Storage`（实现接口 + `registerStorageConformance` 验证）、自定义 `ExecutionEnv`（`packages/env` 就是范例）。**需要 fork 的**：改 scheduler / generation 的核心语义——**强烈不建议**（2521 行调度器是整套正确性的核心）。

### D.2 扩展点全清单

**① Registry + Extension**（工具/prompt/hook/wrapper/task 的打包单位）：
```ts
// src/harness/types.ts:371-380
export interface Extension<Tool extends ToolRegistration = ToolRegistration> {
  readonly name: string;
  readonly tools?: readonly Tool[];
  readonly sections?: readonly PromptSection<Tool>[];
  readonly hooks?: readonly HookRegistration[];
  readonly wraps?: readonly Wrap<Tool>[];       // 按名字装饰 tool/section，在选中该 extension 处生效
  readonly tasks?: readonly AnyTask[];          // 按 name 解析，与选中无关
}
// :403-408
export interface Registry<Tool> extends RegistryReader<Tool> {
  install(extension: Extension<Tool>): void;    // 同名原地替换 = 热重载
  uninstall(extension: Extension): void;
}
// src/harness/define.ts:6-43：defineExtension / defineTool / section(key,render,{tag?}) / hook(task,handlers)
//                           / wrapTool(tool,wrapper) / wrapSection(key,wrapper)
```

**② Tool 注册（完整字段）**：
```ts
// src/harness/types.ts:299-339
export type ToolRegistration<TParameters extends TSchema = TSchema, TDetails extends JsonValue = JsonValue> =
  Tool<TParameters> & {
    readonly replay?: "safe" | "unsafe";                    // 默认 unsafe：崩溃后不重跑
    readonly executionMode?: ToolExecutionMode;             // "parallel" | "sequential"
    prepareArguments?(args: unknown): Static<TParameters>;  // 修复模型常见的参数错误
    readonly structuredOutputSchema?: TSchema;
    readonly callers?: readonly ("model" | "tools")[];      // 谁能调
    readonly deferred?: true;                               // 先不暴露给模型，等 tool_search 加载
    readonly outputLimits?: { maxBytes?; maxLines?; retain?: "head"|"tail" };
    execute(args: Static<TParameters>, api: ToolExecutionApi<TDetails>, context: Context): Promise<ToolExecutionResult<TDetails>>;
  };
// :158-174 —— 三通道分离
export type ToolExecutionResult<TDetails> = { readonly output?: ToolResultMessage["content"];   // 给模型
  readonly structuredOutput?: JsonValue;   // 给程序（executeTool / codemode）
  readonly isError?: boolean;  readonly details?: TDetails;   // 给 UI
  readonly diagnostics?: readonly ToolDiagnostic[];  readonly usage?: Usage;   // 计入 pi.usage.tools
  readonly control?: ToolControl };   // { addTools?, terminate?, handoff? }
```
`ToolExecutionApi`（`:209-293`）关键成员：`taskId/conversationId/callId/registry/models/env`、`agent(ctx)`、`now()`、`output()`、`retainedOutput()`、`diagnostic()`、`details()`、`commit()`、`memo()`、`createTask()`、`waitForTask()`、`conversation(id)`、`executeTool(name, args, ctx, {key?, progress?})`。**`executeTool()` 是「工具调工具」的官方通道**：嵌套调用是独立 `pi.tool` task、被调用者拥有、走完整校验+hook+输出限制+replay 策略，结果只回调用方不进 transcript（`README.md:309-331`）。

**③ Hooks（观察/干预内置 task）**（`src/harness/types.ts:847-914`）：
- `GenerationHooks`（`:859-872`）：`beforeRequest(request, api, ctx)`（可替换 messages）、`afterResponse(msg, api, ctx)`、`onYield(answer, api, ctx): HookResult<{ continue: UserInput }>`、`afterTools(assistant, results, api, ctx)`。
- `ToolHooks`（`:880-894`）：`beforeTool(call, api, ctx): HookResult<{ arguments?: JsonObject; block?: string }>`、`afterTool(call, result, api, ctx): HookResult<ToolExecutionResult>`。
- `CompactionHooks`（`:897-914`）：`beforeCompact({reason,entries,messages,firstKept,instructions?}, api, ctx): HookResult<{ decline: true } | { summary: string }>`。
- `HookApi extends DocumentReader`（`:847-854`）：`{ taskId; conversationId; models; memo(name,ctx); memo(name,candidate,ctx) }`。
**`onYield` 是「多轮直到收敛」的钩子**（`27-reviewer.ts` 用它做 review loop）；**`beforeTool` 的 `{block}` 是权限闸门**（`README.md:609` 用它禁 bash）。⚠️ `spec.md` §12「Guards left out of a selection」：**hook 只在选中该 extension 的会话生效，没有全局 hook**——权限 extension 必须显式加进每个角色的数组。

**④ Per-conversation agent**（`src/harness/types.ts:411-467`）：
```ts
// :411-432 —— 存储形态：全是名字，不是对象
export type AgentState = { model?: ModelRef; thinkingLevel?: ModelThinkingLevel;
  extensions?: string[] | { add?: string[]; remove?: string[] }; tools?: string[] | { remove: string[] };
  modelTools?: string[] | { remove?: string[]; add?: string[] }; instructions?: string; cwd?: string };
// :435-450 —— 修改形态：每字段可给值 / null(清除回宿主默认) / undefined(不动)
export type AgentChange = { readonly model?: ModelRef | null; readonly thinkingLevel?: ModelThinkingLevel | null;
  readonly extensions?: readonly Extension[] | { readonly add?: readonly Extension[]; readonly remove?: readonly Extension[] } | null;
  readonly tools?: readonly ToolRegistration[] | { readonly remove: readonly ToolRegistration[] } | null;
  readonly modelTools?: readonly ToolRegistration[] | { readonly remove?; readonly add? } | null;
  readonly instructions?: string | null; readonly cwd?: string | null };
// :453-467 —— 解析结果：tools=提供给模型的；callable=executeTool 可解析的；deferred=未加载的
export type Agent<Tool> = { readonly model?: ModelRef; readonly thinkingLevel: ModelThinkingLevel;
  readonly extensions: readonly Extension<Tool>[]; readonly tools: readonly Tool[]; readonly callable: readonly Tool[];
  readonly deferred: readonly Tool[]; readonly sections: readonly PromptSection<Tool>[];
  readonly instructions?: string; readonly cwd?: string };
```
语义：**给定字段替换、`null` 清除回宿主默认、`undefined` 不动**（`README.md:382-399`）；存的是**名字**，解析时才对 registry 展开（`resolveAgent`，`src/harness/agent.ts:222`）。`createConversation({agent})` / `fork(at,{agent})` / `root({agent})` 三处都能一次性配置，且在创建 commit 里生效。

**⑤ System prompt 定制**：`PromptSection`（`:355-360`）= `{ key; render(input, ctx): string|undefined|Promise<...>; tag? }`（`tag` 默认 true，包成 `<key>\n...\n</key>`）；`PromptInput`（`:342-352`）= `{ conversationId; agent; env; shown: Record<string,string>; read: DocumentReader }`。
三层：`section(key, render)`（全局/角色 prompt）、`agent.instructions`（会话级，渲染为最后一个 section `instructions`）、`wrapSection(key, wrapper)`（装饰而不替换，`14-system-prompt.ts:43-51`）。
**机制要点**：section 输出与「模型已看到的」做 diff，**只把变化追加成 `pi.system` entry**（`planSystemEntries`，`src/harness/prompt.ts:66`），保住 provider prompt cache。**section 必须是稳定函数**——放时间戳会打爆 cache（`spec.md` §12「Unstable prompt text」）。

**⑥ Storage 自定义**：实现 `Storage` 18 个方法（`src/types.ts:1129-1228`），最低 `commit/mintId` + 16 个读方法；用 `registerStorageConformance` 验证。

**⑦ ExecutionEnv 自定义（「项目=工作空间文件夹」的关键）**：
```ts
// src/env/index.ts:374
export interface ExecutionEnv extends FileSystem, Shell {}
// FileSystem（:209-...）: id, cwd, absolutePath, joinPath, readTextFile, openTextLineReader, readTextLines,
//   readBinaryFile, openBinaryReader, writeFile, appendFile, truncateFile, flushFile, renameFile, fileInfo, listDir, listFiles?
// src/env/node.ts:612-626 —— id 相同即看到相同文件；本地环境共用 "node:local"
export class NodeExecutionEnv implements ExecutionEnv {
	readonly id: string = "node:local";
	constructor(options: { cwd: string; shellPath?: string; shellEnv?: NodeJS.ProcessEnv; watch?: NodeWatchOptions })
}
// src/harness/types.ts:626-627
readonly env?: (target: EnvTarget, context: Context) => ExecutionEnv | undefined | Promise<ExecutionEnv | undefined>;
// EnvTarget = { readonly conversationId: ConversationId; readonly cwd?: string; readonly read: DocumentReader }
```
`28-sandbox-per-conversation.ts:49-52` 是完整范例（从 document 读每会话沙箱路径）。

**⑧ Harness 级设置（不落盘的运行策略）**（`src/harness/types.ts:544-577`）：`HarnessSettings = { extensions?, stream?, retry?, compaction?, progress?, toolExecution?, steeringMode?, followUpMode?, contextRetentionMs?, documentRetentionMs?, afterFailedRun?("keep"|"continue"|"withdraw"), restartLimit?(默认 5) }`。
**可以是 getter 函数**（`settings` 也接受 `() => HarnessSettings`），每次使用都重新读——能接 settings 文件而不重开 Harness（`06-configuration.ts:52-59`、`25-coding-agent.ts:43-50`）。

**⑨ `conversationCreated`——给每个新会话预置 document**：`readonly conversationCreated?: (tx: Tx, conversation: ConversationRecord) => void | Promise<void>`（`src/harness/types.ts:633`）。在**每一个**创建/分叉会话的 commit 里运行，包括工具里裸调 `tx.createConversation()`。**「每个项目会话都自动带上项目元数据」的正确钩子。**

---

## E. 与需求匹配

### E.1 多角色组织（CEO/CTO/CFO/CPO/COO/CMO/CHRO）

**用 Extension + AgentState 表达角色**，每个角色一个 extension：

```ts
const CTO = defineExtension({ name: "role-cto",
  sections: [section("role", () => "你是 CTO。负责技术战略、架构决策、工程团队。输出决策与风险，不要写代码。")],
  tools: [readDoc, queryMetrics, proposeDecision],
  hooks: [hook(GenerationTask, { onYield: (a) => needsMoreAnalysis(a) ? { continue: "再评估一次风险。" } : undefined })] });
const cto = await harness.createConversation({ ownership: { kind: "ownerless" },
  agent: { model: { provider: "anthropic", modelId: "claude-opus-4-6" },
    extensions: [CodingTools, CTO], tools: [readDoc, queryMetrics, proposeDecision],
    instructions: `你是 ${orgName} 的 CTO，直接向 CEO 汇报。`, cwd: projectWorkspacePath } }, context);
```
其余 6 个角色同构，只是 `name` / `section` 文本 / `model` / `tools` / `cwd` 不同。
依据：`27-reviewer.ts:79-90` 就是这个模式的完整可运行版本。

| 组织概念 | durable 概念 |
|---|---|
| 角色定义（职责/prompt） | `Extension.sections`（`types.ts:355`） |
| 角色能力（能调什么） | `Extension.tools` + `AgentState.tools`（`:417`） |
| 角色模型（贵的/便宜的） | `AgentState.model`（`:412`） |
| 角色的"人格"循环 | `hook(GenerationTask, { onYield })` |
| 角色专属记忆 | `defineDoc({ scope: "conversation" })` |
| 角色专属工作目录 | `AgentState.cwd`（`:431`）+ `HarnessOptions.env` |

### E.2 项目 = 工作空间文件夹

**没有「项目」这个一等公民。** 推荐组合路径 1+2：

**路径 1：`AgentState.cwd` + `HarnessOptions.env`（文件隔离）**
```ts
// test/examples/28-sandbox-per-conversation.ts:49-52
env: async ({ conversationId, read }, envContext) => {
  const sandbox = await read.snapshot(Sandbox, conversationId, envContext);
  return sandbox?.path === undefined ? undefined : new NodeExecutionEnv({ cwd: sandbox.path });
},
```
每个项目会话的 `cwd` 指向 `/projects/<project-slug>/`，工具（read/write/edit/bash）自动在该目录工作（`25-coding-agent.ts:54` 同模式）。更简单的做法：`env: ({ cwd = defaultWs }) => new NodeExecutionEnv({ cwd })`（`27-reviewer.ts:71`）。

**路径 2：`app.projects` 总表 document**
```ts
const Projects = defineDoc<{
  projects: Record<string, { name: string; workspace: string; roles: Record<string, ConversationId>; status: string }>
}>({ kind: "app.projects", version: 1, scope: "session", initial: () => ({ projects: {} }), checkpointWhen: () => false });
```
`scope:"session"` 是全局单例（`src/types.ts:52-58`），适合做组织/项目总表。

**路径 3：项目 = 一个 owner 会话 + 其拥有的子会话树**（各角色 `ownership:{kind:"task"}` 挂下面）——`abort()` 能级联到整个项目，`waitForIdle()` 能等项目全部静默。
**⚠️ 不要「每个项目一个 storage」**：`README.md:783` 明确单进程单 storage、无跨进程锁。多 storage = 多 Harness 多进程，成本远高于收益。

### E.3 项目内员工

**模板 = `22-subagent-background.ts` 的 spawn/send/stop/status 四件套**：
```
员工 = 一个 conversation（独立 transcript、独立 pi.usage）
     + 一个 anchor task（ownership 边界，让员工工作不被上级 Esc 打断）
     + 一个 app.project_employees document 里 name → conversationId 的映射
```
代码骨架（改编自 `22-subagent-background.ts:184-204`）：
```ts
const result = await api.commit(async (tx) => {
  const state = await tx.doc(Employees, api.conversationId);
  const background = { ownership: { kind: "conversation" }, background: true } as const;
  if (action === "hire") {
    const anchor = await tx.createTask(Anchor, null, background);
    const child = await tx.createConversation({ ownership: { kind: "task", taskId: anchor } });
    await configure(tx, child.id, { extensions: { remove: [ManagementTools] },   // 员工没有管理工具
      instructions: `你是 ${project} 项目的${role}，向 ${managerRole} 汇报。`, cwd: projectWorkspace });
    state.employees[name] = { conversationId: child.id, role, manager, reported: [] };
  }
  state.reporters[api.taskId] = await tx.createTask(Reporter, { name, conversationId, message }, background);
  return `已派活给 ${name}。`;
}, callContext);
```

### E.4 员工只对接管理层

四层保障，缺一不可：
1. **工具层**：`callers?: readonly ("model"|"tools")[]`（`types.ts:323`）+ 管理工具只放进「管理层 extension」；员工的 `configure` 里 `extensions:{remove:[ManagementTools]}`（照抄 `22-subagent-background.ts:195`、`21-subagent-foreground.ts:59`）。
2. **会话层**：员工没有创建会话的工具，无法绕过管理层直接找老板。
3. **输入层**：老板直接给员工 submit 时用 `whenBusy:"reject"`，拿到 `ConversationBusy`（`src/errors.ts:60-67`）后按组织关系决定放行/记越级/转直属上级。
4. **报告通道**：只允许 Reporter task 往上传（它是**唯一**能向主 agent 投递的通道，且用 `requestId` 去重）→ 员工说任何话都必须走这条通道 → 天然「只对接管理层」。

### E.5 升级链（员工 → 管理层 → CEO → 老板）

**用自定义 Task 的多 phase 实现状态机**，每级一个 phase：
```ts
type EscalationState = { phase: "employee" } | { phase: "manager"; answer?: string }
  | { phase: "ceo"; answer?: string } | { phase: "owner" };

const Escalation = defineTask<{ question: string; project: ConversationId }, EscalationState, string>({
  name: "app.escalation", version: 1, initial: () => ({ phase: "employee" }),
  phases: {
    employee: async (task, runtime, ctx) => {
      const answer = await ask(runtime, task.input.project, "employee", task.input.question, ctx);
      if (answer !== undefined)   // 员工能解决就终止
        return runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result: answer } }), ctx);
      await runtime.commit(() => ({ status: "running", checkpoint: { phase: "manager" } }), ctx);   // 升一级
    },
    manager: async (task, runtime, ctx) => { /* 同理，升到 ceo */ },
    ceo: async (task, runtime, ctx) => { /* 同理，升到 owner */ },
    owner: async (task, runtime, ctx) => {
      const settled = await askOwner(task.input.project, task.input.question, ctx);   // 可能跨天
      await runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result: settled } }), ctx);
    },
  },
  abort: async (_t, runtime, ctx) => runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), ctx),
});
```
关键点：**每级一个 phase**，checkpoint 记走到哪级 → 崩溃/重启从当前级继续，不重走前面问询；每级用 `runtime.conversation(id)`（`src/types.ts:303`）拿角色会话，submit 后 `wait()`；**老板那级可能等很久**，用 `runtime.sleepUntil()` 结束 phase（`src/types.ts:330`），睡眠中不占 invocation、能跨重启；每次 commit 在 `app.escalation_log`（`history:"rewindable"`）追加 `{ level, askedAt, answeredAt, answer }` 做审计。
**替代方案（更轻）**：不用自定义 Task，直接用 `23-child-tasks.ts` 的 `waiting` + `on`。但升级链是串行的，用 phase 更自然。

### E.6 分阶段开会

**方案 A（推荐）：自定义 Task + phase 表示议程**
```ts
type MeetingState = { phase: "agenda"; topics: string[] } | { phase: "collect"; proposals: TaskId<Proposal>[] }
  | { phase: "debate"; rounds: number } | { phase: "decide" } | { phase: "minutes" };
```
`collect` phase 照抄 `23-child-tasks.ts:71-78`（每个议题/每个高管一个子 task，`commit({ status:"waiting", checkpoint:{phase:"debate",proposals}, on: proposals, policy:"allSettled" })`）；`decide` phase 用 `runtime.outcomes(ids)` 读全部意见让 CEO 汇总；**`watchTaskGraph` 直接就是会议进度看板**（`printGraph` 是现成树形渲染）。

**方案 B（更松）：`configure()` 切会议阶段**——照抄 `26-plan-mode.ts`：讨论阶段 `tools:[readDoc, submit_proposal]`，决策阶段 `tools:[readDoc, submit_decision]`，执行阶段恢复全量；`control:{terminate:true}` 让提交动作一轮结束。

**两者叠加**：Task 管跨阶段生命周期与持久化，`configure()` 管每阶段的能力边界。

### E.7 老板实时查看 / 分叉沟通

**实时查看（按粒度选）**：

| 需求 | API | 粒度 |
|---|---|---|
| 某会话完整状态（transcript + 运行中生成 + 工具输出 + inbox + usage） | `conversation.watch()` → `ConversationView` | 100ms |
| 全组织在跑什么 | `harness.watchTaskGraph()` → `TaskGraph` | 每次 commit |
| coding-agent 风格事件流 | `watchEvents(harness, id, ctx)`（experimental） | 每批 commit |
| 某 document（项目状态、员工名单） | `harness.watchDoc(Token, conversationId, ctx)` | 每次 commit |

`ConversationView`（`src/harness/view.ts:24-30`）= `{ conversation: ConversationRecord; entries: readonly EntryRecord[]; docs: Record<string, JsonObject> }`，`docs` 里是 `pi.agent/pi.live/pi.inbox/pi.usage/pi.provider` 五个内置文档。
**「发现子会话」的模式**（`21-subagent-foreground.ts:120-122`）：工具的 `details.conversationId` → 递归 attach。我们照此做「点开某高管 → 看它派出的所有员工」。

**分叉沟通**：`conversation.fork(at, options, ctx)`（`src/harness/types.ts:770`）。fork 看到父到 `at` 的全部 entry；agent 沿用父在 `at` 时刻的配置（`AgentDoc` 是 `fork:"asOf"`，`src/harness/agent.ts:43-50`）；document 按各自 `fork` 语义；**拿到新 provider sessionId**（`ProviderDoc` 是 `fork:"initial"`，`src/harness/provider.ts:12-19`）。
用法：「老板在会议纪要第 3 条处插进来问一句」→ `meetingConversation.fork(entryId, { ownership: { kind: "ownerless" } })`，新分支上 submit，看完即丢。
⚠️ `README.md:493`：「A client that joins late or reconnects starts from the current view; nothing is replayed.」→ 看板要自己维护「从哪一帧接上」。

### E.8 成本核算

**直接拿到的**：单会话 `harness.snapshot(UsageDoc, conversationId, ctx)`；全 Session `harness.usage(ctx)`。
**要自己写的**：
1. **按项目聚合**：`tx.scanConversations({})` 分页扫全部会话 → 按 `ConversationRecord.owner` 或 `app.projects` 里的归属分组 → 各组 `UsageDoc` 求和。`harness.usage()` 内部就是这么做的（`harness.ts:352-362`），照抄后加分组。
2. **按角色聚合**：同上，按角色名分组（角色名在 `app.employees` document）。
3. **预算告警**：`hook(GenerationTask, { afterResponse })` 里检查累计花费，超阈值时 `{block}` 或 `configure({ model: 便宜模型 })`。
4. **实时成本流**：`watchEvents` 的 `usage_changed`（`src/harness/events.ts:90`）或 `watchDoc(UsageDoc, ...)`。

**必须避开的坑**：跑子会话的工具不能把子会话 usage 再报一遍（`spec.md` §12「Double-counted subagent spend」）；fork 从 0 开始（`README.md:745`）→ 分叉沟通花费不算父会话；compaction 花钱（每次尝试都付、摘要过期照付）；失败/中断也计数。

---

## F. 坑与限制

### F.1 experimental：最大风险

`packages/durable/README.md:3`：「**Experimental.** The API changes without notice between releases.」`CHANGELOG` 的 `[1.4.0]` 有 6 条 Breaking Changes，`[Unreleased]` 又有 4 条。真实例子：`TaskRuntime.sleep()` **被删**改成 `sleepUntil(until, checkpoint, ctx)`（phase 内等待会占住 invocation）；`Storage.commit(writes, adopt, ctx)` **多了 `adopt` 参数**；`defineDoc()/defineDocFamily()` **强制要求 `checkpointWhen`**；`WatchHandle` 结束原因改名（`session_closed`→`ended`）；1.4.0 打开 SQLite 会**自动迁移到 schema v2**，迁移后 1.3.0 及更早**打不开**（「a deployment cannot roll back past this release」）。

**应对**：精确锁版本（`"1.4.0"`，不带 `^`）；升级前读 CHANGELOG Breaking 段并跑一遍 `test/examples`；领域逻辑放 extension/document/task 三件套（接口相对稳定）；自己的 Storage/ExecutionEnv 用官方 conformance 套件当回归网。

### F.2 并发与恢复边界

| 边界 | 事实 | 出处 |
|---|---|---|
| 单进程单 storage | 「One process owns a storage at a time; there is no cross-process locking」 | `README.md:783` |
| 会话内串行 | 一个会话同时只有一个 run；新输入进 inbox | `src/harness/live.ts:82` |
| 跨会话并行 | 不同会话可同时跑 | 调度器设计 |
| mutation line 串行 | 所有 commit 同一条线；**回调里不能 await 外部副作用** | `spec.md` §1 不变式 7、§12 |
| 恢复是 at-least-once | phase 崩溃后从头重跑；副作用必须幂等或 `memo()` | `spec.md` §5.2 |
| 工具默认不重跑 | `replay` 默认 `"unsafe"`，崩溃后模型拿 `interrupted` | `src/harness/types.ts:303-304` |
| 进度/watch 会丢帧 | 崩溃最多丢 100ms progress；慢 watch 最多缓存 100 帧后整帧替换 | `README.md:493-495` |
| close 不算 crash | `join()` 把 task 写回 `pending` 且不计 restart | `scheduler.ts:534-540` |
| 非协作代码卡住 close | 忽略 abort signal 的 handler 让 `close()` 永远 pending | `README.md:828` |

**`ReadAfterWrite`**（`spec.md` §12 第一条 footgun）最容易踩：commit 回调里所有表读取必须在第一次表写入前。`tx.createConversation()` 之后不能再 `tx.conversation(id)`（document 读写仍可继续）。

### F.3 SQLite 原生依赖：**实际上没有**

SQLite 走 **Node 内置 `node:sqlite`**，不是 `better-sqlite3`（`packages/chord/src/sqlite/node.ts:3-4`：`import { DatabaseSync } from "node:sqlite"`；`:186`：`new DatabaseSync(path, { timeout })`）。**所以 macOS / Linux / CI 上 `npm i` 就能跑，不需要 node-gyp、不需要 Xcode CLT。** 消除一个巨大的部署风险。需要注意：
- **必须 Node ≥ 22.19**（22.5 之前 `node:sqlite` 需要 `--experimental-sqlite`）。
- WAL + `synchronous = NORMAL`（`README.md:758`）：「commits survive process crashes; the newest may be lost on power or host failure」。要掉电安全得改 storage 配置，但会慢很多。
- `migrations.ts:13`：「`next_id` is TEXT because `node:sqlite` rejects INTEGER results outside JavaScript's safe integer range」。
- 图像处理有真 WASM 依赖 `@silvia-odwyer/photon`，但只有 import `/images/node` 才加载。
- 包根会加载 TypeBox（`README.md:810`）：「about 23 MB of peak RSS unbundled, about 4 MB in a tree-shaken bundle」。

### F.4 测试里体现出的已知语义

**`test/harness-storage-failure.test.ts`（649）—— storage 错误是致命的**
实测断言（`:102-120`）：命中的 `commit` 拿到原始错误 → 所有 pending wait（`task`/`idle`）reject `SessionFailed{cause}` → `watch.closed` 与 `stream.closed` 都是 `{reason:"failed", error}` → 后续 `getTask`/`submit` 同样 reject → `harness.closed` = `{reason:"failed"}` → `signals === ["aborted"]`（running task 收到 abort signal）→ `reports === [failure]`（`onReport` 恰好一次）。
**这条语义必须内化**：一次 storage 错误 = 整个 Harness 死掉，所有 pending wait reject `SessionFailed`，watcher 收 `failed`，running task 收 abort signal，**没有重试**（`README.md:816`：「Nothing is retried; a custom storage retries its own transient failures」）。
对我们的含义：① **必须监听 `harness.closed` 并自动重开**：`harness.closed.then(end => { if (end.reason === "failed") reopen(end.error); })`；② 业务层要容忍「刚提交的东西可能失败」——用 `requestId` 去重，重开后 resubmit 同 requestId 会找回原 submission（`README.md:129-138`）；③ 自定义 storage 必须自己做瞬时错误重试。
另注意：`:121` 非 Session line 上的读（如 `conversation.context()`）失败也杀死整个 Session；`:267` `mintId()` 失败同样致命；`:291` **`StorageRequestError` 从 `commit()` 抛出也是致命的**（只有从「读」抛出才只失败那一次读）。

**`test/harness-cancellation-barrier.test.ts`（235）—— 取消的屏障语义**：`:46`「does not start its next phase while the cascade that marks it has not committed」、`:101`「lets a failFast request in the same pass override a restart mark」、`:154`「upgrades restart marks down the tree when an abort is requested above them」。说明三点：① **取消意图必须先持久化再生效**（否则「取消了但没记录」会被当没取消而重跑）；② **同一轮调度有优先级**：显式 abort request > failFast 传播 > restart mark；③ **restart mark 会被上层 abort 升级**成真正的 abort request（因为 abort handler 要执行清理，restart mark 只是「等定义」）。
含义：**「老板点停止」不是瞬间生效的**，中间有一个 commit 的延迟。UI 应显示「正在停止」，直到 `conversation.abort()` 的 Promise resolve（它 resolve 时才是真 idle，`src/harness/types.ts:775`）。

**`test/harness-blocked.test.ts` —— 停车机制**：`:135` 连续被 cut off `restartLimit` 次就 park 并可用 `retryTask()` 复活；`:181` close 停下的 task 不计数；`:230` abort handler 被 cut off 同样次数则 `faulted`；`:333` **提交一个「和上次一样」的 checkpoint 不算进度**，restart 计数不重置 → 「原地空转」的 task 最终会被停车。

**`test/harness-tasks-recovery.test.ts`（24 个场景）本身就是恢复语义规格书**：`:291`（mark commit 中崩）、`:307`（mark 后 join 前崩）、`:332`（abort handler 跑时崩）、`:353`（abort outcome 写入中崩）、`:388`（terminal 后崩→什么都不重跑）、`:408`（reservation commit 中崩→仍 pending）；定义变更：`:429`（定义缺失→保持 pending 且仍算 live）、`:447`（版本太新→pending）、`:461`（migration 失败→记录不变）、`:513`（旧记录+新定义无 migrate→blocked）、`:657`（同版本替换→phase 边界交接、无重叠）、`:709`（新版本+migrate→交接）。写自己的 task 时应照着测。

### F.5 其他必须知道的坑（`spec.md` §12 精选）

| 坑 | 说明 | 对我们的影响 |
|---|---|---|
| Long transactions / reads inside a commit / detached drafts | 回调里 await 外部 I/O 会卡死 mutation line；`snapshot()`/`watchDoc()`/`getTask()` 在回调里可能永不 resolve；回调结束后所有 `Tx` 操作 reject | 所有 I/O 在 commit 外做；只用 `tx` 读；别把 `tx` 传出去 |
| Reserved `pi.` names | task/document/entry kind 以 `pi.` 开头属于内置 | 我们一律用 `app.` 前缀 |
| Checkpoint starvation | `checkpointWhen:()=>false` 且 document 持续变大 → 存储无限膨胀 | 大 document 必须给 base 策略 |
| Schema stability | document kind 是持久化公共协议，不能改名 | 起名慎重，用 `app.` + 稳定语义名 |
| Guards left out of a selection | 用数组选 extension 会漏掉权限 hook | 权限 extension 必须显式加进每个角色数组 |
| Copies are one-time | task 拥有的会话只在创建时拷贝 owner 的 `pi.agent` | 角色配置要么创建时定死，要么主动 `configure` |
| Moving default selections | 默认选择随 settings/registry 变化，每次变化追加 `pi.system` 并打破 prompt cache | 生产环境显式指定 extensions 数组 |
| Unstable prompt text | section 带时间戳 → 每次追加 system delta，打爆 cache | section 必须是纯函数 |
| Owned work holds its owner | 前台子 agent 会 hold 住调用它的工具和整个 run | 老板要看别的必须用 background 模式 |
| Non-cooperative code at close | 忽略 abort signal 的 handler 让 `close()` 永远 pending | 所有 handler 都要尊重 `runtime.signal` |

---

## 可复用的 12 个代码模式

| # | 模式 | 出处 | 一句话骨架 | 用途 |
|---|---|---|---|---|
| 1 | **前台子 agent** | `21-subagent-foreground.ts:39-77` | `defineTool({ replay:"safe", execute: async (args, api, ctx) => { api.commit 里查重/建子会话 → configure 剥掉自己 → api.details({conversationId}) → submit+wait → 从 answer entry 取文本 } })` | CEO 派单个明确任务，要答案才能继续 |
| 2 | **后台常驻子 agent** | `22-subagent-background.ts:62-212` | Anchor task（`background:true` 边界）+ Reporter task（deliver/report 两 phase）+ `app.subagents` doc + `requestId` 去重 | 员工长期在岗、随时派活、答案异步回报 |
| 3 | **父 task 并行派发子 task 并等待** | `23-child-tasks.ts:71-91` | `commit(async tx => ({ status:"waiting", checkpoint, on: ids, policy:"failFast" }))` → 下个 phase `runtime.outcomes(ids)` | 分阶段开会并行收集意见 |
| 4 | **Task 状态机，每级一个 phase** | `11-tasks.ts:17-45` + `src/types.ts:334-357` | `defineTask({ initial, phases: { 每级: (task,runtime,ctx) => runtime.commit(() => next 或 terminal) }, abort })` | 升级链（员工→管理层→CEO→老板） |
| 5 | **持久化睡眠** | `12-recovery.ts:48`、`23-child-tasks.ts:44` | `await runtime.sleepUntil(runtime.now()+delay, { phase: 下一阶段, ... }, ctx)` | 等老板回复、等外部审批、退避重试 |
| 6 | **memo 幂等去重（effect sandwich）** | `12-recovery.ts:32-35` | `if ((await runtime.memo(key,ctx)) === undefined) { await runtime.memo(key,true,ctx); /* 副作用 */ }` | 任何不能重复的副作用 |
| 7 | **requestId 幂等提交** | `21-subagent-foreground.ts:67`、`README.md:129-138` | `submit({ type:"input", content, requestId: \`${scope}:${stableId}\` }, ctx)` | 所有跨进程边界的消息投递 |
| 8 | **会话级 document 做小注册表** | `22-subagent-background.ts:46-55`、`03-owned-conversations.ts:29-39` | `defineDoc({ scope:"conversation", history:"latest", fork:"initial", checkpointWhen:()=>false })` | 员工名册、项目索引、会议记录指针 |
| 9 | **Extension 定义角色** | `27-reviewer.ts:31-44`、`26-plan-mode.ts:29-57` | `defineExtension({ name:"role-xxx", sections, tools, hooks:[hook(GenerationTask,{onYield})], tasks })` | 7 个高管角色的标准封装 |
| 10 | **configure() 切能力边界** | `26-plan-mode.ts:61-63, 94-101` | `const enter = { extensions:{add:[X]}, tools:[read, submitX] }; const leave = { extensions:null, tools:null }` | 会议阶段切换、只读模式、临时提权 |
| 11 | **递归 attach 子会话事件** | `21-subagent-foreground.ts:113-126` | `watchEvents` → 遇 `tool_execution_update` 且 `details.conversationId` 未 attach 过 → 递归 attach（缩进+2） | 老板点开高管，看它下面所有员工 |
| 12 | **ControlledStorage + openTasks 测错误路径** | `session-support.ts:37-130`、`task-support.ts:65-102` | `class ControlledStorage extends MemoryStorage`（holdCommits/crash/failNextCommit/reopen）+ `openTasks` 收 `reports`/`infos` | 所有崩溃恢复/storage 故障/竞态测试的基建 |

---

## 基于源码的可行性判断

### ✅ 能做（有直接源码依据，改动量小）

| 需求 | 实现方式 | 依据 |
|---|---|---|
| 7 个高管角色，各自 prompt/模型/工具/目录 | `defineExtension` + `createConversation({ agent })` | `27-reviewer.ts:79-90` 完整范例 |
| 项目 = 工作空间文件夹 | `AgentState.cwd` + `HarnessOptions.env` 按 conversationId 返回不同 `NodeExecutionEnv` | `28-sandbox-per-conversation.ts:49-52`、`25-coding-agent.ts:54` |
| 项目内员工，可派活/查状态/叫停 | `22-subagent-background.ts` 的 spawn/send/stop/status | 完整可运行代码 |
| 员工只对接管理层 | `configure({ extensions:{remove:[管理工具]} })` + `whenBusy:"reject"` + Reporter 单一通道 | `21-subagent-foreground.ts:59`、`22-subagent-background.ts:195` |
| 分阶段开会 | 自定义 Task 多 phase + `waiting` 子 task + `configure()` 切能力 | `11-tasks.ts` + `23-child-tasks.ts` + `26-plan-mode.ts` |
| 老板实时查看 | `conversation.watch()` + `harness.watchTaskGraph()` | `view.ts:24`、`task-graph.ts:50` |
| 老板分叉沟通 | `conversation.fork(at, options)` | `02-forks.ts`、`07-harness-conversations.ts:37` |
| 崩溃恢复（进程挂了不丢工作） | 自动；`open()` 时 `running → pending` + restart 计数 | `scheduler.ts:382-420`、`12-recovery.ts` |
| 成本核算（会话级 + 全局） | `snapshot(UsageDoc, id)` + `harness.usage()` | `usage.ts:14-39`、`harness.ts:352-362` |
| 权限闸门 | `hook(ToolTask, { beforeTool: call => ({ block }) })` | `README.md:609`、`types.ts:880-894` |
| 流式输出到看板 | `watchDoc(LiveDoc)` 或 `conversation.watch()` 的 `docs["pi.live"]` | `15-real-model.ts`、`20-late-join.ts` |

### 🔶 要做（源码支持，但需要我们自己写一层）

| 需求 | 要做什么 | 工作量 |
|---|---|---|
| **按项目/按角色聚合成本** | 抄 `harness.usage()`（`harness.ts:352-362`）加分组：`scanConversations` → 按 `app.projects`/`app.employees` 归属分组 → 各组 `UsageDoc` 求和 | 小（~100 行） |
| **升级链完整状态机** | 写 `app.escalation` Task（4-5 phase），每级 `runtime.conversation(id)` + submit + wait；老板级用 `sleepUntil` | 中（~200 行） |
| **会议编排 Task** | 写 `app.meeting` Task：agenda/collect/debate/decide/minutes，`collect` 用子 task + `waiting` | 中（~300 行） |
| **项目/组织总表** | `scope:"session"` 的 `app.org`/`app.projects` document；用 `conversationCreated` 给每个新会话预置 | 小（~80 行） |
| **看板后端** | WS/SSE 服务转发 `conversation.watch()` 与 `watchTaskGraph()` 的 frames；注意「late join 从当前视图开始、不重放」 | 中 |
| **崩溃自愈** | `harness.closed.then(end => end.reason==="failed" && reopen())` + `requestId` 去重重放 | 小 |
| **角色定义热更新** | `registry.install(新版同名 extension)`（`30-reload-and-restart.ts`）；要处理「删掉 extension 后会话静默失去能力」 | 小 |
| **权限模型** | `beforeTool` hook + 每个角色**显式** `extensions` 数组（不能用默认选择，见 §12「Guards left out of a selection」） | 中 |
| **多租户/多用户** | durable 无此概念。方案：单 Harness + 每用户一组会话 + document 记 owner；或每用户一进程一 storage | 中～大 |
| **我们自己领域的 Storage** | 实现 `Storage` 18 方法 + `registerStorageConformance` 验证 | 大（通常不需要） |

### ❌ 做不了 / 不建议做

| 想做的事 | 为什么不行 |
|---|---|
| 跨进程共享一个 storage | `README.md:783`：「One process owns a storage at a time; there is no cross-process locking」。横向扩展必须每进程一 storage，或自己实现带锁的 Storage |
| 保证「恰好一次」的外部副作用 | 恢复是 at-least-once（`spec.md` §5.2）。只能靠 `memo()`/`requestId`/外部幂等键去重，内核做不到 exactly-once |
| 依赖 `watchEvents` 做长期稳定契约 | 它标着 experimental（`src/harness/events.ts:163`）。**用 `conversation.watch()` + `watchTaskGraph()` 替代** |
| token 级实时流 | 进度是 100ms 节流提交（`agent.ts:34-38`）。想要更细只能调小 interval，代价是更多 storage 写入 |
| 靠 `whenBusy:"reject"` 做强一致并发控制 | 它只是准入检查不是锁。真正的串行保证来自「一个会话一个 run」 |
| 在 commit 回调里做重活 | 会卡住整条 mutation line（`spec.md` §12「Long transactions」）。设计约束，不是 bug |
| 改 document kind 名字做版本演进 | `spec.md` §12「Schema stability」：kind 是持久化公共协议，改名需显式 copy + retire。**用 `version` + `migrate`** |
| 完全不用 `env` 也能跑工具 | `README.md:441`：「Without an environment, the built-in tools fail with an error result」。必须提供 `HarnessOptions.env` |
| 升级时跳过 Breaking Changes | 1.4.0 的 SQLite schema 迁移单向（「a deployment cannot roll back past this release」）。升级前必须备份 + 演练 |

---

## 附：本地跑起来的命令

```bash
cd /Users/kirer/projects/ai-company/archive/reference/pi
npm ci --ignore-scripts && npm run build      # 前置包必须先 build（tsconfig 指向 ../*/dist/*.d.ts）
cd packages/durable
node --conditions=source --experimental-strip-types test/examples/21-subagent-foreground.ts   # 无需 API key
npm test                                       # 或单文件：node ../../node_modules/vitest/dist/cli.js --run test/harness-ownership.test.ts
```
Node 必须 ≥ 22.19（本机实测 `v26.12.0` 可用）。
